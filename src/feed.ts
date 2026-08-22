/**
 * Relaying public drop feeds into Discord.
 *
 * This exists because the direct approach doesn't work: Target's live stock API
 * answers a bare HTTP client with a CAPTCHA challenge, from any network, and
 * defeating that is out of scope. See targetapi.ts.
 *
 * What works instead is other people. Communities like r/pkmntcgdeals post
 * "Target drop has started!" minutes before it shows up anywhere else, and they
 * know the cadence -- the recurring midnight-PST window is common knowledge
 * there and unavailable from any endpoint. Reading a public RSS feed is also a
 * thing feeds are *for*, which the alternative was not.
 *
 * Pure: no network, no config, no runtime sibling imports, so the suite can
 * exercise the parsing and matching directly. feedwatch.ts owns the timers.
 */

export interface FeedSource {
  name: string;
  url: string;
}

export interface FeedEntry {
  /** Stable identity for dedupe: Atom <id>, RSS <guid>, else the link. */
  id: string;
  title: string;
  link: string;
  published?: string;
  /** Body text, used for matching and for pulling product links out of. */
  content: string;
}

export interface FeedWatch {
  /** Case-insensitive substring matched against title and body. */
  keyword: string;
  subscribers: string[];
  channelId: string;
  addedBy: string;
  addedAt: string;
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

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(?:amp|quot|#39|apos|lt|gt|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .trim();
}

function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m?.[1] === undefined ? undefined : decode(m[1]);
}

/**
 * Parses Atom and RSS with the same code path.
 *
 * Deliberately regex rather than an XML dependency: the bot compiles itself on a
 * VM during deploy, and the two shapes below are the whole surface. Anything
 * malformed yields fewer entries rather than throwing -- a feed that breaks
 * should cost one poll, not the process.
 */
export function parseFeed(xml: string): FeedEntry[] {
  const atom = xml.split(/<entry(?:\s[^>]*)?>/i).slice(1);
  const rss = xml.split(/<item(?:\s[^>]*)?>/i).slice(1);
  const isAtom = atom.length > 0;
  const blocks = isAtom ? atom : rss;

  const entries: FeedEntry[] = [];
  for (const raw of blocks) {
    const block = raw.split(isAtom ? /<\/entry>/i : /<\/item>/i)[0] ?? "";

    const title = tag(block, "title") ?? "";
    // Atom puts the URL in an attribute; RSS puts it in the element body.
    const link = block.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? tag(block, "link") ?? "";
    const id = tag(block, "id") ?? tag(block, "guid") ?? link;
    const content = tag(block, "content") ?? tag(block, "description") ?? tag(block, "summary") ?? "";
    const published = tag(block, "published") ?? tag(block, "updated") ?? tag(block, "pubDate");

    if (!id || !title) continue;
    entries.push({ id, title, link, content, published });
  }
  return entries;
}

export function matches(entry: FeedEntry, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return false;
  return `${entry.title}\n${entry.content}`.toLowerCase().includes(needle);
}

/** Product links found in an entry, so the ping can go straight to the item. */
export function extractTargetLinks(entry: FeedEntry): string[] {
  const found = `${entry.content} ${entry.link}`.match(/https?:\/\/(?:www\.)?target\.com\/p\/[^\s"'<>&\\]+/gi);
  return [...new Set(found ?? [])];
}

/**
 * Entries not yet alerted on.
 *
 * Dedupe is by feed-assigned id and survives a restart, because the bot
 * redeploys itself: without it, every deploy during a drop would replay the
 * last 25 posts into the channel.
 */
export function unseen(entries: FeedEntry[], seen: readonly string[]): FeedEntry[] {
  const known = new Set(seen);
  return entries.filter((e) => !known.has(e.id));
}

/** Newest-first, capped, so the dedupe list can't grow without bound. */
export function rememberSeen(
  seen: readonly string[],
  entries: FeedEntry[],
  cap = 500,
): string[] {
  return [...entries.map((e) => e.id), ...seen].slice(0, cap);
}

function mention(ids: string[]): string {
  return ids.map((id) => `<@${id}>`).join(" ");
}

export function formatDrop(watch: FeedWatch, entry: FeedEntry, source: FeedSource): string {
  const links = extractTargetLinks(entry);
  return [
    `${mention(watch.subscribers)} **${entry.title}**`,
    `_${source.name} · matched "${watch.keyword}"_`,
    ...links.map((l) => l),
    entry.link,
    "",
    "_Community post, not a stock check — verify before you sprint._",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface PollSettings {
  baseMs: number;
  jitterMs: number;
  backoffStartMs: number;
  backoffMaxMs: number;
  maxConsecutiveBlocks: number;
}

/**
 * How long to wait before the next poll, doubling on every block.
 *
 * Reddit rate-limits unauthenticated readers hard and fast -- two requests in a
 * row was enough to earn a 429 while testing this -- so the base interval is
 * minutes rather than seconds and a block widens it aggressively. There is
 * nothing to be gained by polling faster: the humans writing these posts are
 * the latency floor, not the feed.
 *
 * `random` is injectable so the suite can assert the bounds.
 */
export function nextDelayMs(
  consecutiveBlocks: number,
  poll: PollSettings,
  random: () => number = Math.random,
): number {
  if (consecutiveBlocks <= 0) return poll.baseMs + random() * poll.jitterMs;
  const backoff = poll.backoffStartMs * 2 ** (consecutiveBlocks - 1);
  return Math.min(backoff, poll.backoffMaxMs) + random() * poll.jitterMs;
}

export function shouldPause(consecutiveBlocks: number, poll: PollSettings): boolean {
  return consecutiveBlocks >= poll.maxConsecutiveBlocks;
}
