/**
 * A dispatch-and-claim RPG for Discord.
 *
 * The companion to src/idlerpg/, and a deliberate opposite. That game is
 * jotun's 2004 IRC design, where the only input is your continued silence; it
 * is preserved faithfully under `/irc-idlerpg`. This one exists because that
 * design does not survive contact with Discord: measured over sixty simulated
 * days, twelve always-online players land within three levels of each other
 * and the game's single decision -- alignment -- is worth 0.4 levels. Presence
 * was a costly signal on IRC. On Discord it is free, so a game built on it has
 * no variance a player can influence.
 *
 * The loop here is the genre's answer, the one the modern Discord RPGs settled
 * on: choose something with a duration and a risk, walk away, come back to a
 * result. Decisions are spaced rather than absent, which is what "idle" has
 * actually meant since Cookie Clicker.
 *
 * Types only, so every rule can be tested without booting config.
 */

export type ClassId = "warrior" | "mage" | "thief" | "ranger" | "ritualist" | "raider";

export type Rarity = "common" | "uncommon" | "rare" | "magic" | "legendary";

export const RARITIES: readonly Rarity[] = [
  "common",
  "uncommon",
  "rare",
  "magic",
  "legendary",
];

export type ItemKind = "weapon" | "armor";

export interface Item {
  /** Stable within a character's inventory; used to equip and sell by number. */
  id: number;
  name: string;
  kind: ItemKind;
  /** Damage for a weapon, protection for armor. The only stat an item has. */
  value: number;
  rarity: Rarity;
}

/**
 * An adventure in flight.
 *
 * Stored as an end time rather than a countdown so that it survives restarts
 * without the bot having to tick it. A character on an adventure is committed:
 * the decision was made when it started, and the only thing left is to come
 * back for the result.
 */
export interface Expedition {
  difficulty: number;
  startedAt: number;
  endsAt: number;
}

export interface Character {
  userId: string;
  name: string;
  classId: ClassId;
  /**
   * How far the class has evolved, 0-indexed. Rises at fixed levels and is the
   * slow half of progression -- gear is what changes week to week, class is
   * what changes month to month.
   */
  tier: number;
  level: number;
  xp: number;
  money: number;
  /** Equipped items. Everything else lives in the backpack. */
  weapon: Item | null;
  armor: Item | null;
  backpack: Item[];
  /** Unopened crates, by rarity. */
  crates: Record<Rarity, number>;
  expedition: Expedition | null;
  /** Next id to hand out for an item this character receives. */
  nextItemId: number;
  createdAt: number;
  stats: {
    won: number;
    lost: number;
    duelsWon: number;
    duelsLost: number;
  };
}

export interface GameState {
  characters: Record<string, Character>;
}

/** Something the engine wants said. Delivery is not its problem. */
export interface Announcement {
  to: "channel" | "private";
  userId?: string;
  text: string;
}

/** The tuning a server may reasonably touch. */
export interface Tuning {
  /**
   * Real minutes per unit of adventure difficulty.
   *
   * The genre default is roughly half an hour for the shortest run, which is
   * the right shape: long enough that you leave, short enough that you come
   * back the same evening.
   */
  minutesPerDifficulty: number;
  /** Highest difficulty the game offers. */
  maxDifficulty: number;
  /** Base coin per difficulty step on a win. */
  moneyPerDifficulty: number;
  /** Base experience per difficulty step on a win. */
  xpPerDifficulty: number;
  /** Coin every character starts with. */
  startingMoney: number;
  /** How many items a backpack holds before it must be sold down. */
  backpackSize: number;
}
