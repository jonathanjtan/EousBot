import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { CLASSES, CLASS_IDS } from "../rpg/content.js";
import {
  claimExpedition,
  create,
  duel,
  equip,
  find,
  findByName,
  leaderboard,
  openCrate,
  sell,
  sellAll,
  startExpedition,
} from "../rpg/engine.js";
import {
  adventureTable,
  backpack,
  claimMessage,
  classMenu,
  describe,
  profile,
  ranking,
} from "../rpg/format.js";
import { DEFAULT_TUNING, coin, shortDuration } from "../rpg/rules.js";
import { save, world } from "../rpg/store.js";
import { RARITIES, type ClassId, type Rarity } from "../rpg/types.js";
import type { Command } from "./types.js";

/**
 * The dispatch-and-claim RPG.
 *
 * Takes the `/idlerpg` name because it is the game people will actually play;
 * jotun's original keeps its mechanics intact under `/irc-idlerpg`. See
 * src/rpg/types.ts for why there are two.
 *
 * Every handler is a shell over src/rpg/engine.ts. Where one looks like it is
 * deciding something, it is deciding what to *show*.
 */

function ctx() {
  return { rng: Math.random, now: Date.now(), tuning: DEFAULT_TUNING };
}

export const DUEL_PREFIX = "rpg:duel";

/** `rpg:duel:<challenger>:<opponent>:<stake>`. Ids are snowflakes; stake is an integer. */
export function encodeDuel(challengerId: string, opponentId: string, stake: number): string {
  return `${DUEL_PREFIX}:${challengerId}:${opponentId}:${stake}`;
}

export function decodeDuel(
  customId: string,
): { challengerId: string; opponentId: string; stake: number } | null {
  const parts = customId.split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== DUEL_PREFIX) return null;
  const stake = Number(parts[4]);
  if (!Number.isInteger(stake) || stake < 1) return null;
  return { challengerId: parts[2] as string, opponentId: parts[3] as string, stake };
}

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("idlerpg")
    .setDescription("Send a character out, come back to what it found")
    .addSubcommand((s) =>
      s
        .setName("start")
        .setDescription("Create a character")
        .addStringOption((o) =>
          o
            .setName("class")
            .setDescription("What your character is good at")
            .setRequired(true)
            .addChoices(...CLASS_IDS.map((id) => ({ name: `${id} — ${CLASSES[id].summary.slice(0, 60)}`, value: id }))),
        )
        .addStringOption((o) =>
          o.setName("name").setDescription("Character name. Defaults to your Discord name").setMaxLength(24),
        ),
    )
    .addSubcommand((s) => s.setName("classes").setDescription("What each class does"))
    .addSubcommand((s) =>
      s
        .setName("profile")
        .setDescription("A character sheet")
        .addStringOption((o) => o.setName("player").setDescription("Character name").setMaxLength(24)),
    )
    .addSubcommand((s) => s.setName("adventures").setDescription("Where you could go, and the odds"))
    .addSubcommand((s) =>
      s
        .setName("adventure")
        .setDescription("Go somewhere")
        .addIntegerOption((o) =>
          o.setName("difficulty").setDescription("Higher pays more and fails more").setRequired(true).setMinValue(1).setMaxValue(30),
        ),
    )
    .addSubcommand((s) => s.setName("status").setDescription("How long until you are back"))
    .addSubcommand((s) => s.setName("claim").setDescription("Collect what you found"))
    .addSubcommand((s) => s.setName("backpack").setDescription("What you are carrying"))
    .addSubcommand((s) =>
      s
        .setName("equip")
        .setDescription("Wear something from your backpack")
        .addIntegerOption((o) => o.setName("item").setDescription("Item number").setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName("sell")
        .setDescription("Sell one item")
        .addIntegerOption((o) => o.setName("item").setDescription("Item number").setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName("sellall")
        .setDescription("Sell the junk")
        .addIntegerOption((o) =>
          o.setName("keep_above").setDescription("Keep anything better than this value").setMinValue(0),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("open")
        .setDescription("Open a crate")
        .addStringOption((o) =>
          o
            .setName("rarity")
            .setDescription("Which crate")
            .setRequired(true)
            .addChoices(...RARITIES.map((r) => ({ name: r, value: r }))),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("duel")
        .setDescription("Wager coin against another player")
        .addUserOption((o) => o.setName("player").setDescription("Who to challenge").setRequired(true))
        .addIntegerOption((o) => o.setName("stake").setDescription("Coin each").setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName("top")
        .setDescription("The realm, ranked")
        .addIntegerOption((o) => o.setName("count").setDescription("How many (default 10)").setMinValue(1).setMaxValue(25)),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case "start":
        return doStart(interaction);
      case "classes":
        await interaction.reply({ content: classMenu(), flags: MessageFlags.Ephemeral });
        return;
      case "profile":
        return doProfile(interaction);
      case "adventures":
        return doAdventures(interaction);
      case "adventure":
        return doAdventure(interaction);
      case "status":
        return doStatus(interaction);
      case "claim":
        return doClaim(interaction);
      case "backpack":
        return doBackpack(interaction);
      case "equip":
        return doEquip(interaction);
      case "sell":
      case "sellall":
        return doSell(interaction, sub === "sellall");
      case "open":
        return doOpen(interaction);
      case "duel":
        return doDuel(interaction);
      case "top":
        return doTop(interaction);
      default:
        await interaction.reply({ content: classMenu(), flags: MessageFlags.Ephemeral });
        return;
    }
  },
};

type Interaction = ChatInputCommandInteraction;

/** Everything except `start` needs a character; this is the one gate. */
function mine(interaction: Interaction) {
  return find(world(), interaction.user.id);
}

const NO_CHARACTER = "You have no character yet. `/idlerpg start` makes one.";

async function doStart(interaction: Interaction): Promise<void> {
  const classId = interaction.options.getString("class", true) as ClassId;
  const name = (interaction.options.getString("name") ?? interaction.user.username).trim();

  // Names go into channel messages, so anything that could impersonate another
  // member or ping a role is refused rather than escaped.
  if (!/^[\w '\-]{1,24}$/.test(name)) {
    await interaction.reply({
      content: "Character names are letters, numbers, spaces, apostrophes and hyphens only.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const result = create(world(), interaction.user.id, name, classId, ctx());
  if (!result.ok) {
    await interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  save();

  await interaction.reply({
    content: [
      `**${result.character.name}** the ${classId} is ready, with ${coin(result.character.money)} and a starting kit.`,
      "",
      "`/idlerpg adventures` shows where you can go and what the odds are.",
    ].join("\n"),
    embeds: [profile(result.character)],
  });
}

async function doProfile(interaction: Interaction): Promise<void> {
  const wanted = interaction.options.getString("player");
  const character = wanted ? findByName(world(), wanted) : mine(interaction);
  if (!character) {
    await interaction.reply({
      content: wanted ? `Nobody is called ${wanted}.` : NO_CHARACTER,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({ embeds: [profile(character)] });
}

async function doAdventures(interaction: Interaction): Promise<void> {
  const character = mine(interaction);
  if (!character) {
    await interaction.reply({ content: NO_CHARACTER, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({ content: adventureTable(character), flags: MessageFlags.Ephemeral });
}

async function doAdventure(interaction: Interaction): Promise<void> {
  const difficulty = interaction.options.getInteger("difficulty", true);
  const result = startExpedition(world(), interaction.user.id, difficulty, ctx());
  if (!result.ok) {
    await interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  save();

  await interaction.reply(
    [
      `**${result.character.name}** has gone to ${result.name}.`,
      `Difficulty ${result.difficulty} — back in ${shortDuration(result.endsAt - Date.now())}, ` +
        `<t:${Math.floor(result.endsAt / 1000)}:R>.`,
      "",
      "_`/idlerpg claim` when the time is up. The dice are rolled then, not now._",
    ].join("\n"),
  );
}

async function doStatus(interaction: Interaction): Promise<void> {
  const character = mine(interaction);
  if (!character) {
    await interaction.reply({ content: NO_CHARACTER, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!character.expedition) {
    await interaction.reply({
      content: "You are not on an adventure. `/idlerpg adventures` shows the options.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const left = character.expedition.endsAt - Date.now();
  await interaction.reply({
    content:
      left > 0
        ? `Difficulty ${character.expedition.difficulty}, back <t:${Math.floor(character.expedition.endsAt / 1000)}:R> (${shortDuration(left)}).`
        : "You are back. `/idlerpg claim` to see how it went.",
    flags: MessageFlags.Ephemeral,
  });
}

async function doClaim(interaction: Interaction): Promise<void> {
  const result = claimExpedition(world(), interaction.user.id, ctx());

  if (result.kind === "none") {
    await interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  if (result.kind === "pending") {
    await interaction.reply({
      content: `Not back yet — <t:${Math.floor(result.endsAt / 1000)}:R>.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  save();
  await interaction.reply({ embeds: [claimMessage(result.character, result.reward)] });
  for (const line of result.announcements) {
    await interaction.followUp(line.text);
  }
}

async function doBackpack(interaction: Interaction): Promise<void> {
  const character = mine(interaction);
  if (!character) {
    await interaction.reply({ content: NO_CHARACTER, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({ content: backpack(character), flags: MessageFlags.Ephemeral });
}

async function doEquip(interaction: Interaction): Promise<void> {
  const result = equip(world(), interaction.user.id, interaction.options.getInteger("item", true));
  if (!result.ok) {
    await interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  save();
  await interaction.reply(
    `Equipped ${describe(result.item)}` +
      (result.replaced ? `, and put ${result.replaced.name} back in the pack.` : "."),
  );
}

async function doSell(interaction: Interaction, all: boolean): Promise<void> {
  const result = all
    ? sellAll(world(), interaction.user.id, interaction.options.getInteger("keep_above") ?? 0)
    : sell(world(), interaction.user.id, interaction.options.getInteger("item", true));

  if (!result.ok) {
    await interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  save();
  await interaction.reply({
    content:
      result.count === 0
        ? "Nothing matched, so nothing was sold."
        : `Sold ${result.count} item${result.count === 1 ? "" : "s"} for ${coin(result.paid)}.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function doOpen(interaction: Interaction): Promise<void> {
  const rarity = interaction.options.getString("rarity", true) as Rarity;
  const result = openCrate(world(), interaction.user.id, rarity, ctx());
  if (!result.ok) {
    await interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  save();

  const lines = [`Out of the ${rarity} crate: ${describe(result.item)}`];
  if (result.equipped) {
    lines.push(
      result.replaced
        ? `Better than your ${result.replaced.name} (${result.replaced.value}) — equipped.`
        : "Equipped, since you had nothing in that slot.",
    );
  } else if (result.soldOverflow > 0) {
    lines.push(`Your backpack was full, so it sold immediately for ${coin(result.soldOverflow)}.`);
  } else {
    lines.push("Into the backpack with it.");
  }
  await interaction.reply(lines.join("\n"));
}

/**
 * Challenges another player, and waits for them to accept.
 *
 * The wager is not applied here. Moving somebody's coin because a third party
 * ran a command would be indefensible, so the duel only resolves once the
 * challenged player presses the button themselves.
 */
async function doDuel(interaction: Interaction): Promise<void> {
  const target = interaction.options.getUser("player", true);
  const stake = interaction.options.getInteger("stake", true);
  const state = world();

  const challenger = find(state, interaction.user.id);
  const opponent = find(state, target.id);
  if (!challenger) {
    await interaction.reply({ content: NO_CHARACTER, flags: MessageFlags.Ephemeral });
    return;
  }
  if (target.bot || !opponent) {
    await interaction.reply({
      content: `${target.username} has no character.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (target.id === interaction.user.id) {
    await interaction.reply({ content: "You cannot duel yourself.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (challenger.money < stake || opponent.money < stake) {
    await interaction.reply({
      content: `Both of you need ${coin(stake)}. You have ${coin(challenger.money)}; ${opponent.name} has ${coin(opponent.money)}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content:
      `<@${target.id}> — **${challenger.name}** challenges you for ${coin(stake)}.\n` +
      `_Accept and the loser pays. Ignore it and nothing happens._`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(encodeDuel(interaction.user.id, target.id, stake))
          .setLabel(`Accept — ${stake}`)
          .setEmoji("⚔️")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
  });
}

/** Resolves a duel, but only for the player who was actually challenged. */
export async function handleDuelButton(
  interaction: ButtonInteraction,
  target: { challengerId: string; opponentId: string; stake: number },
): Promise<void> {
  if (interaction.user.id !== target.opponentId) {
    await interaction.reply({
      content: "That challenge is not yours to accept.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const result = duel(world(), target.challengerId, target.opponentId, target.stake, ctx());
  if (!result.ok) {
    await interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  save();

  const { winner, loser, stake, winnerRoll, loserRoll } = result.outcome;
  await interaction.update({
    content:
      `**${winner.name}** [${winnerRoll}] beat **${loser.name}** [${loserRoll}] and takes ${coin(stake)}.`,
    components: [],
  });
}

async function doTop(interaction: Interaction): Promise<void> {
  const count = interaction.options.getInteger("count") ?? 10;
  await interaction.reply(ranking(leaderboard(world(), count)));
}
