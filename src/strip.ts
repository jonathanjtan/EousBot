/**
 * Removing tracking junk from a URL.
 *
 * Kept outside the command handler so the suite can test it without booting
 * config (which exits the process when secrets are absent), and without a
 * Discord client.
 */

/** Query parameters that only ever carry analytics, whatever the host. */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "yclid",
  "ttclid",
  "twclid",
  "igshid",
  "igsh",
  "si",
  "mc_cid",
  "mc_eid",
  "mkt_tok",
  "ncid",
  "cmpid",
  "epik",
  "li_fat_id",
  "ref_src",
  "ref_url",
  "_ga",
  "_gl",
  "__twitter_impression",
  "vero_id",
  "oly_enc_id",
  "oly_anon_id",
]);

/** Prefixes covering the families of tracking parameters (utm_source, ...). */
const TRACKING_PREFIXES = ["utm_", "mtm_", "pk_", "piwik_", "_hs", "hsa_"];

/**
 * Parameters that are tracking on one host and meaningful on another. `s` and
 * `t` are share IDs on x.com but a search query elsewhere, so they only come
 * off when the host says they are safe to lose.
 */
const HOST_PARAMS: { hosts: string[]; params: string[]; prefixes?: string[] }[] = [
  { hosts: ["twitter.com", "x.com"], params: ["s", "t"] },
  { hosts: ["youtube.com", "youtu.be"], params: ["feature", "kw"] },
  {
    hosts: ["amazon.com", "amazon.co.uk", "amazon.ca", "amazon.de", "amazon.co.jp"],
    params: ["ref", "ref_", "tag", "psc", "qid", "sr", "crid", "sprefix"],
    prefixes: ["pd_rd_", "pf_rd_"],
  },
];

export interface StripResult {
  /** The cleaned URL. */
  url: string;
  /** Names of the parameters that came off, in the order they appeared. */
  removed: string[];
}

/** Thrown for input that isn't a URL we can work with. */
export class StripError extends Error {}

/** `www.` is noise for host matching; `m.` and country subdomains are not. */
function hostMatches(host: string, hosts: string[]): boolean {
  const bare = host.replace(/^www\./, "");
  return hosts.some((h) => bare === h || bare.endsWith(`.${h}`));
}

function isTracking(name: string, host: string): boolean {
  const lower = name.toLowerCase();
  if (TRACKING_PARAMS.has(lower)) return true;
  if (TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;

  return HOST_PARAMS.some(
    (rule) =>
      hostMatches(host, rule.hosts) &&
      (rule.params.includes(lower) ||
        (rule.prefixes?.some((prefix) => lower.startsWith(prefix)) ?? false)),
  );
}

/**
 * Parses input the way someone pastes a link: possibly bare of a scheme,
 * possibly wrapped in the angle brackets Discord uses to suppress embeds.
 */
function parse(input: string): URL {
  const trimmed = input.trim().replace(/^<(.*)>$/s, "$1").trim();
  if (trimmed === "") throw new StripError("That doesn't look like a URL.");

  // Only assume https:// for input that names no scheme: prefixing something
  // like "mailto:someone@example.com" would parse the address as userinfo and
  // quietly turn it into a link to example.com.
  // The digit lookahead keeps "localhost:3000/x" a host and port rather than a
  // "localhost:" scheme.
  const scheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed);
  const candidate = scheme ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new StripError("That doesn't look like a URL.");
  }
  // mailto:, javascript: and friends have no query worth cleaning, and a
  // scheme-less one survives the prefix above as a path rather than a host.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new StripError("Only http and https links can be stripped.");
  }
  if (url.hostname === "") throw new StripError("That doesn't look like a URL.");

  return url;
}

/**
 * Strips tracking parameters from `input`. With `all`, every query parameter
 * goes, for links whose host uses a scheme this list doesn't know about.
 */
export function stripUrl(input: string, all = false): StripResult {
  const url = parse(input);

  const removed: string[] = [];
  const kept: [string, string][] = [];
  for (const [name, value] of url.searchParams) {
    if (all || isTracking(name, url.hostname)) removed.push(name);
    else kept.push([name, value]);
  }

  // Rebuilding from the survivors rather than deleting in place: delete() drops
  // every value sharing a name, and the query is left byte-identical when
  // nothing matched.
  if (removed.length > 0) url.search = new URLSearchParams(kept).toString();

  return { url: url.toString(), removed };
}
