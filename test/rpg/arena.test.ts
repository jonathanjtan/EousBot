import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Free-for-all matches, realm-wide events, and trivia.
 *
 * The arena's whole reason to exist alongside the tournament is that it is a
 * lottery rather than a ranking, so the tests here measure exactly that: the
 * strongest entrant must win more often than chance and far less often than
 * always.
 */

const engine = await import("../../src/rpg/engine.ts");
const rules = await import("../../src/rpg/rules.ts");
const arena = await import("../../src/rpg/arena.ts");
const worldevent = await import("../../src/rpg/worldevent.ts");

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

const START = Date.UTC(2026, 0, 1);
const ctx = (seed = 1, now = START) => ({ rng: seeded(seed), now, tuning: rules.DEFAULT_TUNING });

function realm(n: number, money = 100_000) {
  const state = engine.newGame();
  for (let i = 0; i < n; i += 1) {
    engine.create(state, `u${i}`, `P${i}`, "warrior", ctx());
    engine.find(state, `u${i}`)!.money = money;
  }
  return state;
}

const totalCoin = (s: ReturnType<typeof realm>) =>
  Object.values(s.characters).reduce((sum, c) => sum + c.money, 0);

// ------------------------------------------------------------------ arena ---

test("a match takes buy-ins and pays one survivor", () => {
  const state = realm(8);
  assert.equal(arena.openArena(state, "u0", 500, ctx()).ok, true);
  for (let i = 1; i < 8; i += 1) assert.equal(arena.enterArena(state, `u${i}`, ctx()).ok, true);

  const before = totalCoin(state);
  const result = arena.runArena(state, ctx(5));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.pot, 4_000);
  assert.ok(result.value.winner, "somebody must survive");
  assert.equal(totalCoin(state), before + 4_000, "the pot was held aside, then paid");
  assert.ok(result.value.arena.log.length > 0, "the match must narrate itself");
});

test("every field size resolves to exactly one survivor", () => {
  for (const n of [3, 4, 5, 7, 11, 20]) {
    const state = realm(n);
    arena.openArena(state, "u0", 10, ctx());
    for (let i = 1; i < n; i += 1) arena.enterArena(state, `u${i}`, ctx());
    const result = arena.runArena(state, ctx(n));
    assert.equal(result.ok, true, `${n} entrants failed`);
    if (result.ok) assert.ok(result.value.winner, `${n} entrants produced no winner`);
  }
});

test("too small a field refunds instead of running", () => {
  const state = realm(2);
  arena.openArena(state, "u0", 1_000, ctx());
  arena.enterArena(state, "u1", ctx());

  const result = arena.runArena(state, ctx());
  assert.equal(result.ok, false);
  assert.equal(totalCoin(state), 200_000, "everyone got their buy-in back");
  assert.equal(state.arena, null);
});

/**
 * The property that makes the arena worth having next to the tournament.
 */
test("the strongest entrant is favoured but nowhere near safe", () => {
  let titanWins = 0;
  const runs = 200;

  for (let seed = 0; seed < runs; seed += 1) {
    const state = realm(6);
    // One entrant with roughly four times everyone else's power.
    const titan = engine.find(state, "u0")!;
    titan.weapon = { id: 90, name: "x", kind: "weapon", value: 200, rarity: "legendary" };
    titan.armor = { id: 91, name: "y", kind: "armor", value: 200, rarity: "legendary" };

    arena.openArena(state, "u0", 0, ctx(seed));
    for (let i = 1; i < 6; i += 1) arena.enterArena(state, `u${i}`, ctx(seed));
    const result = arena.runArena(state, ctx(seed));
    if (result.ok && result.value.winner?.userId === "u0") titanWins += 1;
  }

  const rate = titanWins / runs;
  assert.ok(rate > 1 / 6, `the titan won ${(rate * 100).toFixed(0)}% — gear should matter at all`);
  assert.ok(rate < 0.6, `the titan won ${(rate * 100).toFixed(0)}% — that is a bracket, not a lottery`);
});

test("a second match cannot open over a live one", () => {
  const state = realm(4);
  arena.openArena(state, "u0", 0, ctx());
  assert.equal(arena.openArena(state, "u1", 0, ctx()).ok, false);
  assert.equal(arena.enterArena(state, "u0", ctx()).ok, false, "the host is already in");
});

test("entry closes when it says it does", () => {
  const state = realm(4);
  arena.openArena(state, "u0", 0, ctx());
  const late = ctx(1, START + arena.ARENA_WINDOW_MS + 1);
  assert.equal(arena.enterArena(state, "u1", late).ok, false);
});

// ----------------------------------------------------------- world events ---

test("an event multiplies the axis it names and nothing else", () => {
  const state = realm(1);
  const event = arena.startEvent(state, ctx(), "bounty");

  assert.equal(worldevent.eventMultiplier(event, "bounty"), 2);
  assert.equal(worldevent.eventMultiplier(event, "study"), 1);
  assert.equal(worldevent.eventMultiplier(event, "fortune"), 1);
  assert.equal(worldevent.eventMultiplier(null, "bounty"), 1);
});

test("an event expires on its own and clears itself", () => {
  const state = realm(1);
  arena.startEvent(state, ctx(), "study");
  assert.ok(worldevent.activeEvent(state, START + 1_000));

  assert.equal(worldevent.activeEvent(state, START + worldevent.EVENT_DURATION_MS + 1), null);
  assert.equal(state.event, null, "an expired event must not linger in the save");
});

test("a bounty actually doubles what an adventure pays", () => {
  const plain = realm(1);
  const bountied = realm(1);
  arena.startEvent(bountied, ctx(), "bounty");

  // Claimed inside the event window. An earlier version of this test claimed
  // far in the future and measured the event correctly *expiring*, which is a
  // real behaviour but not this one.
  const claimAt = START + 2 * 3_600_000 - 60_000;
  const run = (state: ReturnType<typeof realm>) => {
    engine.startExpedition(state, "u0", 1, ctx(3));
    // rng() === 0 forces the win, so this measures the payout, not the luck.
    const result = engine.claimExpedition(state, "u0", {
      rng: () => 0,
      now: claimAt,
      tuning: rules.DEFAULT_TUNING,
    });
    return result.kind === "done" ? result.reward.money : 0;
  };

  const base = run(plain);
  assert.ok(base > 0);
  assert.equal(run(bountied), base * 2);
});

test("the balance suite is unaffected by events, because rules never see them", () => {
  // successChance and the reward formulas take a character and a difficulty,
  // never a world. That is what keeps measured pacing honest.
  const state = realm(1);
  const c = engine.find(state, "u0")!;
  const before = rules.moneyReward(c, 5);
  arena.startEvent(state, ctx(), "bounty");
  assert.equal(rules.moneyReward(c, 5), before);
});

// ----------------------------------------------------------------- trivia ---

test("every trivia question has a valid, in-range answer", () => {
  assert.ok(arena.TRIVIA.length >= 10, "a bank this small repeats too fast");
  for (const q of arena.TRIVIA) {
    assert.ok(q.options.length >= 2 && q.options.length <= 5, `${q.prompt}: bad option count`);
    assert.ok(
      Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length,
      `${q.prompt}: answer index out of range`,
    );
    // Discord button labels cap at 80 characters.
    for (const option of q.options) {
      assert.ok(option.length <= 80, `${q.prompt}: option too long for a button`);
    }
    assert.equal(new Set(q.options).size, q.options.length, `${q.prompt}: duplicate options`);
  }
});

test("a correct answer pays and a wrong one does not", () => {
  const state = realm(1, 0);
  const { index, question } = arena.askTrivia(ctx(7));

  const wrong = (question.answer + 1) % question.options.length;
  const missed = arena.answerTrivia(state, "u0", index, wrong);
  assert.equal(missed.ok, true);
  if (missed.ok) assert.equal(missed.value.correct, false);
  assert.equal(engine.find(state, "u0")!.money, 0);

  const hit = arena.answerTrivia(state, "u0", index, question.answer);
  assert.equal(hit.ok, true);
  if (hit.ok) {
    assert.equal(hit.value.correct, true);
    assert.equal(hit.value.answer, question.options[question.answer]);
  }
  assert.equal(engine.find(state, "u0")!.money, arena.TRIVIA_PRIZE);
});

test("a question that no longer exists is refused rather than crashing", () => {
  const state = realm(1);
  assert.equal(arena.answerTrivia(state, "u0", 9_999, 0).ok, false);
  assert.equal(arena.answerTrivia(state, "nobody", 0, 0).ok, false);
});

// ------------------------------------------------------------------ maths ---

test("a generated sum is always solvable and always has one right answer", () => {
  const rng = seeded(17);
  for (let d = 1; d <= 5; d += 1) {
    for (let i = 0; i < 400; i += 1) {
      const p = arena.makeMathProblem(rng, d);

      assert.equal(p.options.length, 4, `d${d}: wrong option count`);
      assert.equal(new Set(p.options).size, 4, `d${d}: duplicate options in ${p.options.join(",")}`);
      assert.ok(
        p.answer >= 0 && p.answer < p.options.length,
        `d${d}: answer index ${p.answer} out of range`,
      );

      // The labelled answer must actually be the arithmetic result.
      const [lhs] = p.prompt.split(" = ");
      const expr = (lhs as string).replace("×", "*").replace("÷", "/").replace("−", "-");
      const truth = Function(`"use strict";return (${expr})`)() as number;
      assert.equal(
        Number(p.options[p.answer]),
        truth,
        `d${d}: "${p.prompt}" labelled ${p.options[p.answer]}, really ${truth}`,
      );

      // Every option is a positive integer, so nothing reads as a trick.
      for (const option of p.options) {
        const n = Number(option);
        assert.ok(Number.isInteger(n) && n > 0, `d${d}: bad option ${option}`);
        assert.ok(option.length <= 80, `d${d}: option too long for a button`);
      }
    }
  }
});

test("division problems always divide exactly", () => {
  const rng = seeded(23);
  let seen = 0;
  for (let i = 0; i < 3_000; i += 1) {
    const p = arena.makeMathProblem(rng, 4);
    if (!p.prompt.includes("÷")) continue;
    seen += 1;
    const [a, b] = (p.prompt.split(" = ")[0] as string).split(" ÷ ").map(Number);
    assert.equal((a as number) % (b as number), 0, `${p.prompt} does not divide exactly`);
  }
  assert.ok(seen > 50, "division should actually come up at higher difficulty");
});

test("harder sums pay more, and difficulty is clamped to the published range", () => {
  assert.ok(arena.mathPrize(5) > arena.mathPrize(1));
  const rng = seeded(2);
  assert.equal(arena.makeMathProblem(rng, 99).difficulty, 5);
  assert.equal(arena.makeMathProblem(rng, -4).difficulty, 1);
});

// -------------------------------------------------------- seasonal events ---

test("a season is a longer event, and every definition is well formed", () => {
  const state = realm(1);
  const event = arena.startSeason(state, ctx(), 0);
  const ordinary = arena.startEvent(state, ctx(), "bounty");

  assert.ok(
    arena.SEASONS.length >= 4 && event.endsAt - START > ordinary.endsAt - START,
    "a season should outlast an ordinary event",
  );
  for (const season of arena.SEASONS) {
    assert.ok(season.name.length > 0 && season.blurb.length > 0);
    assert.ok(season.multiplier > 1, `${season.name} does nothing`);
    assert.ok(["bounty", "study", "fortune"].includes(season.kind), `${season.name}: bad axis`);
  }
});
