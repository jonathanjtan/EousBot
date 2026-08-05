import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { fetchUsage } from "../agent.js";
import { log } from "../log.js";
import { describePlan, formatWindow, usageColour } from "../usage.js";
import type { Command } from "./types.js";

/**
 * Reports the Claude plan limits the build agent is running against, so a
 * stalled or refused build can be told apart from an exhausted weekly window.
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("usage")
    .setDescription("Show how much of the Claude usage limits this bot has burned through"),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      const snapshot = await fetchUsage();

      const embed = new EmbedBuilder()
        .setColor(usageColour(snapshot.windows))
        .setTitle("Claude usage limits")
        .setDescription(describePlan(snapshot));

      if (snapshot.windows.length === 0) {
        embed.addFields({
          name: "No windows reported",
          value: "The API returned no rate-limit windows for this account.",
        });
      } else {
        embed.addFields(
          snapshot.windows.map((w) => ({ name: w.label, value: formatWindow(w) })),
        );
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      log.error("Failed to read Claude usage", { err: String(err) });
      await interaction.editReply("Couldn't read Claude usage limits just now.");
    }
  },
};
