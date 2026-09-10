import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Loading a save.
 *
 * The store imports config, which exits the process when required environment
 * variables are absent, so dummy values go in before the import.
 */

for (const [key, value] of Object.entries({
  DISCORD_TOKEN: "test-token",
  DISCORD_APP_ID: "0",
  DISCORD_GUILD_ID: "0",
  DISCORD_CHANNEL_ID: "0",
  GITHUB_TOKEN: "test-token",
  GITHUB_OWNER: "test",
  GITHUB_REPO: "test",
})) {
  process.env[key] ??= value;
}

const engine = await import("../../src/rpg/engine.ts");
const rules = await import("../../src/rpg/rules.ts");
const { hydrate } = await import("../../src/rpg/store.ts");

const ctx = { rng: () => 0.5, now: Date.UTC(2026, 0, 1), tuning: rules.DEFAULT_TUNING };

function thing(id: number, value: number) {
  return { id, name: "Thing", kind: "weapon" as const, value, rarity: "common" as const };
}

/** A realm with one character: kit #1 and #2 worn, nextItemId 3. */
function realm() {
  const state = engine.newGame();
  engine.create(state, "u0", "Alpha", "warrior", ctx);
  return state;
}

/** What reaches disk: plain JSON, nothing shared by reference. */
function load(state: object) {
  return hydrate(JSON.parse(JSON.stringify(state)));
}

test("a save with clashing item numbers loads with every number distinct", () => {
  const state = realm();
  // What old gifts left behind: a received #2 beside the kit's own #2, a #20
  // from someone further along, and a listing that also says #20.
  engine.find(state, "u0")!.backpack.push(thing(2, 30), thing(20, 40));
  state.market.push({ id: 1, sellerId: "u0", item: thing(20, 50), price: 10, listedAt: 0 });

  const loaded = load(state);
  const c = loaded.characters.u0!;
  const held = [c.weapon!, c.armor!, ...c.backpack, loaded.market[0]!.item].map((i) => i.id);
  assert.equal(new Set(held).size, held.length, `numbers still clash: ${held}`);
  assert.deepEqual([c.weapon!.id, c.armor!.id], [1, 2], "worn items keep their numbers");
  assert.equal(c.backpack.find((i) => i.value === 40)!.id, 20, "the first #20 keeps it");
  assert.ok(c.nextItemId > Math.max(...held), "the next drop cannot reuse a held number");
});

test("a number above nextItemId moves nextItemId, not the item", () => {
  const state = realm();
  engine.find(state, "u0")!.backpack.push(thing(20, 40));

  const c = load(state).characters.u0!;
  assert.deepEqual(
    [c.weapon!.id, c.armor!.id, ...c.backpack.map((i) => i.id)],
    [1, 2, 20],
  );
  assert.equal(c.nextItemId, 21);
});

test("a clean save loads with the same numbers", () => {
  const state = realm();
  const before = engine.find(state, "u0")!;
  before.backpack.push(thing(3, 30));
  before.nextItemId = 4;

  const c = load(state).characters.u0!;
  assert.deepEqual([c.weapon!.id, c.armor!.id, ...c.backpack.map((i) => i.id)], [1, 2, 3]);
  assert.equal(c.nextItemId, 4);
});
