import { config } from "./config.js";
import { log } from "./log.js";
import {
  type Availability,
  type ProductMetadata,
  extractApiKey,
  findFirst,
  parseMetadata,
  pdpUrl,
} from "./target.js";

/**
 * The network half of reading a Target listing.
 *
 * Two hosts, and only one of them will talk to a plain HTTP client:
 *
 *   www.target.com      -- Fastly. Serves the full PDP HTML to a bare GET, no
 *                          key, from anywhere. Carries the static facts only.
 *   redsky.target.com   -- the aggregation API behind live price and stock.
 *
 * Measured, not assumed: redsky answers a bare curl with `403` and a CAPTCHA
 * challenge body, identically from an Azure IP and from a residential one. It
 * is bot detection keyed on the request, not on the network it came from, so
 * there is no host this can be moved to that fixes it. Satisfying that
 * challenge is deliberately out of scope.
 *
 * The consequence downstream is that `challenged` is modelled as its own state
 * rather than folded into a generic failure. A challenge that read as "no
 * stock" would make a permanently blocked watcher indistinguishable from a
 * working one that has simply never seen a restock -- which is the single
 * worst way for this feature to fail.
 *
 * Note the host: `redsky.api.target.com` is retired and does not resolve at
 * all. The live base URL is declared in the page's own config blob under
 * `redskyAggregations.baseUrl`.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const REDSKY = "https://redsky.target.com/redsky_aggregations/v1/web";

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export interface PdpResponse {
  status: number;
  html: string;
}

export async function fetchPdpHtml(tcin: string, timeoutMs = 15_000): Promise<PdpResponse> {
  return withTimeout(timeoutMs, async (signal) => {
    const res = await fetch(pdpUrl(tcin), {
      signal,
      redirect: "follow",
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    return { status: res.status, html: await res.text() };
  });
}

async function getJson(
  url: string,
  timeoutMs = 12_000,
): Promise<{ status: number; json: unknown }> {
  return withTimeout(timeoutMs, async (signal) => {
    const res = await fetch(url, {
      signal,
      headers: {
        "user-agent": UA,
        accept: "application/json",
        "accept-language": "en-US,en;q=0.9",
        origin: "https://www.target.com",
        referer: "https://www.target.com/",
      },
    });
    const text = await res.text();
    try {
      return { status: res.status, json: JSON.parse(text) as unknown };
    } catch {
      return { status: res.status, json: null };
    }
  });
}

export interface AvailabilityQuery {
  apiKey: string;
  storeId: string;
  zip: string;
  state: string;
}

/**
 * Live price and stock for one item.
 *
 * Two endpoints because Target splits them: fulfillment knows what is in stock
 * and where, pdp_client knows what it costs. Neither is much use without the
 * other, so they go out together.
 */
export async function fetchAvailability(
  tcin: string,
  { apiKey, storeId, zip, state }: AvailabilityQuery,
): Promise<Availability> {
  const common = {
    key: apiKey,
    tcin,
    is_bot: "false",
    channel: "WEB",
    page: `/p/A-${tcin}`,
  };

  const fulfillmentUrl = `${REDSKY}/product_fulfillment_v1?${new URLSearchParams({
    ...common,
    store_id: storeId,
    zip,
    state,
    required_store_id: storeId,
    has_required_store_id: "true",
    scheduled_delivery_store_id: storeId,
  })}`;

  const pricingUrl = `${REDSKY}/pdp_client_v1?${new URLSearchParams({
    ...common,
    store_id: storeId,
    pricing_store_id: storeId,
    has_pricing_store_id: "true",
  })}`;

  const [fulfillment, pricing] = await Promise.all([
    getJson(fulfillmentUrl).catch((err: unknown) => {
      log.debug("Fulfillment probe threw", { tcin, err: String(err) });
      return { status: 0, json: null };
    }),
    getJson(pricingUrl).catch((err: unknown) => {
      log.debug("Pricing probe threw", { tcin, err: String(err) });
      return { status: 0, json: null };
    }),
  ]);

  const blocked = [403, 429].includes(fulfillment.status) || [403, 429].includes(pricing.status);
  // A 403 whose body offers a CAPTCHA URL is bot detection, not rate limiting.
  // Backing off does not clear it, so it is reported rather than retried.
  const challenged = [fulfillment.json, pricing.json].some(
    (j) => findFirst(j, ["captchaRelativeURL", "captchaAbsoluteURL"]) !== undefined,
  );

  const price = Number(findFirst(pricing.json, ["current_retail", "reg_retail"]));
  const atp = Number(findFirst(fulfillment.json, ["available_to_promise_quantity"]));

  const shipping = findFirst(fulfillment.json, ["shipping_options"]);
  const pickup = findFirst(fulfillment.json, ["order_pickup"]);
  const shipStatus = findFirst(shipping, ["availability_status"]);
  const pickupStatus = findFirst(pickup, ["availability_status"]);

  const seller = findFirst(pricing.json, ["seller_name", "vendor_name"]);
  const marketplace = findFirst(pricing.json, ["is_marketplace", "marketplace"]);

  return {
    ok: !blocked && (fulfillment.json !== null || pricing.json !== null),
    status: fulfillment.status || pricing.status,
    blocked,
    challenged,
    unitPrice: Number.isFinite(price) && price > 0 ? price : undefined,
    shipStatus: typeof shipStatus === "string" ? shipStatus : undefined,
    pickupStatus: typeof pickupStatus === "string" ? pickupStatus : undefined,
    atpQuantity: Number.isFinite(atp) ? atp : undefined,
    marketplace: typeof marketplace === "boolean" ? marketplace : undefined,
    sellerName: typeof seller === "string" ? seller : undefined,
  };
}

export interface Probe {
  meta?: ProductMetadata;
  avail?: Availability;
  error?: string;
}

/**
 * One full read of a listing: the product page for the static facts and a fresh
 * key, then redsky for price and stock.
 *
 * Backs `/restock check`. As of writing the second half always comes back
 * challenged, which is exactly what that command exists to show you -- in one
 * invocation, rather than by inference from a watcher that never fires.
 */
export async function probeListing(tcin: string): Promise<Probe> {
  let html: string;
  try {
    const res = await fetchPdpHtml(tcin);
    if (res.status !== 200) return { error: `Target returned HTTP ${res.status} for the product page` };
    html = res.html;
  } catch (err) {
    return { error: `Could not reach the product page: ${String(err)}` };
  }

  const meta = parseMetadata(html);
  const apiKey = extractApiKey(html);
  if (!apiKey) return { meta, error: "No API key found in the product page bundle" };

  try {
    const avail = await fetchAvailability(tcin, {
      apiKey,
      storeId: config.target.storeId,
      zip: config.target.zip,
      state: config.target.state,
    });
    return { meta, avail };
  } catch (err) {
    return { meta, error: `Live availability probe failed: ${String(err)}` };
  }
}
