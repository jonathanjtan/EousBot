import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { REMIND_THRESHOLD } from "../reminders.js";
import { toggleUsageReminder } from "../state.js";
import type { Command } from "./types.js";

/**
 * Toggles a ping when a Claude usage window resets, so somebody blocked by an
 * exhausted window doesn't have to keep running /usage to find out it's back.
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("remindme")
    .setDescription("Toggle a ping when the Claude usage limits reset"),

  async execute(interaction) {
    const subscribed = toggleUsageReminder(interaction.user.id);
    await interaction.reply({
      content: subscribed
        ? `You'll be pinged here when a usage window that was at least ${REMIND_THRESHOLD}% full resets. Run \`/remindme\` again to stop.`
        : "You'll no longer be pinged when the usage limits reset.",
      flags: MessageFlags.Ephemeral,
    });
  },
};
