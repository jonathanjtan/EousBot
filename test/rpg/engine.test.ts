import assert from "node:assert/strict";
import { test } from "node:test";

const engine = await import("../../src/rpg/engine.ts");
const rules = await import("../../src/rpg/rules.ts");

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

function world(classId: "warrior" | "mage" | "thief" = "warrior") {
  const state = engine.newGame();
  engine.create(state, "u0", "Alpha", classId, ctx());
  return state;
}

test("a new character starts equipped, not naked", () => {
  const state = world();
  const c = engine.find(state, "u0")!;
  assert.equal(c.level, 1);
  assert.ok(c.weapon && c.armor, "a starting kit is equipped");
  assert.ok(c.money > 0);
  // Distinct ids, or equipping and selling address the wrong thing.
  assert.notEqual(c.weapon!.id, c.armor!.id);
  // The first adventure should be a favourable bet, not a coin flip.
  assert.ok(rules.successChance(c, 1) > 0.6, `first odds were ${rules.successChance(c, 1)}`);
});

test("one character per account, one name per realm", () => {
  const state = world();
  assert.equal(engine.create(state, "u0", "Other", "mage", ctx()).ok, false);
  const clash = engine.create(state, "u1", "alpha", "mage", ctx());
  assert.equal(clash.ok, false);
  assert.match(clash.ok ? "" : clash.reason, /already called/i);
});

test("an adventure has to finish before it pays", () => {
  const state = world();
  const started = engine.startExpedition(state, "u0", 1, ctx());
  assert.equal(started.ok, true);

  const early = engine.claimExpedition(state, "u0", ctx(1, START + 60_000));
  assert.equal(early.kind, "pending");
  // Still out, so a second dispatch is refused rather than silently replacing it.
  assert.equal(engine.startExpedition(state, "u0", 1, ctx()).ok, false);

  const late = engine.claimExpedition(state, "u0", ctx(1, START + 999_999_999));
  assert.equal(late.kind, "done");
  assert.equal(engine.find(state, "u0")!.expedition, null, "claiming clears the slot");
});

test("difficulty is bounded by level, and the bound is enforced", () => {
  const state = world();
  const ceiling = rules.maxDifficultyFor(engine.find(state, "u0")!);
  assert.equal(engine.startExpedition(state, "u0", ceiling + 1, ctx()).ok, false);
  assert.equal(engine.startExpedition(state, "u0", 0, ctx()).ok, false);
  assert.equal(engine.startExpedition(state, "u0", 1.5, ctx()).ok, false);
  assert.equal(engine.startExpedition(state, "u0", ceiling, ctx()).ok, true);
});

test("a win pays and a loss does not", () => {
  let sawWin = false;
  let sawLoss = false;

  for (let seed = 0; seed < 40 && !(sawWin && sawLoss); seed += 1) {
    const state = world();
    const before = engine.find(state, "u0")!.money;
    engine.startExpedition(state, "u0", 1, ctx(seed));
    const result = engine.claimExpedition(state, "u0", ctx(seed, START + 999_999_999));
    assert.equal(result.kind, "done");
    if (result.kind !== "done") continue;

    const after = engine.find(state, "u0")!.money;
    if (result.reward.won) {
      sawWin = true;
      assert.ok(after > before, "a win must pay");
      assert.ok(result.reward.xp > 0);
    } else {
      sawLoss = true;
      assert.equal(after, before, "a loss costs the time and nothing else");
      assert.equal(result.reward.xp, 0);
    }
  }
  assert.ok(sawWin && sawLoss, "difficulty 1 should produce both outcomes across seeds");
});

test("levelling advances the class tier by itself", () => {
  const state = world();
  const c = engine.find(state, "u0")!;
  c.level = 4;
  c.xp = rules.xpToLevel(4) - 1;
  assert.equal(c.tier, 0);

  engine.startExpedition(state, "u0", 1, ctx(3));
  // Force the win so the test is about tiers, not luck.
  const result = engine.claimExpedition(state, "u0", {
    rng: () => 0,
    now: START + 999_999_999,
    tuning: rules.DEFAULT_TUNING,
  });
  assert.equal(result.kind, "done");
  assert.ok(c.level >= 5);
  assert.equal(c.tier, 1, "reaching level 5 should promote without a command");
});

test("an upgrade from a crate equips itself; a downgrade does not", () => {
  const state = world();
  const c = engine.find(state, "u0")!;
  c.crates.legendary = 1;
  c.level = 30;

  const opened = engine.openCrate(state, "u0", "legendary", ctx(7));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(opened.equipped, true, "a level-30 legendary must beat the starting kit");

  // And the reverse: a junk item at high level goes to the pack.
  c.crates.common = 1;
  c.weapon = { id: 99, name: "Great Sword", kind: "weapon", value: 9999, rarity: "legendary" };
  c.armor = { id: 98, name: "Great Plate", kind: "armor", value: 9999, rarity: "legendary" };
  const junk = engine.openCrate(state, "u0", "common", ctx(8));
  assert.equal(junk.ok, true);
  if (!junk.ok) return;
  assert.equal(junk.equipped, false);
  assert.equal(c.backpack.length, 1);
});

test("a full backpack sells the overflow instead of losing it", () => {
  const state = world();
  const c = engine.find(state, "u0")!;
  c.weapon = { id: 99, name: "x", kind: "weapon", value: 9999, rarity: "legendary" };
  c.armor = { id: 98, name: "y", kind: "armor", value: 9999, rarity: "legendary" };
  for (let i = 0; i < rules.DEFAULT_TUNING.backpackSize; i += 1) {
    c.backpack.push({ id: 1000 + i, name: "junk", kind: "weapon", value: 1, rarity: "common" });
  }
  c.crates.common = 1;
  const before = c.money;

  const opened = engine.openCrate(state, "u0", "common", ctx(5));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.ok(opened.soldOverflow > 0, "the find must not vanish");
  assert.equal(c.money, before + opened.soldOverflow);
  assert.equal(c.backpack.length, rules.DEFAULT_TUNING.backpackSize);
});

test("equipping swaps rather than destroys", () => {
  const state = world();
  const c = engine.find(state, "u0")!;
  const old = c.weapon!;
  c.backpack.push({ id: 500, name: "Better Sword", kind: "weapon", value: 99, rarity: "rare" });

  const result = engine.equip(state, "u0", 500);
  assert.equal(result.ok, true);
  assert.equal(c.weapon!.id, 500);
  assert.ok(c.backpack.some((i) => i.id === old.id), "the displaced item goes back to the pack");
  assert.equal(engine.equip(state, "u0", 9999).ok, false);
});

test("selling empties the pack and fills the purse", () => {
  const state = world();
  const c = engine.find(state, "u0")!;
  c.backpack.push(
    { id: 1, name: "junk", kind: "weapon", value: 2, rarity: "common" },
    { id: 2, name: "keep", kind: "armor", value: 80, rarity: "rare" },
  );
  const before = c.money;

  const result = engine.sellAll(state, "u0", 10);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.count, 1, "only the junk sells");
  assert.equal(c.backpack.length, 1);
  assert.equal(c.backpack[0]!.id, 2);
  assert.equal(c.money, before + result.paid);
});

test("a duel moves the stake one way and only one way", () => {
  const state = engine.newGame();
  engine.create(state, "u0", "Alpha", "warrior", ctx());
  engine.create(state, "u1", "Beta", "mage", ctx());
  const a = engine.find(state, "u0")!;
  const b = engine.find(state, "u1")!;
  const pot = a.money + b.money;

  const result = engine.duel(state, "u0", "u1", 50, ctx(2));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(a.money + b.money, pot, "a duel creates no coin");
  assert.equal(result.outcome.winner.money - result.outcome.loser.money, 100);
  assert.equal(result.outcome.winner.stats.duelsWon, 1);
  assert.equal(result.outcome.loser.stats.duelsLost, 1);
});

test("a duel nobody can cover is refused", () => {
  const state = engine.newGame();
  engine.create(state, "u0", "Alpha", "warrior", ctx());
  engine.create(state, "u1", "Beta", "mage", ctx());
  assert.equal(engine.duel(state, "u0", "u1", 999_999, ctx()).ok, false);
  assert.equal(engine.duel(state, "u0", "u0", 10, ctx()).ok, false);
  assert.equal(engine.duel(state, "u0", "nobody", 10, ctx()).ok, false);
  assert.equal(engine.duel(state, "u0", "u1", 0, ctx()).ok, false);
});

test("the ranking sorts by level, then experience, then coin", () => {
  const state = engine.newGame();
  engine.create(state, "u0", "A", "warrior", ctx());
  engine.create(state, "u1", "B", "mage", ctx());
  engine.create(state, "u2", "C", "thief", ctx());
  engine.find(state, "u0")!.level = 3;
  engine.find(state, "u1")!.level = 9;
  engine.find(state, "u2")!.level = 3;
  engine.find(state, "u2")!.xp = 500;

  assert.deepEqual(engine.leaderboard(state, 10).map((c) => c.name), ["B", "C", "A"]);
});
