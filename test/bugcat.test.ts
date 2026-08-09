import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for the Bugcat Capoo sticker list and its URLs.
 *
 * Imported directly rather than through the command module so the suite doesn't
 * pull in src/config.ts, which exits the process on missing environment
 * variables. Nothing here touches the network — the ids were checked against
 * the LINE sticker shop when they were bundled, and a test suite that fails
 * when a CDN blinks is worse than no test.
 */

const { STICKER_IDS, pickSticker, stickerUrl } = await import("../src/bugcat.ts");

test("the sticker list is non-empty and free of duplicates", () => {
  assert.ok(STICKER_IDS.length > 0);
  assert.equal(new Set(STICKER_IDS).size, STICKER_IDS.length, "ids must not repeat");
});

test("every id is a positive integer", () => {
  for (const id of STICKER_IDS) {
    assert.ok(Number.isInteger(id) && id > 0, `${id} is not a sticker id`);
  }
});

test("pickSticker only ever returns an id from the list", () => {
  for (let i = 0; i < 200; i++) {
    assert.ok(STICKER_IDS.includes(pickSticker()), "picked something off the list");
  }
});

test("pickSticker covers both ends of the list", () => {
  assert.equal(pickSticker(() => 0), STICKER_IDS[0]);
  assert.equal(pickSticker(() => 0.999999999), STICKER_IDS[STICKER_IDS.length - 1]);
});

test("stickerUrl builds an https PNG URL on the LINE sticker shop", () => {
  assert.equal(
    stickerUrl(1806801),
    "https://stickershop.line-scdn.net/stickershop/v1/sticker/1806801/android/sticker.png",
  );

  for (const id of STICKER_IDS) {
    const url = new URL(stickerUrl(id));
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "stickershop.line-scdn.net");
    assert.ok(url.pathname.endsWith("/sticker.png"), `${url} is not a PNG`);
  }
});
