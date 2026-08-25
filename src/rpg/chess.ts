/**
 * A chess engine, from scratch.
 *
 * The original gets away with 250 lines here because it wraps a Python chess
 * library and renders boards through an image service that no longer answers.
 * Neither is available, so this is the real thing: move generation with
 * legality, castling, en passant, promotion, and the draw rules that decide
 * most endgames.
 *
 * No imports at all, which is deliberate -- move generation is the part of a
 * chess program that is subtly wrong for years, and the way you find out is
 * perft: count the leaves of the move tree to a fixed depth and compare against
 * numbers the world already agrees on. test/rpg/chess.test.ts does that from
 * the opening position and from Kiwipete, the standard position for catching
 * castling, en-passant and pin bugs. Those tests are the whole reason to trust
 * anything below.
 *
 * Squares are indexed 0-63 from a8, matching the order FEN is written in, so
 * parsing is a straight walk and there is no coordinate flip to get wrong.
 */

export type Color = "w" | "b";
export type PieceChar =
  | "P" | "N" | "B" | "R" | "Q" | "K"
  | "p" | "n" | "b" | "r" | "q" | "k";

export interface Move {
  from: number;
  to: number;
  /** Lowercase piece letter when a pawn promotes. */
  promotion?: "q" | "r" | "b" | "n";
}

export interface Position {
  /** 64 entries; a piece letter, or "." for an empty square. */
  board: string[];
  turn: Color;
  /** Any of "KQkq", or "-" for none. */
  castling: string;
  /** Square index behind a pawn that just moved two, or null. */
  enPassant: number | null;
  halfmove: number;
  fullmove: number;
}

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const WHITE_PIECES = "PNBRQK";

export function colorOf(piece: string): Color | null {
  if (piece === ".") return null;
  return WHITE_PIECES.includes(piece) ? "w" : "b";
}

export const fileOf = (square: number): number => square % 8;
export const rankOf = (square: number): number => Math.floor(square / 8);

/** Algebraic name of a square, e.g. 12 -> "e7". */
export function squareName(square: number): string {
  return `${"abcdefgh"[fileOf(square)]}${8 - rankOf(square)}`;
}

export function squareIndex(name: string): number | null {
  const file = "abcdefgh".indexOf(name[0] ?? "");
  const rank = Number(name[1]);
  if (file < 0 || !Number.isInteger(rank) || rank < 1 || rank > 8) return null;
  return (8 - rank) * 8 + file;
}

// -------------------------------------------------------------------- FEN ---

export function parseFen(fen: string): Position | null {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4) return null;
  const [placement, turn, castling, ep, half, full] = parts;

  const board: string[] = [];
  for (const row of (placement as string).split("/")) {
    for (const ch of row) {
      if (/[1-8]/.test(ch)) {
        for (let i = 0; i < Number(ch); i += 1) board.push(".");
      } else if (/[pnbrqkPNBRQK]/.test(ch)) {
        board.push(ch);
      } else {
        return null;
      }
    }
  }
  if (board.length !== 64) return null;
  if (turn !== "w" && turn !== "b") return null;

  return {
    board,
    turn,
    castling: castling === "-" ? "-" : (castling as string),
    enPassant: ep && ep !== "-" ? squareIndex(ep) : null,
    halfmove: Number(half ?? 0) || 0,
    fullmove: Number(full ?? 1) || 1,
  };
}

export function toFen(position: Position): string {
  const rows: string[] = [];
  for (let rank = 0; rank < 8; rank += 1) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file += 1) {
      const piece = position.board[rank * 8 + file] as string;
      if (piece === ".") {
        empty += 1;
        continue;
      }
      if (empty > 0) {
        row += String(empty);
        empty = 0;
      }
      row += piece;
    }
    if (empty > 0) row += String(empty);
    rows.push(row);
  }
  return [
    rows.join("/"),
    position.turn,
    position.castling || "-",
    position.enPassant === null ? "-" : squareName(position.enPassant),
    position.halfmove,
    position.fullmove,
  ].join(" ");
}

// ------------------------------------------------------- move  generation ---

/** (fileStep, rankStep) pairs. Rank grows downward, matching the index order. */
const KNIGHT_STEPS: readonly [number, number][] = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const KING_STEPS: readonly [number, number][] = [
  [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1],
];
const ROOK_RAYS: readonly [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const BISHOP_RAYS: readonly [number, number][] = [[1, 1], [1, -1], [-1, -1], [-1, 1]];

function onBoard(file: number, rank: number): boolean {
  return file >= 0 && file < 8 && rank >= 0 && rank < 8;
}

/**
 * Whether `color` attacks `square`.
 *
 * Written as a scan outward from the target rather than a full move
 * generation, because it is called once per candidate move to test legality and
 * generating every reply each time is what makes a naive engine unusably slow.
 */
export function isAttacked(position: Position, square: number, by: Color): boolean {
  const board = position.board;
  const file = fileOf(square);
  const rank = rankOf(square);
  const enemy = (letters: string) => (by === "w" ? letters.toUpperCase() : letters.toLowerCase());

  for (const [df, dr] of KNIGHT_STEPS) {
    const f = file + df;
    const r = rank + dr;
    if (onBoard(f, r) && board[r * 8 + f] === enemy("n")) return true;
  }
  for (const [df, dr] of KING_STEPS) {
    const f = file + df;
    const r = rank + dr;
    if (onBoard(f, r) && board[r * 8 + f] === enemy("k")) return true;
  }

  const slide = (rays: readonly [number, number][], pieces: string) => {
    for (const [df, dr] of rays) {
      let f = file + df;
      let r = rank + dr;
      while (onBoard(f, r)) {
        const piece = board[r * 8 + f] as string;
        if (piece !== ".") {
          if (colorOf(piece) === by && pieces.includes(piece.toLowerCase())) return true;
          break;
        }
        f += df;
        r += dr;
      }
    }
    return false;
  };
  if (slide(ROOK_RAYS, "rq")) return true;
  if (slide(BISHOP_RAYS, "bq")) return true;

  // Pawns capture toward the side they are moving: white upward (rank - 1).
  const pawnRank = by === "w" ? rank + 1 : rank - 1;
  for (const df of [-1, 1]) {
    const f = file + df;
    if (onBoard(f, pawnRank) && board[pawnRank * 8 + f] === enemy("p")) return true;
  }
  return false;
}

export function findKing(position: Position, color: Color): number {
  const king = color === "w" ? "K" : "k";
  return position.board.indexOf(king);
}

export function inCheck(position: Position, color: Color = position.turn): boolean {
  const king = findKing(position, color);
  if (king === -1) return false;
  return isAttacked(position, king, color === "w" ? "b" : "w");
}

/** Pseudo-legal moves: correct in shape, but may leave the king in check. */
function pseudoMoves(position: Position): Move[] {
  const moves: Move[] = [];
  const { board, turn } = position;
  const mine = (square: number) => colorOf(board[square] as string) === turn;

  const push = (from: number, to: number) => {
    if (!onBoard(fileOf(to), rankOf(to))) return;
    if (mine(to)) return;
    moves.push({ from, to });
  };

  for (let from = 0; from < 64; from += 1) {
    const piece = board[from] as string;
    if (piece === "." || colorOf(piece) !== turn) continue;
    const file = fileOf(from);
    const rank = rankOf(from);
    const lower = piece.toLowerCase();

    if (lower === "p") {
      const forward = turn === "w" ? -1 : 1;
      const startRank = turn === "w" ? 6 : 1;
      const lastRank = turn === "w" ? 0 : 7;

      const one = from + forward * 8;
      if (onBoard(file, rank + forward) && board[one] === ".") {
        if (rankOf(one) === lastRank) {
          for (const p of ["q", "r", "b", "n"] as const) moves.push({ from, to: one, promotion: p });
        } else {
          moves.push({ from, to: one });
          const two = from + forward * 16;
          if (rank === startRank && board[two] === ".") moves.push({ from, to: two });
        }
      }
      for (const df of [-1, 1]) {
        const f = file + df;
        const r = rank + forward;
        if (!onBoard(f, r)) continue;
        const to = r * 8 + f;
        const target = board[to] as string;
        const capture = target !== "." && colorOf(target) !== turn;
        if (!capture && to !== position.enPassant) continue;
        if (r === lastRank) {
          for (const p of ["q", "r", "b", "n"] as const) moves.push({ from, to, promotion: p });
        } else {
          moves.push({ from, to });
        }
      }
      continue;
    }

    if (lower === "n") {
      for (const [df, dr] of KNIGHT_STEPS) {
        const f = file + df;
        const r = rank + dr;
        if (onBoard(f, r)) push(from, r * 8 + f);
      }
      continue;
    }

    if (lower === "k") {
      for (const [df, dr] of KING_STEPS) {
        const f = file + df;
        const r = rank + dr;
        if (onBoard(f, r)) push(from, r * 8 + f);
      }
      // Castling: the king must not start in, pass through, or land in check,
      // and the squares between must be empty.
      const enemy: Color = turn === "w" ? "b" : "w";
      const rights = position.castling;
      const homeRank = turn === "w" ? 7 : 0;
      if (rank === homeRank && file === 4 && !isAttacked(position, from, enemy)) {
        const kingSide = turn === "w" ? "K" : "k";
        const queenSide = turn === "w" ? "Q" : "q";
        if (
          rights.includes(kingSide) &&
          board[homeRank * 8 + 5] === "." &&
          board[homeRank * 8 + 6] === "." &&
          !isAttacked(position, homeRank * 8 + 5, enemy) &&
          !isAttacked(position, homeRank * 8 + 6, enemy)
        ) {
          moves.push({ from, to: homeRank * 8 + 6 });
        }
        if (
          rights.includes(queenSide) &&
          board[homeRank * 8 + 1] === "." &&
          board[homeRank * 8 + 2] === "." &&
          board[homeRank * 8 + 3] === "." &&
          !isAttacked(position, homeRank * 8 + 3, enemy) &&
          !isAttacked(position, homeRank * 8 + 2, enemy)
        ) {
          moves.push({ from, to: homeRank * 8 + 2 });
        }
      }
      continue;
    }

    const rays =
      lower === "r" ? ROOK_RAYS : lower === "b" ? BISHOP_RAYS : [...ROOK_RAYS, ...BISHOP_RAYS];
    for (const [df, dr] of rays) {
      let f = file + df;
      let r = rank + dr;
      while (onBoard(f, r)) {
        const to = r * 8 + f;
        const target = board[to] as string;
        if (target === ".") {
          moves.push({ from, to });
        } else {
          if (colorOf(target) !== turn) moves.push({ from, to });
          break;
        }
        f += df;
        r += dr;
      }
    }
  }
  return moves;
}

/** Every move that does not leave the mover's own king attacked. */
export function legalMoves(position: Position): Move[] {
  const mover = position.turn;
  return pseudoMoves(position).filter((move) => {
    const next = applyMove(position, move);
    return !inCheck(next, mover);
  });
}

/**
 * Applies a move without checking legality.
 *
 * Returns a new position; nothing here mutates, because move generation tests
 * legality by playing every candidate and a generator that corrupted the board
 * while looking at it would be a nightmare to debug.
 */
export function applyMove(position: Position, move: Move): Position {
  const board = [...position.board];
  const piece = board[move.from] as string;
  const lower = piece.toLowerCase();
  const captured = board[move.to] as string;
  const turn = position.turn;

  board[move.to] = move.promotion
    ? turn === "w"
      ? move.promotion.toUpperCase()
      : move.promotion
    : piece;
  board[move.from] = ".";

  // En passant removes a pawn that is not on the destination square.
  if (lower === "p" && move.to === position.enPassant) {
    const victim = move.to + (turn === "w" ? 8 : -8);
    board[victim] = ".";
  }

  // Castling drags the rook across with the king.
  if (lower === "k" && Math.abs(fileOf(move.to) - fileOf(move.from)) === 2) {
    const rank = rankOf(move.from);
    if (fileOf(move.to) === 6) {
      board[rank * 8 + 5] = board[rank * 8 + 7] as string;
      board[rank * 8 + 7] = ".";
    } else {
      board[rank * 8 + 3] = board[rank * 8 + 0] as string;
      board[rank * 8 + 0] = ".";
    }
  }

  // Rights are lost by moving the king or a rook, and by capturing a rook on
  // its home square -- that last one is the case naive engines forget.
  let castling = position.castling;
  const drop = (flags: string) => {
    for (const flag of flags) castling = castling.replace(flag, "");
  };
  if (lower === "k") drop(turn === "w" ? "KQ" : "kq");
  if (move.from === 63 || move.to === 63) drop("K");
  if (move.from === 56 || move.to === 56) drop("Q");
  if (move.from === 7 || move.to === 7) drop("k");
  if (move.from === 0 || move.to === 0) drop("q");
  if (castling === "") castling = "-";

  const doubleStep = lower === "p" && Math.abs(rankOf(move.to) - rankOf(move.from)) === 2;
  const enPassant = doubleStep ? (move.from + move.to) / 2 : null;

  return {
    board,
    turn: turn === "w" ? "b" : "w",
    castling,
    enPassant,
    halfmove: lower === "p" || captured !== "." ? 0 : position.halfmove + 1,
    fullmove: turn === "b" ? position.fullmove + 1 : position.fullmove,
  };
}

// ----------------------------------------------------------------- status ---

export type GameStatus =
  | { kind: "playing"; check: boolean }
  | { kind: "checkmate"; winner: Color }
  | { kind: "stalemate" }
  | { kind: "draw"; reason: "fifty-move" | "insufficient material" };

/** Two lone kings, or a king and one minor piece, cannot force mate. */
export function insufficientMaterial(position: Position): boolean {
  const pieces = position.board.filter((p) => p !== "." && p.toLowerCase() !== "k");
  if (pieces.length === 0) return true;
  if (pieces.length === 1) {
    const lower = (pieces[0] as string).toLowerCase();
    return lower === "n" || lower === "b";
  }
  return false;
}

export function status(position: Position): GameStatus {
  const moves = legalMoves(position);
  const check = inCheck(position);

  if (moves.length === 0) {
    if (check) return { kind: "checkmate", winner: position.turn === "w" ? "b" : "w" };
    return { kind: "stalemate" };
  }
  if (position.halfmove >= 100) return { kind: "draw", reason: "fifty-move" };
  if (insufficientMaterial(position)) return { kind: "draw", reason: "insufficient material" };
  return { kind: "playing", check };
}

// ------------------------------------------------------------------ input ---

/**
 * Reads a move in coordinate notation ("e2e4", "e7e8q").
 *
 * Coordinate rather than algebraic on purpose: SAN needs disambiguation rules
 * that are a second source of bugs, and nobody typing into a Discord box
 * benefits from writing "Nbd7" instead of "b8d7".
 */
export function parseMove(position: Position, text: string): Move | null {
  const cleaned = text.trim().toLowerCase().replace(/[\s-]/g, "");
  const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(cleaned);
  if (!match) return null;

  const from = squareIndex(match[1] as string);
  const to = squareIndex(match[2] as string);
  if (from === null || to === null) return null;

  const wanted: Move = match[3]
    ? { from, to, promotion: match[3] as "q" | "r" | "b" | "n" }
    : { from, to };

  return (
    legalMoves(position).find(
      (m) =>
        m.from === wanted.from &&
        m.to === wanted.to &&
        // A pawn reaching the last rank must say what it becomes; defaulting
        // to a queen silently would rob anyone who wanted a knight.
        (m.promotion ?? null) === (wanted.promotion ?? null),
    ) ?? null
  );
}

// ----------------------------------------------------------------- render ---

const GLYPH: Record<string, string> = {
  P: "♙", N: "♘", B: "♗", R: "♖", Q: "♕", K: "♔",
  p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚",
  ".": "·",
};

/**
 * The board as text.
 *
 * Unicode glyphs on a monospace grid, because the image service the original
 * rendered through is gone and a picture is not worth a network dependency
 * that can take the feature down with it.
 */
export function render(position: Position, flipped = false): string {
  const rows: string[] = [];
  const ranks = flipped ? [...Array(8).keys()].reverse() : [...Array(8).keys()];
  for (const rank of ranks) {
    const files = flipped ? [...Array(8).keys()].reverse() : [...Array(8).keys()];
    const cells = files.map((file) => GLYPH[position.board[rank * 8 + file] as string] ?? "·");
    rows.push(`${8 - rank} ${cells.join(" ")}`);
  }
  const footer = flipped ? "  h g f e d c b a" : "  a b c d e f g h";
  return ["```", ...rows, footer, "```"].join("\n");
}

/** Leaf count of the move tree at `depth`. The only honest test of a generator. */
export function perft(position: Position, depth: number): number {
  if (depth === 0) return 1;
  const moves = legalMoves(position);
  if (depth === 1) return moves.length;
  let total = 0;
  for (const move of moves) total += perft(applyMove(position, move), depth - 1);
  return total;
}
