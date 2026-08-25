import { find } from "./engine.js";
import { clamp, coin, loveBonus, power, shuffle } from "./rules.js";
import type { Ctx } from "./engine.js";
import type { Character, GameState, Tournament } from "./types.js";

/**
 * The things players do to each other for money: brackets, wagers, and
 * marriage.
 *
 * Grouped because they share a shape -- each is a short, consensual
 * transaction between people rather than a system a character grinds. All of
 * them are pure over injected randomness.
 */

export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const no = <T>(reason: string): Outcome<T> => ({ ok: false, reason });

const NO_CHARACTER = "You have no character yet. `/idlerpg start` makes one.";

// ------------------------------------------------------------ tournaments ---

/** How long entry stays open before the bracket runs. */
export const TOURNAMENT_WINDOW_MS = 60 * 60_000;
export const TOURNAMENT_MIN_ENTRIES = 2;

export function openTournament(
  state: GameState,
  hostId: string,
  buyIn: number,
  ctx: Ctx,
): Outcome<Tournament> {
  const host = find(state, hostId);
  if (!host) return no(NO_CHARACTER);
  if (state.tournament && !state.tournament.finished && ctx.now < state.tournament.closesAt) {
    return no("A tournament is already taking entries.");
  }
  if (!Number.isInteger(buyIn) || buyIn < 0) return no("Buy-in must be a whole number.");
  if (host.money < buyIn) return no(`You cannot cover the buy-in. You have ${coin(host.money)}.`);

  host.money -= buyIn;
  const tournament: Tournament = {
    hostId,
    buyIn,
    entries: [{ userId: hostId, eliminated: false }],
    closesAt: ctx.now + TOURNAMENT_WINDOW_MS,
    log: [],
    finished: false,
    winnerId: null,
  };
  state.tournament = tournament;
  return ok(tournament);
}

export function enterTournament(state: GameState, userId: string, ctx: Ctx): Outcome<Tournament> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);

  const tournament = state.tournament;
  if (!tournament || tournament.finished) return no("No tournament is taking entries.");
  if (ctx.now >= tournament.closesAt) return no("Entry has closed. Run it with `/idlerpg tournament run`.");
  if (tournament.entries.some((e) => e.userId === userId)) return no("You are already entered.");
  if (character.money < tournament.buyIn) {
    return no(`The buy-in is ${coin(tournament.buyIn)}. You have ${coin(character.money)}.`);
  }

  character.money -= tournament.buyIn;
  tournament.entries.push({ userId, eliminated: false });
  return ok(tournament);
}

export interface TournamentResult {
  tournament: Tournament;
  winner: Character | null;
  pot: number;
}

/**
 * Runs the bracket to completion in one pass.
 *
 * Single elimination with a bye for an odd player out each round, resolved by
 * the same wide power roll duels use. Done all at once rather than round by
 * round: a bracket that needs everyone present for four separate prompts is a
 * bracket that never finishes on a Discord server.
 */
export function runTournament(state: GameState, ctx: Ctx): Outcome<TournamentResult> {
  const tournament = state.tournament;
  if (!tournament) return no("No tournament to run.");
  if (tournament.finished) return no("That tournament has already been decided.");
  if (tournament.entries.length < TOURNAMENT_MIN_ENTRIES) {
    // Refund, because the host paid to open it and nobody came.
    for (const entry of tournament.entries) {
      const c = find(state, entry.userId);
      if (c) c.money += tournament.buyIn;
    }
    state.tournament = null;
    return no("Not enough entries. Everyone has been refunded.");
  }

  const pot = tournament.buyIn * tournament.entries.length;
  let field = shuffle(
    ctx.rng,
    tournament.entries
      .map((e) => find(state, e.userId))
      .filter((c): c is Character => c !== null),
  );

  let round = 1;
  while (field.length > 1) {
    const survivors: Character[] = [];
    const lines: string[] = [];
    for (let i = 0; i < field.length; i += 2) {
      const a = field[i] as Character;
      const b = field[i + 1];
      if (!b) {
        survivors.push(a);
        lines.push(`**${a.name}** advances on a bye.`);
        continue;
      }
      const aRoll = power(a) * (0.5 + ctx.rng());
      const bRoll = power(b) * (0.5 + ctx.rng());
      const winner = aRoll >= bRoll ? a : b;
      const loser = winner === a ? b : a;
      survivors.push(winner);
      lines.push(`**${winner.name}** [${Math.round(Math.max(aRoll, bRoll))}] beat **${loser.name}** [${Math.round(Math.min(aRoll, bRoll))}].`);
    }
    tournament.log.push(`__Round ${round}__\n${lines.join("\n")}`);
    field = survivors;
    round += 1;
  }

  const winner = field[0] ?? null;
  if (winner) winner.money += pot;
  tournament.finished = true;
  tournament.winnerId = winner?.userId ?? null;
  return ok({ tournament, winner, pot });
}

// -------------------------------------------------------------- gambling ---

export interface WagerResult {
  won: boolean;
  stake: number;
  payout: number;
  detail: string;
}

/**
 * A coin flip at even money, with a house edge of exactly nothing.
 *
 * Deliberately fair. A rigged flip is how a game teaches people not to use one
 * of its features, and the coin sinks that matter here are the shop and the
 * guild bank, not a rake on a novelty.
 */
export function flip(
  state: GameState,
  userId: string,
  stake: number,
  callHeads: boolean,
  ctx: Ctx,
): Outcome<WagerResult> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);
  if (!Number.isInteger(stake) || stake < 1) return no("Stake a whole number of coins.");
  if (character.money < stake) return no(`You only have ${coin(character.money)}.`);

  const heads = ctx.rng() < 0.5;
  const won = heads === callHeads;
  character.money += won ? stake : -stake;
  return ok({
    won,
    stake,
    payout: won ? stake : 0,
    detail: `It came up ${heads ? "heads" : "tails"}.`,
  });
}

/**
 * Guess a die roll for a payout proportional to how unlikely the guess was.
 *
 * Pays `sides - 1` to 1, which is also exactly fair. The appeal is variance,
 * not edge -- a player who wants a big swing can reach for a twenty-sided die
 * and one who wants a coin flip already has one above.
 */
export function rollDie(
  state: GameState,
  userId: string,
  stake: number,
  sides: number,
  guess: number,
  ctx: Ctx,
): Outcome<WagerResult> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);
  if (!Number.isInteger(stake) || stake < 1) return no("Stake a whole number of coins.");
  if (character.money < stake) return no(`You only have ${coin(character.money)}.`);
  if (!Number.isInteger(sides) || sides < 2 || sides > 100) return no("Between 2 and 100 sides.");
  if (!Number.isInteger(guess) || guess < 1 || guess > sides) {
    return no(`Guess between 1 and ${sides}.`);
  }

  const rolled = 1 + Math.floor(ctx.rng() * sides);
  const won = rolled === guess;
  const payout = won ? stake * (sides - 1) : 0;
  character.money += won ? payout : -stake;
  return ok({ won, stake, payout, detail: `The die showed ${rolled}.` });
}

// -------------------------------------------------------------- marriage ---

/** Coin a gift converts into affection, and what affection is worth. */
export const LOVE_PER_COIN = 1 / 50;

export function marry(
  state: GameState,
  aId: string,
  bId: string,
): Outcome<{ a: Character; b: Character }> {
  const a = find(state, aId);
  const b = find(state, bId);
  if (!a) return no(NO_CHARACTER);
  if (!b) return no("They have no character.");
  if (a.userId === b.userId) return no("You cannot marry yourself.");
  if (a.spouse) return no("You are already married.");
  if (b.spouse) return no(`${b.name} is already married.`);

  a.spouse = b.userId;
  b.spouse = a.userId;
  return ok({ a, b });
}

export function divorce(state: GameState, userId: string): Outcome<{ character: Character; exName: string }> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);
  if (!character.spouse) return no("You are not married.");

  const ex = find(state, character.spouse);
  character.spouse = null;
  // Affection is not transferable and does not survive. Keeping it would let a
  // pair farm the bonus by marrying, banking it, and splitting.
  character.loveScore = 0;
  if (ex) {
    ex.spouse = null;
    ex.loveScore = 0;
  }
  return ok({ character, exName: ex?.name ?? "someone" });
}

/**
 * Spends coin on your spouse for a shared bonus.
 *
 * Both halves gain, so it is never a transfer with a loser -- the coin leaves
 * the economy and buys a percentage that applies to two people.
 */
export function courtSpouse(
  state: GameState,
  userId: string,
  spend: number,
): Outcome<{ character: Character; spouse: Character; gained: number }> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);
  if (!character.spouse) return no("You are not married.");
  if (!Number.isInteger(spend) || spend < 1) return no("Spend a whole number of coins.");
  if (character.money < spend) return no(`You only have ${coin(character.money)}.`);

  const spouse = find(state, character.spouse);
  if (!spouse) return no("Your spouse's character is gone.");

  character.money -= spend;
  const gained = Math.max(1, Math.floor(spend * LOVE_PER_COIN));
  character.loveScore += gained;
  spouse.loveScore += gained;
  return ok({ character, spouse, gained });
}

export { loveBonus, clamp };
