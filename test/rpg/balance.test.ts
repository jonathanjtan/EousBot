import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Whether this is a game, measured rather than asserted.
 *
 * The IRC original fails exactly this bar: twelve always-online players land
 * within three levels of each other over sixty days, and alignment -- its only
 * decision -- is worth 0.4 levels. These tests exist so the same thing cannot
 * quietly happen here. They assert on the things a player feels (win rates,
 * how long a level takes, whether the choice pays) rather than on formulas,
 * because a formula can be correct and the game still be dead.
 */

const engine = await import("../../src/rpg/engine.ts");
const rules = await import("../../src/rpg/rules.ts");
const { CLASS_IDS } = await import("../../src/rpg/content.ts");
import type { ClassId } from "../../src/rpg/types.ts";

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
const RARITIES = ["common", "uncommon", "rare", "magic", "legendary"] as const;

/** How a simulated player picks their next adventure. */
type Policy = "safest" | "hardest" | "value";

function chooseDifficulty(character: ReturnType<typeof engine.newCharacter>, policy: Policy): number {
  const ceiling = rules.maxDifficultyFor(character);
  if (policy === "safest") return 1;
  if (policy === "hardest") return ceiling;

  let best = 1;
  let bestRate = -1;
  for (let d = 1; d <= ceiling; d += 1) {
    const hours = rules.expeditionDuration(d) / 3_600_000;
    const rate = (rules.successChance(character, d) * rules.xpReward(character, d)) / hours;
    if (rate > bestRate) {
      bestRate = rate;
      best = d;
    }
  }
  return best;
}

/**
 * Plays one character for `hours` of simulated time.
 *
 * Claims the moment an adventure ends, which is the theoretical maximum -- a
 * real player sleeps. That makes these numbers an upper bound on pace, which is
 * the right direction for a balance test to err.
 */
function play(classId: ClassId, policy: Policy, hours: number, seed: number) {
  const state = engine.newGame();
  const rng = seeded(seed);
  let now = START;
  engine.create(state, "p", "Sim", classId, { rng, now, tuning: rules.DEFAULT_TUNING });
  const character = engine.find(state, "p")!;

  let wins = 0;
  let runs = 0;
  const deadline = START + hours * 3_600_000;

  while (now < deadline) {
    const difficulty = chooseDifficulty(character, policy);
    const started = engine.startExpedition(state, "p", difficulty, { rng, now, tuning: rules.DEFAULT_TUNING });
    if (!started.ok) break;

    now = character.expedition!.endsAt;
    const result = engine.claimExpedition(state, "p", { rng, now, tuning: rules.DEFAULT_TUNING });
    runs += 1;
    if (result.kind === "done" && result.reward.won) wins += 1;

    // Open whatever turned up; upgrades equip themselves.
    for (const rarity of RARITIES) {
      while (character.crates[rarity] > 0) {
        engine.openCrate(state, "p", rarity, { rng, now, tuning: rules.DEFAULT_TUNING });
      }
    }
  }

  return { character, wins, runs, winRate: runs === 0 ? 0 : wins / runs };
}

test("the first hour is welcoming, not punishing", () => {
  const runs = [1, 2, 3, 4, 5].map((seed) => play("warrior", "safest", 1, seed));
  const rate = runs.reduce((sum, r) => sum + r.winRate, 0) / runs.length;
  assert.ok(rate > 0.55, `a beginner won only ${(rate * 100).toFixed(0)}% of easy adventures`);
  for (const run of runs) assert.ok(run.runs >= 2, "an hour should fit at least two short runs");
});

test("a day of play produces a real character", () => {
  const results = [1, 2, 3].map((seed) => play("warrior", "value", 24, seed));
  for (const r of results) {
    assert.ok(r.character.level >= 5, `24h produced only level ${r.character.level}`);
    assert.ok(r.character.level <= 40, `24h produced level ${r.character.level}, which is runaway`);
    assert.ok(r.character.money > rules.DEFAULT_TUNING.startingMoney);
  }
});

/**
 * The property the IRC game lacks entirely: choosing well beats choosing badly.
 *
 * If grinding the safest adventure forever were optimal, the menu would be
 * decoration and the game would be a clock with extra steps.
 */
test("choosing well beats grinding the safest option", () => {
  const seeds = [1, 2, 3, 4, 5, 6];
  const mean = (policy: Policy) =>
    seeds.reduce((sum, s) => sum + play("warrior", policy, 72, s).character.level, 0) / seeds.length;

  const safest = mean("safest");
  const value = mean("value");
  assert.ok(
    value > safest * 1.15,
    `playing well reached ${value.toFixed(1)} vs ${safest.toFixed(1)} for grinding — too close to matter`,
  );
});

/** ...but reaching as high as possible must not be free either. */
test("reaching too far is punished, so the choice has two sides", () => {
  const seeds = [1, 2, 3, 4, 5, 6];
  const winRate = (policy: Policy) =>
    seeds.reduce((sum, s) => sum + play("warrior", policy, 72, s).winRate, 0) / seeds.length;

  assert.ok(
    winRate("hardest") < winRate("safest") - 0.15,
    "the hardest available adventure should be visibly riskier",
  );
});

/**
 * Class choice has to be worth making and not worth agonising over.
 *
 * The floor is the IRC game's failure -- alignment moves a character 0.4 levels
 * in sixty days, which is indistinguishable from noise. The ceiling is the
 * opposite failure, where one class is mandatory and the other five are traps.
 */
test("class matters more than the IRC game's alignment, and less than a trap", () => {
  const seeds = [1, 2, 3, 4, 5, 6];
  const levels: Record<string, number> = {};

  for (const classId of CLASS_IDS) {
    levels[classId] =
      seeds.reduce((sum, s) => sum + play(classId, "value", 72, s).character.level, 0) / seeds.length;
  }

  const values = Object.values(levels);
  const best = Math.max(...values);
  const worst = Math.min(...values);
  const report = Object.entries(levels)
    .map(([k, v]) => `${k} ${v.toFixed(1)}`)
    .join(", ");

  assert.ok(best - worst > 0.5, `classes are indistinguishable: ${report}`);
  assert.ok(best / worst < 1.6, `one class dominates: ${report}`);
});

test("gear grows over play, which is what makes the odds move", () => {
  const early = play("warrior", "value", 4, 3).character;
  const late = play("warrior", "value", 96, 3).character;
  assert.ok(
    rules.power(late) > rules.power(early) * 2,
    `power went ${rules.power(early)} to ${rules.power(late)}`,
  );
  // And better gear must actually improve the odds at a fixed difficulty.
  assert.ok(rules.successChance(late, 5) > rules.successChance(early, 5));
});

test("nothing in a long run goes negative or non-finite", () => {
  const { character } = play("thief", "value", 24 * 30, 11);
  assert.ok(Number.isFinite(character.money) && character.money >= 0);
  assert.ok(Number.isFinite(character.xp) && character.xp >= 0);
  assert.ok(Number.isInteger(character.level) && character.level >= 1);
  assert.ok(character.backpack.length <= rules.DEFAULT_TUNING.backpackSize);
  for (const item of [character.weapon, character.armor, ...character.backpack]) {
    if (!item) continue;
    assert.ok(Number.isFinite(item.value) && item.value >= 1, `bad item value ${item?.value}`);
  }
});
