import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for the drop-feed relay.
 *
 * Imported directly so the suite doesn't pull in src/config.ts. The fetching and
 * the timers live in src/feedwatch.ts and need a gateway, so they aren't
 * exercised here.
 */

const {
  extractTargetLinks,
  formatDrop,
  matches,
  nextDelayMs,
  parseFeed,
  rememberSeen,
  shouldPause,
  unseen,
} = await import("../src/feed.ts");

/** The shape Reddit actually serves. */
const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>t3_abc123</id>
    <title>Target drop has started!</title>
    <link href="https://www.reddit.com/r/pkmntcgdeals/comments/abc123/target_drop/"/>
    <published>2026-08-07T07:00:00+00:00</published>
    <content type="html">&lt;a href="https://www.target.com/p/sora/-/A-95267143"&gt;link&lt;/a&gt; live now</content>
  </entry>
  <entry>
    <id>t3_def456</id>
    <title>Walmart Wednesday</title>
    <link href="https://www.reddit.com/r/pkmntcgdeals/comments/def456/walmart/"/>
    <content type="html">nothing to do with the other store</content>
  </entry>
</feed>`;

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <guid>https://slickdeals.net/f/111</guid>
    <title><![CDATA[Pokémon TCG restock @ Target]]></title>
    <link>https://slickdeals.net/f/111</link>
    <description><![CDATA[Back in stock &amp; cheap]]></description>
    <pubDate>Fri, 07 Aug 2026 07:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const SOURCE = { name: "r/pkmntcgdeals", url: "https://www.reddit.com/r/pkmntcgdeals/new.rss" };

const WATCH = {
  keyword: "target",
  subscribers: ["111"],
  channelId: "222",
  addedBy: "111",
  addedAt: "2026-08-06T00:00:00.000Z",
};

const POLL = {
  baseMs: 120_000,
  jitterMs: 15_000,
  backoffStartMs: 300_000,
  backoffMaxMs: 3_600_000,
  maxConsecutiveBlocks: 5,
};

test("parseFeed reads Atom entries", () => {
  const entries = parseFeed(ATOM);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.id, "t3_abc123");
  assert.equal(entries[0]?.title, "Target drop has started!");
  assert.match(entries[0]?.link ?? "", /reddit\.com/);
  assert.match(entries[0]?.content ?? "", /target\.com/);
});

test("parseFeed reads RSS items, decoding CDATA and entities", () => {
  const entries = parseFeed(RSS);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.id, "https://slickdeals.net/f/111");
  assert.equal(entries[0]?.title, "Pokémon TCG restock @ Target");
  assert.equal(entries[0]?.content, "Back in stock & cheap");
});

test("parseFeed yields nothing rather than throwing on junk", () => {
  assert.deepEqual(parseFeed(""), []);
  assert.deepEqual(parseFeed("<html>not a feed</html>"), []);
  assert.deepEqual(parseFeed("<feed><entry><id>x</id></entry></feed>"), [], "no title, no entry");
});

test("matches is case-insensitive across title and body", () => {
  const [drop, walmart] = parseFeed(ATOM);
  assert.equal(matches(drop!, "TARGET"), true);
  assert.equal(matches(drop!, "target"), true);
  assert.equal(matches(walmart!, "target"), false);
  assert.equal(matches(drop!, "sora"), true, "body counts, not just the title");
});

test("matches refuses an empty keyword instead of matching everything", () => {
  const [drop] = parseFeed(ATOM);
  assert.equal(matches(drop!, "   "), false);
});

test("extractTargetLinks pulls product URLs out and dedupes them", () => {
  const [drop] = parseFeed(ATOM);
  assert.deepEqual(extractTargetLinks(drop!), ["https://www.target.com/p/sora/-/A-95267143"]);
});

test("unseen filters what has already been relayed", () => {
  const entries = parseFeed(ATOM);
  assert.equal(unseen(entries, []).length, 2);
  assert.equal(unseen(entries, ["t3_abc123"]).length, 1);
  assert.equal(unseen(entries, ["t3_abc123", "t3_def456"]).length, 0);
});

test("rememberSeen puts new ids first and caps the list", () => {
  const entries = parseFeed(ATOM);
  const seen = rememberSeen(["old1", "old2"], entries);
  assert.deepEqual(seen.slice(0, 2), ["t3_abc123", "t3_def456"]);
  assert.equal(seen.length, 4);
  assert.equal(rememberSeen(Array(600).fill("x"), entries, 500).length, 500);
});

test("formatDrop mentions subscribers, links the product, and flags what it is", () => {
  const [drop] = parseFeed(ATOM);
  const text = formatDrop(WATCH, drop!, SOURCE);
  assert.match(text, /<@111>/);
  assert.match(text, /Target drop has started!/);
  assert.match(text, /r\/pkmntcgdeals/);
  assert.match(text, /A-95267143/);
  assert.match(text, /Community post, not a stock check/);
});

test("nextDelayMs stays near the base interval while nothing is blocked", () => {
  assert.equal(nextDelayMs(0, POLL, () => 0), 120_000);
  assert.equal(nextDelayMs(0, POLL, () => 1), 135_000);
});

test("nextDelayMs doubles per consecutive block and then caps", () => {
  assert.equal(nextDelayMs(1, POLL, () => 0), 300_000);
  assert.equal(nextDelayMs(2, POLL, () => 0), 600_000);
  assert.equal(nextDelayMs(20, POLL, () => 0), 3_600_000);
});

test("shouldPause trips only at the configured ceiling", () => {
  assert.equal(shouldPause(4, POLL), false);
  assert.equal(shouldPause(5, POLL), true);
});
