import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for presenting a Target listing.
 *
 * The theme is omission: live price and stock are usually unreadable (see
 * targetapi.ts), so what matters most is that an unknown field disappears from
 * the output rather than surfacing as "$undefined" or a confident wrong number.
 */

const { describeListing, streetDateNote } = await import("../src/listing.ts");

const META = {
  parsedBlob: true,
  title: "First Partner Illustration Collection",
  purchaseLimit: 2,
  relationshipTypeCode: "SA",
  streetDate: "2026-08-07",
};

const AVAIL = {
  ok: true,
  status: 200,
  blocked: false,
  challenged: false,
  unitPrice: 24.99,
  shipStatus: "IN_STOCK",
  marketplace: false,
};

const NOW = Date.parse("2026-08-07T12:00:00Z");

test("describeListing reports price, limit and seller when they're known", () => {
  const facts = describeListing(META, AVAIL, NOW).join(" | ");
  assert.match(facts, /\$24\.99 each/);
  assert.match(facts, /limit 2 per order/);
  assert.match(facts, /sold by Target/);
});

/** The live case: the CAPTCHA leaves price and stock undefined, metadata intact. */
test("describeListing degrades to the static facts when live stock is unreadable", () => {
  const facts = describeListing(META, { ok: false, status: 403, blocked: true, challenged: true }, NOW);
  assert.deepEqual(facts, ["limit 2 per order", "sold by Target", "releases today (2026-08-07)"]);
  assert.doesNotMatch(facts.join(" "), /undefined|NaN|\$/);
});

test("describeListing claims nothing when it knows nothing", () => {
  const facts = describeListing(
    { parsedBlob: false },
    { ok: true, status: 200, blocked: false, challenged: false },
    NOW,
  );
  assert.deepEqual(facts, []);
});

test("describeListing flags a third-party seller instead of hiding it", () => {
  const facts = describeListing(
    META,
    { ...AVAIL, marketplace: true, sellerName: "CardFlipperLLC" },
    NOW,
  ).join(" | ");
  assert.match(facts, /third-party seller — CardFlipperLLC/);
  assert.doesNotMatch(facts, /sold by Target/);
});

test("describeListing treats a non-SA seller code as third-party", () => {
  const facts = describeListing(
    { ...META, relationshipTypeCode: "VAP" },
    { ...AVAIL, marketplace: undefined },
    NOW,
  ).join(" | ");
  assert.match(facts, /third-party seller/);
});

test("describeListing includes remaining quantity when reported", () => {
  assert.match(describeListing(META, { ...AVAIL, atpQuantity: 3 }, NOW).join(" | "), /3 available/);
});

test("streetDateNote distinguishes a future preorder from a release today", () => {
  assert.equal(streetDateNote(META, NOW), "releases today (2026-08-07)");
  assert.match(streetDateNote(META, Date.parse("2026-08-01T12:00:00Z")) ?? "", /releases in 6 days/);
  assert.equal(
    streetDateNote(META, Date.parse("2026-09-01T12:00:00Z")),
    undefined,
    "past releases are unremarkable",
  );
  assert.equal(streetDateNote({ parsedBlob: true }, NOW), undefined);
});

test("streetDateNote singularises one day", () => {
  assert.match(streetDateNote(META, Date.parse("2026-08-06T12:00:00Z")) ?? "", /in 1 day \(/);
});
