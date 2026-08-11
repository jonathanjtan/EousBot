import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for the avatar picking behind /avatar.
 *
 * Imported directly rather than through the command module so the suite doesn't
 * pull in src/config.ts, which exits the process on missing environment
 * variables. The sources are stand-ins for User and GuildMember — nothing here
 * needs a Discord client.
 */

const { AVATAR_SIZE, avatarViews } = await import("../src/avatar.ts");

/** A stand-in that records the options it was asked for. */
function source(url: string) {
  const sizes: number[] = [];
  return {
    sizes,
    displayAvatarURL({ size }: { size: number }) {
      sizes.push(size);
      return url;
    },
  };
}

test("a user without a member has one view", () => {
  const user = source("https://cdn.discordapp.com/avatars/1/a.png");

  assert.deepEqual(avatarViews(user, null), [
    { label: "Global avatar", url: "https://cdn.discordapp.com/avatars/1/a.png" },
  ]);
});

test("a member with no per-server avatar collapses to one view", () => {
  const url = "https://cdn.discordapp.com/avatars/1/a.png";

  assert.equal(avatarViews(source(url), source(url)).length, 1);
});

test("a per-server avatar comes first, with the global one behind it", () => {
  const user = source("https://cdn.discordapp.com/avatars/1/a.png");
  const member = source("https://cdn.discordapp.com/guilds/2/users/1/avatars/b.png");

  assert.deepEqual(avatarViews(user, member), [
    { label: "Server avatar", url: "https://cdn.discordapp.com/guilds/2/users/1/avatars/b.png" },
    { label: "Global avatar", url: "https://cdn.discordapp.com/avatars/1/a.png" },
  ]);
});

test("avatars are requested at the largest size the CDN serves", () => {
  const user = source("https://cdn.discordapp.com/avatars/1/a.png");
  const member = source("https://cdn.discordapp.com/guilds/2/users/1/avatars/b.png");

  avatarViews(user, member);

  assert.equal(AVATAR_SIZE, 4096);
  assert.deepEqual(user.sizes, [AVATAR_SIZE]);
  assert.deepEqual(member.sizes, [AVATAR_SIZE]);
});
