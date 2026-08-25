import { shuffle } from "./rules.js";
import type { Rng } from "./rules.js";
import type { GameState, Werewolf, WerewolfPlayer, WerewolfRole } from "./types.js";

/**
 * Werewolf, as a state machine.
 *
 * Every rule is here and nothing here knows what Discord is, which matters more
 * for this game than for most: werewolf is almost entirely bookkeeping about
 * who may do what and when, and bookkeeping is exactly what goes wrong when it
 * is tangled up with interaction handlers.
 *
 * Phases advance on a command rather than a clock. A timed night ends at 3am
 * for whoever was asleep; a Discord server is not a table everyone is sitting
 * at, and the host calling the phase is both simpler and kinder.
 */

export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const no = <T>(reason: string): Outcome<T> => ({ ok: false, reason });

/** Below this the roles do not fit and the game is not interesting. */
export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 20;

export function playerIn(game: Werewolf, userId: string): WerewolfPlayer | null {
  return game.players.find((p) => p.userId === userId) ?? null;
}

export function living(game: Werewolf): WerewolfPlayer[] {
  return game.players.filter((p) => p.alive);
}

export function wolves(game: Werewolf): WerewolfPlayer[] {
  return living(game).filter((p) => p.role === "wolf");
}

// ------------------------------------------------------------------ lobby ---

export function openGame(state: GameState, hostId: string): Outcome<Werewolf> {
  if (state.werewolf && state.werewolf.phase !== "over") {
    return no("A game is already running. Finish it first.");
  }
  const game: Werewolf = {
    hostId,
    players: [{ userId: hostId, role: "villager", alive: true }],
    phase: "lobby",
    night: 0,
    wolfVotes: {},
    guardTarget: null,
    seerTarget: null,
    votes: {},
    log: [],
    winner: null,
  };
  state.werewolf = game;
  return ok(game);
}

export function joinGame(state: GameState, userId: string): Outcome<Werewolf> {
  const game = state.werewolf;
  if (!game) return no("No game is open.");
  if (game.phase !== "lobby") return no("That game has already started.");
  if (playerIn(game, userId)) return no("You are already in.");
  if (game.players.length >= MAX_PLAYERS) return no(`A game holds ${MAX_PLAYERS} at most.`);

  game.players.push({ userId, role: "villager", alive: true });
  return ok(game);
}

export function leaveLobby(state: GameState, userId: string): Outcome<Werewolf> {
  const game = state.werewolf;
  if (!game) return no("No game is open.");
  if (game.phase !== "lobby") return no("You cannot leave once it has started. Play it out.");
  if (!playerIn(game, userId)) return no("You are not in it.");

  game.players = game.players.filter((p) => p.userId !== userId);
  if (game.players.length === 0) state.werewolf = null;
  return ok(game);
}

/**
 * How many of each role a given size gets.
 *
 * A quarter wolves is the standard ratio and it is standard because it works:
 * many fewer and the village cannot lose, many more and it cannot win. The seer
 * is always present because a game with no information at all is a coin flip
 * with extra steps; the guard waits for six, below which protecting anyone
 * makes the wolves' job impossible.
 */
export function roleSpread(count: number): Record<WerewolfRole, number> {
  const wolfCount = Math.max(1, Math.floor(count / 4));
  const seer = 1;
  const guard = count >= 6 ? 1 : 0;
  return {
    wolf: wolfCount,
    seer,
    guard,
    villager: Math.max(0, count - wolfCount - seer - guard),
  };
}

export function startGame(state: GameState, userId: string, rng: Rng): Outcome<Werewolf> {
  const game = state.werewolf;
  if (!game) return no("No game is open.");
  if (game.phase !== "lobby") return no("It has already started.");
  if (game.hostId !== userId) return no("Only the host can start it.");
  if (game.players.length < MIN_PLAYERS) {
    return no(`Werewolf needs ${MIN_PLAYERS} players. You have ${game.players.length}.`);
  }

  const spread = roleSpread(game.players.length);
  const roles: WerewolfRole[] = [
    ...Array<WerewolfRole>(spread.wolf).fill("wolf"),
    ...Array<WerewolfRole>(spread.seer).fill("seer"),
    ...Array<WerewolfRole>(spread.guard).fill("guard"),
    ...Array<WerewolfRole>(spread.villager).fill("villager"),
  ];
  shuffle(rng, roles);
  game.players.forEach((player, index) => {
    player.role = roles[index] as WerewolfRole;
    player.alive = true;
  });

  game.phase = "night";
  game.night = 1;
  game.log.push(`The village goes to sleep. ${spread.wolf} wolf${spread.wolf === 1 ? "" : "s"} among ${game.players.length}.`);
  return ok(game);
}

// ------------------------------------------------------------------ night ---

export function nightAction(
  state: GameState,
  actorId: string,
  targetId: string,
): Outcome<{ role: WerewolfRole; seerSaw: WerewolfRole | null }> {
  const game = state.werewolf;
  if (!game) return no("No game is running.");
  if (game.phase !== "night") return no("It is not night.");

  const actor = playerIn(game, actorId);
  if (!actor) return no("You are not in this game.");
  if (!actor.alive) return no("The dead do not act.");

  const target = playerIn(game, targetId);
  if (!target || !target.alive) return no("That is not a living player.");

  switch (actor.role) {
    case "wolf":
      if (target.role === "wolf") return no("Wolves do not eat each other.");
      game.wolfVotes[actorId] = targetId;
      return ok({ role: "wolf", seerSaw: null });
    case "guard":
      if (targetId === actorId) return no("You cannot guard yourself.");
      game.guardTarget = targetId;
      return ok({ role: "guard", seerSaw: null });
    case "seer":
      if (targetId === actorId) return no("You already know what you are.");
      game.seerTarget = targetId;
      // The seer learns immediately: making them wait for dawn to read a DM
      // adds nothing and loses people who log off.
      return ok({ role: "seer", seerSaw: target.role });
    default:
      return no("Villagers sleep through the night.");
  }
}

export interface NightResult {
  victimId: string | null;
  saved: boolean;
  game: Werewolf;
}

/**
 * Resolves the night.
 *
 * The wolves' victim is whoever they named most; a tie means they argued until
 * dawn and nobody dies, which is a real outcome rather than a fudge -- it gives
 * a split pack a reason to coordinate.
 */
export function resolveNight(state: GameState, userId: string): Outcome<NightResult> {
  const game = state.werewolf;
  if (!game) return no("No game is running.");
  if (game.phase !== "night") return no("It is not night.");
  if (game.hostId !== userId) return no("Only the host can call the dawn.");

  const tally = new Map<string, number>();
  for (const target of Object.values(game.wolfVotes)) {
    tally.set(target, (tally.get(target) ?? 0) + 1);
  }
  let victimId: string | null = null;
  let best = 0;
  let tied = false;
  for (const [target, count] of tally) {
    if (count > best) {
      best = count;
      victimId = target;
      tied = false;
    } else if (count === best) {
      tied = true;
    }
  }
  if (tied) victimId = null;

  const saved = victimId !== null && victimId === game.guardTarget;
  if (victimId && !saved) {
    const victim = playerIn(game, victimId);
    if (victim) victim.alive = false;
  }

  game.log.push(
    victimId === null
      ? "The wolves could not agree, and everyone woke up."
      : saved
        ? "The wolves came for somebody, and found them guarded."
        : "Somebody did not wake up.",
  );

  game.wolfVotes = {};
  game.guardTarget = null;
  game.seerTarget = null;
  game.votes = {};
  game.phase = "day";

  const finished = checkWin(game);
  return ok({ victimId: saved ? null : victimId, saved, game: finished });
}

// -------------------------------------------------------------------- day ---

export function vote(state: GameState, voterId: string, targetId: string): Outcome<Werewolf> {
  const game = state.werewolf;
  if (!game) return no("No game is running.");
  if (game.phase !== "day") return no("It is not day.");

  const voter = playerIn(game, voterId);
  if (!voter) return no("You are not in this game.");
  if (!voter.alive) return no("The dead do not vote.");

  const target = playerIn(game, targetId);
  if (!target || !target.alive) return no("That is not a living player.");
  if (targetId === voterId) return no("You cannot vote for yourself.");

  game.votes[voterId] = targetId;
  return ok(game);
}

export interface DayResult {
  lynchedId: string | null;
  role: WerewolfRole | null;
  game: Werewolf;
}

/** Resolves the vote. A tie is a hung village and nobody hangs. */
export function resolveDay(state: GameState, userId: string): Outcome<DayResult> {
  const game = state.werewolf;
  if (!game) return no("No game is running.");
  if (game.phase !== "day") return no("It is not day.");
  if (game.hostId !== userId) return no("Only the host can call the vote.");

  const tally = new Map<string, number>();
  for (const target of Object.values(game.votes)) {
    tally.set(target, (tally.get(target) ?? 0) + 1);
  }
  let lynchedId: string | null = null;
  let best = 0;
  let tied = false;
  for (const [target, count] of tally) {
    if (count > best) {
      best = count;
      lynchedId = target;
      tied = false;
    } else if (count === best) {
      tied = true;
    }
  }
  if (tied) lynchedId = null;

  let role: WerewolfRole | null = null;
  if (lynchedId) {
    const victim = playerIn(game, lynchedId);
    if (victim) {
      victim.alive = false;
      role = victim.role;
    }
  }

  game.log.push(
    lynchedId === null
      ? "The village argued itself to a standstill. Nobody hangs."
      : `The village made its decision, and it was a ${role}.`,
  );

  game.votes = {};
  game.phase = "night";
  game.night += 1;

  const finished = checkWin(game);
  return ok({ lynchedId, role, game: finished });
}

// ------------------------------------------------------------------- ends ---

/**
 * Decides whether the game is over.
 *
 * The wolves win at parity rather than at a majority, which is the standard
 * rule and the correct one: once they equal the village they can never be
 * out-voted, so playing it out would be theatre.
 */
export function checkWin(game: Werewolf): Werewolf {
  if (game.phase === "over") return game;
  const alive = living(game);
  const pack = alive.filter((p) => p.role === "wolf").length;
  const village = alive.length - pack;

  if (pack === 0) {
    game.phase = "over";
    game.winner = "village";
    game.log.push("The last wolf is dead. The village survives.");
  } else if (pack >= village) {
    game.phase = "over";
    game.winner = "wolves";
    game.log.push("The wolves equal the village, and that is that.");
  }
  return game;
}

export function endGame(state: GameState, userId: string): Outcome<Werewolf> {
  const game = state.werewolf;
  if (!game) return no("No game is running.");
  if (game.hostId !== userId) return no("Only the host can end it.");
  game.phase = "over";
  state.werewolf = null;
  return ok(game);
}
