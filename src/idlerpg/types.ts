/**
 * The shape of an Idle RPG world.
 *
 * A faithful port of the mechanics in jotun's irpg.pl 3.1.2 (idlerpg.net) --
 * the level curve, the ten item slots, alignment, quests, the 500x500 map and
 * its collision fights. What could not be ported is the *input*: IRC gives a
 * bot presence, parts, quits, kicks and nick changes for free, and Discord
 * gives none of those without privileged intents this bot deliberately does
 * not hold. See idlerpg/rules.ts for how idling is defined here instead.
 *
 * Types only, so the suite can reach every rule without booting config.
 */

/**
 * The ten equipment slots. Their sum is the only combat statistic in the game:
 * there is no attack, defence or hit points, just a number you roll under.
 */
export const ITEM_SLOTS = [
  "ring",
  "amulet",
  "charm",
  "weapon",
  "helm",
  "tunic",
  "gloves",
  "leggings",
  "shield",
  "boots",
] as const;

export type ItemSlot = (typeof ITEM_SLOTS)[number];

/** Slots a calamity can damage and a godsend can bless. Not all ten. */
export const FRAGILE_SLOTS: readonly ItemSlot[] = [
  "amulet",
  "charm",
  "weapon",
  "tunic",
  "leggings",
  "shield",
];

/** How a slot reads in prose. Three of them are plural in English. */
export const SLOT_NAMES: Record<ItemSlot, string> = {
  ring: "ring",
  amulet: "amulet",
  charm: "charm",
  weapon: "weapon",
  helm: "helm",
  tunic: "tunic",
  gloves: "pair of gloves",
  leggings: "set of leggings",
  shield: "shield",
  boots: "pair of boots",
};

export interface Item {
  level: number;
  /**
   * Name of the unique this slot holds, or null for an ordinary find.
   *
   * The original tracked uniqueness with a letter suffix on the level in a
   * flat text database ("175e"), which meant every read had to int() the
   * field. A field of its own costs nothing in JSON and removes that trap.
   */
  unique: string | null;
}

export type Alignment = "good" | "neutral" | "evil";

/**
 * Where a player's lost time went.
 *
 * Kept as a ledger rather than a single total because the original reports it
 * broken down, and because it is the only record of *why* a clock is long --
 * a player who has been penalised into the ground deserves to see which of
 * their own habits did it.
 */
export type PenaltyKind = "message" | "logout" | "quest" | "part" | "nick";

export type Penalties = Record<PenaltyKind, number>;

export interface Player {
  /**
   * Discord user id. Replaces the original's nick-plus-password login: the
   * account *is* the credential, so there is nothing to hash, nothing to
   * reset, and no way to lose a character to a nick collision.
   */
  userId: string;
  /** Character name. Distinct from the Discord name, which can change freely. */
  name: string;
  charClass: string;
  level: number;
  /**
   * Seconds remaining to the next level -- "the clock", the only currency in
   * the game. Everything that happens to a player is expressed as time added
   * to or removed from this number.
   */
  next: number;
  /** Whether the clock is currently running. */
  online: boolean;
  /**
   * Whether the player has deliberately stepped out with `/old-idlerpg logout`.
   *
   * Separate from `online` because the two answer different questions once
   * presence drives idling: `online` is "is Discord showing them connected",
   * which flaps every time a phone sleeps, and `suspended` is "have they asked
   * to be left alone", which only they can set and only they can clear. Without
   * the distinction, a logout would be silently undone by the next presence
   * event and the penalty paid for nothing.
   */
  suspended: boolean;
  alignment: Alignment;
  items: Record<ItemSlot, Item>;
  /** Position on the map. Wraps at the edges. */
  x: number;
  y: number;
  /** Total seconds spent idle, ever. Never decreases. */
  idled: number;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms of the most recent login, which quest eligibility is measured from. */
  lastLogin: number;
  penalties: Penalties;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * The realm's one quest, if any.
 *
 * Type 1 is a timed quest: four players are chosen and simply have to still be
 * playing when the clock runs out. Type 2 sends them walking to two map
 * waypoints in turn. Both pay 25% off every quester's clock; both are ruined
 * outright if any quester logs out, which is what makes them tense.
 */
export type QuestState =
  | { kind: "idle"; nextAt: number }
  | { kind: "time"; questers: string[]; text: string; endsAt: number }
  | {
      kind: "map";
      questers: string[];
      text: string;
      stage: 1 | 2;
      p1: Point;
      p2: Point;
    };

/**
 * The world events the tick rolls for, in the order it rolls them.
 *
 * Named as a list rather than left implicit in EVENT_DAYS so the tally below
 * has a key type and so a new event cannot be added without deciding what its
 * record looks like.
 */
export const WORLD_EVENTS = [
  "handOfGod",
  "teamBattle",
  "calamity",
  "godsend",
  "evilness",
  "goodness",
] as const;

export type WorldEvent = (typeof WORLD_EVENTS)[number];

/** How often one world event has actually happened. `lastAt` is epoch seconds. */
export interface EventRecord {
  count: number;
  lastAt: number;
}

export interface GameState {
  /** Keyed by Discord user id. */
  players: Record<string, Player>;
  quest: QuestState;
  /**
   * Seconds of game time since the world began, used only to drive the
   * periodic schedules (the top-players roll call, the high-level challenge).
   * Advances with the tick, so pausing genuinely pauses them.
   */
  elapsed: number;
  /** Epoch seconds of the last processed tick. */
  lastTick: number;
  paused: boolean;
  /**
   * What the world has actually done, per event kind.
   *
   * Kept because the events are rare by design -- the hand of God is one per
   * online player per twenty days -- and a rare event and a broken one look
   * identical from the channel. This is the difference between them.
   */
  events: Record<WorldEvent, EventRecord>;
}

/**
 * Something the engine wants said.
 *
 * The engine never touches Discord; it returns these and lets idlerpg/watch.ts
 * deliver them. That is what makes a tick testable -- and it is also why the
 * rules module can produce a line about one player without knowing where it
 * goes.
 *
 * Every one of these goes to the game channel. There is no private kind: see
 * gamechannel.ts for why the realm never DMs anybody.
 */
export interface Announcement {
  text: string;
  /**
   * Whose news this is, for a line about a single player.
   *
   * Carried for throttling alone. The text names the player itself, and the
   * deliverer never turns this into a mention.
   */
  userId?: string;
  /**
   * Marks a line as one of a repeating kind, so the deliverer can post it once
   * and then stay quiet for a while.
   *
   * The two penalties a player can incur over and over need this: on IRC a
   * NOTICE per offence is free, but a channel line per message would make the
   * bot the loudest thing in the room and the penalty louder than the offence.
   */
  throttleKey?: string;
}

/**
 * The knobs a server may turn.
 *
 * Separated from the rest of the rules so that idlerpg/rules.ts stays pure and
 * the suite can run the whole game at canonical settings while a guild runs it
 * at whatever pace it can stand. `rpStep` is the dangerous one: it is the base
 * of an exponential, so 1.16 and 1.20 are not a small difference in the same
 * game, they are different games.
 */
export interface Tuning {
  /** Seconds to level 1. The unit the whole curve is expressed in. */
  rpBase: number;
  /** Growth per level, applied as rpBase * rpStep ** level. */
  rpStep: number;
  /** Growth of penalties per level. Penalties are meant to outpace progress. */
  penStep: number;
  /** Cap on a single penalty in seconds, or 0 for no cap. */
  penLimit: number;
  mapX: number;
  mapY: number;
}
