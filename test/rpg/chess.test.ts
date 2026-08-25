import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The chess engine, validated by perft.
 *
 * Perft counts the leaves of the move tree to a fixed depth. The expected
 * numbers are not ours -- they are the standard published counts that every
 * engine is checked against, and they are unforgiving: a single missing
 * en-passant capture or one castle through check moves the total and the test
 * fails. Everything else in this file is a convenience compared to these.
 *
 * The four non-opening positions are the usual suspects, chosen because each
 * one breaks a different naive implementation: pins, castling rights, promotion
 * under check, and en passant that would expose the king.
 */

const chess = await import("../../src/rpg/chess.ts");

function position(fen: string) {
  const parsed = chess.parseFen(fen);
  assert.ok(parsed, `could not parse ${fen}`);
  return parsed;
}

test("perft from the opening position", () => {
  const start = position(chess.START_FEN);
  assert.equal(chess.perft(start, 1), 20);
  assert.equal(chess.perft(start, 2), 400);
  assert.equal(chess.perft(start, 3), 8_902);
  assert.equal(chess.perft(start, 4), 197_281);
});

test("perft from Kiwipete, which catches castling and pin bugs", () => {
  const p = position("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1");
  assert.equal(chess.perft(p, 1), 48);
  assert.equal(chess.perft(p, 2), 2_039);
  assert.equal(chess.perft(p, 3), 97_862);
});

test("perft from an endgame that catches en-passant discovered check", () => {
  const p = position("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1");
  assert.equal(chess.perft(p, 1), 14);
  assert.equal(chess.perft(p, 2), 191);
  assert.equal(chess.perft(p, 3), 2_812);
  assert.equal(chess.perft(p, 4), 43_238);
});

test("perft from a position full of promotions", () => {
  const p = position("r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1");
  assert.equal(chess.perft(p, 1), 6);
  assert.equal(chess.perft(p, 2), 264);
  assert.equal(chess.perft(p, 3), 9_467);
});

test("perft from a cramped middlegame", () => {
  const p = position("rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8");
  assert.equal(chess.perft(p, 1), 44);
  assert.equal(chess.perft(p, 2), 1_486);
  assert.equal(chess.perft(p, 3), 62_379);
});

// ------------------------------------------------------------------- FEN ---

test("FEN round-trips exactly", () => {
  for (const fen of [
    chess.START_FEN,
    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
    "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3",
  ]) {
    assert.equal(chess.toFen(position(fen)), fen, `round trip failed for ${fen}`);
  }
});

test("malformed FEN is refused rather than half-parsed", () => {
  for (const bad of ["", "not a fen", "8/8/8/8/8/8/8 w - - 0 1", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1"]) {
    assert.equal(chess.parseFen(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test("squares map both ways", () => {
  assert.equal(chess.squareName(0), "a8");
  assert.equal(chess.squareName(63), "h1");
  assert.equal(chess.squareIndex("e4"), 36);
  assert.equal(chess.squareName(36), "e4");
  assert.equal(chess.squareIndex("z9"), null);
});

// ------------------------------------------------------------ game status ---

test("a back-rank mate is detected as mate", () => {
  // Black king on h8, white rook delivers on the back rank.
  const p = position("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1");
  const move = chess.parseMove(p, "a1a8");
  assert.ok(move, "Ra8 should be legal");
  const after = chess.applyMove(p, move);
  const result = chess.status(after);
  assert.equal(result.kind, "checkmate");
  if (result.kind === "checkmate") assert.equal(result.winner, "w");
});

test("fool's mate is mate", () => {
  let p = position(chess.START_FEN);
  for (const text of ["f2f3", "e7e5", "g2g4", "d8h4"]) {
    const move = chess.parseMove(p, text);
    assert.ok(move, `${text} should be legal`);
    p = chess.applyMove(p, move);
  }
  assert.equal(chess.status(p).kind, "checkmate");
});

test("stalemate is not mate", () => {
  const p = position("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
  assert.equal(chess.inCheck(p), false, "the king is not attacked");
  assert.equal(chess.legalMoves(p).length, 0, "and has nowhere to go");
  assert.equal(chess.status(p).kind, "stalemate");
});

test("lone kings are a draw, and so is king plus one minor", () => {
  assert.equal(chess.status(position("7k/8/8/8/8/8/8/K7 w - - 0 1")).kind, "draw");
  assert.equal(chess.status(position("7k/8/8/8/8/8/8/KN6 w - - 0 1")).kind, "draw");
  // A rook is enough to force mate, so that is still a game.
  assert.equal(chess.status(position("7k/8/8/8/8/8/8/KR6 w - - 0 1")).kind, "playing");
});

test("the fifty-move rule ends the game", () => {
  const p = position("7k/8/8/8/8/8/R7/K7 w - - 100 80");
  assert.equal(chess.status(p).kind, "draw");
});

// ------------------------------------------------------------ move rules ---

test("a pinned piece may not step aside", () => {
  // The white knight on e2 is pinned to the king on e1 by the rook on e8.
  const p = position("4r2k/8/8/8/8/8/4N3/4K3 w - - 0 1");
  const moves = chess.legalMoves(p);
  assert.ok(
    moves.every((m) => chess.squareName(m.from) !== "e2"),
    "the pinned knight must not be able to move",
  );
});

test("castling is refused through, out of, and into check", () => {
  // A castling move is the *king* going to g1. Matching on the destination
  // alone also catches the rook on h1 sliding to g1, which is a legal and
  // entirely different move.
  const castles = (p: ReturnType<typeof position>) =>
    chess
      .legalMoves(p)
      .some((m) => chess.squareName(m.from) === "e1" && chess.squareName(m.to) === "g1");

  // Rook on f8 covers f1, so white cannot castle kingside through it.
  assert.equal(
    castles(position("5r1k/8/8/8/8/8/8/4K2R w K - 0 1")),
    false,
    "must not castle through an attacked square",
  );
  // Rook on g8 covers g1, the square the king lands on.
  assert.equal(
    castles(position("6rk/8/8/8/8/8/8/4K2R w K - 0 1")),
    false,
    "must not castle into check",
  );
  // Rook on e8 gives check, so the king may not castle out of it.
  assert.equal(
    castles(position("4r2k/8/8/8/8/8/8/4K2R w K - 0 1")),
    false,
    "must not castle out of check",
  );
  // Nothing on the kingside: castling is fine.
  assert.equal(castles(position("r6k/8/8/8/8/8/8/4K2R w K - 0 1")), true);
});

test("moving a rook forfeits that side's castling right only", () => {
  const p = position("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  const move = chess.parseMove(p, "h1h2");
  assert.ok(move);
  const after = chess.applyMove(p, move);
  assert.equal(after.castling.includes("K"), false, "kingside right is gone");
  assert.equal(after.castling.includes("Q"), true, "queenside survives");
  assert.equal(after.castling.includes("k"), true, "black is untouched");
});

test("capturing a rook on its home square forfeits the right too", () => {
  // The classic omission: rights must drop for the *captured* rook.
  const p = position("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  const grab = chess.parseMove(p, "a1a8");
  assert.ok(grab, "Rxa8 should be legal");
  const after = chess.applyMove(p, grab);
  assert.equal(after.castling.includes("q"), false, "black's queenside right dies with the rook");
});

test("en passant captures the pawn that is not on the target square", () => {
  const p = position("rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3");
  const move = chess.parseMove(p, "e5f6");
  assert.ok(move, "exf6 e.p. should be legal");
  const after = chess.applyMove(p, move);
  assert.equal(after.board[chess.squareIndex("f5") as number], ".", "the captured pawn is gone");
  assert.equal(after.board[chess.squareIndex("f6") as number], "P");
});

test("promotion must say what it becomes", () => {
  const p = position("8/P6k/8/8/8/8/8/K7 w - - 0 1");
  assert.equal(chess.parseMove(p, "a7a8"), null, "a bare push must not silently queen");

  const knight = chess.parseMove(p, "a7a8n");
  assert.ok(knight);
  assert.equal(chess.applyMove(p, knight).board[chess.squareIndex("a8") as number], "N");

  const queen = chess.parseMove(p, "a7a8q");
  assert.ok(queen);
  assert.equal(chess.applyMove(p, queen).board[chess.squareIndex("a8") as number], "Q");
});

test("illegal and malformed input is refused", () => {
  const p = position(chess.START_FEN);
  for (const bad of ["e2e5", "a1a3", "hello", "e2", "e9e4", ""]) {
    assert.equal(chess.parseMove(p, bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.ok(chess.parseMove(p, "E2-E4"), "case and dashes are tolerated");
});

test("applying a move never mutates the position it was given", () => {
  const p = position(chess.START_FEN);
  const before = chess.toFen(p);
  const move = chess.parseMove(p, "e2e4");
  assert.ok(move);
  chess.applyMove(p, move);
  assert.equal(chess.toFen(p), before, "generation plays candidate moves; mutation would corrupt it");
});

test("the board renders from both sides", () => {
  const p = position(chess.START_FEN);
  const white = chess.render(p);
  const black = chess.render(p, true);
  assert.match(white, /a b c d e f g h/);
  assert.match(black, /h g f e d c b a/);
  assert.notEqual(white, black);
});
