import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The custom IDs behind the page buttons on /codes.
 *
 * Everything the button handler needs travels in the ID -- which game was
 * asked for, and which page to build -- so a decode that quietly returns null
 * turns a visible button into a no-op with nothing logged anywhere.
 *
 * The command module imports config, which exits the process when required
 * environment variables are absent, so they are set here first with obvious
 * dummy values. Nothing in this file talks to Discord or to the code list.
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

const { encodeCodesPage, decodeCodesPage } = await import("../src/commands/codes.ts");
const { GAMES } = await import("../src/redeem.ts");

test("every game and page round-trips through the custom ID", () => {
  for (const game of [null, ...GAMES.map((entry) => entry.value)]) {
    for (const page of [0, 7]) {
      const encoded = encodeCodesPage(game, page);
      assert.ok(encoded.length <= 100, "Discord caps custom IDs at 100 chars");
      assert.deepEqual(decodeCodesPage(encoded), { game, page });
    }
  }
});

test("decodeCodesPage leaves other buttons alone", () => {
  assert.equal(decodeCodesPage("eous:approve:11:7"), null);
  assert.equal(decodeCodesPage("codes:page:genshin"), null);
  assert.equal(decodeCodesPage("codes:page:genshin:x"), null);
  assert.equal(decodeCodesPage("codes:page:genshin:-1"), null);
  assert.equal(decodeCodesPage("codes:page:genshin:1.5"), null);
});
