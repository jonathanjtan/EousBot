import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/**
 * The house style, enforced on what the game says out loud.
 *
 * src/unslop.ts is the standard and test/unslop.test.ts already checks that the
 * rules obey themselves. This does the other half: the game's own output, which
 * had 141 em dashes and a help system that explained design decisions to people
 * who wanted to know what to type.
 *
 * Scans source lines rather than rendered output, because most of these strings
 * are templates needing a populated world to render. Comment lines are skipped:
 * they are for whoever maintains this, not for players.
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
 * Scoped to files this rewrite authored, deliberately.
 *
 * A first attempt swept the whole bot and corrupted three pieces of
 * pre-existing parsing logic: a constant named `mdash` was redefined to a
 * comma, a regex matching em-dash-delimited scraped HTML was pointed at commas
 * instead, and a character class of valid frame-data characters lost the dash.
 * The suite caught all three. The lesson is not "be careful with regexes", it
 * is that a punctuation rule for prose has no business running over code
 * somebody else wrote, where the same character may be load-bearing.
 */

/** Source lines that are not comments. */
function speech(path: string): { line: number; text: string }[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => {
      const t = text.trimStart();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    });
}

const BANNED_CHARACTERS: [string, string][] = [
  ["—", "em dash"],
  ["–", "en dash"],
  ["“", "curly open quote"],
  ["”", "curly close quote"],
  ["‘", "curly open apostrophe"],
  ["’", "curly apostrophe"],
];

test("nothing the game says uses a banned mark", () => {
  const offences: string[] = [];
  for (const path of USER_FACING) {
    for (const { line, text } of speech(path)) {
      for (const [char, name] of BANNED_CHARACTERS) {
        if (text.includes(char)) offences.push(`${path}:${line} ${name}: ${text.trim().slice(0, 70)}`);
      }
    }
  }
  assert.deepEqual(offences, [], `banned punctuation:\n${offences.join("\n")}`);
});

test("nothing the game says uses the banned vocabulary", () => {
  const banned = [
    "additionally", "crucial", "delve", "enhance", "garner", "intricate",
    "landscape", "pivotal", "robust", "seamless", "showcase", "testament",
    "underscore", "vibrant", "leverage", "utilize", "facilitate",
    "comprehensive", "serves as", "stands as", "boasts",
  ];
  const offences: string[] = [];
  for (const path of USER_FACING) {
    for (const { line, text } of speech(path)) {
      for (const word of banned) {
        if (new RegExp(`\\b${word}\\b`, "i").test(text)) {
          offences.push(`${path}:${line} "${word}"`);
        }
      }
    }
  }
  assert.deepEqual(offences, [], `banned vocabulary:\n${offences.join("\n")}`);
});

test("the help does not use 'not just X, but Y', or hedge in stacks", () => {
  const help = readFileSync("src/rpg/help.ts", "utf8");
  assert.doesNotMatch(help, /not just .{1,40}, but/i, "say the thing you mean");
  assert.doesNotMatch(help, /could potentially|it might be argued/i, "stacked hedge");
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
