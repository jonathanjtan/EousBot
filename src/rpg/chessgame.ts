import {
  START_FEN,
  applyMove,
  inCheck,
  parseFen,
  parseMove,
  render,
  squareName,
  status,
  toFen,
  type GameStatus,
} from "./chess.js";
import { find } from "./engine.js";
import { coin } from "./rules.js";
import type { Ctx } from "./engine.js";
import type { ChessGame, GameState } from "./types.js";

/**
 * Chess games between players: matchmaking, wagers, and whose turn it is.
 *
 * The rules live in chess.ts, which knows nothing about players or coin. This
 * is the part that does, and it stores a game as nothing but a FEN string --
 * a position is completely described by one, so there is no board state to
 * keep in sync and a save file can be read by any chess tool.
 */

export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const no = <T>(reason: string): Outcome<T> => ({ ok: false, reason });

const NO_CHARACTER = "You have no character yet. `/idlerpg start` makes one.";

export function gameFor(state: GameState, userId: string): ChessGame | null {
  return state.chess.find((g) => g.whiteId === userId || g.blackId === userId) ?? null;
}

/** Whose move it is, as a user id. */
export function toMove(game: ChessGame): string {
  const position = parseFen(game.fen);
  if (!position) return game.whiteId;
  return position.turn === "w" ? game.whiteId : game.blackId;
}

export function opponentOf(game: ChessGame, userId: string): string {
  return game.whiteId === userId ? game.blackId : game.whiteId;
}

/**
 * Starts a game, with the challenger playing white.
 *
 * One game per player at a time. Allowing several would mean every move needed
 * to say which board it was for, and nobody playing chess in a Discord channel
 * wants to disambiguate.
 */
export function startGame(
  state: GameState,
  whiteId: string,
  blackId: string,
  stake: number,
  ctx: Ctx,
): Outcome<ChessGame> {
  const white = find(state, whiteId);
  const black = find(state, blackId);
  if (!white) return no(NO_CHARACTER);
  if (!black) return no("They have no character.");
  if (whiteId === blackId) return no("You cannot play yourself.");
  if (gameFor(state, whiteId)) return no("You are already in a game. Finish or resign it.");
  if (gameFor(state, blackId)) return no("They are already in a game.");
  if (!Number.isInteger(stake) || stake < 0) return no("Stake must be a whole number.");
  if (white.money < stake) return no(`You only have ${coin(white.money)}.`);
  if (black.money < stake) return no(`${black.name} only has ${coin(black.money)}.`);

  const game: ChessGame = {
    id: state.nextChessId,
    whiteId,
    blackId,
    fen: START_FEN,
    stake,
    startedAt: ctx.now,
    lastMoveAt: ctx.now,
  };
  state.nextChessId += 1;
  state.chess.push(game);
  return ok(game);
}

export interface MoveResult {
  game: ChessGame;
  san: string;
  status: GameStatus;
  /** Set when the game ended on this move. */
  finished: { winnerId: string | null; reason: string; paid: number } | null;
}

/**
 * Plays a move, and settles the wager if it ended the game.
 *
 * The stake is only moved here, on the last move, rather than being escrowed at
 * the start. Holding it would mean tracking money that belongs to nobody, and
 * a game abandoned mid-board would strand it.
 */
export function play(
  state: GameState,
  userId: string,
  text: string,
  ctx: Ctx,
): Outcome<MoveResult> {
  const game = gameFor(state, userId);
  if (!game) return no("You are not in a game. `/idlerpg chess challenge` starts one.");
  if (toMove(game) !== userId) return no("It is not your move.");

  const position = parseFen(game.fen);
  if (!position) return no("That game's position is corrupt. Resign it and start again.");

  const move = parseMove(position, text);
  if (!move) {
    return no(
      `\`${text}\` is not a legal move. Use coordinates like \`e2e4\`, ` +
        "and name the piece when a pawn promotes: `e7e8q`.",
    );
  }

  const next = applyMove(position, move);
  game.fen = toFen(next);
  game.lastMoveAt = ctx.now;
  const san = `${squareName(move.from)}${squareName(move.to)}${move.promotion ?? ""}`;
  const result = status(next);

  if (result.kind === "playing") {
    return ok({ game, san, status: result, finished: null });
  }

  const winnerId =
    result.kind === "checkmate"
      ? result.winner === "w"
        ? game.whiteId
        : game.blackId
      : null;
  const paid = settle(state, game, winnerId);
  const reason =
    result.kind === "checkmate"
      ? "checkmate"
      : result.kind === "stalemate"
        ? "stalemate"
        : result.reason;

  return ok({ game, san, status: result, finished: { winnerId, reason, paid } });
}

/** Pays out and removes the game. A draw returns each stake to its owner. */
function settle(state: GameState, game: ChessGame, winnerId: string | null): number {
  state.chess = state.chess.filter((g) => g.id !== game.id);
  if (!winnerId || game.stake === 0) return 0;

  const winner = find(state, winnerId);
  const loser = find(state, opponentOf(game, winnerId));
  if (!winner || !loser) return 0;
  // Capped at what the loser actually has: a game can outlast a fortune.
  const paid = Math.min(game.stake, loser.money);
  winner.money += paid;
  loser.money -= paid;
  return paid;
}

export function resign(
  state: GameState,
  userId: string,
): Outcome<{ game: ChessGame; winnerId: string; paid: number }> {
  const game = gameFor(state, userId);
  if (!game) return no("You are not in a game.");
  const winnerId = opponentOf(game, userId);
  const paid = settle(state, game, winnerId);
  return ok({ game, winnerId, paid });
}

/** A draw both players agree to. Stakes go home. */
export function agreeDraw(state: GameState, userId: string): Outcome<ChessGame> {
  const game = gameFor(state, userId);
  if (!game) return no("You are not in a game.");
  settle(state, game, null);
  return ok(game);
}

/** The board, and a line saying where things stand. */
export function describeGame(
  state: GameState,
  game: ChessGame,
  viewerId?: string,
): string {
  const position = parseFen(game.fen);
  if (!position) return "That game's position is unreadable.";

  const nameOf = (id: string) => state.characters[id]?.name ?? "someone";
  // Shown from the viewer's side when they are black, because reading your own
  // position upside down is the single most annoying thing about chess bots.
  const flipped = viewerId === game.blackId;
  const mover = toMove(game);

  return [
    `**${nameOf(game.whiteId)}** (white) vs **${nameOf(game.blackId)}** (black)` +
      (game.stake > 0 ? `, ${coin(game.stake)} on it` : ""),
    render(position, flipped),
    `**${nameOf(mover)}** to move${inCheck(position) ? ", and in check" : ""}.`,
  ].join("\n");
}
