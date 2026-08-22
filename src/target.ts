/**
 * Reading a Target product listing.
 *
 * Pure by design -- no network, no config -- so the suite can exercise the
 * parsing against captured HTML without booting the bot. The fetching half is
 * targetapi.ts.
 *
 * Target splits what we need across two sources, and the split matters:
 *
 *   - The PDP HTML carries a large inlined blob under `__TGT_DATA__` with the
 *     *static* facts: purchase limit, first-party vs marketplace, street date,
 *     title. No API key needed, served straight off www.target.com.
 *   - Price and stock are NOT in that blob. target.com's own frontend fetches
 *     them from redsky after page load, so anything that only reads the HTML
 *     will report a permanently unknown price.
 *
 * Field paths inside the blob move between page templates, so everything here
 * searches by key rather than by path, and every field is allowed to come back
 * undefined. Callers must treat undefined as "unknown", never as "fine" --
 * see restock.ts, where the guards fail closed on exactly that.
 */

/** Target's item number, as it appears in a PDP URL's `A-<tcin>` segment. */
const TCIN_IN_URL = /(?:^|\/)A-(\d{6,12})(?:$|[/?#])/;
const BARE_TCIN = /^A-(\d{6,12})$/i;

/**
 * Accepts a full PDP URL, a bare `A-1011960739`, or a naked item number.
 *
 * Everything downstream keys off the TCIN rather than the URL: Target rewrites
 * the slug segment freely, so a stored URL goes stale in a way the number never
 * does.
 */
export function parseTcin(input: string | null | undefined): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (/^\d{6,12}$/.test(raw)) return raw;
  return raw.match(TCIN_IN_URL)?.[1] ?? raw.match(BARE_TCIN)?.[1] ?? null;
}

export function pdpUrl(tcin: string): string {
  return `https://www.target.com/p/-/A-${tcin}`;
}

/**
 * Pulls the `__TGT_DATA__` blob out of the page.
 *
 * It is emitted as `JSON.parse("<escaped json>")`, so the string literal is
 * walked by hand: a regex across a 300 KB body full of escaped quotes gets the
 * boundary wrong often enough to be worthless.
 */
export function extractTgtData(html: string): unknown {
  const anchor = html.indexOf("__TGT_DATA__");
  if (anchor < 0) return null;

  const call = html.indexOf("JSON.parse(", anchor);
  if (call < 0) return null;

  let i = call + "JSON.parse(".length;
  while (i < html.length && /\s/.test(html[i] ?? "")) i++;

  const quote = html[i];
  if (quote !== '"' && quote !== "'") return null;

  let j = i + 1;
  let body = "";
  while (j < html.length) {
    const c = html[j];
    if (c === undefined) break;
    if (c === "\\") {
      body += c + (html[j + 1] ?? "");
      j += 2;
      continue;
    }
    if (c === quote) break;
    body += c;
    j++;
  }

  try {
    // First parse resolves the JS string literal's escapes; second parses the JSON.
    const escaped = quote === '"' ? body : body.replace(/"/g, '\\"');
    return JSON.parse(JSON.parse(`"${escaped}"`) as string);
  } catch {
    return null;
  }
}

/** Depth-first search for the first non-null value under any of `keys`. */
export function findFirst(node: unknown, keys: string[], depth = 0): unknown {
  if (node === null || node === undefined || depth > 14) return undefined;

  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findFirst(item, keys, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  if (typeof node !== "object") return undefined;
  const record = node as Record<string, unknown>;

  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  for (const value of Object.values(record)) {
    const hit = findFirst(value, keys, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Regex fallback for when the blob's shape changes and the walk above fails. */
function scrapeScalar(html: string, key: string): string | undefined {
  return html.match(new RegExp(`"${key}"\\s*:\\s*("?)([^",}]{1,64})\\1`))?.[2];
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
};

/**
 * The product name, from the `<title>` tag.
 *
 * Emphatically NOT a bare findFirst for "title": the blob's first `title` on a
 * real PDP belongs to the global navigation menu, so that returns "Global
 * Navigation" for every product on the site. It is a good example of why
 * nothing here searches for a generic key unscoped.
 */
function pageTitle(html: string): string | undefined {
  const raw = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
  if (raw === undefined) return undefined;
  const decoded = raw.replace(/&(?:amp|quot|#39|apos|lt|gt|nbsp);/g, (m) => ENTITIES[m] ?? m);
  // Target suffixes every product page title with " : Target".
  return decoded.replace(/\s*:\s*Target\s*$/i, "").trim() || undefined;
}

export interface ProductMetadata {
  /** False when the blob failed to parse and everything below came from regex. */
  parsedBlob: boolean;
  title?: string;
  /** How many of this item one order may hold, per Target. */
  purchaseLimit?: number;
  /** "SA" is a first-party, Target-owned listing. Anything else is not. */
  relationshipTypeCode?: string;
  /** Release date for preorders, ISO `YYYY-MM-DD`. */
  streetDate?: string;
}

export function parseMetadata(html: string): ProductMetadata {
  const data = extractTgtData(html);

  const pick = (key: string): unknown => {
    const fromBlob = data ? findFirst(data, [key]) : undefined;
    return fromBlob !== undefined ? fromBlob : scrapeScalar(html, key);
  };

  const limit = Number(pick("purchase_limit"));
  const relationship = pick("relationship_type_code");
  const street = pick("street_date");

  // Scoped under product_description when the blob carries it, and otherwise
  // the page title -- never an unscoped search. See pageTitle.
  const described = data ? findFirst(findFirst(data, ["product_description"]), ["title"]) : undefined;
  const title = typeof described === "string" ? described : pageTitle(html);

  return {
    parsedBlob: data !== null && data !== undefined,
    title,
    purchaseLimit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    relationshipTypeCode: typeof relationship === "string" ? relationship : undefined,
    streetDate: typeof street === "string" ? street : undefined,
  };
}

/**
 * The redsky key is embedded in the page bundle.
 *
 * Scraped per-run rather than committed as a constant: it rotates, and a stale
 * hard-coded key fails as a flat 401 that reads exactly like "never restocked".
 */
export function extractApiKey(html: string): string | undefined {
  return html.match(/key=([a-f0-9]{20,})/i)?.[1];
}

export interface Availability {
  /** True when the probe returned usable JSON -- not that the item is in stock. */
  ok: boolean;
  status: number;
  /** 403/429. Distinct from `!ok`: this one means back off. */
  blocked: boolean;
  /**
   * The 403 carried a CAPTCHA challenge, i.e. bot detection rather than rate
   * limiting. Waiting does not clear it, so this is surfaced to the user
   * instead of being retried into.
   */
  challenged: boolean;
  unitPrice?: number;
  shipStatus?: string;
  pickupStatus?: string;
  atpQuantity?: number;
  marketplace?: boolean;
  sellerName?: string;
}

const BUYABLE = new Set(["IN_STOCK", "LIMITED_STOCK", "PRE_ORDER_SELLABLE"]);

export function isBuyable(avail: Availability): boolean {
  return BUYABLE.has(avail.shipStatus ?? "") || BUYABLE.has(avail.pickupStatus ?? "");
}
