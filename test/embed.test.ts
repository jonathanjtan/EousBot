import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for the link rewriting behind /embed.
 *
 * Imported directly rather than through the command module so the suite doesn't
 * pull in src/config.ts, which exits the process on missing environment
 * variables.
 */

const { EmbedError, fixEmbedUrl, SUPPORTED_PLATFORMS } = await import("../src/embed.ts");
const { stripUrl } = await import("../src/strip.ts");

/** X and Twitter roll between several hosts; 0 pins the roll to the first. */
const first = () => 0;

test("x.com and twitter.com go to their own fixers", () => {
  const x = fixEmbedUrl("https://x.com/jack/status/20", first);
  assert.equal(x.url, "https://fixupx.com/jack/status/20");
  assert.equal(x.platform, "X");

  const twitter = fixEmbedUrl("https://twitter.com/jack/status/20", first);
  assert.equal(twitter.url, "https://fxtwitter.com/jack/status/20");
  assert.equal(twitter.platform, "Twitter");
});

test("the path, query and fragment survive the host swap", () => {
  const result = fixEmbedUrl("https://www.tiktok.com/@user/photo/123?img_index=2#top");

  assert.equal(result.url, "https://tnktok.com/@user/photo/123?img_index=2#top");
});

test("www. and other decoration are dropped", () => {
  assert.equal(
    fixEmbedUrl("https://mobile.twitter.com/jack/status/20", first).url,
    "https://fxtwitter.com/jack/status/20",
  );
  assert.equal(
    fixEmbedUrl("https://old.reddit.com/r/aww/comments/abc/").url,
    "https://vxreddit.com/r/aww/comments/abc/",
  );
});

test("TikTok's share shorteners keep their subdomain", () => {
  assert.equal(fixEmbedUrl("https://vm.tiktok.com/ZMhvVWNMx/").url, "https://vm.tnktok.com/ZMhvVWNMx/");
  assert.equal(fixEmbedUrl("https://vt.tiktok.com/ZMhvVWNMx/").url, "https://vt.tnktok.com/ZMhvVWNMx/");
});

test("links on a fixer that stopped working are moved to one that works", () => {
  assert.equal(fixEmbedUrl("https://ddinstagram.com/p/abc/").url, "https://kkinstagram.com/p/abc/");
  assert.equal(fixEmbedUrl("https://vxtiktok.com/@user/video/1").url, "https://tnktok.com/@user/video/1");
  assert.equal(fixEmbedUrl("https://rxddit.com/r/aww/comments/abc/").url, "https://vxreddit.com/r/aww/comments/abc/");
});

test("a link already on the right fixer comes back unchanged", () => {
  assert.equal(fixEmbedUrl("https://fixupx.com/jack/status/20", first).url, "https://fixupx.com/jack/status/20");
  assert.equal(fixEmbedUrl("https://bskx.app/profile/bsky.app/post/abc").url, "https://bskx.app/profile/bsky.app/post/abc");
});

/**
 * The novelty X relinkers from issue #77. The roll has to reach all of them,
 * and a link on one of them has to be recognised on the way back in -- someone
 * who doesn't like the domain they got will run /embed on the result again.
 */
test("X links roll across the relinkers", () => {
  const hosts = new Set<string>();
  for (let roll = 0; roll < 1; roll += 0.01) {
    hosts.add(fixEmbedUrl("https://x.com/jack/status/20", () => roll).host);
  }

  assert.deepEqual(
    [...hosts].sort(),
    ["cunnyx.com", "fixupx.com", "hotyurisex.com", "mpregx.com", "yaoisex.com"],
  );
});

test("twitter.com rolls across the same relinkers, keeping fxtwitter", () => {
  const hosts = new Set<string>();
  for (let roll = 0; roll < 1; roll += 0.01) {
    hosts.add(fixEmbedUrl("https://twitter.com/jack/status/20", () => roll).host);
  }

  assert.deepEqual(
    [...hosts].sort(),
    ["cunnyx.com", "fxtwitter.com", "hotyurisex.com", "mpregx.com", "yaoisex.com"],
  );
});

test("a link on a relinker is rerolled rather than refused", () => {
  const result = fixEmbedUrl("https://cunnyx.com/jack/status/20", first);

  assert.equal(result.url, "https://fixupx.com/jack/status/20");
  assert.equal(result.platform, "X");
});

test("the remaining platforms are covered", () => {
  assert.equal(
    fixEmbedUrl("https://bsky.app/profile/bsky.app/post/abc").url,
    "https://bskx.app/profile/bsky.app/post/abc",
  );
  assert.equal(
    fixEmbedUrl("https://www.instagram.com/reel/abc/").url,
    "https://kkinstagram.com/reel/abc/",
  );
  assert.equal(fixEmbedUrl("https://www.pixiv.net/en/artworks/1").url, "https://phixiv.net/en/artworks/1");
  assert.equal(fixEmbedUrl("https://www.furaffinity.net/view/1/").url, "https://xfuraffinity.net/view/1/");
});

test("http is upgraded", () => {
  assert.equal(fixEmbedUrl("http://x.com/jack/status/20", first).url, "https://fixupx.com/jack/status/20");
});

/**
 * /embed runs stripUrl first, so a share link's tracking is gone before it
 * gets here. This checks the two survive being composed in that order -- the
 * x.com rule for `s` and `t` only fires while the host is still x.com.
 */
test("stripping before the swap takes the share tracking off", () => {
  const cleaned = stripUrl("https://x.com/jack/status/20?s=20&t=abc");

  assert.deepEqual(cleaned.removed, ["s", "t"]);
  assert.equal(fixEmbedUrl(cleaned.url, first).url, "https://fixupx.com/jack/status/20");
});

test("a host that merely contains a known one is not rewritten", () => {
  assert.throws(() => fixEmbedUrl("https://x.com.example.com/jack/status/20"), EmbedError);
  assert.throws(() => fixEmbedUrl("https://notx.com/jack/status/20"), EmbedError);
});

test("unsupported and unparseable input is refused", () => {
  assert.throws(() => fixEmbedUrl("https://example.com/a"), EmbedError);
  assert.throws(() => fixEmbedUrl("mailto:someone@example.com"), EmbedError);
  assert.throws(() => fixEmbedUrl("not a url"), EmbedError);
});

test("the refusal names the platforms that would have worked", () => {
  assert.throws(() => fixEmbedUrl("https://example.com/a"), (error: unknown) => {
    assert.ok(error instanceof EmbedError);
    assert.match(error.message, /example\.com/);
    for (const platform of SUPPORTED_PLATFORMS) assert.ok(error.message.includes(platform));
    return true;
  });
});
