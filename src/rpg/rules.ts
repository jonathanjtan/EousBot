import {
  ARMOR_NOUNS,
  CLASSES,
  PERK_BY_TIER,
  RARITY_MULTIPLIER,
  RARITY_PREFIX,
  RARITY_WEIGHT,
  TIER_LEVELS,
  WEAPON_NOUNS,
  type ClassPerk,
} from "./content.js";
import {
  RARITIES,
  type Character,
  type ClassId,
  type Item,
  type ItemKind,
  type Rarity,
  type Tuning,
} from "./types.js";

/**
 * Every number in the game, and every pure function over them.
 *
 * Free of config and of discord.js, so the suite can play thousands of
 * adventures without a gateway -- and so the balance can be *measured* rather
 * than argued about. See test/rpg/balance.test.ts, which asserts on win rates
 * and progression speed rather than on individual formulas, because those are
 * the things a player actually feels.
 */

export type Rng = () => number;

export function randInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}

/** Uniform in [min, max]. */
export function between(rng: Rng, min: number, max: number): number {
  return min + randInt(rng, Math.max(1, max - min + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[randInt(rng, items.length)] as T;
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export const DEFAULT_TUNING: Tuning = {
  minutesPerDifficulty: 30,
  maxDifficulty: 30,
  moneyPerDifficulty: 40,
  // Experience per difficulty step, and the knob that sets absolute pace.
  // At 30 an optimising player needed ninety hours of *continuous* play to
  // reach level 10, which for a server where people check in twice a day is
  // several weeks to the first interesting decision. The shape of the curve was
  // right; only the scale was wrong.
  xpPerDifficulty: 75,
  startingMoney: 100,
  backpackSize: 40,
};

/**
 * How far above their level a character may reach.
 *
 * Not zero, because a character whose only legal adventure is the one matching
 * their level has no decision to make -- and the decision is the entire point
 * of the loop. Three options is enough to feel like a choice and few enough to
 * read at a glance.
 */
export const REACH = 2;

export function maxDifficultyFor(character: Character, t: Tuning = DEFAULT_TUNING): number {
  return clamp(character.level + REACH, 1, t.maxDifficulty);
}

// ------------------------------------------------------------------ class ---

/** Which tier a level entitles a character to. */
export function tierFor(level: number): number {
  let tier = 0;
  for (const threshold of TIER_LEVELS) {
    if (level >= threshold) tier += 1;
  }
  return tier;
}

export function perkStrength(character: Character): number {
  return PERK_BY_TIER[clamp(character.tier, 0, PERK_BY_TIER.length - 1)] ?? 0;
}

function perkOf(classId: ClassId): ClassPerk {
  return CLASSES[classId].perk;
}

/** The perk's value if the character has that perk, else zero. */
export function perkValue(character: Character, perk: ClassPerk): number {
  return perkOf(character.classId) === perk ? perkStrength(character) : 0;
}

export function className(character: Character): string {
  const def = CLASSES[character.classId];
  return def.tiers[clamp(character.tier, 0, def.tiers.length - 1)] ?? def.tiers[0] ?? "Wanderer";
}

// -------------------------------------------------------------- statistics ---

export function attack(character: Character): number {
  return (character.weapon?.value ?? 0) + perkValue(character, "damage");
}

export function defense(character: Character): number {
  return (character.armor?.value ?? 0) + perkValue(character, "defense");
}

/** The single number an adventure is graded against. */
export function power(character: Character): number {
  return attack(character) + defense(character);
}

// ----------------------------------------------------------------- levels ---

/**
 * Experience needed to leave `level`.
 *
 * Gentle exponent on purpose. The IRC game's curve is geometric and measured in
 * years, which works when the input is time you were spending anyway; here the
 * input is attention, and an attention curve that doubles every level stops
 * being a game and starts being a second job.
 */
export function xpToLevel(level: number): number {
  return Math.floor(100 * level ** 1.35);
}

export interface LevelResult {
  level: number;
  xp: number;
  gained: number;
}

/** Applies experience, rolling over as many levels as it covers. */
export function applyXp(level: number, xp: number, earned: number): LevelResult {
  let nextLevel = level;
  let pool = xp + Math.max(0, earned);
  while (pool >= xpToLevel(nextLevel)) {
    pool -= xpToLevel(nextLevel);
    nextLevel += 1;
  }
  return { level: nextLevel, xp: pool, gained: nextLevel - level };
}

// ------------------------------------------------------------- expedition ---

/** How long a difficulty takes, in milliseconds. */
export function expeditionDuration(difficulty: number, t: Tuning = DEFAULT_TUNING): number {
  return difficulty * t.minutesPerDifficulty * 60_000;
}

/**
 * The odds an adventure succeeds.
 *
 * Three inputs, in descending order of how much they matter: what you are
 * carrying, how far above your level you reached, and your class. Gear
 * dominates deliberately -- it is the thing that changes week to week, and a
 * loop where the decision is "which risk" needs the answer to move as you play.
 *
 * Floored and capped away from certainty at both ends, because an adventure
 * that cannot fail is a withdrawal, not a decision.
 */
export function successChance(
  character: Character,
  difficulty: number,
  t: Tuning = DEFAULT_TUNING,
): number {
  const demand = difficulty * 8;
  const ratio = power(character) / (power(character) + demand);
  const reachPenalty = clamp((character.level - difficulty) * 0.015, -0.25, 0.25);
  const luck = perkValue(character, "luck") / 400;
  void t;
  return clamp(0.25 + 0.65 * ratio + reachPenalty + luck, 0.05, 0.95);
}

/**
 * How much harder work pays.
 *
 * This exponent is the single most important number in the game and it was
 * wrong at first, in a way worth recording. Time scales linearly with
 * difficulty, so a reward that also scales linearly leaves reward-per-hour
 * flat -- and once it is flat, the falling odds settle the question and the
 * safest adventure is optimal forever. The balance suite caught it: the
 * "choose well" policy was picking difficulty 1, identical to grinding.
 *
 * Above 1 (super-linear), reward-per-hour rises as `difficulty ** (EXPONENT-1)`
 * and reaching upward starts to pay for its risk. It must not rise so fast that
 * the ceiling is always correct either, or the choice collapses in the other
 * direction; what stops that is the reach penalty in successChance, which makes
 * the best difficulty an interior one that moves as your gear improves. That
 * movement is the decision this game is built around.
 */
export const REWARD_EXPONENT = 1.6;

export function moneyReward(
  character: Character,
  difficulty: number,
  t: Tuning = DEFAULT_TUNING,
): number {
  const base = t.moneyPerDifficulty * difficulty ** REWARD_EXPONENT;
  return Math.floor(base * (1 + perkValue(character, "greed") / 100));
}

export function xpReward(
  character: Character,
  difficulty: number,
  t: Tuning = DEFAULT_TUNING,
): number {
  const base = t.xpPerDifficulty * difficulty ** REWARD_EXPONENT;
  return Math.floor(base * (1 + perkValue(character, "study") / 100));
}

/** A thief's cut, taken on top of a win. Zero for everyone else. */
export function stolenCoin(character: Character, purse: number, rng: Rng): number {
  const chance = perkValue(character, "steal") / 100;
  if (chance <= 0 || rng() > chance) return 0;
  return Math.floor(purse * (0.25 + rng() * 0.5));
}

/** Odds a won adventure also yields a crate. */
export function crateChance(difficulty: number): number {
  return clamp(0.12 + difficulty * 0.012, 0, 0.6);
}

// ------------------------------------------------------------------ items ---

/**
 * Rolls a rarity, with higher difficulty tilting the table upward.
 *
 * Weighted rather than thresholded so a legendary is always *possible* from a
 * beginner's crate. A drop table with hard gates tells low-level players their
 * luck cannot matter, which is the opposite of why people open crates.
 */
export function rollRarity(rng: Rng, tilt = 0): Rarity {
  const weights = RARITIES.map(
    (rarity, index) => RARITY_WEIGHT[rarity] * (1 + (index * tilt) / 10),
  );
  const total = weights.reduce((sum, w) => sum + w, 0);
  let roll = rng() * total;
  for (let i = 0; i < RARITIES.length; i += 1) {
    roll -= weights[i] as number;
    if (roll <= 0) return RARITIES[i] as Rarity;
  }
  return "common";
}

/**
 * An item's raw power before rarity.
 *
 * Anchored on the level of whoever receives it, so a drop is always roughly
 * relevant -- the alternative is a table indexed by difficulty, which floods
 * high-level players with junk they cannot be bothered to sell.
 */
export function baseItemValue(level: number, difficulty: number): number {
  return 4 + level * 1.6 + difficulty * 0.7;
}

export function rollItem(
  rng: Rng,
  options: { id: number; level: number; difficulty: number; rarity?: Rarity; kind?: ItemKind },
): Item {
  const rarity = options.rarity ?? rollRarity(rng, options.difficulty / 6);
  const kind: ItemKind = options.kind ?? (rng() < 0.5 ? "weapon" : "armor");
  const spread = 0.85 + rng() * 0.3;
  const value = Math.max(
    1,
    Math.round(baseItemValue(options.level, options.difficulty) * RARITY_MULTIPLIER[rarity] * spread),
  );
  const noun = pick(rng, kind === "weapon" ? WEAPON_NOUNS : ARMOR_NOUNS);
  const prefix = pick(rng, RARITY_PREFIX[rarity]);
  return { id: options.id, name: `${prefix} ${noun}`, kind, value, rarity };
}

/** What a shop pays. Deliberately less than the item is worth to keep. */
export function sellValue(item: Item): number {
  return Math.max(1, Math.floor(item.value * 3 * RARITY_MULTIPLIER[item.rarity]));
}

// ------------------------------------------------------------------ duels ---

/**
 * A duel roll: power, scattered widely.
 *
 * The spread is generous (50%-150%) so that a better-equipped duellist is
 * favoured without being a foregone conclusion. Two friends of similar level
 * should both fancy their chances, or nobody accepts a second duel.
 */
export function duelRoll(character: Character, rng: Rng): number {
  return power(character) * (0.5 + rng());
}

export const MIN_STAKE = 10;

// ---------------------------------------------------------------- helpers ---

export function emptyCrates(): Record<Rarity, number> {
  return { common: 0, uncommon: 0, rare: 0, magic: 0, legendary: 0 };
}

/** A readable coin figure. Money gets large and unpunctuated digits stop scanning. */
export function coin(amount: number): string {
  return `${amount.toLocaleString("en-US")}⨎`;
}

export function shortDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}
