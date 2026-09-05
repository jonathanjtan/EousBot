/**
 * Redemption links for HoYoverse gift codes, and working out which game a code
 * is for when nobody says.
 *
 * All three games redeem the same way on the web: a page that takes the code as
 * `?code=` and fills the box in, so the reader only has to log in and press the
 * button. The paths differ per game, which is the entire reason a code needs a
 * game attached to it.
 *
 * A code carries no marking of its own. Most are twelve random alphanumerics
 * and the three games draw from the same alphabet, so there is nothing in
 * `2BJ64QRZ7RT8` to read. What can be done is look it up: hoyo-codes.seria.moe
 * publishes the currently active codes per game, gathered from the streams and
 * socials people find them on in the first place, and a code that appears in
 * one of those lists names its game outright. That list is unofficial and lags
 * a livestream by minutes, so behind it sits the one signal a code does carry
 * on occasion -- the ones that spell a game out, `GENSHINGIFT` and
 * `ZENLESSGIFT` and the like. When both come up empty the command hands over
 * all three links instead of guessing, which costs the reader a click and never
 * sends them to the wrong game.
 *
 * Imports nothing, like the other data modules: pulling in log.ts would drag
 * config.ts along with it, and config exits the process when secrets are
 * absent, which would take the test suite with it. The command handler does the
 * logging.
 */

export interface RedeemGame {
  /** What the game option sends back; the short name people say. */
  value: string;
  /** The full name, as shown to the reader. */
  name: string;
  /** The redemption page, which takes the code as `?code=`. */
  page: string;
  /** The game's key in the published code list -- `nap` is Zenless. */
  key: string;
  /** What a code spells when it names its own game, which is seldom. */
  spells: RegExp;
}

/**
 * The three games, in the order the option lists them. The values match the
 * ones `/hoyohell` uses so the same three words mean the same three games
 * wherever they are typed.
 */
export const GAMES: RedeemGame[] = [
  {
    value: "genshin",
    name: "Genshin Impact",
    page: "https://genshin.hoyoverse.com/en/gift",
    key: "genshin",
    spells: /GENSHIN/,
  },
  {
    value: "hsr",
    name: "Honkai: Star Rail",
    page: "https://hsr.hoyoverse.com/gift",
    key: "hkrpg",
    spells: /HSR|STARRAIL|HONKAI/,
  },
  {
    value: "zzz",
    name: "Zenless Zone Zero",
    page: "https://zenless.hoyoverse.com/redemption",
    key: "nap",
    spells: /ZZZ|ZENLESS/,
  },
];

/** The game an option value names, or null where it names none of them. */
export function gameFor(value: string | null): RedeemGame | null {
  return GAMES.find((game) => game.value === value) ?? null;
}

/**
 * A pasted code as the redemption page wants it, or null if it isn't one.
 *
 * Codes are upper-case letters and digits, nothing else. People paste them
 * wrapped in backticks or with a space caught on the end, so those come off
 * before the check; what fails it after that is a typo or a URL, and both
 * deserve the same answer without a round trip.
 */
export function normaliseCode(raw: string): string | null {
  const code = raw.replace(/[\s`"']/g, "").toUpperCase();
  return /^[A-Z0-9]{4,30}$/.test(code) ? code : null;
}

/** The redemption link for one game, with the code already in the box. */
export function redeemUrl(game: RedeemGame, code: string): string {
  return `${game.page}?${new URLSearchParams({ code })}`;
}

/** The published list of active codes; `game` picks which game's. */
const CODE_LIST = "https://hoyo-codes.seria.moe/codes";

/**
 * Short, because this is a lookup with a fallback rather than the answer
 * itself: three games are worth waiting five seconds for, not thirty.
 */
const LOOKUP_TIMEOUT_MS = 5_000;

/** The codes a list payload names, upper-cased to compare against. */
export function parseCodeList(payload: unknown): string[] {
  const codes = (payload as { codes?: unknown } | null | undefined)?.codes;
  if (!Array.isArray(codes)) return [];

  const found: string[] = [];
  for (const entry of codes) {
    const code = (entry as { code?: unknown } | null | undefined)?.code;
    if (typeof code === "string" && code.trim()) found.push(code.trim().toUpperCase());
  }
  return found;
}

/** Reads the published list; injectable so the tests need no network. */
export type CodeLister = (game: RedeemGame) => Promise<string[]>;

const activeCodes: CodeLister = async (game) => {
  const response = await fetch(`${CODE_LIST}?${new URLSearchParams({ game: game.key })}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  return parseCodeList(await response.json());
};

/** How a code's game was settled, or that it wasn't. */
export type Verdict = "listed" | "spells" | "unknown";

export interface Identification {
  game: RedeemGame | null;
  verdict: Verdict;
  /** Lists that could not be read, with the reason, for the caller to log. */
  failures: Array<{ game: string; error: string }>;
}

/**
 * Which game a code is for: by the published lists first, by what the code
 * spells second, and neither where the code is too fresh to be listed and too
 * random to say anything.
 *
 * One list being unreadable must not cost the other two their answer, so the
 * failures come back alongside the verdict rather than as a thrown error.
 */
export async function identifyGame(
  code: string,
  list: CodeLister = activeCodes,
): Promise<Identification> {
  const results = await Promise.allSettled(GAMES.map((game) => list(game)));

  const failures: Identification["failures"] = [];
  const listed: RedeemGame[] = [];
  results.forEach((result, index) => {
    const game = GAMES[index]!;
    if (result.status === "rejected") failures.push({ game: game.name, error: String(result.reason) });
    else if (result.value.includes(code)) listed.push(game);
  });

  // Two games listing the same code means the lists are wrong rather than that
  // the code is good for both, and picking between them is worse than handing
  // over all three links.
  if (listed.length === 1) return { game: listed[0]!, verdict: "listed", failures };

  const spelled = GAMES.find((game) => game.spells.test(code));
  if (spelled) return { game: spelled, verdict: "spells", failures };

  return { game: null, verdict: "unknown", failures };
}
