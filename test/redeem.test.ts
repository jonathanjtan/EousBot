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

const {
  GAMES,
  NO_HEADING,
  activeCodesFor,
  codeChunks,
  codePages,
  gameFor,
  gamesFor,
  identifyGame,
  normaliseCode,
  parseCodeEntries,
  parseCodeList,
  redeemUrl,
  tidyRewards,
} = await import("../src/redeem.ts");
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

test("gamesFor gives one game or all three", () => {
  assert.deepEqual(gamesFor("zzz"), [zzz]);
  assert.deepEqual(gamesFor(null), GAMES);
  assert.deepEqual(gamesFor("starrail"), GAMES);
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

test("parseCodeEntries keeps the rewards and drops what isn't redeemable", () => {
  const payload = {
    codes: [
      { id: 790, code: "BALLETCOLLAB", status: "OK", game: "genshin", rewards: "Primogem*30" },
      { id: 776, code: " 2bj64qrz7rt8 ", status: "OK", game: "genshin" },
      { id: 777, code: "EXPIRED", status: "NOT_ACTIVE", game: "genshin", rewards: "Mora*1" },
      { id: 1, status: "OK", game: "genshin" },
      null,
    ],
  };
  assert.deepEqual(parseCodeEntries(payload), [
    { code: "BALLETCOLLAB", rewards: "Primogem*30" },
    { code: "2BJ64QRZ7RT8", rewards: null },
  ]);

  assert.deepEqual(parseCodeEntries(null), []);
});

test("tidyRewards reads both shapes the list publishes", () => {
  assert.equal(
    tidyRewards("Primogem*30;Mora*10000;Hero's Wit*3"),
    "Primogem x30, Mora x10000, Hero's Wit x3",
  );
  const prose = "60 primogems and five adventurer's experience";
  assert.equal(tidyRewards(prose), prose);
  assert.equal(tidyRewards("Polychrome*50000000", 12), "Polychrome…");
});

test("codeChunks links every code and says what it pays", () => {
  const chunks = codeChunks(zzz, [
    { code: "ZZZMEIJI", rewards: "Polychrome*50" },
    { code: "ZZZ2YEAR", rewards: null },
  ]);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0]!.split("\n"), [
    "[`ZZZMEIJI`](https://zenless.hoyoverse.com/redemption?code=ZZZMEIJI) · Polychrome x50",
    "[`ZZZ2YEAR`](https://zenless.hoyoverse.com/redemption?code=ZZZ2YEAR)",
  ]);
});

/** A game's worth of codes, each line long enough to make chunking bite. */
function manyCodes(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    code: `STARRAILCODE${index}`,
    rewards: "Stellar Jade*100;Refined Aether*4;Traveler's Guide*2",
  }));
}

test("codeChunks keeps every code, in order, across as many fields as it takes", () => {
  const codes = manyCodes(20);
  const chunks = codeChunks(hsr, codes);
  assert.ok(chunks.length > 1, "20 long lines do not fit one field");

  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1024, `field was ${chunk.length} characters`);
  }

  const lines = chunks.flatMap((chunk) => chunk.split("\n"));
  assert.equal(lines.length, 20);
  assert.deepEqual(
    lines.map((line) => line.match(/`(STARRAILCODE\d+)`/)![1]),
    codes.map((entry) => entry.code),
  );
  assert.ok(!chunks.some((chunk) => chunk.includes("more")));
});

test("codeChunks gives one code one chunk, and no codes none", () => {
  assert.equal(codeChunks(zzz, [{ code: "ZENLESSGIFT", rewards: null }]).length, 1);
  assert.deepEqual(codeChunks(zzz, []), []);
});

test("codeChunks drops a line too long for any field rather than overrunning", () => {
  const chunks = codeChunks(zzz, [
    { code: "A".repeat(700), rewards: null },
    { code: "ZZZMEIJI", rewards: null },
  ]);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0]!.split("\n").length, 1);
  assert.match(chunks[0]!, /ZZZMEIJI/);
});

test("codePages puts three short lists on one page and names each game once", () => {
  const pages = codePages([
    { game: genshin, codes: [{ code: "BALLETCOLLAB", rewards: null }], error: null },
    { game: hsr, codes: [], error: null },
    { game: zzz, codes: [], error: "HTTP 503" },
  ]);

  assert.equal(pages.length, 1);
  assert.deepEqual(
    pages[0]!.map((field) => field.name),
    ["Genshin Impact", "Honkai: Star Rail", "Zenless Zone Zero"],
  );
  assert.equal(pages[0]![1]!.value, "No live codes right now.");
  assert.equal(pages[0]![2]!.value, "List unavailable just now.");
});

test("codePages spills a long list onto further fields under one heading", () => {
  const pages = codePages([{ game: hsr, codes: manyCodes(60), error: null }]);
  assert.ok(pages.length > 1, "60 codes do not fit one page");

  const fields = pages.flat();
  assert.ok(fields.every((field) => field.value.length <= 1024));
  assert.ok(pages.every((page) => page.length <= 4));

  // Named at the top of every page it appears on, and nowhere else.
  for (const page of pages) {
    assert.equal(page[0]!.name, "Honkai: Star Rail");
    assert.ok(page.slice(1).every((field) => field.name === NO_HEADING));
  }

  const shown = fields.flatMap((field) => field.value.split("\n")).length;
  assert.equal(shown, 60);
});

test("codePages always has a page to render", () => {
  assert.deepEqual(codePages([]), [[]]);
});

test("activeCodesFor answers per game, failures and all", async () => {
  const listed = await activeCodesFor(GAMES, async (game) => {
    if (game.key === "hkrpg") throw new Error("HTTP 503");
    return game.key === "nap" ? [{ code: "ZZZMEIJI", rewards: null }] : [];
  });

  assert.deepEqual(
    listed.map((entry) => entry.game),
    GAMES,
  );
  assert.deepEqual(listed[0], { game: genshin, codes: [], error: null });
  assert.deepEqual(listed[1]!.codes, []);
  assert.match(listed[1]!.error!, /HTTP 503/);
  assert.deepEqual(listed[2]!.codes, [{ code: "ZZZMEIJI", rewards: null }]);
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
