import { find } from "./engine.js";
import { clamp, coin, pick, power, randInt, shuffle, type Rng } from "./rules.js";
import type { Ctx } from "./engine.js";
import { EVENT_DURATION_MS, activeEvent, eventMultiplier } from "./worldevent.js";
import type { Arena, Character, GameState, WorldEvent } from "./types.js";

/**
 * Free-for-all matches, realm-wide events, and trivia.
 *
 * The arena is deliberately not the tournament. A bracket rewards the strongest
 * character and everyone can work out who that is before it starts; this is a
 * lottery that gear only nudges, so the two answer different appetites and a
 * realm can run both.
 */

export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const no = <T>(reason: string): Outcome<T> => ({ ok: false, reason });

const NO_CHARACTER = "You have no character yet. `/idlerpg start` makes one.";

// ------------------------------------------------------------------ arena ---

export const ARENA_WINDOW_MS = 30 * 60_000;
export const ARENA_MIN_ENTRANTS = 3;

/** How somebody goes out. Completes "<name> ...". */
const DEMISES: readonly string[] = [
  "backed into the one part of the arena that was still on fire",
  "was talked to death by a herald nobody had invited",
  "tried the door marked EXIT and learned it was decorative",
  "lost an argument with the floor",
  "was voted out by the other competitors, which is not in the rules",
  "stopped to loot at precisely the wrong moment",
  "went looking for the edge of the map and found it",
  "was removed by something the organisers deny arranging",
  "made a heroic last stand two rounds too early",
  "misjudged a jump that a sensible person would not have attempted",
];

/** Flavour for the survivor. */
const VICTORIES: readonly string[] = [
  "walked out with the purse and somebody else's hat",
  "won by outlasting rather than outfighting, which counts",
  "is the last one standing and would like everyone to know it",
  "took the pot and declined to explain the last ten minutes",
];

export function openArena(
  state: GameState,
  hostId: string,
  buyIn: number,
  ctx: Ctx,
): Outcome<Arena> {
  const host = find(state, hostId);
  if (!host) return no(NO_CHARACTER);
  if (state.arena && !state.arena.finished && ctx.now < state.arena.closesAt) {
    return no("A match is already taking entries.");
  }
  if (!Number.isInteger(buyIn) || buyIn < 0) return no("Buy-in must be a whole number.");
  if (host.money < buyIn) return no(`You cannot cover the buy-in. You have ${coin(host.money)}.`);

  host.money -= buyIn;
  const arena: Arena = {
    hostId,
    buyIn,
    entrantIds: [hostId],
    closesAt: ctx.now + ARENA_WINDOW_MS,
    log: [],
    finished: false,
    winnerId: null,
  };
  state.arena = arena;
  return ok(arena);
}

export function enterArena(state: GameState, userId: string, ctx: Ctx): Outcome<Arena> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);

  const arena = state.arena;
  if (!arena || arena.finished) return no("No match is taking entries.");
  if (ctx.now >= arena.closesAt) return no("Entry closed. Run it with `/idlerpg arena run`.");
  if (arena.entrantIds.includes(userId)) return no("You are already in.");
  if (character.money < arena.buyIn) {
    return no(`The buy-in is ${coin(arena.buyIn)}. You have ${coin(character.money)}.`);
  }

  character.money -= arena.buyIn;
  arena.entrantIds.push(userId);
  return ok(arena);
}

export interface ArenaResult {
  arena: Arena;
  winner: Character | null;
  pot: number;
}

/**
 * Runs the match to a single survivor.
 *
 * Each round eliminates roughly a third of the field, weighted by power but
 * only weakly: the weighting is `power / (power + median)`, floored and capped
 * well away from certainty, so the best-equipped entrant is favoured and never
 * safe. A free-for-all that the strongest player always wins is a bracket with
 * extra steps.
 */
export function runArena(state: GameState, ctx: Ctx): Outcome<ArenaResult> {
  const arena = state.arena;
  if (!arena) return no("No match to run.");
  if (arena.finished) return no("That match has already been decided.");

  if (arena.entrantIds.length < ARENA_MIN_ENTRANTS) {
    for (const id of arena.entrantIds) {
      const c = find(state, id);
      if (c) c.money += arena.buyIn;
    }
    state.arena = null;
    return no(`A match needs ${ARENA_MIN_ENTRANTS} entrants. Everyone has been refunded.`);
  }

  const pot = arena.buyIn * arena.entrantIds.length;
  let field = shuffle(
    ctx.rng,
    arena.entrantIds.map((id) => find(state, id)).filter((c): c is Character => c !== null),
  );

  const powers = field.map(power).sort((a, b) => a - b);
  const median = powers[Math.floor(powers.length / 2)] ?? 1;

  let round = 1;
  while (field.length > 1) {
    // At least one goes out per round, or a match could stall forever.
    const doomed = Math.max(1, Math.floor(field.length / 3));
    const scored = field.map((c) => ({
      character: c,
      // Survival odds, weighted but deliberately compressed.
      roll: clamp(power(c) / (power(c) + median), 0.25, 0.75) + ctx.rng(),
    }));
    scored.sort((a, b) => a.roll - b.roll);

    const out = scored.slice(0, Math.min(doomed, field.length - 1)).map((s) => s.character);
    field = field.filter((c) => !out.includes(c));
    arena.log.push(
      `__Round ${round}__\n` +
        out.map((c) => `**${c.name}** ${pick(ctx.rng, DEMISES)}.`).join("\n"),
    );
    round += 1;
  }

  const winner = field[0] ?? null;
  if (winner) {
    winner.money += pot;
    arena.log.push(`**${winner.name}** ${pick(ctx.rng, VICTORIES)}.`);
  }
  arena.finished = true;
  arena.winnerId = winner?.userId ?? null;
  return ok({ arena, winner, pot });
}

// ----------------------------------------------------------- world events ---

/** The three things a realm-wide event can multiply. */
const EVENTS: readonly Omit<WorldEvent, "endsAt">[] = [
  {
    kind: "bounty",
    name: "A Season of Bounty",
    blurb: "Somebody upstream has released the treasury. Coin from adventures is doubled.",
    multiplier: 2,
  },
  {
    kind: "study",
    name: "The Long Lesson",
    blurb: "Every mistake is instructive this week. Experience from adventures is doubled.",
    multiplier: 2,
  },
  {
    kind: "fortune",
    name: "A Run of Luck",
    blurb: "The dice are in an unusual mood. Crates fall half again as often.",
    multiplier: 1.5,
  },
];

export function startEvent(state: GameState, ctx: Ctx, kind?: WorldEvent["kind"]): WorldEvent {
  const chosen = kind
    ? (EVENTS.find((e) => e.kind === kind) ?? (EVENTS[0] as Omit<WorldEvent, "endsAt">))
    : pick(ctx.rng, EVENTS);
  const event: WorldEvent = { ...chosen, endsAt: ctx.now + EVENT_DURATION_MS };
  state.event = event;
  return event;
}

// ----------------------------------------------------------------- trivia ---

export interface TriviaQuestion {
  prompt: string;
  options: readonly string[];
  /** Index into `options`. */
  answer: number;
}

/**
 * A small general-knowledge bank.
 *
 * Written for this bot rather than pulled from an API: a trivia feature that
 * depends on a third-party service is a feature that breaks silently the day
 * that service moves, and this one is meant to be a diversion, not an
 * integration.
 */
export const TRIVIA: readonly TriviaQuestion[] = [
  {
    prompt: "Which planet has the shortest day in the Solar System?",
    options: ["Mercury", "Jupiter", "Mars", "Neptune"],
    answer: 1,
  },
  {
    prompt: "What does a cooper make?",
    options: ["Shoes", "Barrels", "Rope", "Candles"],
    answer: 1,
  },
  {
    prompt: "Which of these is not a prime number?",
    options: ["51", "53", "59", "61"],
    answer: 0,
  },
  {
    prompt: "In computing, what does 'idempotent' describe?",
    options: [
      "An operation safe to repeat",
      "An operation that cannot fail",
      "An operation with no output",
      "An operation that runs in constant time",
    ],
    answer: 0,
  },
  {
    prompt: "Which sea is the saltiest of these?",
    options: ["Baltic Sea", "Red Sea", "North Sea", "Black Sea"],
    answer: 1,
  },
  {
    prompt: "How many strings does a standard violin have?",
    options: ["Four", "Five", "Six", "Seven"],
    answer: 0,
  },
  {
    prompt: "What is the largest organ of the human body?",
    options: ["The liver", "The skin", "The lungs", "The intestine"],
    answer: 1,
  },
  {
    prompt: "Which gas makes up most of Earth's atmosphere?",
    options: ["Oxygen", "Carbon dioxide", "Nitrogen", "Argon"],
    answer: 2,
  },
  {
    prompt: "A group of crows is collectively known as what?",
    options: ["A murder", "A parliament", "A gaggle", "A shoal"],
    answer: 0,
  },
  {
    prompt: "What does the 'S' in HTTPS stand for?",
    options: ["Standard", "Secure", "Static", "Session"],
    answer: 1,
  },
  {
    prompt: "Which of these is a real unit of measurement?",
    options: ["Furlong", "Fathom", "Hogshead", "All of these"],
    answer: 3,
  },
  {
    prompt: "What is the smallest country in the world by area?",
    options: ["Monaco", "Nauru", "Vatican City", "San Marino"],
    answer: 2,
  },
];

/** Coin a correct answer pays. Small: trivia is a diversion, not an income. */
export const TRIVIA_PRIZE = 250;

export function askTrivia(ctx: Ctx): { question: TriviaQuestion; index: number } {
  const index = randInt(ctx.rng, TRIVIA.length);
  return { question: TRIVIA[index] as TriviaQuestion, index };
}

export function answerTrivia(
  state: GameState,
  userId: string,
  questionIndex: number,
  chosen: number,
): Outcome<{ correct: boolean; answer: string; prize: number }> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);

  const question = TRIVIA[questionIndex];
  if (!question) return no("That question is gone.");

  const correct = chosen === question.answer;
  if (correct) character.money += TRIVIA_PRIZE;
  return ok({
    correct,
    answer: question.options[question.answer] as string,
    prize: correct ? TRIVIA_PRIZE : 0,
  });
}

// Re-exported so callers have one import for anything event-shaped.
export { EVENT_DURATION_MS, activeEvent, eventMultiplier };

// ------------------------------------------------------------------ maths ---

export interface MathProblem {
  prompt: string;
  options: readonly string[];
  answer: number;
  /** 1-5. Decides both the arithmetic and the payout. */
  difficulty: number;
}

/** Coin a correct sum pays, by difficulty. Harder sums are worth more. */
export function mathPrize(difficulty: number): number {
  return 100 * difficulty;
}

/**
 * Generates an arithmetic problem rather than drawing one from a bank.
 *
 * Trivia needs a bank because general knowledge cannot be synthesised;
 * arithmetic can, so this never repeats and never needs curating. The
 * distractors are the interesting part -- they are near-misses built from the
 * mistakes people actually make (off-by-one, sign flips, digit transposition),
 * because four random numbers make the right answer obvious at a glance.
 */
export function makeMathProblem(rng: Rng, difficulty: number): MathProblem {
  const d = clamp(Math.floor(difficulty), 1, 5);
  const scale = 10 ** d;

  let prompt: string;
  let value: number;

  const kind = randInt(rng, d >= 3 ? 4 : 3);
  if (kind === 0) {
    const a = 1 + randInt(rng, scale);
    const b = 1 + randInt(rng, scale);
    prompt = `${a} + ${b}`;
    value = a + b;
  } else if (kind === 1) {
    // Built from the answer outwards, for the same reason division is: picking
    // two operands independently lets them collide, and "5 − 5 = ?" is both a
    // silly question and a zero answer, which breaks the promise that every
    // option on the buttons is a positive integer.
    const answer = 1 + randInt(rng, scale);
    const b = 1 + randInt(rng, scale);
    prompt = `${answer + b} − ${b}`;
    value = answer;
  } else if (kind === 2) {
    const a = 2 + randInt(rng, 4 * d);
    const b = 2 + randInt(rng, 4 * d);
    prompt = `${a} × ${b}`;
    value = a * b;
  } else {
    // Built from the answer outwards so it always divides exactly.
    const b = 2 + randInt(rng, 4 * d);
    const answer = 2 + randInt(rng, 6 * d);
    prompt = `${b * answer} ÷ ${b}`;
    value = answer;
  }

  const wrong = new Set<number>();
  const jitter = Math.max(1, Math.floor(Math.abs(value) * 0.1));
  let guard = 0;
  while (wrong.size < 3 && guard < 50) {
    guard += 1;
    const slip = [
      value + 1,
      value - 1,
      value + jitter + randInt(rng, jitter + 1),
      value - jitter - randInt(rng, jitter + 1),
      Number(String(value).split("").reverse().join("")),
    ][randInt(rng, 5)] as number;
    if (Number.isFinite(slip) && slip !== value && slip > 0) wrong.add(slip);
  }
  // Backfill if the near-misses collided, so there are always four choices.
  let filler = value + 2;
  while (wrong.size < 3) {
    if (filler !== value && filler > 0) wrong.add(filler);
    filler += 1;
  }

  const options = shuffle(rng, [value, ...wrong].map(String));
  return {
    prompt: `${prompt} = ?`,
    options,
    answer: options.indexOf(String(value)),
    difficulty: d,
  };
}

// -------------------------------------------------------- seasonal events ---

/**
 * Seasonal events are world events wearing a costume.
 *
 * The original ships four near-identical cogs -- one per holiday -- each
 * granting a themed currency during a window. The mechanic underneath all of
 * them is "a limited-time event with a special reward track", which the event
 * system already does, so these are definitions rather than modules. A server
 * can run one whenever it likes instead of waiting for October.
 */
export const SEASONS: readonly Omit<WorldEvent, "endsAt">[] = [
  {
    kind: "fortune",
    name: "The Turning of the Year",
    blurb: "Something is abroad and it is feeling generous. Crates fall twice as often.",
    multiplier: 2,
  },
  {
    kind: "bounty",
    name: "Harvest Home",
    blurb: "The stores are full and somebody is counting wrong in your favour. Double coin.",
    multiplier: 2,
  },
  {
    kind: "study",
    name: "The Long Dark",
    blurb: "Nothing to do but read. Triple experience while it lasts.",
    multiplier: 3,
  },
  {
    kind: "bounty",
    name: "A Week of Small Kindnesses",
    blurb: "Everyone is being unusually decent about payment. Coin and a half.",
    multiplier: 1.5,
  },
];

export function startSeason(state: GameState, ctx: Ctx, index?: number): WorldEvent {
  const chosen =
    index !== undefined && SEASONS[index]
      ? (SEASONS[index] as Omit<WorldEvent, "endsAt">)
      : pick(ctx.rng, SEASONS);
  // Seasons run four times as long as an ordinary event -- they are meant to
  // be a week the server remembers, not a two-hour window somebody missed.
  const event: WorldEvent = { ...chosen, endsAt: ctx.now + EVENT_DURATION_MS * 4 };
  state.event = event;
  return event;
}
