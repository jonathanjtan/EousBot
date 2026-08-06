import { SlashCommandBuilder } from "discord.js";
import { currentSha } from "../git.js";
import type { Command } from "./types.js";

/** Interaction tokens die after 15 minutes; stay well clear of that. */
const MAX_DELAY_SEC = 600;

/**
 * Health check that also reports which commit is running -- the fastest way to
 * confirm a self-deploy actually took effect. The optional delay exists so
 * somebody can test whether a notification actually reaches them after they've
 * tabbed away.
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check that the bot is alive and see which commit it's running")
    .addIntegerOption((o) =>
      o
        .setName("delay")
        .setDescription(`Seconds to wait before replying (0-${MAX_DELAY_SEC}, default 0)`)
        .setMinValue(0)
        .setMaxValue(MAX_DELAY_SEC)
        .setRequired(false),
    ),

  async execute(interaction) {
    const delaySec = interaction.options.getInteger("delay") ?? 0;
    const sha = await currentSha().catch(() => "unknown");
    const uptimeSec = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);

    const report = [
      `${interaction.user} Alive. Latency \`${Math.round(interaction.client.ws.ping)}ms\`.`,
      `Running \`${sha.slice(0, 8)}\`, up ${hours}h ${minutes}m.`,
    ].join("\n");

    if (delaySec === 0) {
      await interaction.reply(report);
      return;
    }

    // Deferring holds the interaction open, but the ping has to land as a fresh
    // message -- editing a deferred reply doesn't reliably notify anyone.
    await interaction.deferReply();
    await interaction.editReply(`Pinging you in ${delaySec}s...`);
    await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
    await interaction.followUp(report);
  },
};
