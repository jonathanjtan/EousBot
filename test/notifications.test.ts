import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

/**
 * How the two games are allowed to reach a player.
 *
 * Both of them used to DM: the idle game whispered item finds and penalties,
 * and the dispatch game sent a private claim reminder. A bot that opens a
 * one-to-one conversation to narrate your helmet is a bot people mute, so
 * everything goes to the game channel now.
 *
 * Two rules, and this file exists because both are the kind that rot back in
 * one convenient `user.send()` at a time:
 *
 *   1. Neither game touches a DM API.
 *   2. Only the claim reminder mentions anybody. It is the one message that
 *      asks the player to come back and do something.
 *
 * Werewolf is out of scope on purpose: it is a hidden-role game whose whole
 * structure depends on private role cards, and it lives in
 * src/commands/werewolf.ts, which is not scanned here.
 */

/** Every module either game uses to talk to Discord. */
function gameSources(): string[] {
  const dirs = ["src/idlerpg", "src/rpg"];
  const files = dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `${dir}/${name}`),
  );
  return [...files, "src/commands/idlerpg.ts", "src/commands/rpg.ts", "src/commands/rpgsocial.ts"];
}

/** Source lines that are not comments. */
function code(path: string): { line: number; text: string }[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => {
      const t = text.trimStart();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    });
}

test("neither game has a way to DM anybody", () => {
  const dmApis: [RegExp, string][] = [
    [/users\.fetch\s*\(/, "users.fetch, which exists here only to DM the result"],
    [/createDM\s*\(/, "createDM"],
    [/\buser\??\.\s*send\s*\(/, "user.send"],
    [/\bmembers?\??\.\s*send\s*\(/, "member.send"],
  ];

  const offences: string[] = [];
  for (const path of gameSources()) {
    for (const { line, text } of code(path)) {
      for (const [pattern, what] of dmApis) {
        if (pattern.test(text)) offences.push(`${path}:${line} ${what}`);
      }
    }
  }
  assert.deepEqual(offences, [], `a DM path came back:\n${offences.join("\n")}`);
});

test("the idle game never mentions a player", async () => {
  const engine = await import("../src/idlerpg/engine.ts");
  const rules = await import("../src/idlerpg/rules.ts");

  const START = Date.UTC(2026, 0, 1);
  const ctx = {
    rng: () => 0.5,
    now: START,
    tuning: rules.DEFAULT_TUNING,
    bossName: "EousBot",
    presenceDriven: true,
  };

  const state = engine.newWorld(START);
  engine.register(state, "u0", "Player0", "tester", ctx);
  engine.register(state, "u1", "Player1", "tester", ctx);

  const lines = [
    ...engine.penalizeMessage(state, "u0", ctx, 40),
    ...engine.penalizeNick(state, "u1", ctx),
    ...engine.findItem(state.players.u0!, ctx),
    ...engine.tick(state, 3_600, ctx),
  ];

  assert.ok(lines.length > 0, "the realm has to have said something for this to prove anything");
  for (const line of lines) {
    assert.doesNotMatch(line.text, /<@/, `mention in an idle game line: ${line.text.slice(0, 80)}`);
  }
});

test("the claim reminder mentions, because it is the one asking for something back", async () => {
  const engine = await import("../src/rpg/engine.ts");
  const rules = await import("../src/rpg/rules.ts");
  const notify = await import("../src/rpg/notify.ts");

  const START = Date.UTC(2026, 0, 1);
  const ctx = (now = START) => ({ rng: () => 0.5, now, tuning: rules.DEFAULT_TUNING });

  const state = engine.newGame();
  engine.create(state, "u0", "Alpha", "warrior", ctx());
  engine.startExpedition(state, "u0", 1, ctx());

  const due = notify.pendingClaims(state, START + rules.expeditionDuration(1) + 1);
  assert.equal(due.length, 1);
  assert.match(notify.reminder(due[0]!), /<@u0>/);
});
