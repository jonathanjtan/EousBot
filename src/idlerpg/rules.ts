import {
  FRAGILE_SLOTS,
  ITEM_SLOTS,
  type Alignment,
  type Item,
  type ItemSlot,
  type Player,
  type Tuning,
  type WorldEvent,
} from "./types.js";

/**
 * Every number in Idle RPG, and every pure function over them.
 *
 * Deliberately free of imports beyond its own types: the suite exercises this
 * without booting config (which exits the process when secrets are absent),
 * and the engine stays a state machine over functions that can be reasoned
 * about one at a time.
 *
 * The constants are jotun's, from irpg.pl 3.1.2. They are not arbitrary and
 * they are not independent -- rpStep in particular is the entire pacing of the
 * game, and moving it changes how long a character takes to reach level 60
 * from years to an afternoon. Tuning exists so a server can make that choice
 * knowingly; the defaults are the ones idlerpg.net has run since 2004.
 */

/** Randomness, injected so a tick can be replayed exactly in a test. */
export type Rng = () => number;

/** Perl's `int(rand($n))`: a uniform integer in [0, n). */
export function randInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}

/** True with probability 1/n -- Perl's `rand($n) < 1`, the game's idiom for a chance. */
export function oneIn(rng: Rng, n: number): boolean {
  return rng() * n < 1;
}

export function pick<T>(rng: Rng, items: readonly T[]): T | null {
  if (items.length === 0) return null;
  return items[randInt(rng, items.length)] ?? null;
}

/** In place, Fisher-Yates, so team battles draw six distinct players. */
export function shuffle<T>(rng: Rng, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randInt(rng, i + 1);
    const a = items[i] as T;
    const b = items[j] as T;
    items[i] = b;
    items[j] = a;
  }
  return items;
}

export const DEFAULT_TUNING: Tuning = {
  rpBase: 600,
  rpStep: 1.16,
  penStep: 1.14,
  penLimit: 0,
  mapX: 500,
  mapY: 500,
};

/**
 * Where the exponential curve stops and a flat wall begins.
 *
 * Past level 60 the geometric growth would put a single level beyond a human
 * lifespan, so the original switches to level-60 time plus a day per level.
 * That is the difference between an endgame and an ending.
 */
export const CURVE_CAP = 60;

/** Seconds a player must idle to reach `level` from the one below it. */
export function timeToLevel(level: number, t: Tuning = DEFAULT_TUNING): number {
  if (level > CURVE_CAP) {
    return Math.floor(t.rpBase * t.rpStep ** CURVE_CAP + 86_400 * (level - CURVE_CAP));
  }
  return Math.floor(t.rpBase * t.rpStep ** level);
}

export function emptyItems(): Record<ItemSlot, Item> {
  return Object.fromEntries(ITEM_SLOTS.map((slot) => [slot, { level: 0, unique: null }])) as Record<
    ItemSlot,
    Item
  >;
}

/**
 * The alignment multiplier applied to an item sum entering combat.
 *
 * Good fights 10% above its equipment and evil 10% below it, which is the
 * whole trade: evil gets to steal (see the evilness event) and crits far more
 * often, and pays for both here.
 */
export function alignmentCombatFactor(alignment: Alignment): number {
  return alignment === "good" ? 1.1 : alignment === "evil" ? 0.9 : 1;
}

/** One in how many wins lands a critical strike. Lower is better; evil is best. */
export function criticalFactor(alignment: Alignment): number {
  return alignment === "good" ? 50 : alignment === "evil" ? 20 : 35;
}

/**
 * A player's combat number: the sum of ten item levels, adjusted for alignment
 * when it is a battle rather than a scoreboard.
 */
export function itemSum(player: Player, forBattle = false): number {
  const raw = ITEM_SLOTS.reduce((sum, slot) => sum + (player.items[slot]?.level ?? 0), 0);
  if (!forBattle) return raw;
  return Math.floor(raw * alignmentCombatFactor(player.alignment));
}

/**
 * The bot's own combat number, when it stands in as an opponent.
 *
 * One better than the strongest player alive, so the house is always favoured
 * but never certain -- and so it scales itself out of the way as the realm
 * grows rather than becoming a wall or a joke.
 */
export function bossSum(players: readonly Player[]): number {
  return players.reduce((best, p) => Math.max(best, itemSum(p)), 0) + 1;
}

/**
 * The level of an ordinary item found on levelling.
 *
 * Walks candidate levels from 1 to 1.5x the player's level, keeping each one
 * that passes a check whose odds decay geometrically with the level. The
 * effect is a long right tail: most finds are middling, a rare one is far
 * beyond what the player has earned.
 */
export function rollItemLevel(playerLevel: number, rng: Rng): number {
  let level = 1;
  const ceiling = Math.floor(playerLevel * 1.5);
  for (let num = 1; num <= ceiling; num += 1) {
    if (rng() * 1.4 ** (num / 4) < 1) level = num;
  }
  return level;
}

/**
 * The uniques, in the order the original rolls them.
 *
 * Names are this port's own; the mechanics are not. Each entry is a separate
 * 1-in-40 roll tried in sequence and only if the earlier ones missed, so the
 * later, stronger uniques are rarer than their odds alone suggest -- reaching
 * the last one at all takes seven consecutive misses. A unique is only taken
 * if it beats both the ordinary item rolled this level *and* what the player
 * already wears, so late-game finds routinely evaporate.
 */
export interface UniqueDef {
  slot: ItemSlot;
  minLevel: number;
  /** Item level is `base + randInt(spread)`. */
  base: number;
  spread: number;
  name: string;
  /** Second person, shown to the finder alone. */
  blurb: string;
}

export const UNIQUES: readonly UniqueDef[] = [
  {
    slot: "helm",
    minLevel: 25,
    base: 50,
    spread: 25,
    name: "the Cartographer's Sealed Helm",
    blurb: "Every road you have not yet walked lies flat and named inside your skull.",
  },
  {
    slot: "ring",
    minLevel: 25,
    base: 50,
    spread: 25,
    name: "the Ring of the Unpaid Debt",
    blurb: "It tightens whenever someone nearby remembers they owe you something.",
  },
  {
    slot: "tunic",
    minLevel: 30,
    base: 75,
    spread: 25,
    name: "the Quiet Aegis",
    blurb: "Blows land, and are politely declined.",
  },
  {
    slot: "amulet",
    minLevel: 35,
    base: 100,
    spread: 25,
    name: "the Amulet of the Late Storm",
    blurb: "The weather arrives a moment before you do, and it is in a mood.",
  },
  {
    slot: "weapon",
    minLevel: 40,
    base: 150,
    spread: 25,
    name: "the Long Argument",
    blurb: "It is not the sharpest blade in the realm. It is merely the most persuasive.",
  },
  {
    slot: "weapon",
    minLevel: 45,
    base: 175,
    spread: 26,
    name: "the Blind Verdict",
    blurb: "You swing without looking. The realm rearranges itself to be hit.",
  },
  {
    slot: "boots",
    minLevel: 48,
    base: 250,
    spread: 51,
    name: "the Boots of Prior Departure",
    blurb: "You are already elsewhere. You have been for some time.",
  },
  {
    slot: "weapon",
    minLevel: 52,
    base: 300,
    spread: 51,
    name: "the Hammer of Sudden Clarity",
    blurb: "Your enemies understand everything, briefly, and then rather less.",
  },
];

export interface UniqueFind {
  def: UniqueDef;
  level: number;
}

/**
 * Rolls the unique chain for a player, or returns null if none of it hit.
 *
 * `ordinaryLevel` is the plain item already rolled this level-up: a unique
 * that cannot beat it is discarded, which is the original's way of stopping a
 * lucky low roll from handing out a legendary.
 */
export function rollUnique(
  player: Player,
  ordinaryLevel: number,
  rng: Rng,
): UniqueFind | null {
  for (const def of UNIQUES) {
    if (player.level < def.minLevel) continue;
    // A miss stops the chain rather than skipping to the next unique: that
    // sequencing is what makes the high-tier items genuinely rare.
    if (!oneIn(rng, 40)) continue;
    const level = def.base + randInt(rng, def.spread);
    const held = player.items[def.slot]?.level ?? 0;
    if (level >= ordinaryLevel && level > held) return { def, level };
    return null;
  }
  return null;
}

/**
 * A battle: both sides roll under their own item sum, high roll wins, ties go
 * to the challenger.
 *
 * Note what this is *not*: the roll is uniform over [0, sum), so a player with
 * twice the equipment wins about two thirds of the time, not always. Idle RPG
 * is a game about being present, and a combat system that let equipment decide
 * outright would make the first month unrecoverable.
 */
export interface BattleRolls {
  myRoll: number;
  oppRoll: number;
  won: boolean;
}

export function rollBattle(mySum: number, oppSum: number, rng: Rng): BattleRolls {
  const myRoll = randInt(rng, mySum);
  const oppRoll = randInt(rng, oppSum);
  return { myRoll, oppRoll, won: myRoll >= oppRoll };
}

/**
 * Seconds a challenger gains from a win, as a slice of their own clock.
 *
 * Scaled by the *opponent's* level, so beating someone far above you is worth
 * far more than farming beginners -- and floored at 7% so it is never worth
 * nothing.
 */
export function winnings(opponentLevel: number, myNext: number): number {
  const percent = Math.max(7, Math.floor(opponentLevel / 4));
  return Math.floor((percent / 100) * myNext);
}

/** The same, for a loss. A shallower divisor, so losing costs less than winning pays. */
export function losses(opponentLevel: number, myNext: number): number {
  const percent = Math.max(7, Math.floor(opponentLevel / 7));
  return Math.floor((percent / 100) * myNext);
}

/** Fighting the bot pays and costs a fixed rate; it has no level to scale from. */
export const BOSS_WIN_PERCENT = 20;
export const BOSS_LOSS_PERCENT = 10;

export function bossGain(percent: number, myNext: number): number {
  return Math.floor((percent / 100) * myNext);
}

/** A critical strike adds 5-24% of the victim's clock back onto it. */
export function criticalDamage(oppNext: number, rng: Rng): number {
  return Math.floor(((5 + randInt(rng, 20)) / 100) * oppNext);
}

/**
 * A penalty, in seconds.
 *
 * `base` is the flat cost of the act; the exponent is what makes penalties
 * frightening. At penStep 1.14 a level-50 character pays roughly 700 times
 * what a level-1 character pays for the same slip, which is the mechanism that
 * makes a long-lived character *careful*.
 */
export function penalty(base: number, level: number, t: Tuning = DEFAULT_TUNING): number {
  const raw = Math.floor(base * t.penStep ** level);
  if (t.penLimit > 0) return Math.min(raw, t.penLimit);
  return raw;
}

/**
 * Flat costs, in "seconds before scaling", straight from upstream.
 *
 * `message` is a fallback only: with the Message Content intent the charge is
 * the message's length in characters, exactly as the original bills an IRC
 * line. Without it the bot knows a message happened and nothing else, so it
 * charges this instead. See idlerpg/engine.ts.
 *
 * Note how much dearer leaving is than talking. That ordering is the game's
 * opinion about what idling means, and it is worth preserving.
 */
export const PENALTY_BASE = {
  message: 15,
  logout: 20,
  /** Charged to a quester who abandons the realm mid-quest. */
  quest: 15,
  /** Leaving the server outright. */
  part: 200,
  /** Changing your server nickname. */
  nick: 30,
} as const;

/**
 * A nickname change is capped at a tenth of whatever ceiling is in force.
 *
 * Upstream's reasoning holds here: a nick change is a slip, not a desertion,
 * and charging it like one turns an uncapped realm into a place where nobody
 * dares rename themselves.
 */
export const NICK_PENALTY_DIVISOR = 10;

/** What every other player pays when a quest is deserted: a flat fifteen minutes. */
export const QUEST_DESERTION_TOLL = 15 * 60;

/** A calamity takes a tenth off an item; a godsend adds a tenth. */
export function damagedItemLevel(level: number): number {
  return Math.floor(level * 0.9);
}

export function blessedItemLevel(level: number): number {
  return Math.floor(level * 1.1);
}

/** Both events move the clock by 5-12% when they don't touch an item. */
export function fortunePercent(rng: Rng): number {
  return 5 + randInt(rng, 8);
}

export function fragileSlot(rng: Rng): ItemSlot {
  return pick(rng, FRAGILE_SLOTS) ?? "weapon";
}

export function anySlot(rng: Rng): ItemSlot {
  return pick(rng, ITEM_SLOTS) ?? "weapon";
}

/**
 * How often the world's set pieces fire, expressed as one occurrence per this
 * many days per online player.
 *
 * Scaling by population is the reason a busy realm feels eventful and a dead
 * one goes quiet instead of pelting its last two players with miracles.
 */
export const EVENT_DAYS = {
  handOfGod: 20,
  teamBattle: 24,
  calamity: 8,
  godsend: 4,
  /** Per online *evil* player, not per player. */
  evilness: 8,
  /** Per online *good* player. */
  goodness: 12,
} as const satisfies Record<WorldEvent, number>;

/**
 * A temporary hand of God rate, and the window it applies for.
 *
 * Nineteen occurrences per online player per twenty days instead of one, for
 * the realm's first two days under this build. The point is to confirm from
 * the channel that the event fires at all, which at the normal rate takes a
 * fortnight of watching and still proves nothing.
 *
 * Meant to be taken out again. Removing it is three deletions: these two
 * constants, `hogBoostUntil` in types.ts, and the branch in `eventDays`.
 */
export const HOG_BOOST_DAYS = 20 / 19;
export const HOG_BOOST_SECONDS = 2 * 86_400;

/**
 * How long an event of this kind takes to come round, on average, at this
 * population. Seconds; Infinity when nobody it applies to is online.
 *
 * The inverse of eventFires, and the number that answers "is this thing
 * broken or is it just rare".
 */
export function expectedInterval(days: number, population: number): number {
  if (population <= 0) return Infinity;
  return (days * 86_400) / population;
}

/**
 * Whether a population-scaled event fires this tick.
 *
 * `days` occurrences per player per that many days, sampled once per tick of
 * `tickSeconds`, so the rate is independent of how often the bot ticks.
 */
export function eventFires(
  rng: Rng,
  days: number,
  population: number,
  tickSeconds: number,
): boolean {
  if (population <= 0) return false;
  return rng() * ((days * 86_400) / tickSeconds) < population;
}

/** Levels below this only get challenged one time in four, to soften the start. */
export const TIMID_BELOW_LEVEL = 25;
/** Item stealing on a won battle unlocks here. */
export const STEAL_FROM_LEVEL = 20;
/** One win in this many steals an item, if the loser's is better. */
export const STEAL_ODDS = 25;
/** A collision fight crits at a flat rate rather than an alignment-scaled one. */
export const COLLISION_CRITICAL_ODDS = 35;

/** Quests need four players at least this high who have been around a while. */
export const QUEST_MIN_LEVEL = 40;
export const QUEST_PARTY_SIZE = 4;
/** Seconds since login before a player is quest-eligible. Ten hours. */
export const QUEST_MIN_TENURE = 36_000;
/** A completed quest takes this fraction off every quester's clock. */
export const QUEST_REWARD = 0.25;
/** Seconds until the next quest after one completes. Six hours. */
export const QUEST_COOLDOWN = 21_600;
/** Seconds until the next quest after one is deserted. Twelve hours: it stings. */
export const QUEST_DESERTION_COOLDOWN = 43_200;
/** A timed quest runs 1-4 hours. */
export const QUEST_TIME_MIN = 3_600;
export const QUEST_TIME_SPREAD = 10_801;
/** Chance per second that a quester takes a step toward their waypoint. */
export const QUEST_STEP_ODDS = 100;

/** The realm's top three are announced every ten hours. */
export const TOP_LIST_INTERVAL = 36_000;
/** Every hour, if enough of the realm is high level, one of them is picked a fight. */
export const HIGH_LEVEL_CHALLENGE_INTERVAL = 3_600;
export const HIGH_LEVEL_THRESHOLD = 44;
/** Fraction of the online population above that level before the challenge fires. */
export const HIGH_LEVEL_QUORUM = 0.15;
/** A team battle needs two full teams. */
export const TEAM_SIZE = 3;
/** A team battle moves 20% of the largest clock on the winning side. */
export const TEAM_STAKE = 0.2;
/** The hand of God moves 5-75% of a clock, and is merciful four times in five. */
export const HOG_MERCY_ODDS = 5;

/** Seconds, formatted the way the original reports every duration in the game. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86_400);
  const hh = Math.floor((s % 86_400) / 3_600);
  const mm = Math.floor((s % 3_600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${days} day${days === 1 ? "" : "s"}, ${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}
