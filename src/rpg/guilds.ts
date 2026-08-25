import { BOSS_NAMES } from "./content.js";
import { find } from "./engine.js";
import {
  GUILD_CREATE_COST,
  coin,
  guildCapacity,
  guildUpgradeCost,
  pick,
  power,
  raidHit,
  raidHp,
  randInt,
} from "./rules.js";
import type { Ctx } from "./engine.js";
import type { Character, GameState, Guild, Raid } from "./types.js";

/**
 * Guilds, the alliances between them, and the raid bosses they exist to fight.
 *
 * This is the social layer, and on a Discord server it is the half that
 * matters: presence is free here but coordination is not, so the systems worth
 * building are the ones that need two people to agree on something.
 */

export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const no = <T>(reason: string): Outcome<T> => ({ ok: false, reason });

const NO_CHARACTER = "You have no character yet. `/idlerpg start` makes one.";

export function guildOf(state: GameState, character: Character): Guild | null {
  return character.guildId ? (state.guilds[character.guildId] ?? null) : null;
}

export function guildByName(state: GameState, name: string): Guild | null {
  const wanted = name.trim().toLowerCase();
  return Object.values(state.guilds).find((g) => g.name.toLowerCase() === wanted) ?? null;
}

export function members(state: GameState, guild: Guild): Character[] {
  return guild.memberIds
    .map((id) => state.characters[id])
    .filter((c): c is Character => c !== undefined);
}

/** Leader or officer. The only privilege check this module makes. */
export function canManage(guild: Guild, userId: string): boolean {
  return guild.leaderId === userId || guild.officerIds.includes(userId);
}

// ----------------------------------------------------------------- guilds ---

export function createGuild(
  state: GameState,
  userId: string,
  name: string,
  ctx: Ctx,
): Outcome<Guild> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);
  if (character.guildId) return no("You are already in a guild. Leave it first.");

  const trimmed = name.trim();
  if (!/^[\w '\-]{3,32}$/.test(trimmed)) {
    return no("Guild names are 3-32 characters: letters, numbers, spaces, apostrophes, hyphens.");
  }
  if (guildByName(state, trimmed)) return no(`A guild called ${trimmed} already exists.`);
  if (character.money < GUILD_CREATE_COST) {
    return no(`Founding a guild costs ${coin(GUILD_CREATE_COST)}. You have ${coin(character.money)}.`);
  }

  character.money -= GUILD_CREATE_COST;
  // Id is the founder's, which is stable, unique, and never needs a counter.
  const guild: Guild = {
    id: userId,
    name: trimmed,
    leaderId: userId,
    officerIds: [],
    memberIds: [userId],
    bank: 0,
    level: 1,
    allianceOf: null,
    createdAt: ctx.now,
  };
  state.guilds[guild.id] = guild;
  character.guildId = guild.id;
  return ok(guild);
}

export function joinGuild(state: GameState, userId: string, guildId: string): Outcome<Guild> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);
  if (character.guildId) return no("You are already in a guild.");

  const guild = state.guilds[guildId];
  if (!guild) return no("That guild no longer exists.");
  if (guild.memberIds.length >= guildCapacity(guild.level)) {
    return no(`${guild.name} is full (${guildCapacity(guild.level)} members).`);
  }

  guild.memberIds.push(userId);
  character.guildId = guild.id;
  return ok(guild);
}

/**
 * Leaves, and dissolves the guild if the leader was the last one out.
 *
 * A leader may not simply walk away from a populated guild -- that would strand
 * everyone else in something nobody can administer. They hand it over or
 * disband it deliberately.
 */
export function leaveGuild(state: GameState, userId: string): Outcome<Guild> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);
  const guild = guildOf(state, character);
  if (!guild) return no("You are not in a guild.");

  if (guild.leaderId === userId && guild.memberIds.length > 1) {
    return no("You lead this guild. Hand it to somebody else first, or disband it.");
  }

  guild.memberIds = guild.memberIds.filter((id) => id !== userId);
  guild.officerIds = guild.officerIds.filter((id) => id !== userId);
  character.guildId = null;
  if (guild.memberIds.length === 0) delete state.guilds[guild.id];
  return ok(guild);
}

export function kickMember(
  state: GameState,
  actorId: string,
  targetId: string,
): Outcome<{ guild: Guild; target: Character }> {
  const actor = find(state, actorId);
  if (!actor) return no(NO_CHARACTER);
  const guild = guildOf(state, actor);
  if (!guild) return no("You are not in a guild.");
  if (!canManage(guild, actorId)) return no("Only the leader and officers can kick.");
  if (targetId === guild.leaderId) return no("You cannot kick the leader.");
  if (!guild.memberIds.includes(targetId)) return no("They are not in your guild.");

  const target = find(state, targetId);
  guild.memberIds = guild.memberIds.filter((id) => id !== targetId);
  guild.officerIds = guild.officerIds.filter((id) => id !== targetId);
  if (target) target.guildId = null;
  return ok({ guild, target: target as Character });
}

export function setOfficer(
  state: GameState,
  leaderId: string,
  targetId: string,
  promote: boolean,
): Outcome<Guild> {
  const leader = find(state, leaderId);
  if (!leader) return no(NO_CHARACTER);
  const guild = guildOf(state, leader);
  if (!guild) return no("You are not in a guild.");
  if (guild.leaderId !== leaderId) return no("Only the leader can promote and demote.");
  if (!guild.memberIds.includes(targetId)) return no("They are not in your guild.");

  guild.officerIds = guild.officerIds.filter((id) => id !== targetId);
  if (promote) guild.officerIds.push(targetId);
  return ok(guild);
}

export function handOver(state: GameState, leaderId: string, targetId: string): Outcome<Guild> {
  const leader = find(state, leaderId);
  if (!leader) return no(NO_CHARACTER);
  const guild = guildOf(state, leader);
  if (!guild) return no("You are not in a guild.");
  if (guild.leaderId !== leaderId) return no("Only the leader can hand the guild over.");
  if (!guild.memberIds.includes(targetId)) return no("They are not in your guild.");

  guild.leaderId = targetId;
  guild.officerIds = guild.officerIds.filter((id) => id !== targetId);
  if (!guild.officerIds.includes(leaderId)) guild.officerIds.push(leaderId);
  return ok(guild);
}

export function disband(state: GameState, leaderId: string): Outcome<Guild> {
  const leader = find(state, leaderId);
  if (!leader) return no(NO_CHARACTER);
  const guild = guildOf(state, leader);
  if (!guild) return no("You are not in a guild.");
  if (guild.leaderId !== leaderId) return no("Only the leader can disband the guild.");

  for (const member of members(state, guild)) member.guildId = null;
  // The bank goes with the leader rather than evaporating; it was the members'
  // coin and somebody should still have it.
  leader.money += guild.bank;
  delete state.guilds[guild.id];
  // Any alliance led by this guild dissolves with it.
  for (const other of Object.values(state.guilds)) {
    if (other.allianceOf === guild.id) other.allianceOf = null;
  }
  return ok(guild);
}

// ------------------------------------------------------------------- bank ---

export function deposit(state: GameState, userId: string, amount: number): Outcome<Guild> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);
  const guild = guildOf(state, character);
  if (!guild) return no("You are not in a guild.");
  if (!Number.isInteger(amount) || amount < 1) return no("Deposit a whole number of coins.");
  if (character.money < amount) return no(`You only have ${coin(character.money)}.`);

  character.money -= amount;
  guild.bank += amount;
  return ok(guild);
}

/** Withdrawal is leadership-only, which is the whole reason a bank is interesting. */
export function withdraw(state: GameState, userId: string, amount: number): Outcome<Guild> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);
  const guild = guildOf(state, character);
  if (!guild) return no("You are not in a guild.");
  if (!canManage(guild, userId)) return no("Only the leader and officers can withdraw.");
  if (!Number.isInteger(amount) || amount < 1) return no("Withdraw a whole number of coins.");
  if (guild.bank < amount) return no(`The bank holds ${coin(guild.bank)}.`);

  guild.bank -= amount;
  character.money += amount;
  return ok(guild);
}

export function upgrade(state: GameState, userId: string): Outcome<{ guild: Guild; cost: number }> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);
  const guild = guildOf(state, character);
  if (!guild) return no("You are not in a guild.");
  if (guild.leaderId !== userId) return no("Only the leader can upgrade the guild.");

  const cost = guildUpgradeCost(guild.level);
  if (guild.bank < cost) {
    return no(`Upgrading to level ${guild.level + 1} costs ${coin(cost)}. The bank holds ${coin(guild.bank)}.`);
  }

  guild.bank -= cost;
  guild.level += 1;
  return ok({ guild, cost });
}

// -------------------------------------------------------------- alliances ---

/**
 * Alliances are a guild following another guild's banner.
 *
 * Flat rather than a graph: every allied guild points at one leading guild, so
 * "are we allied" is a field comparison instead of a traversal. Nobody has ever
 * wanted a transitive alliance in a game played by two dozen friends.
 */
export function ally(state: GameState, leaderId: string, targetGuildId: string): Outcome<Guild> {
  const leader = find(state, leaderId);
  if (!leader) return no(NO_CHARACTER);
  const guild = guildOf(state, leader);
  if (!guild) return no("You are not in a guild.");
  if (guild.leaderId !== leaderId) return no("Only the leader can join an alliance.");

  const target = state.guilds[targetGuildId];
  if (!target) return no("That guild does not exist.");
  if (target.id === guild.id) return no("You cannot ally with yourself.");
  if (target.allianceOf) return no(`${target.name} already follows another banner.`);

  guild.allianceOf = target.id;
  return ok(target);
}

export function leaveAlliance(state: GameState, leaderId: string): Outcome<Guild> {
  const leader = find(state, leaderId);
  if (!leader) return no(NO_CHARACTER);
  const guild = guildOf(state, leader);
  if (!guild) return no("You are not in a guild.");
  if (guild.leaderId !== leaderId) return no("Only the leader can leave an alliance.");
  if (!guild.allianceOf) return no("You are not in an alliance.");

  guild.allianceOf = null;
  return ok(guild);
}

/** Every guild flying one banner, the leading guild included. */
export function alliance(state: GameState, guild: Guild): Guild[] {
  const bannerId = guild.allianceOf ?? guild.id;
  const banner = state.guilds[bannerId];
  const followers = Object.values(state.guilds).filter((g) => g.allianceOf === bannerId);
  return banner ? [banner, ...followers] : followers;
}

// ----------------------------------------------------------- guild battle ---

export interface GuildBattleResult {
  attacker: Guild;
  defender: Guild;
  attackerPower: number;
  defenderPower: number;
  winner: Guild;
  stake: number;
}

/**
 * Two guilds, summed power, one roll each, the loser's bank pays.
 *
 * Capped at what the loser can actually cover, so a battle is never a way to
 * put a guild into debt it cannot climb out of.
 */
export function guildBattle(
  state: GameState,
  leaderId: string,
  targetGuildId: string,
  stake: number,
  ctx: Ctx,
): Outcome<GuildBattleResult> {
  const leader = find(state, leaderId);
  if (!leader) return no(NO_CHARACTER);
  const attacker = guildOf(state, leader);
  if (!attacker) return no("You are not in a guild.");
  if (!canManage(attacker, leaderId)) return no("Only the leader and officers can declare a battle.");

  const defender = state.guilds[targetGuildId];
  if (!defender) return no("That guild does not exist.");
  if (defender.id === attacker.id) return no("You cannot fight yourself.");
  if (!Number.isInteger(stake) || stake < 1) return no("Stake a whole number of coins.");
  if (attacker.bank < stake) return no(`Your bank holds ${coin(attacker.bank)}.`);
  if (defender.bank < stake) return no(`${defender.name}'s bank holds ${coin(defender.bank)}.`);

  const sum = (g: Guild) =>
    members(state, g).reduce((total, c) => total + power(c), 0);
  const attackerPower = sum(attacker);
  const defenderPower = sum(defender);

  const mine = attackerPower * (0.5 + ctx.rng());
  const theirs = defenderPower * (0.5 + ctx.rng());
  const winner = mine >= theirs ? attacker : defender;
  const loser = winner.id === attacker.id ? defender : attacker;

  winner.bank += stake;
  loser.bank -= stake;
  return ok({ attacker, defender, attackerPower, defenderPower, winner, stake });
}

// ------------------------------------------------------------------ raids ---

/** How long a raid stays open. Long enough to cross a timezone. */
export const RAID_WINDOW_MS = 6 * 3_600_000;
/** What starting a raid costs, seeded into the reward pool. */
export const RAID_SEED = 5_000;

export function startRaid(
  state: GameState,
  userId: string,
  ctx: Ctx,
): Outcome<Raid> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);
  if (state.raid && ctx.now < state.raid.endsAt && state.raid.hp > 0) {
    return no(`${state.raid.bossName} is already loose. Join that one.`);
  }
  if (character.money < RAID_SEED) {
    return no(`Calling a raid costs ${coin(RAID_SEED)} into the pot. You have ${coin(character.money)}.`);
  }

  character.money -= RAID_SEED;
  const expected = Math.max(2, Math.ceil(Object.keys(state.characters).length / 2));
  const hp = raidHp(character.level, expected);
  const raid: Raid = {
    bossName: pick(ctx.rng, BOSS_NAMES),
    hp,
    maxHp: hp,
    damage: {},
    endsAt: ctx.now + RAID_WINDOW_MS,
    pot: RAID_SEED,
    startedAt: ctx.now,
  };
  state.raid = raid;
  return ok(raid);
}

export interface RaidHitResult {
  raid: Raid;
  damage: number;
  killed: boolean;
  /** Present only on the killing blow. */
  payouts: { userId: string; share: number; damage: number }[] | null;
}

/**
 * One swing at the boss.
 *
 * Anyone may hit, as often as they like, for as long as the window is open.
 * There is no per-player cooldown on purpose: the limit that matters is the
 * boss's health, and adding a second limit would just mean people set alarms.
 */
export function hitRaid(state: GameState, userId: string, ctx: Ctx): Outcome<RaidHitResult> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);

  const raid = state.raid;
  if (!raid) return no("Nothing is loose. `/idlerpg raid call` starts one.");
  if (raid.hp <= 0) return no("That boss is already dead.");
  if (ctx.now >= raid.endsAt) {
    state.raid = null;
    return no(`${raid.bossName} slipped away before enough of you turned up.`);
  }

  const damage = raidHit(character, ctx.rng);
  raid.hp = Math.max(0, raid.hp - damage);
  raid.damage[userId] = (raid.damage[userId] ?? 0) + damage;

  if (raid.hp > 0) {
    return ok({ raid, damage, killed: false, payouts: null });
  }

  // Killed: the pot splits by damage dealt, so turning up early and often pays.
  const total = Object.values(raid.damage).reduce((sum, d) => sum + d, 0) || 1;
  const payouts = Object.entries(raid.damage)
    .map(([id, dealt]) => ({
      userId: id,
      damage: dealt,
      share: Math.floor((dealt / total) * raid.pot),
    }))
    .sort((a, b) => b.damage - a.damage);

  for (const payout of payouts) {
    const winner = find(state, payout.userId);
    if (winner) {
      winner.money += payout.share;
      // Everyone who landed a hit gets a crate, scaled to how the boss went
      // down. A raid nobody profits from is a raid nobody calls twice.
      const rarity = payout.share > raid.pot / 4 ? "rare" : "uncommon";
      winner.crates[rarity] += 1;
    }
  }

  state.raid = null;
  return ok({ raid, damage, killed: true, payouts });
}

/** Clears a raid whose window closed, so a stale boss cannot block a new one. */
export function expireRaid(state: GameState, ctx: Ctx): Raid | null {
  const raid = state.raid;
  if (!raid) return null;
  if (ctx.now < raid.endsAt && raid.hp > 0) return null;
  state.raid = null;
  return raid;
}

export { randInt };
