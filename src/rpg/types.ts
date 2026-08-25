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

/**
 * Race is the second, smaller half of who you are.
 *
 * Deliberately weaker than class: two choices at creation only work if one of
 * them is clearly the big one, or a new player is made to agonise over a
 * decision they have no information to make.
 */
export type RaceId = "human" | "elf" | "dwarf" | "orc" | "revenant";

export type GodId = "harvest" | "forge" | "tide" | "ledger" | "quiet" | "wheel";

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
  race: RaceId;
  /** Whom you follow, if anyone. Switching costs coin. */
  god: GodId | null;
  /** Sacrificed value, accumulated. Buys luck, which buys better odds. */
  favor: number;
  /** Guild id, or null. */
  guildId: string | null;
  /** Spouse's user id, or null. */
  spouse: string | null;
  /** Accumulated affection, which pays a joint bonus. */
  loveScore: number;
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

/** A player-listed item, waiting for a buyer. */
export interface Listing {
  id: number;
  sellerId: string;
  item: Item;
  price: number;
  listedAt: number;
}

export interface Guild {
  id: string;
  name: string;
  leaderId: string;
  /** Members who may invite and kick. The leader is always one. */
  officerIds: string[];
  memberIds: string[];
  bank: number;
  /** Coin spent upgrading, which raises the member cap and the bank ceiling. */
  level: number;
  /** The guild leading the alliance this guild belongs to, or null. */
  allianceOf: string | null;
  createdAt: number;
}

/** A boss everyone hits together. One at a time, realm-wide. */
export interface Raid {
  bossName: string;
  hp: number;
  maxHp: number;
  /** Damage dealt per participant, which decides the payout split. */
  damage: Record<string, number>;
  /** When the boss escapes if it has not been killed. */
  endsAt: number;
  /** Coin seeded into the reward pool. */
  pot: number;
  startedAt: number;
}

export interface TournamentEntry {
  userId: string;
  eliminated: boolean;
}

export interface Tournament {
  hostId: string;
  buyIn: number;
  entries: TournamentEntry[];
  /** Open until this moment, then it runs. */
  closesAt: number;
  /** Round-by-round transcript, kept so the result can be shown. */
  log: string[];
  finished: boolean;
  winnerId: string | null;
}

/**
 * A realm-wide modifier with an expiry.
 *
 * Applied where rewards are handed out rather than inside the reward formulas,
 * so rules.ts stays pure and a balance test never has to know that events
 * exist. See engine.claimExpedition.
 */
export interface WorldEvent {
  kind: "bounty" | "study" | "fortune";
  name: string;
  blurb: string;
  /** Multiplier applied to whatever the event affects. */
  multiplier: number;
  endsAt: number;
}

/** A free-for-all elimination match. Distinct from the bracket in tournament. */
export interface Arena {
  hostId: string;
  buyIn: number;
  entrantIds: string[];
  closesAt: number;
  log: string[];
  finished: boolean;
  winnerId: string | null;
}

/** A chess game in progress between two players. */
export interface ChessGame {
  id: number;
  whiteId: string;
  blackId: string;
  /** The whole position, so nothing else has to be persisted. */
  fen: string;
  /** Coin each side staked, paid to the winner. Zero for a friendly. */
  stake: number;
  startedAt: number;
  lastMoveAt: number;
}

export type WerewolfRole = "wolf" | "seer" | "guard" | "villager";

export interface WerewolfPlayer {
  userId: string;
  role: WerewolfRole;
  alive: boolean;
}

/**
 * A game of werewolf.
 *
 * Phases advance on a command rather than a timer. A timed phase means the game
 * ends at 3am for whoever was asleep, and a Discord server is not a table
 * everyone is sitting at.
 */
export interface Werewolf {
  hostId: string;
  players: WerewolfPlayer[];
  phase: "lobby" | "night" | "day" | "over";
  night: number;
  /** Wolf user id -> the victim they named. Majority decides. */
  wolfVotes: Record<string, string>;
  guardTarget: string | null;
  seerTarget: string | null;
  /** Voter -> accused, during the day. */
  votes: Record<string, string>;
  log: string[];
  winner: "village" | "wolves" | null;
}

export interface GameState {
  characters: Record<string, Character>;
  guilds: Record<string, Guild>;
  market: Listing[];
  nextListingId: number;
  raid: Raid | null;
  tournament: Tournament | null;
  arena: Arena | null;
  event: WorldEvent | null;
  chess: ChessGame[];
  nextChessId: number;
  werewolf: Werewolf | null;
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
