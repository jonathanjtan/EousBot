import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { find, findByName } from "../rpg/engine.js";
import {
  buyCrates,
  buyListing,
  browse,
  followGod,
  give,
  listForSale,
  sacrifice,
  unlist,
} from "../rpg/economy.js";
import {
  alliance,
  ally,
  createGuild,
  deposit,
  disband,
  expireRaid,
  guildBattle,
  guildByName,
  guildOf,
  handOver,
  hitRaid,
  joinGuild,
  kickMember,
  leaveAlliance,
  leaveGuild,
  members,
  setOfficer,
  startRaid,
  upgrade,
  withdraw,
} from "../rpg/guilds.js";
import {
  courtSpouse,
  divorce,
  enterTournament,
  flip,
  marry,
  openTournament,
  rollDie,
  runTournament,
} from "../rpg/contests.js";
import {
  godMenu,
  godStanding,
  guildCard,
  guildList,
  marketBoard,
  marriageCard,
  raidCard,
  rankBoard,
  storeList,
  tournamentCard,
  type RankMetric,
} from "../rpg/format.js";
import { DEFAULT_TUNING, coin, tierFor } from "../rpg/rules.js";
import {
  TRIVIA_PRIZE,
  answerTrivia,
  askTrivia,
  enterArena,
  makeMathProblem,
  mathPrize,
  openArena,
  runArena,
  startEvent,
  startSeason,
} from "../rpg/arena.js";
import { activeEvent } from "../rpg/worldevent.js";
import type { Ctx } from "../rpg/engine.js";
import { save, world } from "../rpg/store.js";
import type { GodId, Rarity } from "../rpg/types.js";

/**
 * Handlers for everything the adventure loop feeds: gods, the shop, guilds,
 * the market, raids, tournaments, marriage and wagers.
 *
 * Split from commands/rpg.ts to keep either file readable. Same contract as
 * every handler there -- a shell over a pure module, deciding only what to
 * show. All the rules live in src/rpg/.
 */

type I = ChatInputCommandInteraction;

/**
 * One properly-formed context for every handler here.
 *
 * An earlier version passed `{ rng, now }` cast to the right shape, on the
 * reasoning that these systems never read `tuning`. That is true today and is
 * exactly the kind of thing that stops being true silently -- the first module
 * to read a tuning value would get `undefined` at runtime with no type error
 * to warn anyone. Building the real object costs nothing.
 */
function ctx(): Ctx {
  return { rng: Math.random, now: Date.now(), tuning: DEFAULT_TUNING };
}

async function whisper(interaction: I, content: string): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/** Names for ids, for boards that list other people. */
function namer() {
  const state = world();
  return (id: string) => state.characters[id]?.name ?? "someone";
}

// ------------------------------------------------------------------- gods ---

export async function handleGod(interaction: I, sub: string): Promise<void> {
  const state = world();

  if (sub === "list") return whisper(interaction, godMenu());

  if (sub === "status") {
    const character = find(state, interaction.user.id);
    if (!character) return whisper(interaction, "You have no character yet.");
    return whisper(interaction, godStanding(character));
  }

  if (sub === "follow") {
    const god = interaction.options.getString("god", true) as GodId;
    const result = followGod(state, interaction.user.id, god);
    if (!result.ok) return whisper(interaction, result.reason);
    save();
    await interaction.reply(
      result.value.cost > 0
        ? `You have left your old god for a new one, at a cost of ${coin(result.value.cost)}. Your favour follows you.`
        : `You now follow **${god}**. Sacrifice what you cannot wear.`,
    );
    return;
  }

  if (sub === "sacrifice") {
    const raw = interaction.options.getString("items", true);
    const ids = raw
      .split(/[\s,]+/)
      .map((s) => Number(s.replace("#", "")))
      .filter((n) => Number.isInteger(n) && n > 0);

    const result = sacrifice(state, interaction.user.id, ids);
    if (!result.ok) return whisper(interaction, result.reason);
    save();
    await interaction.reply(
      `Given up ${result.value.items.length} item${result.value.items.length === 1 ? "" : "s"} ` +
        `for **${result.value.favor.toLocaleString("en-US")}** favour. ` +
        `Total: ${result.value.total.toLocaleString("en-US")}.`,
    );
  }
}

// ------------------------------------------------------------------ store ---

export async function handleStore(interaction: I, sub: string): Promise<void> {
  if (sub === "list") return whisper(interaction, storeList());

  const rarity = interaction.options.getString("rarity", true) as Rarity;
  const count = interaction.options.getInteger("count") ?? 1;
  const result = buyCrates(world(), interaction.user.id, rarity, count);
  if (!result.ok) return whisper(interaction, result.reason);
  save();
  await interaction.reply(
    `Bought ${result.value.count} ${rarity} crate${result.value.count === 1 ? "" : "s"} for ${coin(result.value.paid)}.`,
  );
}

// ------------------------------------------------------------------- give ---

export async function handleGive(interaction: I): Promise<void> {
  const target = interaction.options.getUser("player", true);
  const money = interaction.options.getInteger("coin") ?? 0;
  const itemId = interaction.options.getInteger("item");

  const result = give(world(), interaction.user.id, target.id, {
    money,
    ...(itemId !== null ? { itemId } : {}),
  });
  if (!result.ok) return whisper(interaction, result.reason);
  save();

  const parts: string[] = [];
  if (result.value.money > 0) parts.push(coin(result.value.money));
  if (result.value.item) parts.push(result.value.item.name);
  await interaction.reply(
    `**${result.value.from.name}** gave ${parts.join(" and ")} to **${result.value.to.name}**.`,
  );
}

// ----------------------------------------------------------------- guilds ---

export async function handleGuild(interaction: I, sub: string): Promise<void> {
  const state = world();
  const userId = interaction.user.id;

  switch (sub) {
    case "list":
      return whisper(interaction, guildList(Object.values(state.guilds)));

    case "info": {
      const wanted = interaction.options.getString("name");
      const character = find(state, userId);
      const guild = wanted
        ? guildByName(state, wanted)
        : character
          ? guildOf(state, character)
          : null;
      if (!guild) return whisper(interaction, wanted ? "No such guild." : "You are not in a guild.");
      await interaction.reply({
        embeds: [guildCard(guild, members(state, guild), alliance(state, guild))],
      });
      return;
    }

    case "create": {
      const result = createGuild(state, userId, interaction.options.getString("name", true), ctx());
      if (!result.ok) return whisper(interaction, result.reason);
      save();
      await interaction.reply(`**${result.value.name}** is founded. `
        + "`/idlerpg guild invite` brings people in.");
      return;
    }

    case "join": {
      const name = interaction.options.getString("name", true);
      const guild = guildByName(state, name);
      if (!guild) return whisper(interaction, "No such guild.");
      const result = joinGuild(state, userId, guild.id);
      if (!result.ok) return whisper(interaction, result.reason);
      save();
      await interaction.reply(`**${interaction.user.username}** joined **${result.value.name}**.`);
      return;
    }

    case "leave": {
      const result = leaveGuild(state, userId);
      if (!result.ok) return whisper(interaction, result.reason);
      save();
      await interaction.reply(`Left **${result.value.name}**.`);
      return;
    }

    case "kick": {
      const target = interaction.options.getUser("player", true);
      const result = kickMember(state, userId, target.id);
      if (!result.ok) return whisper(interaction, result.reason);
      save();
      await interaction.reply(`**${result.value.target?.name ?? target.username}** is out of **${result.value.guild.name}**.`);
      return;
    }

    case "promote":
    case "demote": {
      const target = interaction.options.getUser("player", true);
      const result = setOfficer(state, userId, target.id, sub === "promote");
      if (!result.ok) return whisper(interaction, result.reason);
      save();
      await interaction.reply(
        `${target.username} is ${sub === "promote" ? "now an officer" : "no longer an officer"} of **${result.value.name}**.`,
      );
      return;
    }

    case "handover": {
      const target = interaction.options.getUser("player", true);
      const result = handOver(state, userId, target.id);
      if (!result.ok) return whisper(interaction, result.reason);
      save();
      await interaction.reply(`**${result.value.name}** now answers to ${target.username}.`);
      return;
    }

    case "disband": {
      const result = disband(state, userId);
      if (!result.ok) return whisper(interaction, result.reason);
      save();
      await interaction.reply(`**${result.value.name}** is dissolved. The bank went with its leader.`);
      return;
    }

    case "deposit":
    case "withdraw": {
      const amount = interaction.options.getInteger("coin", true);
      const result =
        sub === "deposit" ? deposit(state, userId, amount) : withdraw(state, userId, amount);
      if (!result.ok) return whisper(interaction, result.reason);
      save();
      await interaction.reply(
        `${sub === "deposit" ? "Deposited" : "Withdrew"} ${coin(amount)}. ` +
          `**${result.value.name}** holds ${coin(result.value.bank)}.`,
      );
      return;
    }

    case "upgrade": {
      const result = upgrade(state, userId);
      if (!result.ok) return whisper(interaction, result.reason);
      save();
      await interaction.reply(
        `**${result.value.guild.name}** is now level ${result.value.guild.level}, for ${coin(result.value.cost)}.`,
      );
      return;
    }

    case "ally":
    case "unally": {
      if (sub === "unally") {
        const result = leaveAlliance(state, userId);
        if (!result.ok) return whisper(interaction, result.reason);
        save();
        await interaction.reply(`**${result.value.name}** flies its own banner again.`);
        return;
      }
      const name = interaction.options.getString("name", true);
      const target = guildByName(state, name);
      if (!target) return whisper(interaction, "No such guild.");
      const result = ally(state, userId, target.id);
      if (!result.ok) return whisper(interaction, result.reason);
      save();
      await interaction.reply(`Now flying under **${result.value.name}**'s banner.`);
      return;
    }

    case "battle": {
      const name = interaction.options.getString("name", true);
      const stake = interaction.options.getInteger("stake", true);
      const target = guildByName(state, name);
      if (!target) return whisper(interaction, "No such guild.");
      const result = guildBattle(state, userId, target.id, stake, ctx());
      if (!result.ok) return whisper(interaction, result.reason);
      save();
      const v = result.value;
      await interaction.reply(
        `**${v.attacker.name}** [${v.attackerPower}] fought **${v.defender.name}** [${v.defenderPower}].\n` +
          `**${v.winner.name}** takes ${coin(v.stake)}.`,
      );
      return;
    }
  }
}

// ----------------------------------------------------------------- market ---

export async function handleMarket(interaction: I, sub: string): Promise<void> {
  const state = world();

  if (sub === "list") {
    return whisper(interaction, marketBoard(browse(state, 20), namer()));
  }

  if (sub === "sell") {
    const itemId = interaction.options.getInteger("item", true);
    const price = interaction.options.getInteger("price", true);
    const result = listForSale(state, interaction.user.id, itemId, price, ctx());
    if (!result.ok) return whisper(interaction, result.reason);
    save();
    await interaction.reply(
      `Listed **${result.value.item.name}** as \`#${result.value.id}\` for ${coin(result.value.price)}.`,
    );
    return;
  }

  if (sub === "buy") {
    const listingId = interaction.options.getInteger("listing", true);
    const result = buyListing(state, interaction.user.id, listingId);
    if (!result.ok) return whisper(interaction, result.reason);
    save();
    await interaction.reply(
      `Bought **${result.value.listing.item.name}** for ${coin(result.value.listing.price)}` +
        (result.value.seller ? ` from **${result.value.seller.name}**.` : "."),
    );
    return;
  }

  if (sub === "unlist") {
    const listingId = interaction.options.getInteger("listing", true);
    const result = unlist(state, interaction.user.id, listingId);
    if (!result.ok) return whisper(interaction, result.reason);
    save();
    await whisper(interaction, `Took **${result.value.item.name}** off the market.`);
  }
}

// ------------------------------------------------------------------ raids ---

export async function handleRaid(interaction: I, sub: string): Promise<void> {
  const state = world();
  const now = Date.now();
  expireRaid(state, ctx());

  if (sub === "status") {
    if (!state.raid) return whisper(interaction, "Nothing is loose. `/idlerpg raid call` starts one.");
    await interaction.reply({ embeds: [raidCard(state.raid, namer())] });
    return;
  }

  if (sub === "call") {
    const result = startRaid(state, interaction.user.id, ctx());
    if (!result.ok) return whisper(interaction, result.reason);
    save();
    await interaction.reply({
      content: `**${result.value.bossName}** is loose. Everyone can hit it with \`/idlerpg raid hit\`.`,
      embeds: [raidCard(result.value, namer())],
    });
    return;
  }

  if (sub === "hit") {
    const result = hitRaid(state, interaction.user.id, ctx());
    if (!result.ok) return whisper(interaction, result.reason);
    save();
    const v = result.value;

    if (!v.killed) {
      await interaction.reply(
        `**${interaction.user.username}** hit **${v.raid.bossName}** for **${v.damage.toLocaleString("en-US")}**. ` +
          `${v.raid.hp.toLocaleString("en-US")} left.`,
      );
      return;
    }

    const name = namer();
    await interaction.reply({
      content: [
        `**${v.raid.bossName} is down.** Final blow by ${interaction.user.username} for ${v.damage.toLocaleString("en-US")}.`,
        "",
        ...(v.payouts ?? [])
          .slice(0, 15)
          .map((p) => `**${name(p.userId)}** — ${p.damage.toLocaleString("en-US")} damage, ${coin(p.share)} and a crate`),
      ].join("\n"),
    });
  }
}

// ------------------------------------------------------------ tournaments ---

export async function handleTournament(interaction: I, sub: string): Promise<void> {
  const state = world();
  const now = Date.now();

  if (sub === "status") {
    if (!state.tournament) return whisper(interaction, "No tournament right now.");
    await interaction.reply(tournamentCard(state.tournament, namer()));
    return;
  }

  if (sub === "open") {
    const buyIn = interaction.options.getInteger("buy_in") ?? 0;
    const result = openTournament(state, interaction.user.id, buyIn, ctx());
    if (!result.ok) return whisper(interaction, result.reason);
    save();
    await interaction.reply(tournamentCard(result.value, namer()));
    return;
  }

  if (sub === "join") {
    const result = enterTournament(state, interaction.user.id, ctx());
    if (!result.ok) return whisper(interaction, result.reason);
    save();
    await interaction.reply(
      `**${interaction.user.username}** entered. ${result.value.entries.length} in the bracket.`,
    );
    return;
  }

  if (sub === "run") {
    const result = runTournament(state, ctx());
    if (!result.ok) return whisper(interaction, result.reason);
    save();
    await interaction.reply(tournamentCard(result.value.tournament, namer()));
  }
}

// --------------------------------------------------------------- marriage ---

export async function handleMarry(interaction: I, sub: string): Promise<void> {
  const state = world();

  if (sub === "status") {
    const character = find(state, interaction.user.id);
    if (!character) return whisper(interaction, "You have no character yet.");
    const spouse = character.spouse ? find(state, character.spouse) : null;
    return whisper(interaction, marriageCard(character, spouse));
  }

  if (sub === "divorce") {
    const result = divorce(state, interaction.user.id);
    if (!result.ok) return whisper(interaction, result.reason);
    save();
    await interaction.reply(
      `**${result.value.character.name}** and **${result.value.exName}** have gone their separate ways. ` +
        "The affection does not survive it.",
    );
    return;
  }

  if (sub === "court") {
    const spend = interaction.options.getInteger("coin", true);
    const result = courtSpouse(state, interaction.user.id, spend);
    if (!result.ok) return whisper(interaction, result.reason);
    save();
    await interaction.reply(
      `**${result.value.character.name}** spent ${coin(spend)} on **${result.value.spouse.name}**. ` +
        `Affection up ${result.value.gained} for both.`,
    );
  }
}

/** Called from the accept button, so nobody is married without agreeing. */
export async function completeMarriage(
  proposerId: string,
  accepterId: string,
): Promise<{ ok: boolean; text: string }> {
  const result = marry(world(), proposerId, accepterId);
  if (!result.ok) return { ok: false, text: result.reason };
  save();
  return {
    ok: true,
    text: `**${result.value.a.name}** and **${result.value.b.name}** are married. ` +
      "`/idlerpg marry court` makes it worth something.",
  };
}

// --------------------------------------------------------------- gambling ---

export async function handleBet(interaction: I, sub: string): Promise<void> {
  const state = world();
  const stake = interaction.options.getInteger("stake", true);

  if (sub === "flip") {
    const call = interaction.options.getString("call", true) === "heads";
    const result = flip(state, interaction.user.id, stake, call, ctx());
    if (!result.ok) return whisper(interaction, result.reason);
    save();
    const v = result.value;
    await interaction.reply(
      `${v.detail} **${interaction.user.username}** ${v.won ? `wins ${coin(v.payout)}` : `loses ${coin(v.stake)}`}.`,
    );
    return;
  }

  if (sub === "dice") {
    const sides = interaction.options.getInteger("sides") ?? 6;
    const guess = interaction.options.getInteger("guess", true);
    const result = rollDie(state, interaction.user.id, stake, sides, guess, ctx());
    if (!result.ok) return whisper(interaction, result.reason);
    save();
    const v = result.value;
    await interaction.reply(
      `${v.detail} **${interaction.user.username}** called ${guess} and ` +
        `${v.won ? `wins ${coin(v.payout)}` : `loses ${coin(v.stake)}`}.`,
    );
  }
}

export { findByName };

// ------------------------------------------------------------ game master ---

/**
 * Operator controls.
 *
 * Gated on the bot's admin allowlist by the caller, not here -- this module
 * decides what happens, config.ts decides who may ask. Everything is
 * deliberately blunt and deliberately logged into the channel: an admin who
 * quietly hands themselves a legendary has broken the game for everyone else,
 * and the cheapest defence is that everyone can see it happen.
 */
export async function handleAdmin(interaction: I, sub: string): Promise<void> {
  const state = world();

  if (sub === "clear") {
    const what: string[] = [];
    if (state.raid) {
      what.push(`the raid on ${state.raid.bossName}`);
      state.raid = null;
    }
    if (state.tournament) {
      what.push("the tournament");
      state.tournament = null;
    }
    save();
    await interaction.reply(
      what.length > 0 ? `Cleared ${what.join(" and ")}.` : "Nothing was stuck.",
    );
    return;
  }

  const target = interaction.options.getUser("player", true);
  const character = find(state, target.id);
  if (!character) {
    return whisper(interaction, `${target.username} has no character.`);
  }

  switch (sub) {
    case "grant": {
      const amount = interaction.options.getInteger("coin", true);
      character.money = Math.max(0, character.money + amount);
      save();
      await interaction.reply(
        `${interaction.user.username} ${amount >= 0 ? "granted" : "took"} ` +
          `${coin(Math.abs(amount))} ${amount >= 0 ? "to" : "from"} **${character.name}**.`,
      );
      return;
    }

    case "setlevel": {
      const level = interaction.options.getInteger("level", true);
      character.level = level;
      character.xp = 0;
      // Tier follows level, or a hand-set level leaves the class ladder stale.
      character.tier = tierFor(level);
      save();
      await interaction.reply(
        `${interaction.user.username} set **${character.name}** to level ${level}.`,
      );
      return;
    }

    case "spawn": {
      const value = interaction.options.getInteger("value", true);
      const rarity = interaction.options.getString("rarity", true) as Rarity;
      const kind = interaction.options.getString("kind", true) as "weapon" | "armor";
      const item = {
        id: character.nextItemId,
        name: `${rarity === "common" ? "Plain" : "Granted"} ${kind === "weapon" ? "Blade" : "Coat"}`,
        kind,
        value,
        rarity,
      };
      character.nextItemId += 1;
      character.backpack.push(item);
      save();
      await interaction.reply(
        `${interaction.user.username} gave **${character.name}** a level ${value} ${rarity} ${kind}.`,
      );
      return;
    }

    case "reset": {
      const guild = character.guildId ? state.guilds[character.guildId] : null;
      if (guild) {
        guild.memberIds = guild.memberIds.filter((id) => id !== character.userId);
        guild.officerIds = guild.officerIds.filter((id) => id !== character.userId);
        if (guild.memberIds.length === 0) delete state.guilds[guild.id];
      }
      // Listings and marriages would otherwise point at a character that is
      // gone, which is how a leaderboard starts rendering "someone" forever.
      state.market = state.market.filter((l) => l.sellerId !== character.userId);
      if (character.spouse) {
        const spouse = find(state, character.spouse);
        if (spouse) {
          spouse.spouse = null;
          spouse.loveScore = 0;
        }
      }
      delete state.characters[character.userId];
      save();
      await interaction.reply(
        `${interaction.user.username} deleted **${character.name}**, level ${character.level}.`,
      );
      return;
    }
  }
}

// ------------------------------------------------------------------ ranks ---

export async function handleTopBoard(interaction: I): Promise<void> {
  const metric = (interaction.options.getString("by") ?? "level") as RankMetric;
  const count = interaction.options.getInteger("count") ?? 10;
  await interaction.reply(
    rankBoard(Object.values(world().characters), metric, count),
  );
}

// ------------------------------------------------------------------ arena ---

export async function handleArena(interaction: I, sub: string): Promise<void> {
  const state = world();

  if (sub === "status") {
    if (!state.arena) return whisper(interaction, "No match right now.");
    const name = namer();
    const a = state.arena;
    if (a.finished) {
      await interaction.reply(
        [`**Match over.**`, "", ...a.log].join("\n").slice(0, 1900),
      );
      return;
    }
    await interaction.reply(
      [
        `**Free-for-all** — buy-in ${coin(a.buyIn)}, pot ${coin(a.buyIn * a.entrantIds.length)}.`,
        `Entry closes <t:${Math.floor(a.closesAt / 1000)}:R>.`,
        "",
        `**${a.entrantIds.length} in:** ${a.entrantIds.map(name).join(", ")}`,
      ].join("\n"),
    );
    return;
  }

  if (sub === "open") {
    const buyIn = interaction.options.getInteger("buy_in") ?? 0;
    const result = openArena(state, interaction.user.id, buyIn, ctx());
    if (!result.ok) return whisper(interaction, result.reason);
    save();
    await interaction.reply(
      `**${interaction.user.username}** opened a free-for-all. Buy-in ${coin(buyIn)}, ` +
        `entry closes <t:${Math.floor(result.value.closesAt / 1000)}:R>. \`/idlerpg arena join\`.`,
    );
    return;
  }

  if (sub === "join") {
    const result = enterArena(state, interaction.user.id, ctx());
    if (!result.ok) return whisper(interaction, result.reason);
    save();
    await interaction.reply(
      `**${interaction.user.username}** is in. ${result.value.entrantIds.length} entrants.`,
    );
    return;
  }

  if (sub === "run") {
    const result = runArena(state, ctx());
    if (!result.ok) return whisper(interaction, result.reason);
    save();
    const v = result.value;
    // The transcript can outrun a Discord message on a big field, so the tail
    // is what gets kept -- the rounds that decided it.
    const body = v.arena.log.join("\n\n");
    await interaction.reply(
      [
        `**The arena** — ${v.arena.entrantIds.length} in, ${coin(v.pot)} on the table.`,
        "",
        body.length > 1700 ? `…\n${body.slice(-1700)}` : body,
      ].join("\n"),
    );
  }
}

// ----------------------------------------------------------------- trivia ---

export const TRIVIA_PREFIX = "rpg:trivia";

/** `rpg:trivia:<questionIndex>:<optionIndex>`. */
export function encodeTrivia(question: number, option: number): string {
  return `${TRIVIA_PREFIX}:${question}:${option}`;
}

export function decodeTrivia(customId: string): { question: number; option: number } | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || `${parts[0]}:${parts[1]}` !== TRIVIA_PREFIX) return null;
  const question = Number(parts[2]);
  const option = Number(parts[3]);
  if (!Number.isInteger(question) || !Number.isInteger(option)) return null;
  return { question, option };
}

export async function handleTrivia(interaction: I): Promise<void> {
  const { question, index } = askTrivia(ctx());
  await interaction.reply({
    content: `**${question.prompt}**\n_First correct answer takes ${coin(TRIVIA_PRIZE)}._`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...question.options.map((option, i) =>
          new ButtonBuilder()
            .setCustomId(encodeTrivia(index, i))
            .setLabel(option.slice(0, 80))
            .setStyle(ButtonStyle.Secondary),
        ),
      ),
    ],
  });
}

/**
 * Scores an answer.
 *
 * The buttons are stripped on the first response, so the prize genuinely goes
 * to whoever was fastest rather than to everyone who eventually clicked.
 */
export async function handleTriviaButton(
  interaction: ButtonInteraction,
  target: { question: number; option: number },
): Promise<void> {
  const result = answerTrivia(world(), interaction.user.id, target.question, target.option);
  if (!result.ok) {
    await interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  save();
  const v = result.value;
  await interaction.update({
    content:
      `**${interaction.user.username}** answered **${v.correct ? "correctly" : "wrongly"}**. ` +
      `The answer was *${v.answer}*.` +
      (v.correct ? ` ${coin(v.prize)} awarded.` : ""),
    components: [],
  });
}

// ------------------------------------------------------------ world event ---

export async function handleEvent(interaction: I): Promise<void> {
  const state = world();
  const kind = interaction.options.getString("kind") as
    | "bounty"
    | "study"
    | "fortune"
    | null;
  const event = startEvent(state, ctx(), kind ?? undefined);
  save();
  await interaction.reply(
    [
      `**${event.name}**`,
      event.blurb,
      `Ends <t:${Math.floor(event.endsAt / 1000)}:R>.`,
    ].join("\n"),
  );
}

/** Shown on the adventure table so nobody misses a running event. */
export function eventLine(now: number): string | null {
  const event = activeEvent(world(), now);
  if (!event) return null;
  return `**${event.name}** — ${event.blurb} (ends <t:${Math.floor(event.endsAt / 1000)}:R>)`;
}

// ------------------------------------------------------------------ maths ---

export const MATHS_PREFIX = "rpg:maths";

/** `rpg:maths:<difficulty>:<correctIndex>:<chosenIndex>`. */
export function encodeMaths(difficulty: number, correct: number, chosen: number): string {
  return `${MATHS_PREFIX}:${difficulty}:${correct}:${chosen}`;
}

export function decodeMaths(
  customId: string,
): { difficulty: number; correct: number; chosen: number } | null {
  const parts = customId.split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== MATHS_PREFIX) return null;
  const [difficulty, correct, chosen] = [Number(parts[2]), Number(parts[3]), Number(parts[4])];
  if (![difficulty, correct, chosen].every(Number.isInteger)) return null;
  return { difficulty, correct, chosen };
}

/**
 * A generated sum.
 *
 * Unlike trivia, the answer travels in the button id rather than an index into
 * a bank -- the problem is synthesised per call and there is nothing to look it
 * up in afterwards. Nothing is at stake in forging one beyond a few hundred
 * coin, and the alternative is holding server-side state for every question
 * anyone has ever been asked.
 */
export async function handleMaths(interaction: I): Promise<void> {
  const difficulty = interaction.options.getInteger("difficulty") ?? 2;
  const problem = makeMathProblem(Math.random, difficulty);

  await interaction.reply({
    content:
      `**${problem.prompt}**\n_First correct answer takes ${coin(mathPrize(problem.difficulty))}._`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...problem.options.map((option, i) =>
          new ButtonBuilder()
            .setCustomId(encodeMaths(problem.difficulty, problem.answer, i))
            .setLabel(option.slice(0, 80))
            .setStyle(ButtonStyle.Secondary),
        ),
      ),
    ],
  });
}

export async function handleMathsButton(
  interaction: ButtonInteraction,
  target: { difficulty: number; correct: number; chosen: number },
): Promise<void> {
  const state = world();
  const character = find(state, interaction.user.id);
  if (!character) {
    await interaction.reply({
      content: "You have no character yet. `/idlerpg start` makes one.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const correct = target.chosen === target.correct;
  const prize = correct ? mathPrize(target.difficulty) : 0;
  if (correct) {
    character.money += prize;
    save();
  }
  await interaction.update({
    content: correct
      ? `**${interaction.user.username}** got it. ${coin(prize)} awarded.`
      : `**${interaction.user.username}** got it wrong.`,
    components: [],
  });
}

// --------------------------------------------------------------- seasonal ---

export async function handleSeason(interaction: I): Promise<void> {
  const index = interaction.options.getInteger("which");
  const event = startSeason(world(), ctx(), index ?? undefined);
  save();
  await interaction.reply(
    [`**${event.name}**`, event.blurb, `Ends <t:${Math.floor(event.endsAt / 1000)}:R>.`].join("\n"),
  );
}
