import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { createFeatureRequest } from "../github.js";
import { log } from "../log.js";
import type { Command } from "./types.js";

/** Files a feature request as a GitHub issue. Open to everyone in the guild. */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("request")
    .setDescription("File a feature request for the bot to build")
    .addStringOption((o) =>
      o
        .setName("title")
        .setDescription("Short summary, e.g. 'add a /roll command for dice'")
        .setRequired(true)
        .setMaxLength(120),
    )
    .addStringOption((o) =>
      o
        .setName("details")
        .setDescription("What it should do, edge cases, how you'd use it")
        .setRequired(true)
        .setMaxLength(3000),
    ),

  async execute(interaction) {
    const title = interaction.options.getString("title", true);
    const details = interaction.options.getString("details", true);

    await interaction.deferReply();

    try {
      const issue = await createFeatureRequest({
        title,
        description: details,
        discordUserId: interaction.user.id,
        discordUsername: interaction.user.username,
      });

      const embed = new EmbedBuilder()
        .setColor(0x0e8a16)
        .setTitle(`#${issue.number}: ${issue.title}`)
        .setURL(issue.url)
        .setDescription(details.length > 400 ? `${details.slice(0, 400)}…` : details)
        .setFooter({ text: `Filed by ${interaction.user.username} · /claude ${issue.number} to start` });

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      log.error("Failed to file request", { err: String(err) });
      await interaction.editReply(
        "Couldn't file that request. GitHub rejected it, so check the bot's token scopes.",
      );
    }
  },
};
