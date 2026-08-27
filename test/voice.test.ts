import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The house style, enforced on everything the bot says.
 *
 * src/unslop.ts is the standard and test/unslop.test.ts checks that the rules
 * obey themselves. test/rpg/style.test.ts covers what the game says. This
 * covers the rest, which is most of what a user actually hears: the answer to
 * an `@EousBot` question, the build status lines, every command reply, every
 * embed title.
 *
 * A prompt can only ask the model for a style. These strings are the bot's own
 * voice, written by hand, and there is no reason for them to be sloppier than
 * what the prompt demands of the model. Before this file there were 63 em
 * dashes and a help embed in curly quotes.
 *
 * Scanning source rather than rendered output, because almost every string
 * here is a template needing a live Discord interaction to render.
 */

/** Everything under src/, so a file added later is covered without an edit. */
function sources(dir = "src"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out.sort();
}

/**
 * The one file that has to break the rules to state them.
 *
 * test/unslop.test.ts holds it to a stricter version of the same standard:
 * each banned word may appear once, as its own ban.
 */
const EXEMPT = new Set(["src/unslop.ts"]);

/**
 * Source lines that are not comments.
 *
 * Comments are for whoever maintains this. Two of them quote scraped HTML that
 * really does contain an em dash, and rewriting those would make them wrong.
 */
function speech(path: string): { line: number; text: string }[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => {
      const t = text.trimStart();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    });
}

function scan(check: (text: string) => string | null): string[] {
  const offences: string[] = [];
  for (const path of sources()) {
    if (EXEMPT.has(path)) continue;
    for (const { line, text } of speech(path)) {
      const why = check(text);
      if (why !== null) offences.push(`${path}:${line} ${why}: ${text.trim().slice(0, 70)}`);
    }
  }
  return offences;
}

const BANNED_CHARACTERS: [string, string][] = [
  ["—", "em dash"],
  ["–", "en dash"],
  ["“", "curly open quote"],
  ["”", "curly close quote"],
  ["‘", "curly open apostrophe"],
  ["’", "curly apostrophe"],
];

/**
 * Written as escapes, not as the characters themselves.
 *
 * src/smash.ts parses a wiki that delimits its stat lines with a real em dash,
 * and an earlier sweep of this repo replaced that character with a comma and
 * broke the scraper. Spelling a needed codepoint as \u2014 keeps it working
 * and says which of the two it is: data the bot reads, not words it writes.
 */
test("nothing the bot says uses a banned mark", () => {
  const offences = scan((text) => {
    for (const [char, name] of BANNED_CHARACTERS) if (text.includes(char)) return name;
    return null;
  });
  assert.deepEqual(offences, [], `banned punctuation:\n${offences.join("\n")}`);
});

test("nothing the bot says uses the banned vocabulary", () => {
  const banned = [
    "additionally", "crucial", "delve", "enhance", "garner", "intricate",
    "landscape", "pivotal", "robust", "seamless", "showcase", "testament",
    "underscore", "vibrant", "leverage", "utilize", "facilitate",
    "comprehensive", "serves as", "stands as", "boasts",
  ];
  const offences = scan((text) => {
    for (const word of banned) if (new RegExp(`\\b${word}\\b`, "i").test(text)) return `"${word}"`;
    return null;
  });
  assert.deepEqual(offences, [], `banned vocabulary:\n${offences.join("\n")}`);
});

/**
 * The tics, in strings only.
 *
 * test/rpg/style.test.ts checks the game's comments too. Here the scan stops
 * at the comment line, because forty of these sit in prose explaining the
 * design to the next maintainer, and that is a separate cleanup.
 */
test("nothing the bot says flags its own intent instead of stating the thing", () => {
  const tics = ["deliberately", "on purpose", "load-bearing", "quietly", "genuinely", "theatre"];
  const offences = scan((text) => {
    for (const tic of tics) if (new RegExp(`\\b${tic}\\b`, "i").test(text)) return `"${tic}"`;
    return null;
  });
  assert.deepEqual(offences, [], `intent-flagging words:\n${offences.join("\n")}`);
});

test("nothing the bot says restates itself in the negative, or hedges in stacks", () => {
  const patterns: [RegExp, string][] = [
    [/not just .{1,40}, but/i, "say the thing you mean"],
    [/could potentially|it might be argued/i, "stacked hedge"],
    [/\b(then|now|here|there), not (then|now|here|there)\b/i, "restated in the negative"],
  ];
  const offences = scan((text) => {
    for (const [pattern, why] of patterns) if (pattern.test(text)) return why;
    return null;
  });
  assert.deepEqual(offences, [], `restatement:\n${offences.join("\n")}`);
});

/**
 * The other half of the job, and the half a punctuation scan cannot reach.
 *
 * Most of what a user reads is written by the model, not by hand, so the rules
 * have to ride in the system prompt of every session that produces prose. Both
 * of them do: chat.ts answers questions, and agent.ts writes the build summary
 * that lands in the review message. A third `query()` added later without the
 * rules would ship a second voice, so this fails until it has them.
 */
test("every prompt the bot speaks through carries the house style", () => {
  const speaking = sources().filter((path) => /\bquery\(\{/.test(readFileSync(path, "utf8")));
  assert.deepEqual(speaking, ["src/agent.ts", "src/chat.ts"], "a new agent session appeared");

  for (const path of speaking) {
    assert.match(
      readFileSync(path, "utf8"),
      /\$\{UNSLOP_RULES\}/,
      `${path} builds a system prompt without the house style in it`,
    );
  }
});
