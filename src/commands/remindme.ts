import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { fetchUsage } from "../agent.js";
import { log } from "../log.js";
import { REMIND_THRESHOLD, nextResetAt } from "../reminders.js";
import { readResetMemory, toggleUsageReminder } from "../state.js";
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

    if (!subscribed) {
      await interaction.reply({
        content: "You'll no longer be pinged when the usage limits reset.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Subscribing is itself a reason to read the limits: fetchUsage memoizes
    // the reset times, which both arms the reminder and lets this reply say
    // when it will land. A failure costs the answer, not the subscription.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await fetchUsage();
    } catch (err) {
      log.warn("Could not read usage while subscribing to reset reminders", {
        err: String(err),
      });
    }

    const at = nextResetAt(readResetMemory());
    const when =
      at === null
        ? `Nothing is near its limit right now — you'll be pinged the next time a window that's at least ${REMIND_THRESHOLD}% full rolls over.`
        : `Next ping <t:${Math.floor(at / 1000)}:R>, when the fullest window resets.`;

    await interaction.editReply(`${when} Run \`/remindme\` again to stop.`);
  },
};
