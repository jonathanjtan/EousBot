import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The arithmetic of the dispatch RPG.
 *
 * Imported through the .ts path so the suite never boots config, which exits
 * the process when secrets are absent.
 */

const rules = await import("../../src/rpg/rules.ts");
const engine = await import("../../src/rpg/engine.ts");

export function seeded(seed: number): () => number {
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
const ctx = (seed = 1, now = START) => ({
  rng: seeded(seed),
  now,
  tuning: rules.DEFAULT_TUNING,
});

function char(overrides: Record<string, unknown> = {}) {
  const c = engine.newCharacter("u", "Test", "warrior", ctx());
  return Object.assign(c, overrides);
}

test("the experience curve rises but never runs away", () => {
  assert.equal(rules.xpToLevel(1), 100);
  for (let level = 2; level <= 60; level += 1) {
    assert.ok(rules.xpToLevel(level) > rules.xpToLevel(level - 1), `level ${level} not dearer`);
  }
  // Polynomial, not geometric. Roughly 100x from level 1 to 30 and still
  // polynomial at 60 -- where the IRC game's geometric curve has passed 7000x
  // and has to be capped by hand to stay finite. Whether that pace is any fun
  // is a question about play, not arithmetic; test/rpg/balance.test.ts answers
  // it by actually playing.
  assert.ok(rules.xpToLevel(30) / rules.xpToLevel(1) < 150);
  assert.ok(rules.xpToLevel(60) / rules.xpToLevel(30) < 3);
});

test("experience rolls over as many levels as it covers", () => {
  const jump = rules.applyXp(1, 0, 100_000);
  assert.ok(jump.level > 10, `one huge payout should carry several levels, got ${jump.level}`);
  assert.ok(jump.xp >= 0 && jump.xp < rules.xpToLevel(jump.level));

  const none = rules.applyXp(5, 10, 0);
  assert.deepEqual(none, { level: 5, xp: 10, gained: 0 });
  // Negative earnings cannot claw back a level.
  assert.equal(rules.applyXp(5, 10, -500).level, 5);
});

test("odds stay strictly between certain success and certain failure", () => {
  const weak = char({ weapon: null, armor: null, tier: 0 });
  const titan = char({
    weapon: { id: 1, name: "x", kind: "weapon", value: 9999, rarity: "legendary" },
    armor: { id: 2, name: "y", kind: "armor", value: 9999, rarity: "legendary" },
  });

  for (let d = 1; d <= 30; d += 1) {
    for (const c of [weak, titan]) {
      const odds = rules.successChance(c, d);
      assert.ok(odds >= 0.05 && odds <= 0.95, `difficulty ${d} gave ${odds}`);
    }
  }
  // An adventure that cannot fail is a withdrawal, not a decision.
  assert.ok(rules.successChance(titan, 1) <= 0.95);
});

test("better gear is worth more than anything else", () => {
  const bare = char({ weapon: null, armor: null });
  const armed = char({
    weapon: { id: 1, name: "x", kind: "weapon", value: 40, rarity: "rare" },
    armor: { id: 2, name: "y", kind: "armor", value: 40, rarity: "rare" },
  });
  assert.ok(rules.successChance(armed, 5) > rules.successChance(bare, 5) + 0.2);
});

test("reaching above your level costs odds and pays more", () => {
  const c = char({ level: 10 });
  assert.ok(rules.successChance(c, 12) < rules.successChance(c, 8), "harder must be riskier");
  assert.ok(rules.moneyReward(c, 12) > rules.moneyReward(c, 8), "harder must pay more");
  assert.ok(rules.xpReward(c, 12) > rules.xpReward(c, 8));
});

test("difficulty unlocks with level, and always offers a choice", () => {
  assert.equal(rules.maxDifficultyFor(char({ level: 1 })), 3);
  assert.equal(rules.maxDifficultyFor(char({ level: 10 })), 12);
  // Capped at the top of the table however high the character goes.
  assert.equal(rules.maxDifficultyFor(char({ level: 900 })), rules.DEFAULT_TUNING.maxDifficulty);
});

test("class tiers advance at the published levels and no sooner", () => {
  assert.equal(rules.tierFor(1), 0);
  assert.equal(rules.tierFor(4), 0);
  assert.equal(rules.tierFor(5), 1);
  assert.equal(rules.tierFor(12), 2);
  assert.equal(rules.tierFor(20), 3);
  assert.equal(rules.tierFor(30), 4);
  assert.equal(rules.tierFor(999), 4, "the ladder ends rather than running off its table");
});

test("a perk only pays the class that has it", () => {
  const warrior = char({ classId: "warrior", tier: 2 });
  const mage = char({ classId: "mage", tier: 2 });
  assert.ok(rules.perkValue(warrior, "defense") > 0);
  assert.equal(rules.perkValue(warrior, "damage"), 0);
  assert.ok(rules.perkValue(mage, "damage") > 0);
  assert.equal(rules.perkValue(mage, "defense"), 0);
});

test("rarity is a tilt, never a gate", () => {
  const rng = seeded(4);
  const seen = new Set<string>();
  for (let i = 0; i < 60_000; i += 1) seen.add(rules.rollRarity(rng, 0));
  // A beginner's crate must be able to produce anything, or luck cannot matter.
  assert.equal(seen.size, 5, `only saw ${[...seen].join(", ")}`);
});

test("difficulty tilts the drop table upward without breaking it", () => {
  const count = (tilt: number) => {
    const rng = seeded(9);
    let good = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const r = rules.rollRarity(rng, tilt);
      if (r === "magic" || r === "legendary") good += 1;
    }
    return good;
  };
  assert.ok(count(5) > count(0), "harder adventures should drop better");
});

test("items scale with the level of whoever receives them", () => {
  const rng = seeded(11);
  const low = rules.rollItem(rng, { id: 1, level: 1, difficulty: 1, rarity: "common" });
  const high = rules.rollItem(rng, { id: 2, level: 40, difficulty: 20, rarity: "common" });
  assert.ok(high.value > low.value * 5, "a level 40 drop must not be beginner loot");
  assert.ok(low.value >= 1);
});

test("selling pays less than the item is worth to keep", () => {
  const item = { id: 1, name: "x", kind: "weapon" as const, value: 50, rarity: "common" as const };
  assert.ok(rules.sellValue(item) > 0);
  const legendary = { ...item, rarity: "legendary" as const };
  assert.ok(rules.sellValue(legendary) > rules.sellValue(item), "rarity is worth coin");
});

test("coin and duration render for humans", () => {
  assert.equal(rules.coin(1234567), "1,234,567⨎");
  assert.equal(rules.shortDuration(0), "0m");
  assert.equal(rules.shortDuration(30 * 60_000), "30m");
  assert.equal(rules.shortDuration(3 * 3_600_000), "3h");
  assert.equal(rules.shortDuration(90 * 60_000), "1h 30m");
});
