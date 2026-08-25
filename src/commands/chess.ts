import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { find } from "../rpg/engine.js";
import {
  agreeDraw,
  describeGame,
  gameFor,
  opponentOf,
  play,
  resign,
  startGame,
} from "../rpg/chessgame.js";
import { DEFAULT_TUNING, coin } from "../rpg/rules.js";
import { save, world } from "../rpg/store.js";
import type { Command } from "./types.js";

/**
 * Chess, as its own command rather than a corner of /idlerpg.
 *
 * Partly because `/idlerpg` is near Discord's 25-option ceiling, and mostly
 * because this is not an RPG feature -- it shares the coin and nothing else. A
 * player looking for a chess game should not have to know it lives inside an
 * idle game to find it.
 *
 * The engine is src/rpg/chess.ts, validated by perft; this file only decides
 * what to show.
 */

function ctx() {
  return { rng: Math.random, now: Date.now(), tuning: DEFAULT_TUNING };
}

export const CHESS_ACCEPT = "chess:accept";
export const CHESS_DRAW = "chess:draw";

/** `chess:accept:<challenger>:<target>:<stake>` */
export function encodeChallenge(challengerId: string, targetId: string, stake: number): string {
  return `${CHESS_ACCEPT}:${challengerId}:${targetId}:${stake}`;
}

export function decodeChallenge(
  customId: string,
): { challengerId: string; targetId: string; stake: number } | null {
  const parts = customId.split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== CHESS_ACCEPT) return null;
  const stake = Number(parts[4]);
  if (!Number.isInteger(stake) || stake < 0) return null;
  return { challengerId: parts[2] as string, targetId: parts[3] as string, stake };
}

/** `chess:draw:<offerer>:<target>` */
export function encodeDrawOffer(offererId: string, targetId: string): string {
  return `${CHESS_DRAW}:${offererId}:${targetId}`;
}

export function decodeDrawOffer(
  customId: string,
): { offererId: string; targetId: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || `${parts[0]}:${parts[1]}` !== CHESS_DRAW) return null;
  return { offererId: parts[2] as string, targetId: parts[3] as string };
}

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("chess")
    .setDescription("Play chess against another player")
    .addSubcommand((s) =>
      s
        .setName("challenge")
        .setDescription("Challenge somebody. You play white")
        .addUserOption((o) => o.setName("player").setDescription("Who").setRequired(true))
        .addIntegerOption((o) =>
          o.setName("stake").setDescription("Coin on the game (default none)").setMinValue(0),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("move")
        .setDescription("Play a move, in coordinates like e2e4")
        .addStringOption((o) =>
          o.setName("move").setDescription("e2e4, or e7e8q to promote").setRequired(true).setMaxLength(10),
        ),
    )
    .addSubcommand((s) => s.setName("board").setDescription("Show the current position"))
    .addSubcommand((s) => s.setName("draw").setDescription("Offer a draw"))
    .addSubcommand((s) => s.setName("resign").setDescription("Resign the game")),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    switch (sub) {
      case "challenge":
        return doChallenge(interaction);
      case "move":
        return doMove(interaction);
      case "board":
        return doBoard(interaction);
      case "draw":
        return doDrawOffer(interaction);
      case "resign":
        return doResign(interaction);
    }
  },
};

type I = ChatInputCommandInteraction;

const NO_CHARACTER = "You have no character yet. `/idlerpg start` makes one.";

async function whisper(interaction: I, content: string): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function doChallenge(interaction: I): Promise<void> {
  const target = interaction.options.getUser("player", true);
  const stake = interaction.options.getInteger("stake") ?? 0;
  const state = world();

  const challenger = find(state, interaction.user.id);
  if (!challenger) return whisper(interaction, NO_CHARACTER);
  if (target.bot || !find(state, target.id)) {
    return whisper(interaction, `${target.username} has no character.`);
  }
  if (target.id === interaction.user.id) return whisper(interaction, "You cannot play yourself.");
  if (gameFor(state, interaction.user.id)) {
    return whisper(interaction, "You are already in a game. Finish or resign it first.");
  }
  if (gameFor(state, target.id)) {
    return whisper(interaction, `${target.username} is already in a game.`);
  }

  await interaction.reply({
    content:
      `<@${target.id}> — **${interaction.user.username}** challenges you to chess` +
      (stake > 0 ? ` for ${coin(stake)}` : "") +
      ".\n_They play white._",
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(encodeChallenge(interaction.user.id, target.id, stake))
          .setLabel("Accept")
          .setEmoji("♟️")
          .setStyle(ButtonStyle.Primary),
      ),
    ],
  });
}

/** Only the challenged player may accept, as with every other wager here. */
export async function handleChallengeButton(
  interaction: ButtonInteraction,
  target: { challengerId: string; targetId: string; stake: number },
): Promise<void> {
  if (interaction.user.id !== target.targetId) {
    await interaction.reply({
      content: "That challenge is not yours to accept.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const state = world();
  const result = startGame(state, target.challengerId, target.targetId, target.stake, ctx());
  if (!result.ok) {
    await interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  save();
  await interaction.update({
    content: describeGame(state, result.value),
    components: [],
  });
}

async function doMove(interaction: I): Promise<void> {
  const state = world();
  const result = play(state, interaction.user.id, interaction.options.getString("move", true), ctx());
  if (!result.ok) return whisper(interaction, result.reason);
  save();

  const v = result.value;
  const nameOf = (id: string) => state.characters[id]?.name ?? "someone";

  if (!v.finished) {
    await interaction.reply(
      [
        `**${interaction.user.username}** played \`${v.san}\`.`,
        describeGame(state, v.game),
      ].join("\n"),
    );
    return;
  }

  const ending =
    v.finished.winnerId === null
      ? `**Draw** by ${v.finished.reason}.`
      : `**${nameOf(v.finished.winnerId)}** wins by ${v.finished.reason}` +
        (v.finished.paid > 0 ? `, and takes ${coin(v.finished.paid)}` : "") +
        ".";

  await interaction.reply([`**${interaction.user.username}** played \`${v.san}\`.`, ending].join("\n"));
}

async function doBoard(interaction: I): Promise<void> {
  const state = world();
  const game = gameFor(state, interaction.user.id);
  if (!game) return whisper(interaction, "You are not in a game.");
  await interaction.reply(describeGame(state, game, interaction.user.id));
}

async function doDrawOffer(interaction: I): Promise<void> {
  const state = world();
  const game = gameFor(state, interaction.user.id);
  if (!game) return whisper(interaction, "You are not in a game.");

  const other = opponentOf(game, interaction.user.id);
  await interaction.reply({
    content: `<@${other}> — **${interaction.user.username}** offers a draw.`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(encodeDrawOffer(interaction.user.id, other))
          .setLabel("Accept the draw")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

export async function handleDrawButton(
  interaction: ButtonInteraction,
  target: { offererId: string; targetId: string },
): Promise<void> {
  if (interaction.user.id !== target.targetId) {
    await interaction.reply({
      content: "That offer is not yours to accept.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const result = agreeDraw(world(), target.targetId);
  if (!result.ok) {
    await interaction.reply({ content: result.reason, flags: MessageFlags.Ephemeral });
    return;
  }
  save();
  await interaction.update({ content: "**Draw agreed.** Stakes go home.", components: [] });
}

async function doResign(interaction: I): Promise<void> {
  const state = world();
  const result = resign(state, interaction.user.id);
  if (!result.ok) return whisper(interaction, result.reason);
  save();

  const nameOf = (id: string) => state.characters[id]?.name ?? "someone";
  await interaction.reply(
    `**${interaction.user.username}** resigns. **${nameOf(result.value.winnerId)}** wins` +
      (result.value.paid > 0 ? `, and takes ${coin(result.value.paid)}` : "") +
      ".",
  );
}
