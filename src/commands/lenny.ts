import { SlashCommandBuilder } from "discord.js";
import { LENNY, formatFace, pickFace } from "../lenny.js";
import type { Command } from "./types.js";

/** Posts a Lenny face. Open to everyone in the guild. */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("lenny")
    .setDescription("Post ( ͡° ͜ʖ ͡°)")
    .addBooleanOption((o) =>
      o
        .setName("random")
        .setDescription("Post a random face instead of the classic one")
        .setRequired(false),
    ),

  async execute(interaction) {
    const random = interaction.options.getBoolean("random") ?? false;
    await interaction.reply(formatFace(random ? pickFace() : LENNY));
  },
};
