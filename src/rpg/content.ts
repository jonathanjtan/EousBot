import type { ClassId, ItemKind, Rarity } from "./types.js";

/**
 * Everything the game is made of that isn't arithmetic: classes, their
 * ladders, and the words items are named from.
 *
 * Kept apart from rules.ts for the same reason idlerpg/flavor.ts is kept apart
 * from idlerpg/rules.ts -- a server should be able to rewrite the vocabulary
 * without touching a formula, and a formula should never depend on a noun.
 */

/**
 * What a class does, and how much of it.
 *
 * Every class grants exactly one bonus that grows with tier. One bonus each is
 * a deliberate constraint: six classes with three overlapping perks apiece is
 * a spreadsheet, and nobody picks a class by reading a spreadsheet. This way
 * the choice is legible in one line.
 */
export type ClassPerk =
  /** Flat protection, added to armor. */
  | "defense"
  /** Flat damage, added to the weapon. */
  | "damage"
  /** Percentage chance to lift extra coin after a won adventure. */
  | "steal"
  /** Percentage bonus to experience earned. */
  | "study"
  /** Percentage bonus to coin earned. */
  | "greed"
  /** Percentage improvement to the odds of an adventure succeeding. */
  | "luck";

export interface ClassDef {
  id: ClassId;
  perk: ClassPerk;
  /** Blurb shown when choosing. One line, says what the perk actually does. */
  summary: string;
  /**
   * Names by tier, weakest first. The ladder is flavour; the strength comes
   * from `perkValue`, which is uniform across classes so no class is a trap.
   */
  tiers: readonly string[];
}

/** Levels at which a class advances a tier. Index into this gives the tier. */
export const TIER_LEVELS: readonly number[] = [5, 12, 20, 30];

export const CLASSES: Record<ClassId, ClassDef> = {
  warrior: {
    id: "warrior",
    perk: "defense",
    summary: "Takes the hit. Adds protection on top of whatever armour you wear.",
    tiers: ["Footpad", "Shieldbearer", "Bulwark", "Wall of the March", "Immovable"],
  },
  mage: {
    id: "mage",
    perk: "damage",
    summary: "Ends things early. Adds damage on top of whatever weapon you carry.",
    tiers: ["Hedge-reader", "Adept", "Stormwright", "Archmage", "First Cause"],
  },
  thief: {
    id: "thief",
    perk: "steal",
    summary: "Leaves richer than they arrived. Chance to lift extra coin after a win.",
    tiers: ["Cutpurse", "Housebreaker", "Ghost", "Master of Keys", "Unaccounted For"],
  },
  ranger: {
    id: "ranger",
    perk: "luck",
    summary: "Knows the country. Improves the odds of an adventure going well.",
    tiers: ["Tracker", "Pathfinder", "Warden", "Trailmaster", "Compass"],
  },
  ritualist: {
    id: "ritualist",
    perk: "study",
    summary: "Learns faster than the rest. Bonus experience from everything.",
    tiers: ["Acolyte", "Keeper", "Celebrant", "Hierophant", "Oracle"],
  },
  raider: {
    id: "raider",
    perk: "greed",
    summary: "Takes the good stuff first. Bonus coin from everything.",
    tiers: ["Freebooter", "Reaver", "Captain", "Warlord", "Tide"],
  },
};

export const CLASS_IDS = Object.keys(CLASSES) as ClassId[];

/**
 * How strong a perk is at each tier.
 *
 * Flat perks (damage, defense) read as points; percentage perks read as
 * percent. Sharing one table across both keeps the classes balanced against
 * each other by construction rather than by repeated tuning.
 */
export const PERK_BY_TIER: readonly number[] = [4, 9, 16, 25, 36];

/** How rare each rarity is, as relative weights. */
export const RARITY_WEIGHT: Record<Rarity, number> = {
  common: 100,
  uncommon: 45,
  rare: 18,
  magic: 6,
  legendary: 1,
};

/** What a rarity multiplies an item's value by. */
export const RARITY_MULTIPLIER: Record<Rarity, number> = {
  common: 1,
  uncommon: 1.35,
  rare: 1.8,
  magic: 2.5,
  legendary: 3.6,
};

/** Discord embed colours, so rarity reads at a glance. */
export const RARITY_COLOUR: Record<Rarity, number> = {
  common: 0x9aa4b2,
  uncommon: 0x4caf50,
  rare: 0x2f81f7,
  magic: 0xa970ff,
  legendary: 0xf5a623,
};

/** Prefixes by rarity. A legendary should read as one before you check. */
export const RARITY_PREFIX: Record<Rarity, readonly string[]> = {
  common: ["Chipped", "Serviceable", "Plain", "Secondhand", "Borrowed"],
  uncommon: ["Keen", "Reinforced", "Oiled", "Balanced", "Hardened"],
  rare: ["Runed", "Storm-touched", "Cold-forged", "Singing", "Moonlit"],
  magic: ["Unmaking", "Starbound", "Whisper-clad", "Doomsaid", "Everburning"],
  legendary: ["Worldending", "First", "Last", "Unnamed", "Sky-sundering"],
};

export const WEAPON_NOUNS: readonly string[] = [
  "Sword",
  "Axe",
  "Spear",
  "Hammer",
  "Dagger",
  "Bow",
  "Glaive",
  "Mace",
  "Scythe",
  "Cudgel",
  "Sabre",
  "Pike",
];

export const ARMOR_NOUNS: readonly string[] = [
  "Plate",
  "Mail",
  "Cuirass",
  "Brigandine",
  "Hauberk",
  "Coat",
  "Harness",
  "Scale",
  "Aegis",
  "Vestments",
];

export function nounsFor(kind: ItemKind): readonly string[] {
  return kind === "weapon" ? WEAPON_NOUNS : ARMOR_NOUNS;
}

/**
 * What an adventure is called, by difficulty band.
 *
 * Indexed by tenths of the difficulty range, so the names escalate with what
 * the player is actually signing up for.
 */
export const EXPEDITION_NAMES: readonly (readonly string[])[] = [
  ["clear rats from a granary", "walk a merchant to the next village", "find a lost goat"],
  ["clear a bandit camp", "survey a collapsed mine", "settle a dispute about a well"],
  ["break a siege that nobody is winning", "map the drowned quarter", "escort a tax collector"],
  ["put down something in the reservoir", "retrieve a body from the pass", "burn a plague ship"],
  ["hold a bridge against a column", "descend into the second vault", "answer what is under the hill"],
  ["kill the thing wearing the duke's face", "walk into the storm and come back", "close the door at the bottom"],
];

/** Won-adventure lines. Completes "Your party ...". */
export const WIN_LINES: readonly string[] = [
  "came back muddy, intact, and slightly richer",
  "did it properly, which surprised everyone including them",
  "returned early and refused to say why",
  "solved it with a rope, a lie, and considerable nerve",
  "won on the second attempt and is reporting the first",
  "made it look easy, which it was not",
];

/** Lost-adventure lines. Completes "Your party ...". */
export const LOSS_LINES: readonly string[] = [
  "came back with nothing but a strong opinion about the map",
  "got as far as the door and thought better of it",
  "was outnumbered, outmanoeuvred, and out by nightfall",
  "lost the payment, the cart, and most of their dignity",
  "returned in the wrong order and without the important one",
  "found out why the last party did not come back",
];
