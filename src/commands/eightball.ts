import { SlashCommandBuilder } from "discord.js";
import { MAX_QUESTION_LENGTH, formatAnswer, pickAnswer } from "../eightball.js";
import type { Command } from "./types.js";

/** Shakes the Magic 8-Ball. Open to everyone in the guild. */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("8ball")
    .setDescription("Ask the Magic 8-Ball a yes-or-no question")
    .addStringOption((o) =>
      o
        .setName("question")
        .setDescription("What you want to ask, e.g. 'will it rain tomorrow?'")
        .setRequired(true)
        .setMaxLength(MAX_QUESTION_LENGTH),
    ),

  async execute(interaction) {
    const question = interaction.options.getString("question", true);
    await interaction.reply(formatAnswer(question, pickAnswer()));
  },
};
