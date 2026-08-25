import { CLASSES, EXPEDITION_NAMES, LOSS_LINES, WIN_LINES } from "./content.js";
import {
  DEFAULT_TUNING,
  applyXp,
  attack,
  between,
  className,
  clamp,
  coin,
  crateChance,
  defense,
  duelRoll,
  emptyCrates,
  expeditionDuration,
  maxDifficultyFor,
  moneyReward,
  pick,
  power,
  rollItem,
  rollRarity,
  sellValue,
  shortDuration,
  stolenCoin,
  successChance,
  tierFor,
  xpReward,
  type Rng,
} from "./rules.js";
import type {
  Announcement,
  Character,
  ClassId,
  RaceId,
  GameState,
  Item,
  Rarity,
  Tuning,
} from "./types.js";

/**
 * The verbs: make a character, send it somewhere, bring it home, spend what it
 * found.
 *
 * Mutates the state it is handed and returns what it wants said. Knows nothing
 * about Discord, which is what lets the balance suite play ten thousand
 * adventures in a second.
 */

export interface Ctx {
  rng: Rng;
  /** Epoch ms. */
  now: number;
  tuning: Tuning;
}

export function newGame(): GameState {
  return {
    characters: {},
    guilds: {},
    market: [],
    nextListingId: 1,
    raid: null,
    tournament: null,
  };
}

export function newCharacter(
  userId: string,
  name: string,
  classId: ClassId,
  ctx: Ctx,
  raceId: RaceId = "human",
): Character {
  const character: Character = {
    userId,
    name,
    classId,
    race: raceId,
    god: null,
    favor: 0,
    guildId: null,
    spouse: null,
    loveScore: 0,
    tier: 0,
    level: 1,
    xp: 0,
    money: ctx.tuning.startingMoney,
    weapon: null,
    armor: null,
    backpack: [],
    crates: emptyCrates(),
    expedition: null,
    nextItemId: 1,
    createdAt: ctx.now,
    stats: { won: 0, lost: 0, duelsWon: 0, duelsLost: 0 },
  };

  // Starting kit, equipped. A character with nothing has roughly a coin-flip
  // on the easiest adventure, which is a miserable first ten minutes and the
  // most common reason people bounce off a game like this.
  character.weapon = take(character, {
    id: 0,
    name: "Chipped Sword",
    kind: "weapon",
    value: 5,
    rarity: "common",
  });
  character.armor = take(character, {
    id: 0,
    name: "Plain Coat",
    kind: "armor",
    value: 5,
    rarity: "common",
  });
  return character;
}

/** Stamps an item with this character's next id. */
function take(character: Character, item: Item): Item {
  const owned = { ...item, id: character.nextItemId };
  character.nextItemId += 1;
  return owned;
}

function say(text: string): Announcement {
  return { to: "channel", text };
}

export function find(state: GameState, userId: string): Character | null {
  return state.characters[userId] ?? null;
}

export function findByName(state: GameState, name: string): Character | null {
  const wanted = name.trim().toLowerCase();
  return Object.values(state.characters).find((c) => c.name.toLowerCase() === wanted) ?? null;
}

// ------------------------------------------------------------ progression ---

/**
 * Brings the class tier up to what the level entitles it to.
 *
 * Applied on every level gain rather than claimed by a command: a perk the
 * player has earned but not noticed is a perk that does nothing, and "go run
 * /evolve" is a chore, not a decision.
 */
function syncTier(character: Character): string | null {
  const earned = tierFor(character.level);
  if (earned <= character.tier) return null;
  character.tier = earned;
  return className(character);
}

// ------------------------------------------------------------- expedition ---

export type StartResult =
  | { ok: true; character: Character; difficulty: number; endsAt: number; name: string }
  | { ok: false; reason: string };

/** The flavour name for a difficulty, drawn from its band. */
export function expeditionName(difficulty: number, rng: Rng, t: Tuning = DEFAULT_TUNING): string {
  const band = clamp(
    Math.floor(((difficulty - 1) / t.maxDifficulty) * EXPEDITION_NAMES.length),
    0,
    EXPEDITION_NAMES.length - 1,
  );
  return pick(rng, EXPEDITION_NAMES[band] as readonly string[]);
}

export function startExpedition(
  state: GameState,
  userId: string,
  difficulty: number,
  ctx: Ctx,
): StartResult {
  const character = find(state, userId);
  if (!character) return { ok: false, reason: "You have no character yet." };
  if (character.expedition) {
    const left = character.expedition.endsAt - ctx.now;
    return {
      ok: false,
      reason:
        left > 0
          ? `You are already out. ${shortDuration(left)} left — check back with \`/idlerpg status\`.`
          : "You are already out, and finished. Claim it with `/idlerpg claim`.",
    };
  }

  const ceiling = maxDifficultyFor(character, ctx.tuning);
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > ceiling) {
    return {
      ok: false,
      reason: `Pick a difficulty between 1 and ${ceiling}. You unlock harder ones by levelling.`,
    };
  }

  const endsAt = ctx.now + expeditionDuration(difficulty, ctx.tuning);
  character.expedition = { difficulty, startedAt: ctx.now, endsAt };
  return {
    ok: true,
    character,
    difficulty,
    endsAt,
    name: expeditionName(difficulty, ctx.rng, ctx.tuning),
  };
}

export interface ClaimReward {
  won: boolean;
  difficulty: number;
  money: number;
  xp: number;
  stolen: number;
  crate: Rarity | null;
  levelsGained: number;
  newTier: string | null;
  line: string;
}

export type ClaimResult =
  | { kind: "none"; reason: string }
  | { kind: "pending"; endsAt: number; difficulty: number }
  | { kind: "done"; character: Character; reward: ClaimReward; announcements: Announcement[] };

/**
 * Resolves a finished adventure.
 *
 * The roll happens here, on claim, rather than when the adventure was
 * dispatched. That is deliberate and it is the difference between a wait that
 * is tense and a wait that is a lie: if the outcome were decided up front, the
 * intervening hours would be theatre.
 */
export function claimExpedition(state: GameState, userId: string, ctx: Ctx): ClaimResult {
  const character = find(state, userId);
  if (!character) return { kind: "none", reason: "You have no character yet." };

  const run = character.expedition;
  if (!run) {
    return { kind: "none", reason: "You are not on an adventure. `/idlerpg adventure` sends you out." };
  }
  if (ctx.now < run.endsAt) {
    return { kind: "pending", endsAt: run.endsAt, difficulty: run.difficulty };
  }

  character.expedition = null;
  const won = ctx.rng() < successChance(character, run.difficulty, ctx.tuning);
  const announcements: Announcement[] = [];

  if (!won) {
    character.stats.lost += 1;
    return {
      kind: "done",
      character,
      reward: {
        won: false,
        difficulty: run.difficulty,
        money: 0,
        xp: 0,
        stolen: 0,
        crate: null,
        levelsGained: 0,
        newTier: null,
        line: pick(ctx.rng, LOSS_LINES),
      },
      announcements,
    };
  }

  character.stats.won += 1;
  const money = moneyReward(character, run.difficulty, ctx.tuning);
  const stolen = stolenCoin(character, money, ctx.rng);
  const xp = xpReward(character, run.difficulty, ctx.tuning);

  character.money += money + stolen;
  const levelled = applyXp(character.level, character.xp, xp);
  character.level = levelled.level;
  character.xp = levelled.xp;
  const newTier = levelled.gained > 0 ? syncTier(character) : null;

  let crate: Rarity | null = null;
  if (ctx.rng() < crateChance(run.difficulty)) {
    crate = rollRarity(ctx.rng, run.difficulty / 6);
    character.crates[crate] += 1;
  }

  if (levelled.gained > 0) {
    announcements.push(
      say(
        `**${character.name}** reached level ${character.level}` +
          (newTier ? ` and became a **${newTier}**.` : "."),
      ),
    );
  }

  return {
    kind: "done",
    character,
    reward: {
      won: true,
      difficulty: run.difficulty,
      money,
      xp,
      stolen,
      crate,
      levelsGained: levelled.gained,
      newTier,
      line: pick(ctx.rng, WIN_LINES),
    },
    announcements,
  };
}

// ------------------------------------------------------------------ items ---

export type CrateResult =
  | { ok: true; item: Item; replaced: Item | null; equipped: boolean; soldOverflow: number }
  | { ok: false; reason: string };

/**
 * Opens a crate and files what falls out.
 *
 * Better-than-current gear equips itself. Making the player run a second
 * command to wear an obvious upgrade is the kind of friction that reads as
 * depth for exactly one day.
 */
export function openCrate(
  state: GameState,
  userId: string,
  rarity: Rarity,
  ctx: Ctx,
): CrateResult {
  const character = find(state, userId);
  if (!character) return { ok: false, reason: "You have no character yet." };
  if (character.crates[rarity] < 1) return { ok: false, reason: `You have no ${rarity} crates.` };

  character.crates[rarity] -= 1;
  const item = take(
    character,
    rollItem(ctx.rng, {
      id: 0,
      level: character.level,
      difficulty: character.level,
      rarity,
    }),
  );

  const slot = item.kind === "weapon" ? character.weapon : character.armor;
  if (!slot || item.value > slot.value) {
    if (item.kind === "weapon") character.weapon = item;
    else character.armor = item;
    return { ok: true, item, replaced: slot, equipped: true, soldOverflow: 0 };
  }

  const soldOverflow = stow(character, item, ctx.tuning);
  return { ok: true, item, replaced: null, equipped: false, soldOverflow };
}

/**
 * Puts an item in the backpack, selling it instead if there is no room.
 *
 * Returns the coin paid for an item that could not fit. Silently dropping the
 * find would be worse, and refusing the reward outright punishes the player for
 * a bookkeeping problem they did not know they had.
 */
function stow(character: Character, item: Item, t: Tuning): number {
  if (character.backpack.length < t.backpackSize) {
    character.backpack.push(item);
    return 0;
  }
  const paid = sellValue(item);
  character.money += paid;
  return paid;
}

export type EquipResult =
  | { ok: true; item: Item; replaced: Item | null }
  | { ok: false; reason: string };

export function equip(state: GameState, userId: string, itemId: number): EquipResult {
  const character = find(state, userId);
  if (!character) return { ok: false, reason: "You have no character yet." };

  const index = character.backpack.findIndex((i) => i.id === itemId);
  if (index === -1) return { ok: false, reason: `You have no item #${itemId} in your backpack.` };

  const item = character.backpack[index] as Item;
  character.backpack.splice(index, 1);
  const replaced = item.kind === "weapon" ? character.weapon : character.armor;
  if (item.kind === "weapon") character.weapon = item;
  else character.armor = item;
  // The displaced item goes back to the pack rather than vanishing.
  if (replaced) character.backpack.push(replaced);
  return { ok: true, item, replaced };
}

export type SellResult = { ok: true; paid: number; count: number } | { ok: false; reason: string };

export function sell(state: GameState, userId: string, itemId: number): SellResult {
  const character = find(state, userId);
  if (!character) return { ok: false, reason: "You have no character yet." };

  const index = character.backpack.findIndex((i) => i.id === itemId);
  if (index === -1) return { ok: false, reason: `You have no item #${itemId} in your backpack.` };

  const [item] = character.backpack.splice(index, 1) as [Item];
  const paid = sellValue(item);
  character.money += paid;
  return { ok: true, paid, count: 1 };
}

/** Sells everything in the backpack at or below `keepAbove` value. */
export function sellAll(state: GameState, userId: string, keepAbove: number): SellResult {
  const character = find(state, userId);
  if (!character) return { ok: false, reason: "You have no character yet." };

  const keeping: Item[] = [];
  let paid = 0;
  let count = 0;
  for (const item of character.backpack) {
    if (item.value > keepAbove) {
      keeping.push(item);
      continue;
    }
    paid += sellValue(item);
    count += 1;
  }
  character.backpack = keeping;
  character.money += paid;
  return { ok: true, paid, count };
}

// ------------------------------------------------------------------ duels ---

export interface DuelOutcome {
  winner: Character;
  loser: Character;
  stake: number;
  winnerRoll: number;
  loserRoll: number;
}

export type DuelResult = { ok: true; outcome: DuelOutcome } | { ok: false; reason: string };

/**
 * A wagered duel between two characters.
 *
 * Both must cover the stake, and the roll is power scattered widely enough that
 * the better-equipped duellist is favoured without it being settled in advance.
 * This is the one part of the game that needs another person, and on a Discord
 * server that is the abundant resource -- so it is deliberately the cheapest
 * thing to do and the only one with no cooldown.
 */
export function duel(
  state: GameState,
  challengerId: string,
  opponentId: string,
  stake: number,
  ctx: Ctx,
): DuelResult {
  const challenger = find(state, challengerId);
  const opponent = find(state, opponentId);
  if (!challenger) return { ok: false, reason: "You have no character yet." };
  if (!opponent) return { ok: false, reason: "They have no character yet." };
  if (challenger.userId === opponent.userId) {
    return { ok: false, reason: "You cannot duel yourself." };
  }
  if (!Number.isInteger(stake) || stake < 1) {
    return { ok: false, reason: "Stake must be a whole number of coins." };
  }
  if (challenger.money < stake) {
    return { ok: false, reason: `You only have ${coin(challenger.money)}.` };
  }
  if (opponent.money < stake) {
    return { ok: false, reason: `${opponent.name} only has ${coin(opponent.money)}.` };
  }

  const mine = duelRoll(challenger, ctx.rng);
  const theirs = duelRoll(opponent, ctx.rng);
  const iWin = mine >= theirs;
  const winner = iWin ? challenger : opponent;
  const loser = iWin ? opponent : challenger;

  winner.money += stake;
  loser.money -= stake;
  winner.stats.duelsWon += 1;
  loser.stats.duelsLost += 1;

  return {
    ok: true,
    outcome: {
      winner,
      loser,
      stake,
      winnerRoll: Math.round(iWin ? mine : theirs),
      loserRoll: Math.round(iWin ? theirs : mine),
    },
  };
}

// --------------------------------------------------------------- creation ---

export type CreateResult = { ok: true; character: Character } | { ok: false; reason: string };

export function create(
  state: GameState,
  userId: string,
  name: string,
  classId: ClassId,
  ctx: Ctx,
  raceId: RaceId = "human",
): CreateResult {
  if (state.characters[userId]) {
    return { ok: false, reason: "You already have a character. `/idlerpg profile` shows it." };
  }
  if (findByName(state, name)) {
    return { ok: false, reason: `Somebody is already called ${name}.` };
  }
  if (!CLASSES[classId]) return { ok: false, reason: "That is not a class." };

  const character = newCharacter(userId, name, classId, ctx, raceId);
  state.characters[userId] = character;
  return { ok: true, character };
}

export function leaderboard(state: GameState, limit: number): Character[] {
  return Object.values(state.characters)
    .sort((a, b) => b.level - a.level || b.xp - a.xp || b.money - a.money)
    .slice(0, limit);
}

export { attack, defense, power, between, className };
