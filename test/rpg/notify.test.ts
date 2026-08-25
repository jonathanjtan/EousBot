import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Claim reminders.
 *
 * The dispatch game is built around walking away, which means the game has to
 * be the thing that tells you to walk back. It did not, for six deploys.
 */

const engine = await import("../../src/rpg/engine.ts");
const rules = await import("../../src/rpg/rules.ts");
const notify = await import("../../src/rpg/notify.ts");

const START = Date.UTC(2026, 0, 1);
const ctx = (now = START) => ({ rng: () => 0.5, now, tuning: rules.DEFAULT_TUNING });

function realmOnAdventure(difficulty = 2) {
  const state = engine.newGame();
  engine.create(state, "u0", "Alpha", "warrior", ctx());
  engine.startExpedition(state, "u0", difficulty, ctx());
  return state;
}

test("nobody is reminded while the adventure is still running", () => {
  const state = realmOnAdventure(2);
  assert.deepEqual(notify.pendingClaims(state, START), []);
  assert.deepEqual(notify.pendingClaims(state, START + 60_000), []);
});

test("a finished adventure is reminded once and only once", () => {
  const state = realmOnAdventure(1);
  const after = START + rules.expeditionDuration(1) + 1;

  const due = notify.pendingClaims(state, after);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.userId, "u0");
  assert.match(notify.reminder(due[0]!), /Alpha/);
  assert.match(notify.reminder(due[0]!), /claim/);

  notify.markNotified(due[0]!);
  assert.deepEqual(notify.pendingClaims(state, after), [], "a second sweep must stay quiet");
  assert.deepEqual(
    notify.pendingClaims(state, after + 86_400_000),
    [],
    "and stay quiet indefinitely",
  );
});

test("claiming clears the reminder rather than leaving it armed", () => {
  const state = realmOnAdventure(1);
  const after = START + rules.expeditionDuration(1) + 1;
  engine.claimExpedition(state, "u0", ctx(after));

  assert.deepEqual(notify.pendingClaims(state, after), [], "there is nothing to come back to");
  assert.equal(engine.find(state, "u0")!.expedition, null);
});

test("a fresh adventure re-arms the reminder", () => {
  const state = realmOnAdventure(1);
  let now = START + rules.expeditionDuration(1) + 1;
  notify.markNotified(notify.pendingClaims(state, now)[0]!);
  engine.claimExpedition(state, "u0", ctx(now));

  engine.startExpedition(state, "u0", 1, ctx(now));
  now += rules.expeditionDuration(1) + 1;
  assert.equal(notify.pendingClaims(state, now).length, 1, "the next one must remind too");
});

test("marking somebody who has already claimed is harmless", () => {
  const state = realmOnAdventure(1);
  const character = engine.find(state, "u0")!;
  engine.claimExpedition(state, "u0", ctx(START + rules.expeditionDuration(1) + 1));
  assert.doesNotThrow(() => notify.markNotified(character));
});

test("a realm with nobody on an adventure costs nothing to sweep", () => {
  const state = engine.newGame();
  engine.create(state, "u0", "Alpha", "mage", ctx());
  assert.deepEqual(notify.pendingClaims(state, START + 999_999_999), []);
  assert.deepEqual(notify.pendingClaims(engine.newGame(), START), []);
});
