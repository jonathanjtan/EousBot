import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for the link building and game detection behind /code.
 *
 * Imported directly rather than through the command module so the suite doesn't
 * pull in src/config.ts, which exits the process on missing environment
 * variables. Nothing here touches the network: `identifyGame` takes the lister
 * it reads codes with, so the lists below stand in for the published ones,
 * including the failure a game whose list won't load produces.
 */

const { GAMES, gameFor, identifyGame, normaliseCode, parseCodeList, redeemUrl } = await import(
  "../src/redeem.ts"
);
const { GAME_CHOICES } = await import("../src/hoyo.ts");

const genshin = GAMES[0]!;
const hsr = GAMES[1]!;
const zzz = GAMES[2]!;

/** A lister that answers with fixed lists, keyed by the game's list key. */
function listing(lists: Record<string, string[]>) {
  return async (game: (typeof GAMES)[number]) => lists[game.key] ?? [];
}

test("the three games are the ones /hoyohell names, spelled the same way", () => {
  assert.deepEqual(
    GAMES.map((game) => game.value),
    GAME_CHOICES.map((game) => game.value),
  );
  assert.deepEqual(
    GAMES.map((game) => game.name),
    GAME_CHOICES.map((game) => game.name),
  );
});

test("each game's link puts the code in the query", () => {
  assert.equal(
    redeemUrl(genshin, "GENSHINGIFT"),
    "https://genshin.hoyoverse.com/en/gift?code=GENSHINGIFT",
  );
  assert.equal(redeemUrl(hsr, "STARRAILGIFT"), "https://hsr.hoyoverse.com/gift?code=STARRAILGIFT");
  assert.equal(
    redeemUrl(zzz, "ZENLESSGIFT"),
    "https://zenless.hoyoverse.com/redemption?code=ZENLESSGIFT",
  );
});

test("gameFor takes the option values and nothing else", () => {
  assert.equal(gameFor("hsr"), hsr);
  assert.equal(gameFor("zzz"), zzz);
  assert.equal(gameFor("starrail"), null);
  assert.equal(gameFor(null), null);
});

test("normaliseCode accepts a code however it was pasted", () => {
  assert.equal(normaliseCode("GENSHINGIFT"), "GENSHINGIFT");
  assert.equal(normaliseCode("  2bj64qrz7rt8 "), "2BJ64QRZ7RT8");
  assert.equal(normaliseCode("`ZZZMEIJI`"), "ZZZMEIJI");
  assert.equal(normaliseCode('"5S6ZHRWTDNJB"'), "5S6ZHRWTDNJB");
});

test("normaliseCode refuses what isn't a code", () => {
  assert.equal(normaliseCode(""), null);
  assert.equal(normaliseCode("ABC"), null);
  assert.equal(normaliseCode("https://genshin.hoyoverse.com/en/gift?code=X"), null);
  assert.equal(normaliseCode("CODE-WITH-DASHES"), null);
  assert.equal(normaliseCode("A".repeat(31)), null);
});

test("parseCodeList reads the published shape and survives anything else", () => {
  const payload = {
    codes: [
      { id: 790, code: "BALLETCOLLAB", status: "OK", game: "genshin" },
      { id: 776, code: " 2bj64qrz7rt8 ", status: "OK", game: "genshin" },
      { id: 1, status: "OK", game: "genshin" },
      null,
      "GENSHINGIFT",
    ],
  };
  assert.deepEqual(parseCodeList(payload), ["BALLETCOLLAB", "2BJ64QRZ7RT8"]);

  assert.deepEqual(parseCodeList({ detail: "Field required" }), []);
  assert.deepEqual(parseCodeList(null), []);
  assert.deepEqual(parseCodeList("nonsense"), []);
});

test("a code on one game's list names that game", async () => {
  const found = await identifyGame(
    "5S6ZHRWTDNJB",
    listing({ genshin: ["BALLETCOLLAB"], hkrpg: ["5S6ZHRWTDNJB"], nap: ["ZZZMEIJI"] }),
  );
  assert.equal(found.game, hsr);
  assert.equal(found.verdict, "listed");
  assert.deepEqual(found.failures, []);
});

test("an unlisted code falls back to what it spells", async () => {
  const found = await identifyGame("ZZZFRESHCODE", listing({}));
  assert.equal(found.game, zzz);
  assert.equal(found.verdict, "spells");
});

test("an unlisted code that spells nothing settles on no game", async () => {
  const found = await identifyGame("2BJ64QRZ7RT8", listing({}));
  assert.equal(found.game, null);
  assert.equal(found.verdict, "unknown");
});

test("two lists claiming the same code is treated as no answer", async () => {
  const found = await identifyGame(
    "DOUBLECLAIMED",
    listing({ genshin: ["DOUBLECLAIMED"], nap: ["DOUBLECLAIMED"] }),
  );
  assert.equal(found.game, null);
  assert.equal(found.verdict, "unknown");
});

test("a list that won't load costs its own game, not the answer", async () => {
  const found = await identifyGame("5S6ZHRWTDNJB", async (game) => {
    if (game.key === "genshin") throw new Error("HTTP 503");
    return game.key === "hkrpg" ? ["5S6ZHRWTDNJB"] : [];
  });
  assert.equal(found.game, hsr);
  assert.equal(found.verdict, "listed");
  assert.deepEqual(
    found.failures.map((failure) => failure.game),
    ["Genshin Impact"],
  );
  assert.match(found.failures[0]!.error, /HTTP 503/);
});

test("every list failing still leaves the spelling to fall back on", async () => {
  const found = await identifyGame("GENSHINGIFT", async () => {
    throw new Error("HTTP 503");
  });
  assert.equal(found.game, genshin);
  assert.equal(found.verdict, "spells");
  assert.equal(found.failures.length, GAMES.length);
});
