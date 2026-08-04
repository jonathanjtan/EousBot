import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { formatRoll, parseDiceNotation, rollDice } from "../dice.js";
import type { Command } from "./types.js";

/** Rolls dice from standard notation. Open to everyone in the guild. */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("roll")
    .setDescription("Roll dice using standard notation")
    .addStringOption((o) =>
      o
        .setName("notation")
        .setDescription("Dice to roll, e.g. 'd20', '2d6+3', '4d6-1'")
        .setRequired(true)
        .setMaxLength(32),
    ),

  async execute(interaction) {
    const notation = interaction.options.getString("notation", true);

    const parsed = parseDiceNotation(notation);
    if (!parsed.ok) {
      // The user's own mistake, so keep it out of everyone else's channel.
      await interaction.reply({ content: parsed.error, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply(formatRoll(rollDice(parsed.spec)));
  },
};
