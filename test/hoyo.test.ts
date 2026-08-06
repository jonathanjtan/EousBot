import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for the announcement parsing behind /hoyohell.
 *
 * Imported directly rather than through the command module so the suite
 * doesn't pull in src/config.ts, which exits the process on missing
 * environment variables. Nothing here touches the network: the fixtures below
 * reproduce the shapes the three games actually return, including the
 * doubly-nested picture carousel Star Rail and Zenless hide half their events
 * in, the HTML Zenless wraps its titles in, and the wording the announcement
 * bodies state their gem rewards in.
 */

const {
  DEFAULT_COUNT,
  GAME_CHOICES,
  GAMES,
  eventFields,
  expiringSoonest,
  feedsFor,
  parseAnnouncements,
  parseRewards,
  parseServerTime,
  plainText,
  urgencyColour,
} = await import("../src/hoyo.ts");

const NOW = Date.parse("2026-08-05T00:00:00Z");
const HOUR = 3_600_000;

/** Stand-ins for the real feeds: one that files notices, one that doesn't. */
const PLAIN = {
  label: "Star Rail",
  url: "https://example.invalid/list",
  contentUrl: "https://example.invalid/content",
  currency: "Stellar Jade",
  notices: [],
};
const FILED = {
  label: "Genshin",
  url: "https://example.invalid/list",
  contentUrl: "https://example.invalid/content",
  currency: "Primogems",
  notices: ["Game", "社群公告"],
};

const PAYLOAD = {
  retcode: 0,
  data: {
    timezone: 8,
    list: [
      {
        type_id: 1,
        type_label: "Event",
        list: [
          {
            ann_id: 1,
            title: "Ley Line Overflow",
            subtitle: "Ley Line Overflow",
            start_time: "2026-08-01 05:00:00",
            end_time: "2026-08-10 03:59:59",
          },
          {
            ann_id: 2,
            title: "Game Version Optimization and Known Issues",
            start_time: "2026-07-01 00:00:00",
            end_time: "2026-08-20 00:00:00",
          },
          {
            ann_id: 3,
            title: "Fair Use Statement",
            start_time: "2024-07-03 00:00:00",
            end_time: "2034-07-03 00:00:00",
          },
          {
            ann_id: 5,
            title: "Summer",
            start_time: "2026-08-01 00:00:00",
            end_time: "2026-08-12 00:00:00",
          },
          {
            ann_id: 7,
            title: "Not open yet",
            start_time: "2026-09-01 00:00:00",
            end_time: "2026-09-10 00:00:00",
          },
          {
            ann_id: 8,
            title: "Long gone",
            start_time: "2026-06-01 00:00:00",
            end_time: "2026-07-01 00:00:00",
          },
          { ann_id: 9, title: "Unreadable", start_time: "soon", end_time: "later" },
          {
            ann_id: 10,
            title: "Official Top-Up Center Now Online",
            type_label: "Game",
            start_time: "2026-08-01 00:00:00",
            end_time: "2026-08-15 00:00:00",
          },
          {
            ann_id: 11,
            title: "Behind the Design | ZTALK",
            tag_label: "社群公告",
            start_time: "2026-08-01 00:00:00",
            end_time: "2026-08-06 00:00:00",
          },
          {
            ann_id: 12,
            title: "Experience the Paths Vol. 6 Trailer OST Now Available",
            start_time: "2026-08-02 14:00:00",
            end_time: "2026-08-09 00:00:00",
          },
        ],
      },
    ],
    pic_list: [
      {
        type_list: [
          {
            list: [
              {
                ann_id: 4,
                title: "",
                subtitle: "",
                start_time: "2026-08-04 12:00:00",
                end_time: "2026-08-09 15:00:00",
                // The carousel slides carry no ann_id and must be passed over.
                pic_list: [{ title: "1", img: "https://example.invalid/1.jpg" }],
              },
              {
                ann_id: 5,
                title: '<p style="white-space: pre-wrap;">Summer &amp; Waves Roll In</p>',
                subtitle: "Summer",
                start_time: "2026-08-01 00:00:00",
                end_time: "2026-08-12 00:00:00",
              },
              {
                ann_id: 6,
                title: "",
                subtitle: "Version 4.4 Event Warp: Phase II",
                start_time: "2026-08-04 12:00:00",
                end_time: "2026-08-25 15:00:00",
              },
            ],
          },
        ],
      },
    ],
  },
};

/**
 * `getAnnContent` against the same IDs, with the wordings the live bodies use:
 * the plain `×N`, the four-digit figure written with a comma, the rate quoted
 * inside a larger compensation figure, the number written before the currency,
 * and the majority case that promises rewards without ever naming a count. The
 * escaped `&times;` is the one form not seen live -- the bodies do escape their
 * other punctuation, so it is covered rather than assumed away.
 */
const CONTENT = {
  retcode: 0,
  data: {
    list: [
      {
        ann_id: 1,
        title: "Ley Line Overflow",
        content:
          '<p style="white-space: pre-wrap;">Complete the missions to obtain an additional' +
          " reward of Primogems &times;400.</p>",
      },
      {
        ann_id: 2,
        title: "Game Version Optimization and Known Issues",
        content:
          "<p>Maintenance Compensation: Primogems ×300 (60 Primogems per hour the servers" +
          " are down)</p><p>Issue Fix Compensation: Primogems ×30</p>",
      },
      {
        ann_id: 5,
        title: "Summer",
        content: "<p>Log in to claim Primogems ×1,600 and an exclusive namecard!</p>",
      },
      {
        ann_id: 11,
        title: "Behind the Design | ZTALK",
        content: "<p>You will receive 100 Primogems for watching.</p>",
      },
      {
        ann_id: 12,
        title: "Experience the Paths Vol. 6 Trailer OST Now Available",
        content: "<p>Listen now to obtain Primogems, Mora, and other rewards.</p>",
      },
    ],
    pic_list: [
      {
        type_list: [
          {
            list: [
              {
                ann_id: 6,
                title: "Version 4.4 Event Warp: Phase II",
                content: "<p>Warp to obtain Stellar Jade ×80.</p>",
              },
            ],
          },
        ],
      },
    ],
  },
};

test("parseServerTime reads wall-clock server time against the stated offset", () => {
  assert.equal(
    parseServerTime("2026-08-10 03:59:59", 8),
    Date.parse("2026-08-09T19:59:59Z"),
  );
  // The offset is the payload's, never the host's.
  assert.equal(parseServerTime("2026-08-10 03:59:59", 0), Date.parse("2026-08-10T03:59:59Z"));
});

test("parseServerTime rejects anything that isn't a timestamp", () => {
  for (const junk of ["", "soon", "2026-08-10", "2026-08-10T03:59:59.000Z"]) {
    assert.equal(parseServerTime(junk, 8), null, `accepted ${junk}`);
  }
});

test("plainText unwraps the HTML Zenless sends and decodes its entities", () => {
  assert.equal(
    plainText('<p style="white-space: pre-wrap;">Summer &amp; Waves Roll In</p>'),
    "Summer & Waves Roll In",
  );
  assert.equal(plainText("&quot;Gift&#39;s&quot;&nbsp;Details"), "\"Gift's\" Details");
  assert.equal(plainText("  spaced   out  "), "spaced out");
  // An entity the table doesn't know is left as it came rather than mangled.
  assert.equal(plainText("Tea &hellip; Party"), "Tea &hellip; Party");
});

test("parseAnnouncements reaches the events nested in the picture carousel", () => {
  const events = parseAnnouncements(PLAIN, PAYLOAD);
  const found = events.find((e) => e.id === 6);
  assert.ok(found, "the carousel-only announcement was missed");
  assert.equal(found.title, "Version 4.4 Event Warp: Phase II", "fell back to the subtitle");
  assert.equal(found.game, "Star Rail");
  assert.equal(found.endsAt, Date.parse("2026-08-25T07:00:00Z"));
});

test("parseAnnouncements drops what it cannot use and keeps the fuller title", () => {
  const events = parseAnnouncements(PLAIN, PAYLOAD);
  const ids = events.map((e) => e.id).sort((a, b) => a - b);
  // 4 has no title anywhere and 9 has no readable times; the carousel slides
  // have no ann_id at all.
  assert.deepEqual(ids, [1, 2, 3, 5, 6, 7, 8, 10, 11, 12]);

  const both = events.filter((e) => e.id === 5);
  assert.equal(both.length, 1, "the duplicated announcement was listed twice");
  assert.equal(both[0]?.title, "Summer & Waves Roll In");
});

test("parseAnnouncements skips the sections a feed files its notices under", () => {
  const ids = parseAnnouncements(FILED, PAYLOAD).map((e) => e.id);
  assert.ok(!ids.includes(10), "kept an entry from a notice section");
  assert.ok(!ids.includes(11), "kept an entry carrying a notice tag");
  assert.ok(ids.includes(1), "threw out the events along with the notices");
});

test("parseRewards reads the figure each body states, in every wording", () => {
  const rewards = parseRewards(FILED, CONTENT);

  assert.equal(rewards.get(1), 400, "missed the entity-escaped multiplication sign");
  assert.equal(rewards.get(5), 1600, "tripped over the thousands comma");
  assert.equal(rewards.get(11), 100, "missed the figure written before the currency");
});

test("parseRewards takes the largest figure a body states, never their sum", () => {
  // 300 for the maintenance, of which the 60 an hour is a part, and 30 for the
  // fix: adding them up would advertise 390 gems that nobody is getting.
  assert.equal(parseRewards(FILED, CONTENT).get(2), 300);
});

test("parseRewards passes over bodies that name no figure, and other currencies", () => {
  const rewards = parseRewards(FILED, CONTENT);

  assert.ok(!rewards.has(12), "invented a count for a body that promised no number");
  assert.ok(!rewards.has(6), "read another game's currency as Primogems");
  // The nested body is found when it is the feed's own currency being asked for.
  assert.equal(parseRewards(PLAIN, CONTENT).get(6), 80, "missed the body in the carousel");
});

test("parseAnnouncements hangs the gem counts off the events by announcement id", () => {
  const events = parseAnnouncements(FILED, PAYLOAD, parseRewards(FILED, CONTENT));
  const gems = new Map(events.map((e) => [e.id, e.gems]));

  assert.equal(gems.get(1), 400);
  assert.equal(gems.get(5), 1600, "lost the count when the duplicate copy won the title");
  assert.equal(gems.get(7), null, "claimed a count for an announcement with no body");
});

test("parseAnnouncements leaves the counts null when no bodies were read", () => {
  const events = parseAnnouncements(FILED, PAYLOAD);
  assert.ok(
    events.every((e) => e.gems === null),
    "conjured gem counts out of the list alone",
  );
});

test("expiringSoonest keeps only what is running, soonest expiry first", () => {
  // The gem filter is off throughout this one: what's under test is the rest
  // of the chain, and the fixture's events carry no counts of their own.
  const events = expiringSoonest(parseAnnouncements(FILED, PAYLOAD), NOW, DEFAULT_COUNT, false);

  // 2 and 12 are housekeeping, 3 is an evergreen notice, 6 is a warp banner, 7
  // hasn't opened and 8 is over.
  assert.deepEqual(
    events.map((e) => e.id),
    [1, 5],
  );
  assert.ok(
    events.every((e) => e.startsAt <= NOW && e.endsAt > NOW),
    "listed something nobody can clear",
  );
});

test("expiringSoonest honours the requested count", () => {
  const events = parseAnnouncements(FILED, PAYLOAD);
  assert.equal(expiringSoonest(events, NOW, 1, false).length, 1);
  assert.equal(expiringSoonest(events, NOW, 1, false)[0]?.id, 1, "kept the wrong one");
  assert.equal(
    expiringSoonest(events, NOW, 50, false).length,
    2,
    "invented events to fill the count",
  );
});

test("expiringSoonest drops the TCG, banner and Miliastra entries", () => {
  const running = (id, title) => ({
    game: "Genshin",
    id,
    title,
    startsAt: NOW - HOUR,
    endsAt: NOW + HOUR,
    gems: null,
  });
  const events = expiringSoonest(
    [
      running(1, "Genius Invokation TCG: Duel! Wits and Cards"),
      running(2, 'Event Wish "Farewell of Snezhnaya" - Boosted Drop Rate!'),
      running(3, "Miliastra Wonderland: Creator Season"),
      running(4, "TCG Card Shop Update"),
      running(5, "Ley Line Overflow"),
      running(6, "Version 4.4 Event Warp: Phase II"),
      running(7, "Signal Search: Astral Voice"),
    ],
    NOW,
    DEFAULT_COUNT,
    false,
  );

  assert.deepEqual(
    events.map((e) => e.id),
    [5],
  );
});

test("expiringSoonest lists only what states a gem count, unless told otherwise", () => {
  const events = parseAnnouncements(FILED, PAYLOAD, parseRewards(FILED, CONTENT));

  // 1 and 5 are the two that survive the rest of the chain, and both carry a
  // count -- so the fixture is made to disagree to prove the filter bites.
  const stripped = events.map((e) => (e.id === 5 ? { ...e, gems: null } : e));

  assert.deepEqual(
    expiringSoonest(stripped, NOW, DEFAULT_COUNT).map((e) => e.id),
    [1],
    "kept an event whose announcement named no figure",
  );
  assert.deepEqual(
    expiringSoonest(stripped, NOW, DEFAULT_COUNT, false).map((e) => e.id),
    [1, 5],
    "dropped the unpriced event even with the filter off",
  );
});

test("expiringSoonest filters on the gem count before it takes the count asked for", () => {
  const running = (id, gems) => ({
    game: "Genshin",
    id,
    title: `Event ${id}`,
    startsAt: NOW - HOUR,
    endsAt: NOW + id * HOUR,
    gems,
  });
  // The three unpriced events sort ahead of the priced one, and must not eat
  // the single slot that was asked for.
  const events = [running(1, null), running(2, null), running(3, null), running(4, 60)];

  assert.deepEqual(
    expiringSoonest(events, NOW, 1).map((e) => e.id),
    [4],
  );
});

test("eventFields renders the game, the title and a Discord countdown", () => {
  const [field] = eventFields([
    {
      game: "ZZZ",
      id: 1,
      title: "Gift From the Clouds",
      startsAt: NOW,
      endsAt: NOW + HOUR,
      gems: null,
    },
  ]);

  assert.equal(field?.name, "ZZZ · Gift From the Clouds");
  const seconds = Math.floor((NOW + HOUR) / 1000);
  assert.equal(field?.value, `Ends <t:${seconds}:R> — <t:${seconds}:f>`);
});

test("eventFields names the gems in each game's own currency, when there are any", () => {
  const at = (game, gems) => ({
    game,
    id: 1,
    title: "x",
    startsAt: NOW,
    endsAt: NOW + HOUR,
    gems,
  });
  const value = (event) => eventFields([event])[0]?.value.split("\n")[1];

  assert.equal(value(at("Genshin", 400)), "Primogems ×400");
  assert.equal(value(at("Star Rail", 300)), "Stellar Jade ×300");
  assert.equal(value(at("ZZZ", 1600)), "Polychrome ×1,600", "dropped the thousands separator");
  assert.equal(value(at("Genshin", null)), undefined, "wrote a line for a count it doesn't have");
});

test("eventFields keeps field names inside the embed limit", () => {
  const [field] = eventFields([
    {
      game: "Genshin",
      id: 1,
      title: "e".repeat(500),
      startsAt: NOW,
      endsAt: NOW + HOUR,
      gems: null,
    },
  ]);

  assert.ok((field?.name.length ?? 0) <= 256, "would be rejected by Discord");
  assert.ok(field?.name.endsWith("…"), "truncated without saying so");
});

test("urgencyColour escalates as the soonest expiry closes in", () => {
  const at = (endsAt: number) => [
    { game: "Genshin", id: 1, title: "x", startsAt: NOW - HOUR, endsAt, gems: null },
  ];

  assert.equal(urgencyColour(at(NOW + 2 * HOUR), NOW), 0xd7263d);
  assert.equal(urgencyColour(at(NOW + 48 * HOUR), NOW), 0xe0a458);
  assert.equal(urgencyColour(at(NOW + 200 * HOUR), NOW), 0x2f9e44);
  // Nothing to colour is not a reason to throw.
  assert.equal(urgencyColour([], NOW), 0x2f9e44);
});

test("every game is asked for the English list of its own announcements", () => {
  assert.equal(GAMES.length, 3);
  for (const game of GAMES) {
    const url = new URL(game.url);
    assert.equal(url.protocol, "https:", `${game.label} is not on https`);
    assert.equal(url.searchParams.get("lang"), "en");
    assert.ok(url.pathname.endsWith("/announcement/api/getAnnList"), url.pathname);
  }
  assert.equal(new Set(GAMES.map((g) => g.url)).size, 3, "two games share a feed");
});

test("every game asks the same host for the bodies its gem counts come from", () => {
  for (const game of GAMES) {
    const list = new URL(game.url);
    const content = new URL(game.contentUrl);
    assert.ok(content.pathname.endsWith("/announcement/api/getAnnContent"), content.pathname);
    assert.equal(content.host, list.host, `${game.label} reads its bodies off another host`);
    assert.equal(content.search, list.search, `${game.label} asks the two endpoints differently`);
    assert.ok(game.currency.length > 0, `${game.label} has no currency to report`);
  }
  assert.equal(new Set(GAMES.map((g) => g.currency)).size, 3, "two games share a currency");
});

test("the game option narrows the feeds to one, and anything else asks all three", () => {
  for (const choice of GAME_CHOICES) {
    assert.deepEqual(
      feedsFor(choice.value).map((feed) => feed.label),
      [choice.label],
    );
  }
  assert.equal(feedsFor(null).length, GAMES.length);
  assert.equal(feedsFor("honkai impact").length, GAMES.length);
});
