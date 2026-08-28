import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Rendering the realm for Discord.
 *
 * The batching tests exist because the failure they guard against is silent:
 * Discord rejects a message over 2000 characters outright, so a busy tick with
 * no batching does not look wrong, it simply never arrives.
 */

const { batch, eventReport, itemList, labelled, leaderboard, questLine } = await import(
  "../../src/idlerpg/format.ts"
);
const rules = await import("../../src/idlerpg/rules.ts");
const engine = await import("../../src/idlerpg/engine.ts");

const START = Date.UTC(2026, 0, 1);

function ctx(seed = 1) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { rng, now: START, tuning: rules.DEFAULT_TUNING, bossName: "EousBot" };
}

function realmOf(count: number) {
  const c = ctx();
  const state = engine.newWorld(START);
  for (let i = 0; i < count; i += 1) {
    engine.register(state, `u${i}`, `Player${i}`, "tester", c);
  }
  return state;
}

test("batching packs lines up to the limit and never splits one", () => {
  const lines = ["aaa", "bbb", "ccc", "ddd"];
  assert.deepEqual(batch(lines, 100), ["aaa\nbbb\nccc\nddd"]);
  assert.deepEqual(batch(lines, 7), ["aaa\nbbb", "ccc\nddd"]);

  for (const chunk of batch(lines, 7)) {
    assert.ok(chunk.length <= 7, `chunk over the limit: ${chunk.length}`);
  }
});

test("every batch stays under the limit, whatever it is handed", () => {
  const lines = Array.from({ length: 200 }, (_, i) => "x".repeat((i % 40) + 1));
  for (const limit of [20, 50, 200, 1_900]) {
    for (const chunk of batch(lines, limit)) {
      assert.ok(chunk.length <= limit, `limit ${limit} produced a ${chunk.length}-char message`);
    }
  }
});

test("a single over-long line is truncated rather than dropped", () => {
  const [only, ...rest] = batch(["y".repeat(500)], 50);
  assert.equal(rest.length, 0);
  assert.ok(only);
  assert.equal(only.length, 50);
  assert.ok(only.endsWith("…"), "truncation should be visible");
});

test("batching nothing produces nothing", () => {
  assert.deepEqual(batch([], 100), []);
  assert.deepEqual(batch(["", ""], 100), []);
});

/**
 * Two games post into one channel, so every message says which one it is.
 *
 * The second chunk is the case worth a test. Stamping only the first would
 * leave a long tick's overflow looking like it came from the other game, which
 * is the exact confusion the tag was added to end.
 */
test("every labelled chunk carries the tag, not just the first", () => {
  const chunks = labelled("[tag]", ["aaa", "bbb", "ccc", "ddd"], 13);
  assert.equal(chunks.length, 2);
  for (const chunk of chunks) {
    assert.ok(chunk.startsWith("[tag]\n"), `unstamped chunk: ${chunk}`);
    assert.ok(chunk.length <= 13, `chunk over the limit: ${chunk.length}`);
  }
  assert.deepEqual(chunks, ["[tag]\naaa\nbbb", "[tag]\nccc\nddd"]);
});

test("a labelled message still fits what Discord will take", () => {
  const lines = Array.from({ length: 200 }, (_, i) => "x".repeat((i % 40) + 1));
  for (const chunk of labelled("[#G7 Idle RPG]", lines, 1_900)) {
    assert.ok(chunk.length <= 1_900, `a ${chunk.length}-char message would be rejected`);
  }
});

test("nothing to say is not stamped with a tag", () => {
  assert.deepEqual(labelled("[tag]", [], 100), []);
});

test("an empty realm's leaderboard points at how to join it", () => {
  assert.match(leaderboard(engine.newWorld(START), 10), /register/);
});

test("the leaderboard honours its limit and marks who is idling", () => {
  const state = realmOf(5);
  state.players.u3!.online = false;

  const listed = leaderboard(state, 3);
  assert.equal(listed.split("\n").length, 4, "a heading plus three rows");

  const all = leaderboard(state, 10);
  assert.match(all, /⚫ \*\*Player3\*\*/, "an idle-stopped player is marked");
  assert.match(all, /🟢 \*\*Player0\*\*/);
});

test("an item list names uniques and shows the sum the game actually rolls against", () => {
  const state = realmOf(1);
  const player = state.players.u0!;
  player.items.weapon = { level: 300, unique: "the Hammer of Sudden Clarity" };
  player.items.helm = { level: 12, unique: null };

  const listed = itemList(player);
  assert.match(listed, /the Hammer of Sudden Clarity/);
  assert.match(listed, /sum 312/);
  // All ten slots appear even at level 0, or a new player sees an empty list.
  assert.equal(listed.split("\n").length, 11);
});

test("with no quest running the realm says when to expect one", () => {
  const state = engine.newWorld(START);
  assert.match(questLine(state, START), /No quest is running/);
  assert.match(questLine(state, START), /in 0 days, 06:00:00/);

  state.quest = { kind: "idle", nextAt: 0 };
  assert.match(questLine(state, START), /looking for four/);
});

test("a timed quest reports its party and its remaining time", () => {
  const state = realmOf(4);
  state.quest = {
    kind: "time",
    questers: ["u0", "u1", "u2", "u3"],
    text: "count the bells",
    endsAt: Math.floor(START / 1000) + 3_600,
  };

  const line = questLine(state, START);
  assert.match(line, /count the bells/);
  assert.match(line, /Player0/);
  assert.match(line, /0 days, 01:00:00/);
});

test("a map quest reports how far each quester still has to walk", () => {
  const state = realmOf(4);
  state.players.u0!.x = 10;
  state.players.u0!.y = 10;
  state.quest = {
    kind: "map",
    questers: ["u0", "u1", "u2", "u3"],
    text: "walk the river",
    stage: 1,
    p1: { x: 40, y: 10 },
    p2: { x: 0, y: 0 },
  };

  const line = questLine(state, START);
  assert.match(line, /waypoint 1 at \[40, 10\]/);
  assert.match(line, /Player0: 30 steps away/);
});

test("a quester who has left the realm does not break the quest line", () => {
  const state = realmOf(1);
  state.quest = {
    kind: "map",
    questers: ["u0", "ghost"],
    text: "walk",
    stage: 2,
    p1: { x: 0, y: 0 },
    p2: { x: 5, y: 5 },
  };
  assert.doesNotThrow(() => questLine(state, START));
  assert.match(questLine(state, START), /someone/);
});

test("the events report gives an untriggered event a rate to be judged against", () => {
  const state = realmOf(4);
  const report = eventReport(state, START);

  // Four online, one hand of God per player per twenty days, so five days.
  assert.match(report, /`hand of God` never fired\. Expected one every 5 days, 00:00:00 at 4 online/);
  assert.match(report, /4 online/);
});

test("the events report counts what the tick recorded", () => {
  const state = realmOf(4);
  state.events.handOfGod = { count: 3, lastAt: Math.floor(START / 1000) - 7_200 };

  assert.match(eventReport(state, START), /fired 3, last 0 days, 02:00:00 ago/);
});

test("an event nobody qualifies for says so instead of quoting a rate", () => {
  const state = realmOf(2);
  const report = eventReport(state, START);

  // Everybody registers neutral, so neither alignment event can ever roll.
  assert.match(report, /Nobody is evil and online, so it cannot fire/);
  assert.match(report, /Nobody is good and online, so it cannot fire/);
});

test("a frozen realm says the rolls are held, not that the events are broken", () => {
  const state = realmOf(2);
  state.paused = true;
  assert.match(eventReport(state, START), /frozen/);
});

test("the report says when the hand of God is running at the temporary rate", () => {
  const state = realmOf(4);
  state.hogBoostUntil = Math.floor(START / 1000) + 3_600;

  const report = eventReport(state, START);
  assert.match(report, /turned up 19x for the next 0 days, 01:00:00/);
  assert.match(report, /`hand of God` never fired\. Expected one every 0 days, 06:18:56/);

  state.hogBoostUntil = Math.floor(START / 1000);
  assert.doesNotMatch(eventReport(state, START), /turned up/);
});
