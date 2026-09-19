/**
 * Rewriting a social media link onto the third-party host that renders a
 * working Discord embed.
 *
 * Kept outside the command handler so the suite can test it without booting
 * config (which exits the process when secrets are absent), and without a
 * Discord client.
 */

interface Fixer {
  /** Platform name, for the reply and the "nothing matched" message. */
  name: string;
  /**
   * Hosts this rule claims, matched on the registrable name so subdomains and
   * `www.` come along. Fixer hosts that have since stopped answering are
   * listed here too, so a link someone rewrote months ago gets moved onto a
   * service that still works instead of staying broken.
   */
  hosts: string[];
  /**
   * The hosts the link may be rewritten onto. One is picked per call, so a
   * platform with several interchangeable services spreads across them.
   */
  to: string[];
  /** Subdomains that carry meaning and survive the rewrite. */
  subdomains?: string[];
}

/**
 * Novelty X relinkers: fixer deployments whose only distinguishing feature is
 * the domain name, which is the joke. Requested in issue #77 from
 * https://x.com/dergonartificer/status/2101193095479996789, cunnyx added on
 * top. Each renders the same preview as the boring host it sits alongside,
 * checked against a real post.
 *
 * The post's fourth host, faggotx, was cut in review. It works; the slur in
 * the domain is the reason, so don't add it back from the post.
 */
const JOKE_RELINKERS = ["mpregx.com", "hotyurisex.com", "yaoisex.com", "cunnyx.com"];

/**
 * The services, one entry per platform. Each was checked against a real post
 * before being listed; the notes record why the obvious alternative isn't
 * here, since these go dead often enough that the next person to touch this
 * file will wonder.
 */
const FIXERS: Fixer[] = [
  {
    name: "X",
    // The novelty hosts are claimed here rather than under Twitter so a link
    // that came back from an earlier /embed is recognised and rerolled.
    hosts: ["x.com", "fixupx.com", ...JOKE_RELINKERS],
    to: ["fixupx.com", ...JOKE_RELINKERS],
  },
  {
    name: "Twitter",
    hosts: ["twitter.com", "fxtwitter.com", "vxtwitter.com", "fixvx.com"],
    // The relinkers key off the path, so a twitter.com link works on them too
    // and gets the same roll an x.com one would.
    to: ["fxtwitter.com", ...JOKE_RELINKERS],
  },
  { name: "Bluesky", hosts: ["bsky.app", "bskx.app"], to: ["bskx.app"] },
  {
    name: "Instagram",
    // ddinstagram.com answers 403 to everything now; kkinstagram is the
    // successor. instagramez.com is deliberately absent -- it resolves to an
    // ad network rather than to Instagram.
    hosts: ["instagram.com", "ddinstagram.com", "kkinstagram.com"],
    to: ["kkinstagram.com"],
  },
  {
    name: "TikTok",
    // vxtiktok.com serves a takedown notice ("no longer available due to a
    // legal request"), so the FixTikTok host is the remaining option.
    hosts: ["tiktok.com", "vxtiktok.com", "tnktok.com"],
    to: ["tnktok.com"],
    // vm./vt. are TikTok's share shorteners and the path means nothing without
    // them; tnktok serves the same subdomains.
    subdomains: ["vm", "vt"],
  },
  {
    name: "Reddit",
    // rxddit.com now embeds "Reddit blocked the request" instead of the post.
    hosts: ["reddit.com", "rxddit.com", "vxreddit.com"],
    to: ["vxreddit.com"],
  },
  { name: "Pixiv", hosts: ["pixiv.net", "phixiv.net"], to: ["phixiv.net"] },
  {
    name: "FurAffinity",
    hosts: ["furaffinity.net", "xfuraffinity.net"],
    to: ["xfuraffinity.net"],
  },
];

/** Platforms `fixEmbedUrl` knows about, in the order they are tried. */
export const SUPPORTED_PLATFORMS = FIXERS.map((fixer) => fixer.name);

export interface EmbedFix {
  /** The rewritten URL. */
  url: string;
  /** Which platform matched. */
  platform: string;
  /** The host it was rewritten onto. */
  host: string;
}

/** Thrown for input this can't rewrite. */
export class EmbedError extends Error {}

/**
 * The subdomain part of `host` when the rest of it is `base`, or null when the
 * two are unrelated. Returns "" for an exact match. Comparing against the full
 * registrable name rather than a substring keeps `x.com.example.com` from
 * being treated as x.com.
 */
function subdomainOf(host: string, base: string): string | null {
  const lower = host.toLowerCase();
  if (lower === base) return "";
  return lower.endsWith(`.${base}`) ? lower.slice(0, -(base.length + 1)) : null;
}

/**
 * Rewrites an absolute http(s) URL onto the embed fixer for its platform.
 *
 * Lenient parsing -- bare hosts, Discord's angle brackets -- and taking the
 * share tracking off is `stripUrl`'s job, and the caller runs it first. This
 * module stays free of relative imports so the suite can load it without
 * booting anything else.
 *
 * `random` is injectable so tests can pin which of a platform's hosts is used.
 */
export function fixEmbedUrl(input: string, random: () => number = Math.random): EmbedFix {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new EmbedError("That doesn't look like a URL.");
  }
  // mailto: and friends parse as a URL but have no hostname to match on, which
  // would otherwise reach the "no fixer for ``" message below.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EmbedError("Only http and https links can be rewritten.");
  }

  for (const fixer of FIXERS) {
    for (const host of fixer.hosts) {
      const subdomain = subdomainOf(url.hostname, host);
      if (subdomain === null) continue;

      const to = fixer.to[Math.floor(random() * fixer.to.length)]!;
      const keep = fixer.subdomains?.includes(subdomain) ?? false;
      url.hostname = keep ? `${subdomain}.${to}` : to;
      // A fixer that answered over http would still embed, but there is no
      // reason to hand back the downgrade.
      url.protocol = "https:";

      return { url: url.toString(), platform: fixer.name, host: to };
    }
  }

  throw new EmbedError(
    `No embed fixer for \`${url.hostname}\`. I know: ${SUPPORTED_PLATFORMS.join(", ")}.`,
  );
}
