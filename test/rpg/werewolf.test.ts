import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Werewolf.
 *
 * Almost all of this game is bookkeeping about who may act and when, so that
 * is what these tests are about: phase gating, the dead staying dead and
 * silent, ties resolving to nothing, and the two win conditions firing at
 * exactly the right moment rather than a turn late.
 */

const engine = await import("../../src/rpg/engine.ts");
const ww = await import("../../src/rpg/werewolf.ts");

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A started game of `n` players, host is u0. */
function started(n: number, seed = 1) {
  const state = engine.newGame();
  ww.openGame(state, "u0");
  for (let i = 1; i < n; i += 1) ww.joinGame(state, `u${i}`);
  const result = ww.startGame(state, "u0", seeded(seed));
  assert.equal(result.ok, true, "the game should start");
  return { state, game: state.werewolf! };
}

const idsWithRole = (g: ReturnType<typeof started>["game"], role: string) =>
  g.players.filter((p) => p.role === role).map((p) => p.userId);

test("the role spread always accounts for every player", () => {
  for (let n = ww.MIN_PLAYERS; n <= ww.MAX_PLAYERS; n += 1) {
    const spread = ww.roleSpread(n);
    const total = spread.wolf + spread.seer + spread.guard + spread.villager;
    assert.equal(total, n, `${n} players: spread sums to ${total}`);
    assert.ok(spread.wolf >= 1, `${n} players: no wolves`);
    assert.equal(spread.seer, 1, `${n} players: the seer is not optional`);
    // The wolves must never start at parity, or the village loses at dawn.
    assert.ok(spread.wolf < n - spread.wolf, `${n} players: wolves start at parity`);
  }
});

test("starting deals every role out exactly once", () => {
  const { game } = started(9, 4);
  assert.equal(game.phase, "night");
  assert.equal(game.night, 1);
  assert.equal(game.players.length, 9);
  assert.ok(game.players.every((p) => p.alive));

  const spread = ww.roleSpread(9);
  for (const role of ["wolf", "seer", "guard", "villager"] as const) {
    assert.equal(idsWithRole(game, role).length, spread[role], `wrong number of ${role}s`);
  }
});

test("a game will not start under-filled, and only the host starts it", () => {
  const state = engine.newGame();
  ww.openGame(state, "u0");
  for (let i = 1; i < ww.MIN_PLAYERS - 1; i += 1) ww.joinGame(state, `u${i}`);

  assert.equal(ww.startGame(state, "u0", seeded(1)).ok, false, "too few players");
  ww.joinGame(state, "u9");
  assert.equal(ww.startGame(state, "u1", seeded(1)).ok, false, "not the host");
  assert.equal(ww.startGame(state, "u0", seeded(1)).ok, true);
});

test("the lobby closes once the game starts", () => {
  const { state } = started(6);
  assert.equal(ww.joinGame(state, "newcomer").ok, false);
  assert.equal(ww.leaveLobby(state, "u1").ok, false, "no leaving mid-game");
});

test("only the right roles act at night, and never on themselves", () => {
  const { state, game } = started(8, 7);
  const wolf = idsWithRole(game, "wolf")[0] as string;
  const seer = idsWithRole(game, "seer")[0] as string;
  const guard = idsWithRole(game, "guard")[0] as string;
  const villager = idsWithRole(game, "villager")[0] as string;
  const victim = game.players.find((p) => p.role !== "wolf")!.userId;

  assert.equal(ww.nightAction(state, villager, victim).ok, false, "villagers sleep");
  assert.equal(ww.nightAction(state, seer, seer).ok, false, "the seer knows itself");
  assert.equal(ww.nightAction(state, guard, guard).ok, false, "no self-guarding");
  assert.equal(ww.nightAction(state, wolf, idsWithRole(game, "wolf")[0] as string).ok, false, "no cannibalism");

  const looked = ww.nightAction(state, seer, victim);
  assert.equal(looked.ok, true);
  if (looked.ok) {
    assert.equal(looked.value.seerSaw, ww.playerIn(game, victim)!.role, "the seer sees the truth");
  }
  assert.equal(ww.nightAction(state, wolf, victim).ok, true);
});

test("the guard saves the wolves' target", () => {
  const { state, game } = started(8, 11);
  const wolfIds = idsWithRole(game, "wolf");
  const guard = idsWithRole(game, "guard")[0] as string;
  const victim = game.players.find((p) => p.role === "villager")!.userId;

  for (const wolf of wolfIds) ww.nightAction(state, wolf, victim);
  ww.nightAction(state, guard, victim);

  const dawn = ww.resolveNight(state, "u0");
  assert.equal(dawn.ok, true);
  if (!dawn.ok) return;
  assert.equal(dawn.value.saved, true);
  assert.equal(dawn.value.victimId, null);
  assert.equal(ww.playerIn(game, victim)!.alive, true, "the guarded player lives");
});

test("an unguarded victim dies, and the night's slate is wiped", () => {
  const { state, game } = started(8, 13);
  const wolfIds = idsWithRole(game, "wolf");
  const victim = game.players.find((p) => p.role === "villager")!.userId;
  for (const wolf of wolfIds) ww.nightAction(state, wolf, victim);

  const dawn = ww.resolveNight(state, "u0");
  assert.equal(dawn.ok, true);
  assert.equal(ww.playerIn(game, victim)!.alive, false);
  assert.equal(game.phase, "day");
  assert.deepEqual(game.wolfVotes, {}, "night actions must not carry over");
  assert.equal(game.guardTarget, null);
});

test("a split pack kills nobody", () => {
  const { state, game } = started(12, 17);
  const wolfIds = idsWithRole(game, "wolf");
  assert.ok(wolfIds.length >= 2, "this test needs a pack");

  const targets = game.players.filter((p) => p.role !== "wolf").map((p) => p.userId);
  // Each wolf names a different victim: a tie, so they argue until dawn.
  wolfIds.forEach((wolf, i) => ww.nightAction(state, wolf, targets[i] as string));

  const dawn = ww.resolveNight(state, "u0");
  assert.equal(dawn.ok, true);
  if (dawn.ok) assert.equal(dawn.value.victimId, null);
  assert.ok(game.players.every((p) => p.alive), "nobody dies on a tie");
});

test("the dead neither act nor vote", () => {
  const { state, game } = started(8, 19);
  const wolfIds = idsWithRole(game, "wolf");
  const victim = game.players.find((p) => p.role === "villager")!.userId;
  for (const wolf of wolfIds) ww.nightAction(state, wolf, victim);
  ww.resolveNight(state, "u0");

  const survivor = ww.living(game)[0]!.userId;
  assert.equal(ww.vote(state, victim, survivor).ok, false, "the dead do not vote");
  ww.resolveDay(state, "u0");
  assert.equal(ww.nightAction(state, victim, survivor).ok, false, "the dead do not act");
});

test("phases gate their own actions", () => {
  const { state, game } = started(8, 23);
  const alive = ww.living(game);
  // It is night: voting is not a thing yet.
  assert.equal(ww.vote(state, alive[0]!.userId, alive[1]!.userId).ok, false);
  assert.equal(ww.resolveDay(state, "u0").ok, false, "no day to resolve");

  ww.resolveNight(state, "u0");
  const stillAlive = ww.living(game);
  assert.equal(
    ww.nightAction(state, stillAlive[0]!.userId, stillAlive[1]!.userId).ok,
    false,
    "no night actions in daylight",
  );
});

test("only the host advances the clock", () => {
  const { state } = started(8, 29);
  assert.equal(ww.resolveNight(state, "u1").ok, false, "not the host");
  assert.equal(ww.resolveNight(state, "u0").ok, true);
  assert.equal(ww.resolveDay(state, "u1").ok, false, "not the host");
});

test("a tied vote hangs nobody", () => {
  const { state, game } = started(8, 31);
  ww.resolveNight(state, "u0");
  const alive = ww.living(game);
  // Two votes each way.
  ww.vote(state, alive[0]!.userId, alive[2]!.userId);
  ww.vote(state, alive[1]!.userId, alive[3]!.userId);

  const dusk = ww.resolveDay(state, "u0");
  assert.equal(dusk.ok, true);
  if (dusk.ok) assert.equal(dusk.value.lynchedId, null);
  assert.equal(ww.living(game).length, alive.length, "nobody hangs on a tie");
});

test("the village wins the moment the last wolf dies", () => {
  const { state, game } = started(8, 37);
  for (const wolf of idsWithRole(game, "wolf")) {
    ww.playerIn(game, wolf)!.alive = false;
  }
  ww.checkWin(game);
  assert.equal(game.phase, "over");
  assert.equal(game.winner, "village");
});

test("the wolves win at parity, not at a majority", () => {
  const { state, game } = started(8, 41);
  const pack = idsWithRole(game, "wolf");
  const others = game.players.filter((p) => p.role !== "wolf").map((p) => p.userId);

  // Kill villagers until exactly as many remain as there are wolves.
  const toKill = others.length - pack.length;
  for (let i = 0; i < toKill; i += 1) ww.playerIn(game, others[i] as string)!.alive = false;

  ww.checkWin(game);
  assert.equal(game.phase, "over");
  assert.equal(game.winner, "wolves");
  void state;
});

test("a finished game is not resurrected by another check", () => {
  const { game } = started(6, 43);
  for (const wolf of idsWithRole(game, "wolf")) ww.playerIn(game, wolf)!.alive = false;
  ww.checkWin(game);
  const entries = game.log.length;
  ww.checkWin(game);
  assert.equal(game.log.length, entries, "checking twice must not narrate twice");
});

test("a full game reaches a winner without getting stuck", () => {
  for (const seed of [2, 5, 8, 12, 20]) {
    const { state, game } = started(7, seed);
    let guard = 0;

    while (game.phase !== "over" && guard < 60) {
      guard += 1;
      if (game.phase === "night") {
        const pack = ww.living(game).filter((p) => p.role === "wolf");
        const prey = ww.living(game).find((p) => p.role !== "wolf");
        if (prey) for (const wolf of pack) ww.nightAction(state, wolf.userId, prey.userId);
        ww.resolveNight(state, "u0");
      } else if (game.phase === "day") {
        const alive = ww.living(game);
        // Everyone piles on the first living player who is not themselves.
        const accused = alive.find((p) => p.userId !== alive[0]!.userId);
        if (accused) for (const voter of alive) {
          if (voter.userId !== accused.userId) ww.vote(state, voter.userId, accused.userId);
        }
        ww.resolveDay(state, "u0");
      }
    }

    assert.equal(game.phase, "over", `seed ${seed} never finished`);
    assert.ok(game.winner === "village" || game.winner === "wolves", `seed ${seed}: no winner`);
    assert.ok(guard < 60, `seed ${seed} took too long`);
  }
});
