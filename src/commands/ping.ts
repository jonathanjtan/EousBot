import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { currentSha } from "../git.js";
import type { Command } from "./types.js";

/**
 * Health check that also reports which commit is running -- the fastest way to
 * confirm a self-deploy actually took effect.
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check that the bot is alive and see which commit it's running"),

  async execute(interaction) {
    const sha = await currentSha().catch(() => "unknown");
    const uptimeSec = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);

    await interaction.reply({
      content: [
        `Alive. Latency \`${Math.round(interaction.client.ws.ping)}ms\`.`,
        `Running \`${sha.slice(0, 8)}\`, up ${hours}h ${minutes}m.`,
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    });
  },
};
