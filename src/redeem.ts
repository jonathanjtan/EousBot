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
 * That same published list is the whole of `/codes`, which reads it per game
 * and hands back every live code as the link that redeems it, so nobody has to
 * find a code before they can use one.
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

/** The games one option value asks for, or all three when it names none. */
export function gamesFor(value: string | null): RedeemGame[] {
  const chosen = gameFor(value);
  return chosen === null ? GAMES : [chosen];
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

/** One live code, with whatever the list says it pays out. */
export interface ActiveCode {
  code: string;
  /** The published reward text, or null where the entry gives none. */
  rewards: string | null;
}

/**
 * The codes a list payload names, upper-cased to compare against.
 *
 * Entries carry a status, and anything other than `OK` is a code the list is
 * still holding but nobody can redeem, so those come out here rather than in
 * each caller.
 */
export function parseCodeEntries(payload: unknown): ActiveCode[] {
  const codes = (payload as { codes?: unknown } | null | undefined)?.codes;
  if (!Array.isArray(codes)) return [];

  const found: ActiveCode[] = [];
  for (const entry of codes) {
    const { code, status, rewards } = (entry ?? {}) as {
      code?: unknown;
      status?: unknown;
      rewards?: unknown;
    };
    if (typeof code !== "string" || !code.trim()) continue;
    if (typeof status === "string" && status !== "OK") continue;

    found.push({
      code: code.trim().toUpperCase(),
      rewards: typeof rewards === "string" && rewards.trim() ? rewards.trim() : null,
    });
  }
  return found;
}

/** Just the codes, for the places that only compare them. */
export function parseCodeList(payload: unknown): string[] {
  return parseCodeEntries(payload).map((entry) => entry.code);
}

/**
 * Reads one game's published list. Injectable everywhere it's used so the tests
 * need no network.
 */
export type CodeFetcher = (game: RedeemGame) => Promise<ActiveCode[]>;

export const fetchActiveCodes: CodeFetcher = async (game) => {
  const response = await fetch(`${CODE_LIST}?${new URLSearchParams({ game: game.key })}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  return parseCodeEntries(await response.json());
};

/** The same read, reduced to the codes `identifyGame` matches on. */
export type CodeLister = (game: RedeemGame) => Promise<string[]>;

const activeCodes: CodeLister = async (game) =>
  (await fetchActiveCodes(game)).map((entry) => entry.code);

/** One game's list, or the reason it couldn't be read. */
export interface GameCodes {
  game: RedeemGame;
  codes: ActiveCode[];
  error: string | null;
}

/**
 * Every named game's active codes, gathered at once.
 *
 * One list being unreadable must not cost the others theirs, so a game that
 * fails comes back with its reason attached and the rest still answer.
 */
export async function activeCodesFor(
  games: RedeemGame[],
  fetcher: CodeFetcher = fetchActiveCodes,
): Promise<GameCodes[]> {
  const results = await Promise.allSettled(games.map((game) => fetcher(game)));

  return results.map((result, index) => {
    const game = games[index]!;
    return result.status === "fulfilled"
      ? { game, codes: result.value, error: null }
      : { game, codes: [], error: String(result.reason) };
  });
}

/**
 * The published reward text as a line worth reading. It arrives either as
 * `Primogem*30;Mora*10000` or as a sentence somebody wrote by hand, so the
 * separators are tidied where they exist and the prose is left alone.
 */
export function tidyRewards(rewards: string, limit = 90): string {
  const tidied = rewards
    .split(";")
    .map((part) => part.trim().replace(/\s*\*\s*/, " x"))
    .filter((part) => part !== "")
    .join(", ");

  return tidied.length <= limit ? tidied : `${tidied.slice(0, limit - 1).trimEnd()}…`;
}

/** One code as a link that redeems it, with what it pays beside it. */
export function codeLine(game: RedeemGame, entry: ActiveCode): string {
  const link = `[\`${entry.code}\`](${redeemUrl(game, entry.code)})`;
  return entry.rewards === null ? link : `${link} · ${tidyRewards(entry.rewards)}`;
}

/**
 * A game's codes as lines fitting `limit` characters.
 *
 * Star Rail runs ten codes at a slow month and the reward text is the long part
 * of each line, so the tail is dropped with a count of what it held rather than
 * the whole lot being refused for length.
 */
export function codeLines(game: RedeemGame, codes: ActiveCode[], limit: number): string {
  const lines: string[] = [];
  let length = 0;

  for (const [index, entry] of codes.entries()) {
    const rendered = codeLine(game, entry);
    const remaining = codes.length - index;
    const note = `…and ${remaining} more`;
    // Room for this line, and for the note as well while codes are still to
    // come after it. Every line taken reserves that room, so the note that
    // replaces the tail always has somewhere to go.
    const needed = rendered.length + 1 + (remaining > 1 ? note.length + 1 : 0);
    if (length + needed > limit) {
      lines.push(note);
      break;
    }
    lines.push(rendered);
    length += rendered.length + 1;
  }

  return lines.join("\n");
}

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
