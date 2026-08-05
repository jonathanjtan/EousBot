/**
 * Which limited-time HoYoverse events run out first.
 *
 * Genshin Impact, Honkai: Star Rail, and Zenless Zone Zero all publish the
 * announcement list their in-game notice board renders, at an unauthenticated
 * endpoint the launcher hits before anyone logs in. That list is the only
 * machine-readable source of event end times HoYoverse offers -- the wikis are
 * hand-maintained and the HoYoLAB APIs want a session cookie -- so it is what
 * this reads. Each entry carries a start and an end, which is all "what
 * expires next" needs.
 *
 * Unlike the other pure modules this one does reach the network, but it still
 * imports nothing: pulling in log.ts would drag config.ts along with it, and
 * config exits the process when secrets are absent, which would take the test
 * suite with it. The command handler does the logging.
 */

/** How many events `/hoyohell` lists when no count is given. */
export const DEFAULT_COUNT = 5;

/** Discord embeds hold 25 fields; stay well inside that. */
export const MAX_COUNT = 20;

interface GameSource {
  /** Short label, prefixed to every event so mixed lists stay readable. */
  label: string;
  host: string;
  /** The API's internal game code and business ID -- `nap` is Zenless. */
  game: string;
  biz: string;
  /**
   * Server cluster. Announcement times are wall-clock on the chosen cluster,
   * so all three are pinned to Asia (UTC+8) to keep one footnote instead of
   * three.
   */
  region: string;
  /** Some notices are gated behind account level; ask as a maxed-out account. */
  level: number;
  /**
   * The feed's own words for a section that holds standing notices rather than
   * things you clear -- matched against each entry's category and tag.
   *
   * The three games label their sections differently and none of them agree:
   * Genshin files concert announcements and top-up links under "Game" while
   * keeping "Event" clean, Zenless tags every entry in Chinese even in the
   * English feed, and Star Rail drops everything into one "Notices" bucket
   * that has no such split to exploit.
   */
  notices: string[];
}

const SOURCES: GameSource[] = [
  {
    label: "Genshin",
    host: "https://sg-hk4e-api.hoyoverse.com",
    game: "hk4e",
    biz: "hk4e_global",
    region: "os_asia",
    level: 60,
    notices: ["Game"],
  },
  {
    label: "Star Rail",
    host: "https://sg-hkrpg-api.hoyoverse.com",
    game: "hkrpg",
    biz: "hkrpg_global",
    region: "prod_official_asia",
    level: 70,
    notices: [],
  },
  {
    label: "ZZZ",
    host: "https://sg-announcement-api.hoyoverse.com",
    game: "nap",
    biz: "nap_global",
    region: "prod_gf_jp",
    level: 60,
    // Regular, community and headline announcements; what's left is the event,
    // welfare, banner and Ridu Newsletter tags.
    notices: ["常规公告", "社群公告", "重要公告"],
  },
];

/**
 * `uid` is required by the endpoint but never checked -- the list served is
 * the public one either way.
 */
function announcementUrl(source: GameSource): string {
  const query = new URLSearchParams({
    game: source.game,
    game_biz: source.biz,
    lang: "en",
    bundle_id: source.biz,
    platform: "pc",
    region: source.region,
    level: String(source.level),
    uid: "1",
  });
  return `${source.host}/common/${source.biz}/announcement/api/getAnnList?${query}`;
}

/** One game's feed, as everything downstream of the URL construction sees it. */
export interface HoyoFeed {
  label: string;
  url: string;
  notices: string[];
}

export const GAMES: HoyoFeed[] = SOURCES.map((source) => ({
  label: source.label,
  url: announcementUrl(source),
  notices: source.notices,
}));

/**
 * The values `/hoyohell`'s game option takes, mapped to the feed labels. The
 * values are what Discord sends back, so they are the short names people say.
 */
export const GAME_CHOICES: Array<{ value: string; name: string; label: string }> = [
  { value: "genshin", name: "Genshin Impact", label: "Genshin" },
  { value: "hsr", name: "Honkai: Star Rail", label: "Star Rail" },
  { value: "zzz", name: "Zenless Zone Zero", label: "ZZZ" },
];

/** The feeds one game option asks for, or all three when it names none of them. */
export function feedsFor(choice: string | null): HoyoFeed[] {
  const label = GAME_CHOICES.find((game) => game.value === choice)?.label;
  return label === undefined ? GAMES : GAMES.filter((game) => game.label === label);
}

export interface HoyoEvent {
  /** The short game label, as shown to the reader. */
  game: string;
  /** Announcement ID, unique within a game. */
  id: number;
  title: string;
  startsAt: number;
  endsAt: number;
}

/** The fields an announcement has to have before it is worth reading. */
interface RawAnnouncement {
  ann_id: number;
  title?: unknown;
  subtitle?: unknown;
  /** The section it was filed under, and the badge the notice board shows. */
  type_label?: unknown;
  tag_label?: unknown;
  start_time: string;
  end_time: string;
}

function looksLikeAnnouncement(value: object): value is RawAnnouncement {
  const record = value as Record<string, unknown>;
  return (
    typeof record.ann_id === "number" &&
    typeof record.start_time === "string" &&
    typeof record.end_time === "string"
  );
}

/** Guards against a pathological payload turning the walk below into a hang. */
const MAX_DEPTH = 8;

/**
 * Every announcement anywhere in the payload.
 *
 * The three games nest the same records differently -- Genshin groups them by
 * type under `list`, Star Rail and Zenless hide half of them two levels deeper
 * inside `pic_list[].type_list[].list` -- and the shapes have moved before.
 * Walking for anything that looks like an announcement survives that, where
 * three hand-written paths would quietly return nothing the next time the
 * notice board is reorganised. The carousel images nested inside an
 * announcement have no `ann_id`, so they are passed over.
 */
function collectAnnouncements(
  node: unknown,
  depth = 0,
  into: RawAnnouncement[] = [],
): RawAnnouncement[] {
  if (depth > MAX_DEPTH || node === null || typeof node !== "object") return into;

  if (Array.isArray(node)) {
    for (const item of node) collectAnnouncements(item, depth + 1, into);
    return into;
  }

  if (looksLikeAnnouncement(node)) into.push(node);
  for (const value of Object.values(node)) collectAnnouncements(value, depth + 1, into);
  return into;
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

/** Asia cluster time, and what the payload reports when it omits its own. */
const DEFAULT_UTC_OFFSET = 8;

/**
 * One announcement timestamp as epoch milliseconds.
 *
 * The API sends wall-clock time on the game server with no offset attached and
 * states the offset once, at the top of the payload; reading these with
 * `Date.parse` would silently apply whatever timezone the bot's host happens
 * to sit in.
 */
export function parseServerTime(text: string, utcOffsetHours: number): number | null {
  const match = TIMESTAMP.exec(text.trim());
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const asUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return Number.isNaN(asUtc) ? null : asUtc - utcOffsetHours * 3_600_000;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
};

/**
 * Zenless ships its titles as HTML fragments (`<p style="...">Title</p>`)
 * while the other two send plain text, so everything is put through the same
 * strip before it reaches an embed.
 */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#\d+|[a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/\s+/g, " ")
    .trim();
}

/** Turns one game's announcement payload into events, dropping what it can't read. */
export function parseAnnouncements(feed: HoyoFeed, payload: unknown): HoyoEvent[] {
  const data = (payload as { data?: { timezone?: unknown } } | null | undefined)?.data;
  const offset = typeof data?.timezone === "number" ? data.timezone : DEFAULT_UTC_OFFSET;

  const byId = new Map<number, HoyoEvent>();
  for (const raw of collectAnnouncements(payload)) {
    const filed = [raw.type_label, raw.tag_label].filter((v) => typeof v === "string");
    if (filed.some((label) => feed.notices.includes(label))) continue;

    const startsAt = parseServerTime(raw.start_time, offset);
    const endsAt = parseServerTime(raw.end_time, offset);
    if (startsAt === null || endsAt === null) continue;

    const title =
      cleanTitle(typeof raw.title === "string" ? raw.title : "") ||
      cleanTitle(typeof raw.subtitle === "string" ? raw.subtitle : "");
    if (!title) continue;

    // An announcement can appear in both the notice list and the picture
    // carousel, and the carousel copy often has an empty title; keep whichever
    // copy actually names it.
    const seen = byId.get(raw.ann_id);
    if (seen && seen.title.length >= title.length) continue;
    byId.set(raw.ann_id, { game: feed.label, id: raw.ann_id, title, startsAt, endsAt });
  }

  return [...byId.values()];
}

/**
 * How long a run can be before it stops being an event.
 *
 * Fair-use statements, social media links and standing surveys are posted with
 * end dates years out, and sorting by expiry would otherwise put them in the
 * list the moment a version lull left nothing else running.
 */
const EVERGREEN_MS = 120 * 24 * 3_600_000;

/**
 * Notices with nothing to claim, for the entries the section labels can't rule
 * out -- Star Rail files patch notes, soundtrack releases and real events
 * together under one heading. Kept to words that never appear on something
 * with a reward attached.
 */
const HOUSEKEEPING = [
  /known issues/i,
  /optimization/i,
  /maintenance/i,
  /fair (use|gaming)/i,
  /social media/i,
  /\bfaq\b/i,
  /privacy|terms of service/i,
  /\bost\b|trailer|livestream|concert|symphony/i,
];

/** The events running right now, soonest to expire first. */
export function expiringSoonest(events: HoyoEvent[], now: number, limit: number): HoyoEvent[] {
  return events
    .filter((event) => event.startsAt <= now && event.endsAt > now)
    .filter((event) => event.endsAt - event.startsAt <= EVERGREEN_MS)
    .filter((event) => !HOUSEKEEPING.some((pattern) => pattern.test(event.title)))
    .sort((a, b) => a.endsAt - b.endsAt || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/** Embed field names cap at 256 characters, and event titles run long. */
const MAX_NAME = 200;

/**
 * One field per event. Expiries go out as Discord relative timestamps so each
 * reader sees the countdown against their own clock rather than the server's.
 */
export function eventFields(events: HoyoEvent[]): Array<{ name: string; value: string }> {
  return events.map((event) => {
    const name = `${event.game} · ${event.title}`;
    const seconds = Math.floor(event.endsAt / 1000);
    return {
      name: name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name,
      value: `Ends <t:${seconds}:R> — <t:${seconds}:f>`,
    };
  });
}

/** Red once something is down to its last day, amber inside three. */
export function urgencyColour(events: HoyoEvent[], now: number): number {
  const soonest = Math.min(...events.map((event) => event.endsAt - now));
  if (!Number.isFinite(soonest)) return 0x2f9e44;
  if (soonest <= 24 * 3_600_000) return 0xd7263d;
  if (soonest <= 72 * 3_600_000) return 0xe0a458;
  return 0x2f9e44;
}

export interface EventFetch {
  events: HoyoEvent[];
  /** Feeds that could not be read, with the reason, for the caller to log. */
  failures: Array<{ game: string; error: string }>;
}

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Reads the given notice boards, all three by default.
 *
 * One game being unreachable must not cost the other two their answer, so the
 * failures come back alongside the events rather than as a thrown error.
 */
export async function fetchEvents(
  feeds: HoyoFeed[] = GAMES,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<EventFetch> {
  const results = await Promise.allSettled(
    feeds.map(async (game) => {
      const response = await fetch(game.url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const body = (await response.json()) as { retcode?: unknown; message?: unknown };
      // The endpoint answers 200 with a non-zero retcode when it dislikes the
      // query, so the status alone doesn't say the payload is usable.
      if (typeof body.retcode === "number" && body.retcode !== 0) {
        throw new Error(`retcode ${body.retcode}: ${String(body.message ?? "")}`.trim());
      }

      return parseAnnouncements(game, body);
    }),
  );

  const events: HoyoEvent[] = [];
  const failures: EventFetch["failures"] = [];
  results.forEach((result, index) => {
    const game = feeds[index]?.label ?? "unknown";
    if (result.status === "fulfilled") events.push(...result.value);
    else failures.push({ game, error: String(result.reason) });
  });

  return { events, failures };
}
