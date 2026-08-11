import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for the URL cleaning behind /strip.
 *
 * Imported directly rather than through the command module so the suite doesn't
 * pull in src/config.ts, which exits the process on missing environment
 * variables.
 */

const { StripError, stripUrl } = await import("../src/strip.ts");

test("tracking parameters come off and the rest of the link survives", () => {
  const result = stripUrl(
    "https://example.com/path?utm_source=news&id=7&fbclid=abc#section",
  );

  assert.equal(result.url, "https://example.com/path?id=7#section");
  assert.deepEqual(result.removed, ["utm_source", "fbclid"]);
});

test("a clean link is returned untouched", () => {
  const result = stripUrl("https://example.com/a?q=hello+world");

  assert.equal(result.url, "https://example.com/a?q=hello+world");
  assert.deepEqual(result.removed, []);
});

test("the question mark goes when every parameter was tracking", () => {
  const result = stripUrl("https://youtu.be/dQw4w9WgXcQ?si=xyz");

  assert.equal(result.url, "https://youtu.be/dQw4w9WgXcQ");
});

test("host-specific parameters only come off on that host", () => {
  assert.deepEqual(stripUrl("https://x.com/a/status/1?s=20&t=abc").removed, ["s", "t"]);
  assert.deepEqual(stripUrl("https://example.com/search?s=20&t=abc").removed, []);
});

test("www. does not hide a host rule", () => {
  assert.deepEqual(stripUrl("https://www.twitter.com/a/status/1?s=20").removed, ["s"]);
});

test("all drops parameters the tracking list doesn't know", () => {
  const result = stripUrl("https://example.com/a?q=1&page=2", true);

  assert.equal(result.url, "https://example.com/a");
  assert.deepEqual(result.removed, ["q", "page"]);
});

test("a scheme-less link is treated as https", () => {
  assert.equal(stripUrl("example.com/a?utm_medium=x").url, "https://example.com/a");
});

test("Discord's embed-suppressing brackets are ignored", () => {
  assert.equal(stripUrl("  <https://example.com/a?gclid=1>  ").url, "https://example.com/a");
});

test("repeated parameter names are all removed", () => {
  const result = stripUrl("https://example.com/a?utm_source=x&utm_source=y&keep=1");

  assert.equal(result.url, "https://example.com/a?keep=1");
  assert.deepEqual(result.removed, ["utm_source", "utm_source"]);
});

test("non-web schemes and non-URLs are rejected", () => {
  assert.throws(() => stripUrl("mailto:someone@example.com"), StripError);
  assert.throws(() => stripUrl("not a url"), StripError);
  assert.throws(() => stripUrl("   "), StripError);
});
