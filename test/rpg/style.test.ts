import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/**
 * The house style, enforced on what the game says out loud.
 *
 * This file used to hold the punctuation, vocabulary and restatement rules for
 * a list of fourteen game modules. test/voice.test.ts now runs those over every
 * file in src/, which is a superset, so keeping a second copy here would only
 * give the two lists somewhere to drift apart. What is left is the part that is
 * about this game rather than about the bot: a stricter tic scan that reads
 * comments too, and the manual.
 */

/** Every module that produces text a player will read. */
const USER_FACING = [
  "src/rpg/help.ts",
  "src/rpg/format.ts",
  "src/rpg/content.ts",
  "src/rpg/engine.ts",
  "src/rpg/chessgame.ts",
  "src/rpg/notify.ts",
  "src/commands/rpg.ts",
  "src/commands/rpgsocial.ts",
  "src/commands/chess.ts",
  "src/commands/werewolf.ts",
  "src/idlerpg/format.ts",
  "src/idlerpg/flavor.ts",
  "src/idlerpg/engine.ts",
  "src/commands/idlerpg.ts",
];

/**
 * Named tics, checked in comments as well as strings.
 *
 * The repo-wide scan stops at the comment line, because forty of these sit in
 * older modules explaining the design to the next maintainer. These files were
 * swept, and this keeps them swept. The words showed up 21 times in comments
 * and 4 times in commit messages before anyone said anything, which is where a
 * tic lives before it reaches a user.
 */
test("nothing here flags its own intent instead of stating the thing", () => {
  const tics = ["deliberately", "on purpose", "load-bearing", "quietly", "genuinely", "theatre"];
  const offences: string[] = [];

  for (const path of USER_FACING) {
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((text, i) => {
        for (const tic of tics) {
          if (new RegExp(`\\b${tic}\\b`, "i").test(text)) {
            offences.push(`${path}:${i + 1} "${tic}"`);
          }
        }
      });
  }
  assert.deepEqual(offences, [], `intent-flagging words:\n${offences.join("\n")}`);
});

/**
 * The failure that prompted this file.
 *
 * The first help pages argued for their own design at players: "deliberately
 * not the tournament", "the whole reason it is interesting", "on purpose". That
 * is a code comment wearing a manual's clothes, and it costs the reader length
 * without buying them anything.
 */
test("the help explains how to play, not why it was built that way", async () => {
  // Dynamic import, not require: this file is ESM, and require() throws here.
  // Made the same mistake in a handler earlier in this project and caught it
  // before shipping; made it again three files later.
  const { HELP_PAGES } = await import("../../src/rpg/help.ts");
  const tells = [/\bon purpose\b/i, /\bdeliberately\b/i, /\bthe whole point\b/i, /\bthe whole reason\b/i];
  const offences: string[] = [];

  for (const page of HELP_PAGES) {
    for (const line of page.body) {
      for (const tell of tells) {
        if (tell.test(line)) offences.push(`${page.topic}: ${line.trim().slice(0, 60)}`);
      }
    }
  }
  assert.deepEqual(offences, [], `design commentary in the manual:\n${offences.join("\n")}`);
});

test("the adventure table columns are wide enough for their widest value", () => {
  // "10h 30m" is seven characters and used to overflow a five-wide column,
  // which nothing caught until somebody rendered a level-22 character.
  const source = readFileSync("src/rpg/format.ts", "utf8");
  const match = /shortDuration\(expeditionDuration\(d, t\)\)\.padStart\((\d+)\)/.exec(source);
  assert.ok(match, "could not find the time column");
  assert.ok(Number(match[1]) >= 7, `time column pads to ${match[1]}, needs 7 for "10h 30m"`);
});
