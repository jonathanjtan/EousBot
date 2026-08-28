import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The arithmetic of Idle RPG.
 *
 * Imported through the .ts path so the suite never boots config, which exits
 * the process when secrets are absent. Anything random takes an injected
 * generator, so these are assertions on exact values rather than on ranges.
 *
 * Several tests pin absolute numbers (600 seconds to level 1, 696 to level 2)
 * on purpose: the level curve is the game, and a refactor that quietly moves it
 * should fail here rather than be discovered a month into somebody's character.
 */

const rules = await import("../../src/idlerpg/rules.ts");

/** mulberry32 -- small, seedable, and good enough to make a tick reproducible. */
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

test("the level curve is the canonical one", () => {
  assert.equal(rules.timeToLevel(0), 600, "level 1 costs ten minutes");
  assert.equal(rules.timeToLevel(1), 696);
  assert.equal(rules.timeToLevel(2), 807);

  // Geometric all the way to the cap, and each level strictly dearer.
  for (let level = 1; level <= rules.CURVE_CAP; level += 1) {
    assert.ok(
      rules.timeToLevel(level) > rules.timeToLevel(level - 1),
      `level ${level} should cost more than ${level - 1}`,
    );
  }
});

test("past level 60 the curve becomes a flat day per level", () => {
  const cap = rules.timeToLevel(rules.CURVE_CAP);
  assert.equal(rules.timeToLevel(61), cap + 86_400);
  assert.equal(rules.timeToLevel(70), cap + 86_400 * 10);
  // The point of the cap. By level 100 the uncapped curve is two orders of
  // magnitude worse -- a single level would take longer than the game has
  // existed, which is exactly what the cap exists to prevent.
  assert.ok(600 * 1.16 ** 100 > rules.timeToLevel(100) * 100);
});

test("tuning changes the curve without changing its shape", () => {
  const fast = { ...rules.DEFAULT_TUNING, rpBase: 60, rpStep: 1.1 };
  assert.equal(rules.timeToLevel(0, fast), 60);
  assert.equal(rules.timeToLevel(1, fast), 66);
  assert.ok(rules.timeToLevel(20, fast) < rules.timeToLevel(20));
});

test("duration reads the way the game reports every clock", () => {
  assert.equal(rules.duration(0), "0 days, 00:00:00");
  assert.equal(rules.duration(86_400), "1 day, 00:00:00");
  assert.equal(rules.duration(90_061), "1 day, 01:01:01");
  assert.equal(rules.duration(172_800), "2 days, 00:00:00");
  // Negative clocks are impossible, but a formatter that renders them as
  // "-1 days, -01:.." would be a memorable bug.
  assert.equal(rules.duration(-5), "0 days, 00:00:00");
});

function playerWith(levels: number[], alignment: "good" | "neutral" | "evil" = "neutral") {
  const items = rules.emptyItems();
  const slots = Object.keys(items) as (keyof typeof items)[];
  levels.forEach((level, i) => {
    const slot = slots[i];
    if (slot) items[slot] = { level, unique: null };
  });
  return {
    userId: "u",
    name: "Test",
    charClass: "tester",
    level: 10,
    next: 1000,
    online: true,
    alignment,
    items,
    x: 0,
    y: 0,
    idled: 0,
    createdAt: 0,
    lastLogin: 0,
    penalties: { message: 0, logout: 0, quest: 0 },
  };
}

test("item sum is the plain total outside combat and alignment-shifted inside it", () => {
  const neutral = playerWith([10, 20, 30]);
  assert.equal(rules.itemSum(neutral), 60);
  assert.equal(rules.itemSum(neutral, true), 60);

  assert.equal(rules.itemSum(playerWith([10, 20, 30], "good"), true), 66);
  assert.equal(rules.itemSum(playerWith([10, 20, 30], "evil"), true), 54);
  // The scoreboard must not lie about equipment just because of alignment.
  assert.equal(rules.itemSum(playerWith([10, 20, 30], "evil")), 60);
});

test("evil crits far more often than good, which is what pays for its penalty", () => {
  assert.equal(rules.criticalFactor("evil"), 20);
  assert.equal(rules.criticalFactor("neutral"), 35);
  assert.equal(rules.criticalFactor("good"), 50);
  assert.ok(rules.alignmentCombatFactor("good") > rules.alignmentCombatFactor("evil"));
});

test("the bot always outguns the strongest player by exactly one", () => {
  assert.equal(rules.bossSum([playerWith([10, 20]), playerWith([5])]), 31);
  assert.equal(rules.bossSum([]), 1, "an empty realm still gives the bot something to roll");
});

test("found items never exceed 1.5x the finder's level", () => {
  const rng = seeded(7);
  for (let level = 1; level <= 60; level += 1) {
    for (let i = 0; i < 40; i += 1) {
      const found = rules.rollItemLevel(level, rng);
      assert.ok(found >= 1, "a find is always at least level 1");
      assert.ok(
        found <= Math.floor(level * 1.5),
        `level ${level} found ${found}, above the ceiling`,
      );
    }
  }
});

test("uniques are gated by level and cannot be won below their tier", () => {
  const rng = seeded(1);
  const novice = { ...playerWith([]), level: 10 };
  for (let i = 0; i < 500; i += 1) {
    assert.equal(rules.rollUnique(novice, 1, rng), null, "level 10 cannot find a unique");
  }

  // Every unique is reachable by somebody, or the tier list is decoration.
  const veteran = { ...playerWith([]), level: 60 };
  const seen = new Set<string>();
  for (let i = 0; i < 200_000 && seen.size < rules.UNIQUES.length; i += 1) {
    const found = rules.rollUnique(veteran, 1, seeded(i));
    if (found) seen.add(found.def.name);
  }
  assert.equal(seen.size, rules.UNIQUES.length, "some unique is unreachable");
});

test("a unique that cannot beat what you already wear is discarded", () => {
  const veteran = { ...playerWith([]), level: 60 };
  veteran.items.helm = { level: 9999, unique: "prior" };
  const rng = seeded(3);
  for (let i = 0; i < 200; i += 1) {
    const found = rules.rollUnique(veteran, 1, rng);
    if (found) assert.notEqual(found.def.slot, "helm");
  }
});

test("penalties outgrow the levels they punish", () => {
  const level1 = rules.penalty(rules.PENALTY_BASE.message, 1);
  const level50 = rules.penalty(rules.PENALTY_BASE.message, 50);
  assert.equal(level1, 17);
  assert.ok(level50 > level1 * 500, "a veteran should pay orders of magnitude more");

  const capped = { ...rules.DEFAULT_TUNING, penLimit: 100 };
  assert.equal(rules.penalty(rules.PENALTY_BASE.message, 50, capped), 100);
});

test("battle rolls favour the better-equipped without ever guaranteeing them", () => {
  const rng = seeded(42);
  let underdogWins = 0;
  for (let i = 0; i < 10_000; i += 1) {
    if (rules.rollBattle(10, 100, rng).won) underdogWins += 1;
  }
  assert.ok(underdogWins > 0, "a 10-vs-100 underdog must sometimes win");
  assert.ok(underdogWins < 1_500, "...but not often");
});

test("a tie goes to the challenger", () => {
  assert.equal(rules.rollBattle(1, 1, () => 0).won, true);
});

test("winning pays more than losing costs, at every opponent level", () => {
  for (const level of [1, 10, 28, 49, 60]) {
    assert.ok(
      rules.winnings(level, 10_000) >= rules.losses(level, 10_000),
      `losing to a level ${level} should not cost more than beating them pays`,
    );
  }
  // Floored, so beating a beginner is still worth something.
  assert.equal(rules.winnings(1, 10_000), 700);
  assert.equal(rules.losses(1, 10_000), 700);
});

test("event rates are the same whatever the tick length", () => {
  const days = 4;
  const population = 5;
  const expectedPerDay = population / days;

  for (const tick of [1, 10, 60, 600]) {
    const rng = seeded(99);
    const ticksInADay = 86_400 / tick;
    let fires = 0;
    for (let i = 0; i < ticksInADay * 200; i += 1) {
      if (rules.eventFires(rng, days, population, tick)) fires += 1;
    }
    const perDay = fires / 200;
    assert.ok(
      Math.abs(perDay - expectedPerDay) < expectedPerDay * 0.15,
      `tick ${tick}s produced ${perDay.toFixed(3)} events/day, expected ~${expectedPerDay}`,
    );
  }
});

test("nothing happens to an empty realm", () => {
  assert.equal(rules.eventFires(() => 0, 4, 0, 10), false);
});

/**
 * The one rate in the game that is ours rather than jotun's, pinned so that
 * changing it is a decision somebody makes rather than a number that drifts.
 */
test("events fire 24 times as often as irpg 3.1.2", () => {
  const upstream = {
    handOfGod: 20,
    teamBattle: 24,
    calamity: 8,
    godsend: 4,
    evilness: 8,
    goodness: 12,
  };

  assert.equal(rules.EVENT_RATE_MULTIPLIER, 24);
  for (const [event, days] of Object.entries(upstream)) {
    assert.equal(
      rules.EVENT_DAYS[event as keyof typeof rules.EVENT_DAYS],
      days / 24,
      `${event} should fire 24x as often as upstream's one per ${days} days`,
    );
  }
  assert.deepEqual(Object.keys(rules.EVENT_DAYS).sort(), Object.keys(upstream).sort());
});

/**
 * eventFires is a single Bernoulli draw, so a rate that comes due more than
 * once in a tick is clipped to once. The realm has to be enormous to get there
 * on the ten-second tick; the 600-second catch-up tick after an outage is the
 * case with any slack at all, and it errs towards too few events.
 */
test("the fastest event needs an implausible realm to saturate a tick", () => {
  const fastest = Math.min(...Object.values(rules.EVENT_DAYS));
  const certain = (population: number, tick: number) =>
    rules.eventFires(() => 0.999999, fastest, population, tick);

  assert.equal(certain(6, 10), false, "a realm of six does not saturate the normal tick");
  assert.equal(certain(1_000, 10), false, "nor does a realm of a thousand");
  assert.equal(certain(2_000, 10), true, "two thousand players would");
  assert.equal(certain(6, 600), false, "a realm of six survives a full catch-up tick");
});

test("shuffle keeps every element exactly once", () => {
  const rng = seeded(5);
  const original = [1, 2, 3, 4, 5, 6, 7, 8];
  const shuffled = rules.shuffle(rng, [...original]);
  assert.deepEqual([...shuffled].sort((a, b) => a - b), original);
});

test("damage and blessing are a tenth, and neither can lift a level-0 item", () => {
  assert.equal(rules.damagedItemLevel(100), 90);
  assert.equal(rules.blessedItemLevel(100), 110);
  assert.equal(rules.blessedItemLevel(0), 0, "a blessing cannot conjure an item from nothing");
  assert.equal(rules.damagedItemLevel(0), 0);
});
