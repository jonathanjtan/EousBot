import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for reading a Target product listing.
 *
 * Imported directly so the suite doesn't pull in src/config.ts. The fetching
 * half lives in src/targetapi.ts and needs the network, so it isn't exercised
 * here -- `/restock check` is what verifies that end to end against the real
 * site.
 */

const { extractApiKey, extractTgtData, findFirst, isBuyable, parseMetadata, parseTcin, pdpUrl } =
  await import("../src/target.ts");

/** Builds a page carrying `data` the way Target actually emits it. */
function page(data: unknown, extra = ""): string {
  // JSON.stringify twice: once to the JSON payload, once to a JS string literal
  // with every quote escaped -- which is the shape the parser has to survive.
  return `<script>window.__TGT_DATA__=JSON.parse(${JSON.stringify(JSON.stringify(data))});</script>${extra}`;
}

const REAL_SHAPE = {
  __PRELOADED_QUERIES__: {
    queries: [
      [
        { name: "pdp" },
        {
          data: {
            product: {
              tcin: "1011960739",
              item: {
                relationship_type_code: "SA",
                product_description: {
                  title: "Pokémon Trading Card Game: First Partner Illustration Collection",
                },
                fulfillment: { purchase_limit: 2 },
                mmbv_content: { street_date: "2026-08-07" },
              },
            },
          },
        },
      ],
    ],
  },
};

test("parseTcin accepts a full product URL", () => {
  assert.equal(
    parseTcin(
      "https://www.target.com/p/pok-233-mon-trading-card-game-first-partner-illustration-collection-8212-series-3/-/A-1011960739",
    ),
    "1011960739",
  );
});

test("parseTcin accepts a bare number, an A- prefix, and a URL with a query string", () => {
  assert.equal(parseTcin("1011960739"), "1011960739");
  assert.equal(parseTcin("A-1011960739"), "1011960739");
  assert.equal(parseTcin("https://www.target.com/p/x/-/A-1011960739?preselect=88"), "1011960739");
});

test("parseTcin rejects anything without an item number", () => {
  for (const input of ["", "   ", null, undefined, "https://www.target.com/", "not a url"]) {
    assert.equal(parseTcin(input), null, `expected null for ${JSON.stringify(input)}`);
  }
});

test("pdpUrl builds a slug-free canonical URL", () => {
  assert.equal(pdpUrl("1011960739"), "https://www.target.com/p/-/A-1011960739");
});

test("extractTgtData parses the blob through both layers of escaping", () => {
  const parsed = extractTgtData(page({ a: { b: 'quote " and \\ backslash' } })) as {
    a: { b: string };
  };
  assert.equal(parsed.a.b, 'quote " and \\ backslash');
});

test("extractTgtData returns null rather than throwing on a page it can't read", () => {
  assert.equal(extractTgtData("<html>nothing here</html>"), null);
  assert.equal(extractTgtData("window.__TGT_DATA__=JSON.parse(notAString)"), null);
  assert.equal(extractTgtData("window.__TGT_DATA__=JSON.parse(\"{ broken\")"), null);
});

test("findFirst reaches a key nested under arrays and objects", () => {
  assert.equal(findFirst(REAL_SHAPE, ["purchase_limit"]), 2);
  assert.equal(findFirst(REAL_SHAPE, ["street_date"]), "2026-08-07");
  assert.equal(findFirst(REAL_SHAPE, ["nope"]), undefined);
});

test("findFirst skips null values so an explicit null doesn't shadow a real one", () => {
  assert.equal(findFirst({ a: { price: null }, b: { price: 4 } }, ["price"]), 4);
});

test("parseMetadata reads the real page shape", () => {
  const meta = parseMetadata(page(REAL_SHAPE));
  assert.equal(meta.parsedBlob, true);
  assert.equal(meta.purchaseLimit, 2);
  assert.equal(meta.relationshipTypeCode, "SA");
  assert.equal(meta.streetDate, "2026-08-07");
  assert.match(meta.title ?? "", /First Partner/);
});

/**
 * Regression: a live PDP puts the global nav's `title` in the blob ahead of
 * anything about the product, so an unscoped search named every item on the
 * site "Global Navigation".
 */
test("parseMetadata does not mistake the nav menu's title for the product's", () => {
  const withNav = page(
    { nav: { title: "Global Navigation" }, ...REAL_SHAPE },
    "",
  );
  const meta = parseMetadata(withNav);
  assert.notEqual(meta.title, "Global Navigation");
  assert.match(meta.title ?? "", /First Partner/);
});

test("parseMetadata falls back to the page title, minus Target's suffix", () => {
  // The shape a real PDP has: product name only in <title>, nothing usable in the blob.
  const html = `<title>Pokémon TCG: Prismatic Evolutions &amp; More : Target</title>${page({ nav: { title: "Global Navigation" } })}`;
  assert.equal(parseMetadata(html).title, "Pokémon TCG: Prismatic Evolutions & More");
});

test("parseMetadata falls back to scraping when the blob won't parse", () => {
  // The shape moved, but the fields are still in the body somewhere.
  const meta = parseMetadata('<html>"purchase_limit":2,"relationship_type_code":"SA"</html>');
  assert.equal(meta.parsedBlob, false, "should report that it fell back");
  assert.equal(meta.purchaseLimit, 2);
  assert.equal(meta.relationshipTypeCode, "SA");
});

test("parseMetadata leaves absent fields undefined rather than guessing", () => {
  const meta = parseMetadata(page({ product: {} }));
  assert.equal(meta.purchaseLimit, undefined);
  assert.equal(meta.relationshipTypeCode, undefined);
  assert.equal(meta.streetDate, undefined);
});

test("extractApiKey pulls the rotating key out of the bundle", () => {
  const html = page(REAL_SHAPE, 'fetch("/redsky?key=9f36aeafbe60771e321a7cc95a78140772ab3e96")');
  assert.equal(extractApiKey(html), "9f36aeafbe60771e321a7cc95a78140772ab3e96");
  assert.equal(extractApiKey("<html></html>"), undefined);
});

test("isBuyable covers shipping and pickup, and preorders count", () => {
  const base = { ok: true, status: 200, blocked: false };
  assert.equal(isBuyable({ ...base, shipStatus: "IN_STOCK" }), true);
  assert.equal(isBuyable({ ...base, pickupStatus: "IN_STOCK" }), true);
  assert.equal(isBuyable({ ...base, shipStatus: "PRE_ORDER_SELLABLE" }), true);
  assert.equal(isBuyable({ ...base, shipStatus: "LIMITED_STOCK" }), true);
  assert.equal(isBuyable({ ...base, shipStatus: "OUT_OF_STOCK" }), false);
  assert.equal(isBuyable({ ...base, shipStatus: "PRE_ORDER_UNSELLABLE" }), false);
  assert.equal(isBuyable(base), false, "unknown status is not buyable");
});
