import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The manual, and whether it is telling the truth.
 *
 * The load-bearing test here is the last one: every command the help text
 * mentions is resolved against the actual registered command tree. Hand-written
 * help rots the instant a subcommand is renamed, and rotted help is worse than
 * none because it is confidently wrong. This makes that rot a build failure.
 *
 * Resolving the tree means importing the command registry, which imports
 * config, which exits the process when required environment variables are
 * absent. So they are set here before the import -- deliberately with obvious
 * dummy values, so nobody mistakes this for a test that talks to Discord.
 */

const help = await import("../../src/rpg/help.ts");

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

const { commands } = await import("../../src/commands/index.ts");

/** Every valid command path, as "name", "name sub", and "name group sub". */
function knownPaths(): Set<string> {
  const paths = new Set<string>();
  for (const command of commands) {
    const json = command.data.toJSON() as {
      name: string;
      options?: { name: string; type: number; options?: { name: string }[] }[];
    };
    paths.add(json.name);
    for (const option of json.options ?? []) {
      // 1 = subcommand, 2 = subcommand group.
      if (option.type === 1) paths.add(`${json.name} ${option.name}`);
      if (option.type === 2) {
        // The group itself counts: documentation legitimately refers to
        // "/idlerpg guild" as a family rather than naming a leaf every time.
        paths.add(`${json.name} ${option.name}`);
        for (const sub of option.options ?? []) {
          paths.add(`${json.name} ${option.name} ${sub.name}`);
        }
      }
    }
  }
  return paths;
}

/**
 * Pulls every command path out of a page.
 *
 * Tokens stop at the first one carrying a `key:value` option or any punctuation,
 * because "`/idlerpg adventure difficulty:3`" names one subcommand, not two, and
 * "`/werewolf open · join`" names one as well.
 */
function referencedPaths(text: string): string[] {
  const found: string[] = [];
  const pattern = /\/(idlerpg|old-idlerpg|chess|werewolf)((?:[ \t]+[^\s`]+)*)/g;

  for (const match of text.matchAll(pattern)) {
    const parts = [match[1] as string];
    // A run of two or more spaces is the alignment gap before a comment inside
    // a code block, so everything after it is prose, not a subcommand.
    const tail = (match[2] ?? "").split(/\s{2,}/)[0] ?? "";
    for (const token of tail.trim().split(/\s+/)) {
      if (!/^[a-z_]+$/.test(token)) break;
      parts.push(token);
      if (parts.length === 3) break;
    }
    found.push(parts.join(" "));
  }
  return found;
}

test("every topic is unique, named, and summarised", () => {
  assert.ok(help.HELP_PAGES.length >= 5, "a manual this thin is a tooltip");
  const topics = help.HELP_PAGES.map((p) => p.topic);
  assert.equal(new Set(topics).size, topics.length, "duplicate topic");

  for (const page of help.HELP_PAGES) {
    assert.match(page.topic, /^[a-z]+$/, `${page.topic}: topics are lowercase words`);
    assert.ok(page.summary.length > 0, `${page.topic}: no summary`);
    assert.ok(page.body.length > 3, `${page.topic}: barely a page`);
  }
});

test("every page fits in a Discord message, index included", () => {
  for (const page of help.HELP_PAGES) {
    const rendered = help.helpPage(page.topic);
    assert.ok(
      rendered.length <= 2_000,
      `${page.topic} renders ${rendered.length} characters; Discord's ceiling is 2000`,
    );
  }
});

test("an unknown or missing topic falls back to the overview", () => {
  const overview = help.helpPage("overview");
  assert.equal(help.helpPage(null), overview);
  assert.equal(help.helpPage("nonsense"), overview);
  assert.match(overview, /idlerpg start/, "the overview must say how to begin");
});

test("every page links onward to the others", () => {
  for (const page of help.HELP_PAGES) {
    const rendered = help.helpPage(page.topic);
    for (const other of help.HELP_PAGES) {
      if (other.topic === page.topic) continue;
      assert.match(
        rendered,
        new RegExp(`\`${other.topic}\``),
        `${page.topic} does not point at ${other.topic}`,
      );
    }
  }
});

test("the code blocks are balanced, so nothing renders as raw text", () => {
  for (const page of help.HELP_PAGES) {
    const fences = page.body.filter((line) => line.trim() === "```").length;
    assert.equal(fences % 2, 0, `${page.topic} has an unclosed code fence`);
  }
});

/**
 * The one that stops the manual from lying.
 */
test("every command the help mentions actually exists", () => {
  const known = knownPaths();
  const missing: string[] = [];

  for (const page of help.HELP_PAGES) {
    for (const path of referencedPaths(page.body.join("\n"))) {
      if (!known.has(path)) missing.push(`${page.topic}: /${path}`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `help references commands that do not exist:\n${missing.join("\n")}`,
  );
});

test("the reference extractor is not silently matching nothing", () => {
  // A guard on the guard: if the regex broke, the test above would pass
  // vacuously and the manual could rot freely.
  const all = help.HELP_PAGES.flatMap((p) => referencedPaths(p.body.join("\n")));
  assert.ok(all.length > 30, `only extracted ${all.length} command references`);
  assert.ok(all.includes("idlerpg claim"), "expected a known path among them");
  assert.ok(all.includes("chess move"), "expected the chess commands too");

  // And it must reject a path that genuinely does not exist.
  assert.deepEqual(referencedPaths("`/idlerpg definitely-not-real`"), ["idlerpg"]);
  assert.deepEqual(referencedPaths("`/idlerpg guild ally name:Banner`"), ["idlerpg guild ally"]);
  assert.deepEqual(referencedPaths("`/idlerpg adventure difficulty:3`"), ["idlerpg adventure"]);
  // The alignment gap inside a code block is prose, not a subcommand.
  assert.deepEqual(referencedPaths("/idlerpg claim                 collect"), ["idlerpg claim"]);
});

/**
 * The README is documentation too, and it drifts the same way help does.
 *
 * This was not hypothetical: the rename to /old-idlerpg left five references
 * pointing at commands that had moved, and nothing would have caught them.
 */
test("every command the README mentions actually exists", async () => {
  const { readFileSync } = await import("node:fs");
  const known = knownPaths();
  const missing = new Set<string>();

  for (const path of referencedPaths(readFileSync("README.md", "utf8"))) {
    if (!known.has(path)) missing.add(path);
  }

  assert.deepEqual(
    [...missing],
    [],
    `README references commands that do not exist:\n${[...missing].map((m) => `/${m}`).join("\n")}`,
  );
});

test("both games are reachable, and their names cannot collide on autofill", () => {
  const names = commands.map((c) => c.data.name);
  assert.ok(names.includes("idlerpg"), "the dispatch game");
  assert.ok(names.includes("old-idlerpg"), "the IRC original");
  assert.ok(!names.includes("irc-idlerpg"), "the old name must be fully gone");

  // The point of the rename: typing "/i" must not offer two similar games.
  const iPrefixed = names.filter((n) => n.startsWith("i"));
  assert.deepEqual(iPrefixed, ["idlerpg"], `"/i" offers ${iPrefixed.join(", ")}`);
});

test("every command that can be played offers help", () => {
  for (const name of ["idlerpg", "old-idlerpg", "chess", "werewolf"]) {
    const command = commands.find((c) => c.data.name === name);
    assert.ok(command, `${name} is not registered`);
    const json = command.data.toJSON() as { options?: { name: string; type: number }[] };
    assert.ok(
      (json.options ?? []).some((o) => o.name === "help" && o.type === 1),
      `/${name} has no help subcommand`,
    );
  }
});
