import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The game as a running system: ticks, penalties, quests and fights.
 *
 * Every test drives a seeded generator, so a failure here is reproducible
 * rather than a thing that happened once on CI. The engine imports no config
 * and no discord.js, which is the whole reason a realm can be simulated for a
 * simulated year inside a unit test.
 */

const engine = await import("../../src/idlerpg/engine.ts");
const rules = await import("../../src/idlerpg/rules.ts");

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

const START = Date.UTC(2026, 0, 1) ;

function ctx(seed = 1, now = START) {
  return {
    rng: seeded(seed),
    now,
    tuning: rules.DEFAULT_TUNING,
    bossName: "EousBot",
  };
}

/** A realm with `count` registered, logged-in players. */
function realmOf(count: number, seed = 1) {
  const c = ctx(seed);
  const state = engine.newWorld(START);
  for (let i = 0; i < count; i += 1) {
    engine.register(state, `u${i}`, `Player${i}`, "tester", c);
  }
  return { state, c };
}

function text(announcements: { text: string }[]): string {
  return announcements.map((a) => a.text).join("\n");
}

test("registering puts a level-0 character on the clock", () => {
  const { state } = realmOf(1);
  const player = state.players.u0;
  assert.ok(player);
  assert.equal(player.level, 0);
  assert.equal(player.next, 600);
  assert.equal(player.online, true);
  assert.equal(player.alignment, "neutral");
  assert.equal(rules.itemSum(player), 0, "a new character owns nothing");
});

test("a name already in the realm is refused", () => {
  const { state, c } = realmOf(1);
  const clash = engine.register(state, "someone-else", "player0", "thief", c);
  assert.equal(clash.ok, false);
  assert.match(clash.ok ? "" : clash.reason, /already called/i);

  const second = engine.register(state, "u0", "Different", "tester", c);
  assert.equal(second.ok, false, "one character per account");
});

test("idling advances the clock and nothing else", () => {
  const { state, c } = realmOf(1);
  const before = state.players.u0!.next;

  engine.tick(state, 60, c);

  assert.equal(state.players.u0!.next, before - 60);
  assert.equal(state.players.u0!.idled, 60);
  assert.equal(state.players.u0!.level, 0);
});

test("a clock that runs out levels the player and hands them a new one", () => {
  const { state, c } = realmOf(1);
  const out = engine.tick(state, 600, c);

  const player = state.players.u0!;
  assert.equal(player.level, 1);
  assert.equal(player.next, rules.timeToLevel(1));
  assert.match(text(out), /attained level 1/);
  // Levelling always rolls an item, reported to the finder alone.
  assert.ok(out.some((a) => a.to === "private" && a.userId === "u0"));
});

test("a paused realm does not move at all", () => {
  const { state, c } = realmOf(3);
  state.paused = true;
  const before = state.players.u0!.next;

  const out = engine.tick(state, 100_000, c);

  assert.deepEqual(out, []);
  assert.equal(state.players.u0!.next, before);
  assert.equal(state.elapsed, 0);
});

test("a pause does not bank time to hand back the moment it lifts", () => {
  const { state, c } = realmOf(1);
  const before = state.players.u0!.next;

  state.paused = true;
  const hourLater = START + 3_600_000;
  engine.tick(state, 3_600, { ...c, now: hourLater });

  // lastTick moves even while frozen, so the next unpaused tick sees a small
  // delta rather than the whole outage.
  assert.equal(state.lastTick, Math.floor(hourLater / 1000));
  assert.equal(state.players.u0!.next, before);

  state.paused = false;
  engine.tick(state, 10, { ...c, now: hourLater + 10_000 });
  assert.equal(state.players.u0!.next, before - 10);
});

test("time passes for an empty realm, so it does not owe itself a burst on return", () => {
  const state = engine.newWorld(START);
  engine.tick(state, 3_600, ctx());
  assert.equal(state.elapsed, 3_600);
});

test("talking costs time, and costs a veteran far more than a beginner", () => {
  const { state, c } = realmOf(2);
  const beginner = state.players.u0!;
  const veteran = state.players.u1!;
  veteran.level = 40;

  engine.penalizeMessage(state, "u0", c);
  engine.penalizeMessage(state, "u1", c);

  assert.ok(beginner.penalties.message > 0);
  assert.ok(
    veteran.penalties.message > beginner.penalties.message * 100,
    "penalties must scale steeply or they stop mattering",
  );
  assert.equal(beginner.next, 600 + beginner.penalties.message);
});

test("the talking penalty is a throttled DM, never a channel line", () => {
  const { state, c } = realmOf(1);
  const out = engine.penalizeMessage(state, "u0", c);

  assert.equal(out.length, 1);
  assert.equal(out[0]!.to, "private");
  assert.equal(out[0]!.throttleKey, "message-penalty");
});

test("talking is billed by message length when the bot can see it", () => {
  const { state, c } = realmOf(2);

  engine.penalizeMessage(state, "u0", c, 10);
  engine.penalizeMessage(state, "u1", c, 200);

  assert.equal(state.players.u0!.penalties.message, rules.penalty(10, 0));
  assert.equal(state.players.u1!.penalties.message, rules.penalty(200, 0));
  assert.ok(
    state.players.u1!.penalties.message > state.players.u0!.penalties.message,
    "a longer message must cost more",
  );
});

test("a message of unknown length falls back to the flat rate, never to free", () => {
  const { state, c } = realmOf(3);
  const flat = rules.penalty(rules.PENALTY_BASE.message, 0);

  // No count at all: the MessageContent intent is off.
  engine.penalizeMessage(state, "u0", c);
  // Zero-length: an attachment or a sticker with no text.
  engine.penalizeMessage(state, "u1", c, 0);

  assert.equal(state.players.u0!.penalties.message, flat);
  assert.equal(state.players.u1!.penalties.message, flat);
});

test("leaving the server is the dearest penalty there is", () => {
  const { state, c } = realmOf(2);
  state.players.u0!.level = 20;
  state.players.u1!.level = 20;

  engine.penalizePart(state, "u0", c);
  engine.logout(state, "u1", c);

  assert.equal(state.players.u0!.online, false);
  assert.ok(
    state.players.u0!.penalties.part > state.players.u1!.penalties.logout * 5,
    "parting should dwarf a logout",
  );
  // The character survives: people leave servers and come back.
  assert.ok(state.players.u0!, "the character must not be deleted");
});

test("renaming yourself costs something, but is capped far harder", () => {
  const { state } = realmOf(1);
  const capped = {
    rng: () => 0.5,
    now: START,
    tuning: { ...rules.DEFAULT_TUNING, penLimit: 1_000 },
    bossName: "EousBot",
  };
  state.players.u0!.level = 60;

  const out = engine.penalizeNick(state, "u0", capped);

  assert.equal(state.players.u0!.penalties.nick, 100, "a tenth of the ceiling");
  assert.equal(out[0]!.to, "private", "a rename is not channel news");
});

test("renaming does not abandon a quest, but talking does", () => {
  const { state, c } = realmOnQuest(2);
  const questers = state.quest.kind === "idle" ? [] : [...state.quest.questers];

  engine.penalizeNick(state, questers[0]!, c);
  assert.notEqual(state.quest.kind, "idle", "a rename is not a desertion");

  const out = engine.penalizeMessage(state, questers[0]!, c, 5);
  assert.equal(state.quest.kind, "idle", "talking is");
  assert.match(text(out), /abandoned the quest/);
});

test("presence starts and stops the clock without charging for it", () => {
  const { state, c } = realmOf(1);
  const player = state.players.u0!;
  const before = player.next;

  engine.setPresence(state, "u0", false);
  assert.equal(player.online, false);
  engine.tick(state, 500, c);
  assert.equal(player.next, before, "an offline clock does not move");

  engine.setPresence(state, "u0", true);
  assert.equal(player.online, true);
  assert.equal(player.penalties.logout, 0, "going offline is not a logout");
  assert.equal(player.penalties.part, 0);
});

test("presence does not reset quest tenure the way a manual login does", () => {
  const { state, c } = realmOf(1);
  const player = state.players.u0!;
  player.lastLogin = START - 99_999_000;
  const tenured = player.lastLogin;

  engine.setPresence(state, "u0", false);
  engine.setPresence(state, "u0", true);
  assert.equal(player.lastLogin, tenured, "a phone sleeping must not cost quest eligibility");

  // Logging out and back in is the deliberate act, and it does restart tenure.
  // Calling login while already idling is a no-op, so it cannot be used to
  // dodge the wait either.
  engine.login(state, "u0", c);
  assert.equal(player.lastLogin, tenured, "login while already idling changes nothing");

  engine.logout(state, "u0", c);
  engine.login(state, "u0", c);
  assert.equal(player.lastLogin, START, "a real login does restart tenure");
});

test("a deliberate logout outranks presence until the player takes it back", () => {
  const { state, c } = realmOf(1);
  const player = state.players.u0!;

  engine.logout(state, "u0", c);
  assert.equal(player.suspended, true);

  // Discord says they are online; the game does not care.
  engine.setPresence(state, "u0", true);
  assert.equal(player.online, false, "presence must not undo a paid-for logout");

  engine.login(state, "u0", c);
  assert.equal(player.suspended, false);
  assert.equal(player.online, true);
});

test("presence for somebody with no character does nothing at all", () => {
  const { state } = realmOf(1);
  assert.deepEqual(engine.setPresence(state, "a-stranger", true), []);
});

test("a player who is not logged in is not penalised for talking", () => {
  const { state, c } = realmOf(1);
  state.players.u0!.online = false;
  const before = state.players.u0!.next;

  assert.deepEqual(engine.penalizeMessage(state, "u0", c), []);
  assert.equal(state.players.u0!.next, before);
  assert.deepEqual(engine.penalizeMessage(state, "nobody", c), []);
});

test("logging out costs more than talking, and stops the clock", () => {
  const { state, c } = realmOf(1);
  const player = state.players.u0!;

  const out = engine.logout(state, "u0", c);

  assert.equal(player.online, false);
  assert.equal(player.penalties.logout, rules.penalty(rules.PENALTY_BASE.logout, 0));
  assert.ok(player.penalties.logout > rules.penalty(rules.PENALTY_BASE.message, 0));
  assert.match(text(out), /stopped idling/);

  // And the clock genuinely stops.
  const frozen = player.next;
  engine.tick(state, 1_000, c);
  assert.equal(player.next, frozen);
});

test("logging back in restarts the clock where it was left", () => {
  const { state, c } = realmOf(1);
  engine.logout(state, "u0", c);
  const parked = state.players.u0!.next;

  const out = engine.login(state, "u0", c);

  assert.equal(state.players.u0!.online, true);
  assert.equal(state.players.u0!.next, parked);
  assert.match(text(out), /idling again/);
});

/** Puts four eligible questers in the realm and starts a quest immediately. */
function realmOnQuest(seed: number) {
  const c = ctx(seed);
  const state = engine.newWorld(START);
  for (let i = 0; i < 5; i += 1) {
    engine.register(state, `u${i}`, `Player${i}`, "tester", c);
    const p = state.players[`u${i}`]!;
    p.level = 50;
    p.next = 100_000;
    // Quests only draw on players who have been logged in for ten hours.
    p.lastLogin = START - rules.QUEST_MIN_TENURE * 1000 - 1000;
  }
  state.quest = { kind: "idle", nextAt: 0 };
  // Ticking with the quest due starts one; the seed decides which kind.
  engine.tick(state, 1, c);
  return { state, c };
}

test("a quest draws exactly four eligible players", () => {
  for (const seed of [2, 4, 6, 8]) {
    const { state } = realmOnQuest(seed);
    assert.notEqual(state.quest.kind, "idle", `seed ${seed} started no quest`);
    if (state.quest.kind === "idle") continue;
    assert.equal(state.quest.questers.length, rules.QUEST_PARTY_SIZE);
    assert.equal(new Set(state.quest.questers).size, 4, "nobody is drafted twice");
  }
});

test("low-level players are never sent on a quest", () => {
  const c = ctx(3);
  const state = engine.newWorld(START);
  for (let i = 0; i < 8; i += 1) {
    engine.register(state, `u${i}`, `Player${i}`, "tester", c);
    state.players[`u${i}`]!.lastLogin = START - rules.QUEST_MIN_TENURE * 1000 - 1000;
  }
  state.quest = { kind: "idle", nextAt: 0 };

  engine.tick(state, 1, c);
  assert.equal(state.quest.kind, "idle", "level-0 players cannot quest");
});

test("abandoning a quest bills the deserter and everyone else", () => {
  const { state, c } = realmOnQuest(2);
  assert.notEqual(state.quest.kind, "idle");
  const questers = state.quest.kind === "idle" ? [] : [...state.quest.questers];
  const deserter = state.players[questers[0]!]!;
  const bystander = Object.values(state.players).find((p) => !questers.includes(p.userId))!;
  const bystanderBefore = bystander.next;

  const out = engine.logout(state, deserter.userId, c);

  assert.match(text(out), /abandoned the quest/);
  assert.equal(state.quest.kind, "idle");
  assert.equal(
    bystander.next - bystanderBefore,
    rules.QUEST_DESERTION_TOLL,
    "an innocent bystander pays the flat toll",
  );
  assert.ok(deserter.penalties.quest > rules.QUEST_DESERTION_TOLL, "the deserter pays more");
});

test("a deserted quest keeps the realm waiting twice as long as a finished one", () => {
  const { state, c } = realmOnQuest(2);
  const questers = state.quest.kind === "idle" ? [] : [...state.quest.questers];
  engine.logout(state, questers[0]!, c);

  assert.equal(state.quest.kind, "idle");
  if (state.quest.kind !== "idle") return;
  assert.equal(state.quest.nextAt, Math.floor(START / 1000) + rules.QUEST_DESERTION_COOLDOWN);
  assert.equal(rules.QUEST_DESERTION_COOLDOWN, rules.QUEST_COOLDOWN * 2);
});

test("a timed quest that runs its course takes a quarter off every quester's clock", () => {
  let ran = false;
  for (const seed of [2, 4, 6, 8, 10, 12]) {
    const { state } = realmOnQuest(seed);
    if (state.quest.kind !== "time") continue;
    ran = true;

    const questers = [...state.quest.questers];
    const before = questers.map((id) => state.players[id]!.next);
    const endsAt = state.quest.endsAt;

    const out = engine.tick(state, 1, ctx(seed, (endsAt + 1) * 1000));

    assert.match(text(out), /completed their quest/);
    questers.forEach((id, i) => {
      // The tick also spends a second of clock, hence the tolerance.
      const expected = Math.floor(before[i]! * (1 - rules.QUEST_REWARD));
      assert.ok(Math.abs(state.players[id]!.next - expected) <= 1);
    });
    assert.equal(state.quest.kind, "idle");
    break;
  }
  assert.ok(ran, "no seed produced a timed quest");
});

test("map questers walk toward their waypoint and nobody fights while they do", () => {
  let ran = false;
  for (const seed of [2, 4, 6, 8, 10, 12, 14]) {
    const { state, c } = realmOnQuest(seed);
    if (state.quest.kind !== "map") continue;
    ran = true;

    const target = state.quest.p1;
    const questers = [...state.quest.questers];
    const far = (id: string) => {
      const p = state.players[id]!;
      return Math.max(Math.abs(p.x - target.x), Math.abs(p.y - target.y));
    };
    const before = questers.map(far);

    const out = engine.tick(state, 3_000, c);

    assert.ok(
      questers.some((id, i) => far(id) < before[i]!),
      "somebody should have made progress",
    );
    assert.doesNotMatch(text(out), /came upon/, "collisions are suspended during a map quest");
    break;
  }
  assert.ok(ran, "no seed produced a map quest");
});

test("the hand of God moves a clock in one direction or the other", () => {
  const { state } = realmOf(1);
  const player = state.players.u0!;
  player.next = 10_000;

  let raised = 0;
  let lowered = 0;
  for (let seed = 0; seed < 60; seed += 1) {
    player.next = 10_000;
    engine.handOfGod(state, ctx(seed), player);
    if (player.next > 10_000) raised += 1;
    if (player.next < 10_000) lowered += 1;
  }

  assert.ok(lowered > raised, "the hand is merciful more often than not");
  assert.ok(raised > 0, "...but not always");
});

test("a battle moves the challenger's clock and says by how much", () => {
  const { state } = realmOf(2);
  for (const p of Object.values(state.players)) {
    p.level = 30;
    p.next = 100_000;
    p.items.weapon = { level: 50, unique: null };
  }
  const me = state.players.u0!;
  const before = me.next;

  const out = engine.challenge(state, me, ctx(11));

  assert.ok(out.length > 0, "two online players should produce a fight");
  assert.notEqual(me.next, before);
  assert.match(text(out), /challenged/);
});

test("a lone player has nobody to challenge", () => {
  const { state } = realmOf(1);
  assert.deepEqual(engine.challenge(state, state.players.u0!, ctx(1)), []);
});

test("alignment is announced only when it actually changes", () => {
  const { state } = realmOf(1);
  assert.deepEqual(engine.setAlignment(state, "u0", "neutral"), [], "already neutral");

  const out = engine.setAlignment(state, "u0", "evil");
  assert.equal(state.players.u0!.alignment, "evil");
  assert.match(text(out), /now evil/);
});

test("players wrap at the edges of the map rather than walking off it", () => {
  const { state, c } = realmOf(4);
  for (const p of Object.values(state.players)) {
    p.x = 0;
    p.y = rules.DEFAULT_TUNING.mapY;
  }

  engine.tick(state, 200, c);

  for (const p of Object.values(state.players)) {
    assert.ok(p.x >= 0 && p.x <= rules.DEFAULT_TUNING.mapX, `x escaped: ${p.x}`);
    assert.ok(p.y >= 0 && p.y <= rules.DEFAULT_TUNING.mapY, `y escaped: ${p.y}`);
  }
});

test("no clock ever goes negative, however brutal the tick", () => {
  const { state, c } = realmOf(6);
  for (const p of Object.values(state.players)) p.alignment = "evil";

  for (let i = 0; i < 400; i += 1) {
    engine.tick(state, 600, { ...c, now: START + i * 600_000 });
    for (const p of Object.values(state.players)) {
      assert.ok(p.next >= 0, `${p.name} has a negative clock`);
      assert.ok(Number.isFinite(p.next), `${p.name} has a nonsense clock`);
    }
  }
});

/**
 * Runs a realm for `days`, optionally starting everyone at `startLevel`.
 *
 * The head start is not a shortcut: quests need level-40 players, so a run that
 * begins at level 0 spends most of its budget on a ramp that tells us nothing
 * about the thing being measured.
 */
function simulate(pop: number, days: number, seed: number, startLevel = 0) {
  const { state, c } = realmOf(pop, seed);
  if (startLevel > 0) {
    for (const p of Object.values(state.players)) {
      p.level = startLevel;
      p.next = rules.timeToLevel(startLevel);
      p.lastLogin = START - rules.QUEST_MIN_TENURE * 1000 - 1000;
    }
  }
  const STEP = 1_800;
  for (let elapsed = 0; elapsed < days * 86_400; elapsed += STEP) {
    engine.tick(state, STEP, { ...c, now: START + elapsed * 1000 });
  }
  return state;
}

test("a long run leaves every character in a sane state", () => {
  const state = simulate(6, 60, 77);

  for (const p of Object.values(state.players)) {
    assert.ok(p.level > 0, `${p.name} never levelled in two months of idling`);
    assert.ok(Number.isFinite(p.next) && p.next >= 0, `${p.name} has a broken clock`);
    assert.ok(p.idled > 0);
    assert.equal(Object.keys(p.items).length, 10);
    for (const [slot, item] of Object.entries(p.items)) {
      assert.ok(
        Number.isFinite(item.level) && item.level >= 0,
        `${p.name}'s ${slot} is level ${item.level}`,
      );
    }
    assert.ok(p.x >= 0 && p.x <= rules.DEFAULT_TUNING.mapX);
    assert.ok(p.y >= 0 && p.y <= rules.DEFAULT_TUNING.mapY);
  }
});

/**
 * The pacing property that surprises everyone who runs this on a small server.
 *
 * A quest always draws exactly four players and always pays them a quarter off
 * their clocks, whatever the population. In the IRC channels the game was
 * written for that is a lottery nobody wins twice a year; in a realm of five it
 * is most of your progression, and characters level several times faster than
 * the curve alone would suggest.
 *
 * This is upstream's behaviour, not a defect, and it is pinned here so that any
 * future change to the quest system has to be deliberate about it.
 */
test("a small realm levels faster than a large one, because quests do not scale", () => {
  const best = (pop: number) =>
    engine.topPlayers(simulate(pop, 25, 5, rules.QUEST_MIN_LEVEL), 1)[0]!.level;

  const small = best(5);
  const large = best(20);
  assert.ok(small > large, `small realm reached ${small}, large reached ${large}`);
});

test("the leaderboard sorts by level, then by who is closest to the next one", () => {
  const { state } = realmOf(3);
  state.players.u0!.level = 5;
  state.players.u0!.next = 900;
  state.players.u1!.level = 5;
  state.players.u1!.next = 100;
  state.players.u2!.level = 9;

  assert.deepEqual(
    engine.topPlayers(state).map((p) => p.userId),
    ["u2", "u1", "u0"],
  );
});

test("findByName ignores case and returns null for a stranger", () => {
  const { state } = realmOf(1);
  assert.equal(engine.findByName(state, "pLaYeR0")?.userId, "u0");
  assert.equal(engine.findByName(state, "Nobody"), null);
});

test("a frozen realm charges nobody for talking", () => {
  const { state, c } = realmOf(1);
  const player = state.players.u0;
  assert.ok(player);
  player.level = 13;
  player.next = 1814;
  state.paused = true;

  const before = player.next;
  const out = engine.penalizeMessage(state, "u0", c, 40);

  assert.equal(out.length, 0, "a frozen realm says nothing about a penalty it did not apply");
  assert.equal(player.next, before, "the clock must not move while it is held");
  assert.equal(player.penalties.message, 0);

  // And the tick is not quietly crediting it back either: still held.
  engine.tick(state, 600, c);
  assert.equal(player.next, before);
});

test("leaving a frozen realm stops the clock without costing time", () => {
  const { state, c } = realmOf(1);
  const player = state.players.u0;
  assert.ok(player);
  player.level = 13;
  state.paused = true;

  const before = player.next;
  engine.logout(state, "u0", c);

  assert.equal(player.online, false, "the choice is still honoured");
  assert.equal(player.suspended, true);
  assert.equal(player.next, before, "but it costs nothing while nothing is moving");
  assert.equal(player.penalties.logout, 0);
});

test("a penalty ceiling under ten seconds still caps a nick change", () => {
  const { state, c } = realmOf(1);
  const player = state.players.u0;
  assert.ok(player);
  player.level = 50;

  // A ceiling of 5 divides to 0, which penalty() reads as "uncapped" unless
  // the floor holds. Uncapped, this rename costs the better part of six hours.
  const ctx = { ...c, tuning: { ...rules.DEFAULT_TUNING, penLimit: 5 } };
  engine.penalizeNick(state, "u0", ctx);

  assert.ok(
    player.penalties.nick <= 5,
    `a nick change cost ${player.penalties.nick}s in a realm capped at 5s`,
  );
});

test("presence-driven realms tell a player what actually stops their clock", () => {
  const { state, c } = realmOf(1);
  const player = state.players.u0;
  assert.ok(player);
  player.level = 13;

  const quiet = text(engine.penalizeMessage(state, "u0", c, 40));
  assert.ok(!quiet.includes("only runs while you are online"));

  player.penalties.message = 0;
  const told = text(engine.penalizeMessage(state, "u0", { ...c, presenceDriven: true }, 40));
  assert.match(told, /only runs while you are online/);
});
