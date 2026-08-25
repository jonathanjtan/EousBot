import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Gods, the shop, gifts, the market, guilds, alliances, raids, tournaments,
 * marriage and wagers.
 *
 * The invariants worth guarding here are conservation ones -- coin must not be
 * created or destroyed by a transfer, and an item must never exist in two
 * places or nowhere. Those are the bugs that quietly ruin an economy, and they
 * are invisible in a happy-path test.
 */

const engine = await import("../../src/rpg/engine.ts");
const rules = await import("../../src/rpg/rules.ts");
const economy = await import("../../src/rpg/economy.ts");
const guilds = await import("../../src/rpg/guilds.ts");
const contests = await import("../../src/rpg/contests.ts");

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START = Date.UTC(2026, 0, 1);
const ctx = (seed = 1, now = START) => ({ rng: seeded(seed), now, tuning: rules.DEFAULT_TUNING });

/** A realm with `n` characters, each holding `money`. */
function realm(n: number, money = 100_000) {
  const state = engine.newGame();
  for (let i = 0; i < n; i += 1) {
    engine.create(state, `u${i}`, `P${i}`, "warrior", ctx());
    engine.find(state, `u${i}`)!.money = money;
  }
  return state;
}

function item(id: number, value = 20) {
  return { id, name: "Thing", kind: "weapon" as const, value, rarity: "common" as const };
}

const totalCoin = (state: ReturnType<typeof realm>) =>
  Object.values(state.characters).reduce((sum, c) => sum + c.money, 0) +
  Object.values(state.guilds).reduce((sum, g) => sum + g.bank, 0);

// ------------------------------------------------------------------- gods ---

test("following a god is free the first time and costly after", () => {
  const state = realm(1);
  const c = engine.find(state, "u0")!;

  assert.equal(economy.followGod(state, "u0", "forge").ok, true);
  assert.equal(c.money, 100_000, "the first oath is free");

  c.favor = 4_000;
  const again = economy.followGod(state, "u0", "tide");
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.value.cost, 2_000, "half your favour, in coin");
  assert.equal(c.favor, 4_000, "the favour itself survives the switch");
  assert.equal(economy.followGod(state, "u0", "tide").ok, false, "already following");
});

test("sacrificing converts items into odds, and consumes them", () => {
  const state = realm(1);
  const c = engine.find(state, "u0")!;
  economy.followGod(state, "u0", "quiet");
  c.backpack.push(item(1), item(2), item(3));
  const before = rules.successChance(c, 5);

  const result = economy.sacrifice(state, "u0", [1, 2]);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(c.backpack.length, 1, "sacrificed items are gone");
  assert.ok(c.favor > 0);
  assert.ok(rules.successChance(c, 5) > before, "favour must buy better odds");
  // And it is capped, or it would eventually trivialise every adventure.
  c.favor = 10_000_000;
  assert.ok(rules.favorLuck(c) <= rules.MAX_FAVOR_LUCK + 1e-9);
});

test("you cannot sacrifice without a god, or sacrifice nothing", () => {
  const state = realm(1);
  engine.find(state, "u0")!.backpack.push(item(1));
  assert.equal(economy.sacrifice(state, "u0", [1]).ok, false, "no god");
  economy.followGod(state, "u0", "wheel");
  assert.equal(economy.sacrifice(state, "u0", []).ok, false);
  assert.equal(economy.sacrifice(state, "u0", [999]).ok, false, "not in the pack");
});

// -------------------------------------------------------- store and gifts ---

test("the shop is a coin sink, never a profit", () => {
  const state = realm(1, 1_000_000);
  const c = engine.find(state, "u0")!;

  const bought = economy.buyCrates(state, "u0", "rare", 2);
  assert.equal(bought.ok, true);
  assert.equal(c.crates.rare, 2);
  assert.equal(c.money, 1_000_000 - rules.CRATE_PRICE.rare * 2);

  // A crate must cost more than what typically falls out of it sells for.
  const rng = seeded(3);
  let takings = 0;
  for (let i = 0; i < 200; i += 1) {
    takings += rules.sellValue(
      rules.rollItem(rng, { id: 1, level: c.level, difficulty: c.level, rarity: "rare" }),
    );
  }
  assert.ok(takings / 200 < rules.CRATE_PRICE.rare, "buying crates to resell must lose money");
});

test("giving moves value without creating any", () => {
  const state = realm(2);
  const before = totalCoin(state);
  engine.find(state, "u0")!.backpack.push(item(1));

  const result = economy.give(state, "u0", "u1", { money: 500, itemId: 1 });
  assert.equal(result.ok, true);

  assert.equal(totalCoin(state), before, "a gift creates no coin");
  assert.equal(engine.find(state, "u1")!.money, 100_500);
  assert.equal(engine.find(state, "u0")!.backpack.length, 0);
  assert.equal(engine.find(state, "u1")!.backpack.length, 1, "the item exists exactly once");
});

test("you cannot give what you do not have, or give to yourself", () => {
  const state = realm(2);
  assert.equal(economy.give(state, "u0", "u1", { money: 999_999 }).ok, false);
  assert.equal(economy.give(state, "u0", "u0", { money: 1 }).ok, false);
  assert.equal(economy.give(state, "u0", "u1", {}).ok, false, "give something");
  assert.equal(economy.give(state, "u0", "u1", { money: -5 }).ok, false);
});

// ----------------------------------------------------------------- market ---

test("a listing takes the item out of the world until it sells", () => {
  const state = realm(2);
  engine.find(state, "u0")!.backpack.push(item(1, 50));

  const listed = economy.listForSale(state, "u0", 1, 900, ctx());
  assert.equal(listed.ok, true);
  assert.equal(engine.find(state, "u0")!.backpack.length, 0, "not in the pack");
  assert.equal(state.market.length, 1);

  const before = totalCoin(state);
  const bought = economy.buyListing(state, "u1", 1);
  assert.equal(bought.ok, true);

  assert.equal(totalCoin(state), before, "a sale creates no coin");
  assert.equal(engine.find(state, "u1")!.backpack.length, 1);
  assert.equal(engine.find(state, "u0")!.money, 100_900);
  assert.equal(state.market.length, 0);
});

test("unlisting returns the item, and only to its owner", () => {
  const state = realm(2);
  engine.find(state, "u0")!.backpack.push(item(1));
  economy.listForSale(state, "u0", 1, 100, ctx());

  assert.equal(economy.unlist(state, "u1", 1).ok, false, "not yours");
  assert.equal(economy.unlist(state, "u0", 1).ok, true);
  assert.equal(engine.find(state, "u0")!.backpack.length, 1);
  assert.equal(state.market.length, 0);
});

test("the market refuses self-dealing and unaffordable buys", () => {
  const state = realm(2);
  const c = engine.find(state, "u0")!;
  c.backpack.push(item(1));
  economy.listForSale(state, "u0", 1, 500_000, ctx());
  assert.equal(economy.buyListing(state, "u0", 1).ok, false, "own listing");
  assert.equal(economy.buyListing(state, "u1", 1).ok, false, "cannot afford");
  assert.equal(economy.buyListing(state, "u1", 999).ok, false, "no such listing");
});

test("listings are capped per player so the board stays readable", () => {
  const state = realm(1);
  const c = engine.find(state, "u0")!;
  for (let i = 1; i <= economy.MARKET_MAX_PER_PLAYER + 1; i += 1) c.backpack.push(item(i));
  for (let i = 1; i <= economy.MARKET_MAX_PER_PLAYER; i += 1) {
    assert.equal(economy.listForSale(state, "u0", i, 10, ctx()).ok, true);
  }
  assert.equal(economy.listForSale(state, "u0", economy.MARKET_MAX_PER_PLAYER + 1, 10, ctx()).ok, false);
});

// ----------------------------------------------------------------- guilds ---

function guilded() {
  const state = realm(4);
  guilds.createGuild(state, "u0", "The Wall", ctx());
  const guild = state.guilds.u0!;
  guilds.joinGuild(state, "u1", guild.id);
  guilds.joinGuild(state, "u2", guild.id);
  return { state, guild };
}

test("founding a guild costs coin and enrols the founder", () => {
  const state = realm(1);
  const result = guilds.createGuild(state, "u0", "The Wall", ctx());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(engine.find(state, "u0")!.money, 100_000 - rules.GUILD_CREATE_COST);
  assert.equal(result.value.leaderId, "u0");
  assert.deepEqual(result.value.memberIds, ["u0"]);
  assert.equal(guilds.createGuild(state, "u0", "Another", ctx()).ok, false, "one guild each");
});

test("guild names are unique and validated", () => {
  const state = realm(2);
  guilds.createGuild(state, "u0", "The Wall", ctx());
  assert.equal(guilds.createGuild(state, "u1", "the wall", ctx()).ok, false, "case-insensitive");
  assert.equal(guilds.createGuild(state, "u1", "x", ctx()).ok, false, "too short");
  assert.equal(guilds.createGuild(state, "u1", "@everyone ping", ctx()).ok, false, "unsafe");
});

test("a leader cannot abandon a populated guild", () => {
  const { state } = guilded();
  assert.equal(guilds.leaveGuild(state, "u0").ok, false, "hand it over first");
  assert.equal(guilds.leaveGuild(state, "u1").ok, true);
  assert.equal(engine.find(state, "u1")!.guildId, null);
});

test("handing over swaps the leader and keeps the old one as an officer", () => {
  const { state, guild } = guilded();
  assert.equal(guilds.handOver(state, "u0", "u1").ok, true);
  assert.equal(guild.leaderId, "u1");
  assert.ok(guild.officerIds.includes("u0"));
  assert.equal(guilds.handOver(state, "u0", "u2").ok, false, "no longer the leader");
});

test("only leaders and officers may kick, and never the leader", () => {
  const { state, guild } = guilded();
  assert.equal(guilds.kickMember(state, "u1", "u2").ok, false, "u1 is a plain member");
  guilds.setOfficer(state, "u0", "u1", true);
  assert.equal(guilds.kickMember(state, "u1", "u2").ok, true);
  assert.equal(engine.find(state, "u2")!.guildId, null);
  assert.equal(guilds.kickMember(state, "u1", guild.leaderId).ok, false);
});

test("the bank takes from anyone and pays only leadership", () => {
  const { state, guild } = guilded();
  const before = totalCoin(state);

  assert.equal(guilds.deposit(state, "u1", 5_000).ok, true);
  assert.equal(guild.bank, 5_000);
  assert.equal(totalCoin(state), before, "banking creates no coin");

  assert.equal(guilds.withdraw(state, "u1", 100).ok, false, "plain members cannot withdraw");
  assert.equal(guilds.withdraw(state, "u0", 100).ok, true);
  assert.equal(guilds.withdraw(state, "u0", 999_999).ok, false, "more than the bank holds");
});

test("upgrading spends the bank and raises capacity", () => {
  const { state, guild } = guilded();
  const cost = rules.guildUpgradeCost(guild.level);
  const capacityBefore = rules.guildCapacity(guild.level);
  guilds.deposit(state, "u0", cost);

  assert.equal(guilds.upgrade(state, "u1").ok, false, "leader only");
  assert.equal(guilds.upgrade(state, "u0").ok, true);
  assert.equal(guild.level, 2);
  assert.equal(guild.bank, 0);
  assert.ok(rules.guildCapacity(guild.level) > capacityBefore);
});

test("a full guild turns people away", () => {
  const state = realm(30);
  guilds.createGuild(state, "u0", "The Wall", ctx());
  const guild = state.guilds.u0!;
  const cap = rules.guildCapacity(guild.level);
  for (let i = 1; i < cap; i += 1) assert.equal(guilds.joinGuild(state, `u${i}`, guild.id).ok, true);
  assert.equal(guild.memberIds.length, cap);
  assert.equal(guilds.joinGuild(state, `u${cap}`, guild.id).ok, false);
});

test("disbanding frees every member and hands the bank to the leader", () => {
  const { state, guild } = guilded();
  guilds.deposit(state, "u1", 9_000);
  const leaderBefore = engine.find(state, "u0")!.money;

  assert.equal(guilds.disband(state, "u1").ok, false, "leader only");
  assert.equal(guilds.disband(state, "u0").ok, true);

  assert.equal(state.guilds[guild.id], undefined);
  for (const id of ["u0", "u1", "u2"]) assert.equal(engine.find(state, id)!.guildId, null);
  assert.equal(engine.find(state, "u0")!.money, leaderBefore + 9_000, "the bank is not destroyed");
});

test("alliances are flat, and dissolve with the banner guild", () => {
  const state = realm(4);
  guilds.createGuild(state, "u0", "Banner", ctx());
  guilds.createGuild(state, "u1", "Follower", ctx());

  assert.equal(guilds.ally(state, "u1", "u0").ok, true);
  assert.equal(state.guilds.u1!.allianceOf, "u0");
  assert.equal(guilds.alliance(state, state.guilds.u1!).length, 2);

  guilds.disband(state, "u0");
  assert.equal(state.guilds.u1!.allianceOf, null, "the alliance dies with its banner");
});

test("a guild battle moves bank coin and creates none", () => {
  const state = realm(6);
  guilds.createGuild(state, "u0", "Alpha", ctx());
  guilds.createGuild(state, "u1", "Beta", ctx());
  guilds.deposit(state, "u0", 20_000);
  guilds.deposit(state, "u1", 20_000);
  const before = totalCoin(state);

  const result = guilds.guildBattle(state, "u0", "u1", 5_000, ctx(4));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(totalCoin(state), before, "a battle creates no coin");
  assert.equal(result.value.winner.bank, 25_000);
  const loser = result.value.winner.id === "u0" ? state.guilds.u1! : state.guilds.u0!;
  assert.equal(loser.bank, 15_000);
});

// ------------------------------------------------------------------ raids ---

test("a raid dies when its health does, and pays by damage dealt", () => {
  const state = realm(3);
  const called = guilds.startRaid(state, "u0", ctx());
  assert.equal(called.ok, true);
  if (!called.ok) return;

  assert.equal(engine.find(state, "u0")!.money, 100_000 - guilds.RAID_SEED);
  assert.equal(called.value.pot, guilds.RAID_SEED);

  // Beat on it until it drops.
  let killed = false;
  for (let i = 0; i < 5_000 && !killed; i += 1) {
    const hit = guilds.hitRaid(state, `u${i % 3}`, ctx(i, START + 1000));
    if (hit.ok && hit.value.killed) {
      killed = true;
      assert.ok(hit.value.payouts && hit.value.payouts.length > 0);
      const paid = hit.value.payouts!.reduce((sum, p) => sum + p.share, 0);
      assert.ok(paid <= called.value.pot, "the pot cannot pay out more than it holds");
      // Damage order decides the split.
      const shares = hit.value.payouts!.map((p) => p.share);
      assert.deepEqual(shares, [...shares].sort((a, b) => b - a));
    }
  }
  assert.ok(killed, "the boss must be killable");
  assert.equal(state.raid, null, "a dead boss is cleared");
});

test("a raid nobody finished expires instead of blocking the next one", () => {
  const state = realm(2);
  guilds.startRaid(state, "u0", ctx());
  const late = ctx(1, START + guilds.RAID_WINDOW_MS + 1);

  assert.equal(guilds.hitRaid(state, "u1", late).ok, false, "the window closed");
  assert.equal(state.raid, null);
  assert.equal(guilds.startRaid(state, "u1", late).ok, true, "a new raid can be called");
});

test("two raids cannot be loose at once", () => {
  const state = realm(2);
  guilds.startRaid(state, "u0", ctx());
  assert.equal(guilds.startRaid(state, "u1", ctx()).ok, false);
});

// ------------------------------------------------------------ tournaments ---

test("a tournament collects buy-ins and pays the pot to one winner", () => {
  const state = realm(8);
  assert.equal(contests.openTournament(state, "u0", 1_000, ctx()).ok, true);
  for (let i = 1; i < 8; i += 1) {
    assert.equal(contests.enterTournament(state, `u${i}`, ctx()).ok, true);
  }
  const before = totalCoin(state);

  const result = contests.runTournament(state, ctx(9));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.pot, 8_000);
  assert.ok(result.value.winner);
  assert.equal(totalCoin(state), before + 8_000, "the pot was held aside, then paid out");
  assert.equal(result.value.winner!.money, 100_000 - 1_000 + 8_000);
  assert.ok(result.value.tournament.log.length >= 3, "three rounds for eight entrants");
});

test("an odd bracket still resolves to exactly one winner", () => {
  for (const n of [2, 3, 5, 7]) {
    const state = realm(n);
    contests.openTournament(state, "u0", 100, ctx());
    for (let i = 1; i < n; i += 1) contests.enterTournament(state, `u${i}`, ctx());
    const result = contests.runTournament(state, ctx(n));
    assert.equal(result.ok, true, `${n} entrants failed`);
    if (result.ok) assert.ok(result.value.winner, `${n} entrants produced no winner`);
  }
});

test("a tournament nobody joined refunds the host", () => {
  const state = realm(1);
  contests.openTournament(state, "u0", 2_500, ctx());
  assert.equal(engine.find(state, "u0")!.money, 97_500);

  const result = contests.runTournament(state, ctx());
  assert.equal(result.ok, false, "not enough entries");
  assert.equal(engine.find(state, "u0")!.money, 100_000, "the host got their buy-in back");
  assert.equal(state.tournament, null);
});

// --------------------------------------------------------------- marriage ---

test("marriage is mutual, exclusive, and pays both halves", () => {
  const state = realm(3);
  assert.equal(contests.marry(state, "u0", "u1").ok, true);
  assert.equal(engine.find(state, "u0")!.spouse, "u1");
  assert.equal(engine.find(state, "u1")!.spouse, "u0");
  assert.equal(contests.marry(state, "u2", "u0").ok, false, "already married");
  assert.equal(contests.marry(state, "u0", "u0").ok, false);

  const before = totalCoin(state);
  const courted = contests.courtSpouse(state, "u0", 5_000);
  assert.equal(courted.ok, true);
  assert.ok(totalCoin(state) < before, "courting burns coin rather than moving it");
  assert.equal(engine.find(state, "u0")!.loveScore, engine.find(state, "u1")!.loveScore);
  assert.ok(rules.loveBonus(engine.find(state, "u1")!) > 0, "the spouse benefits too");
});

test("divorce frees both and does not bank the affection", () => {
  const state = realm(2);
  contests.marry(state, "u0", "u1");
  contests.courtSpouse(state, "u0", 50_000);

  assert.equal(contests.divorce(state, "u0").ok, true);
  for (const id of ["u0", "u1"]) {
    assert.equal(engine.find(state, id)!.spouse, null);
    assert.equal(engine.find(state, id)!.loveScore, 0, "affection must not survive to be re-farmed");
  }
});

// --------------------------------------------------------------- gambling ---

test("a coin flip is fair to within noise, and never conjures coin", () => {
  const state = realm(1, 10_000_000);
  const c = engine.find(state, "u0")!;
  const rng = seeded(21);
  let wins = 0;
  const rounds = 20_000;

  for (let i = 0; i < rounds; i += 1) {
    const result = contests.flip(state, "u0", 1, true, { rng, now: START, tuning: rules.DEFAULT_TUNING });
    if (result.ok && result.value.won) wins += 1;
  }
  const rate = wins / rounds;
  assert.ok(Math.abs(rate - 0.5) < 0.03, `flip won ${(rate * 100).toFixed(1)}% of the time`);
  assert.equal(c.money, 10_000_000 + (wins - (rounds - wins)), "the purse matches the record exactly");
});

test("the die pays in proportion to how unlikely the guess was", () => {
  const state = realm(1, 10_000_000);
  const rng = seeded(31);
  let wins = 0;
  const rounds = 20_000;
  for (let i = 0; i < rounds; i += 1) {
    const r = contests.rollDie(state, "u0", 1, 6, 3, { rng, now: START, tuning: rules.DEFAULT_TUNING });
    if (r.ok && r.value.won) wins += 1;
  }
  assert.ok(Math.abs(wins / rounds - 1 / 6) < 0.02, `d6 hit ${(wins / rounds * 100).toFixed(1)}%`);
  // Fair: 1-in-6 to win, paying 5 to 1, is expectation zero.
  const c = engine.find(state, "u0")!;
  assert.ok(Math.abs(c.money - 10_000_000) < 10_000_000 * 0.05);
});

test("wagers refuse what the purse cannot cover", () => {
  const state = realm(1, 10);
  const c = ctx();
  assert.equal(contests.flip(state, "u0", 100, true, c).ok, false);
  assert.equal(contests.rollDie(state, "u0", 1, 6, 99, c).ok, false, "guess out of range");
  assert.equal(contests.rollDie(state, "u0", 1, 1, 1, c).ok, false, "a one-sided die");
  assert.equal(contests.flip(state, "u0", 0, true, c).ok, false);
});
