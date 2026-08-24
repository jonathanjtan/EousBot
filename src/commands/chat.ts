import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { EFFORT_CHOICES, MODEL_CHOICES, parseEffort, parseModel } from "../agentopts.js";
import { chatSettings, conversationStatus, resetConversation, setChatSetting } from "../chat.js";
import { config } from "../config.js";
import type { Command } from "./types.js";

/**
 * Controls for the conversational agent.
 *
 * These exist because the session is invisible otherwise. Mentioning the bot
 * resumes whatever transcript the channel has accumulated, and resuming
 * replays all of it on every turn -- so a channel that has been chatting all
 * afternoon is quietly paying more per question than one that just started,
 * with nothing on screen to say so. `status` makes that legible and `reset`
 * makes it fixable.
 *
 * Model and effort are per channel rather than per question for the same
 * reason `/claude` takes them per build: prose is a bad place to pick one, and
 * a setting you can see beats a flag you have to remember.
 */

/** Reads as a duration a person would say out loud. */
function humanise(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const command: Command = {
  adminOnly: true,
  data: new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Control the conversational agent in this channel (admin only)")
    .addSubcommand((s) =>
      s.setName("status").setDescription("What this channel's session is currently carrying"),
    )
    .addSubcommand((s) =>
      s.setName("reset").setDescription("Forget this channel's conversation and delete its files"),
    )
    .addSubcommand((s) =>
      s
        .setName("model")
        .setDescription("Set the model for this channel")
        .addStringOption((o) =>
          o
            .setName("model")
            .setDescription("Leave empty to go back to the configured default")
            .addChoices(...MODEL_CHOICES),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("effort")
        .setDescription("Set the reasoning effort for this channel")
        .addStringOption((o) =>
          o
            .setName("effort")
            .setDescription("Leave empty to go back to the configured default")
            .addChoices(...EFFORT_CHOICES),
        ),
    ),

  async execute(interaction) {
    const key = interaction.channelId;
    const sub = interaction.options.getSubcommand();

    if (sub === "reset") {
      const had = await resetConversation(key);
      await interaction.reply(
        had
          ? "Cleared. Next mention starts a fresh session with an empty workspace."
          : "Nothing to clear, this channel has no session.",
      );
      return;
    }

    if (sub === "model" || sub === "effort") {
      const raw = interaction.options.getString(sub);
      // Discord validated the choice, so an unparseable value can only be the
      // empty option, which is how you ask for the default back.
      const value = sub === "model" ? parseModel(raw) : parseEffort(raw);
      setChatSetting(key, { [sub]: value ?? null });

      const now = chatSettings(key);
      await interaction.reply(
        value
          ? `Chat ${sub} for this channel is now \`${value}\`.`
          : `Chat ${sub} reset to the configured default, \`${sub === "model" ? now.model : now.effort}\`.`,
      );
      return;
    }

    const status = conversationStatus(key);
    const { model, effort } = chatSettings(key);

    if (!status) {
      await interaction.reply({
        content: `No session in this channel. Next mention starts one on \`${model}\`, ${effort} effort.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply(
      [
        `Session: **${status.turns}** turns, started ${humanise(status.ageMs)} ago, idle ${humanise(status.idleMs)}.`,
        `Model \`${model}\`, ${effort} effort.`,
        `Rolls over at ${config.chat.sessionMaxTurns} turns or ${humanise(config.chat.sessionMaxAgeMs)}, whichever comes first.`,
        `Files live in \`${status.dir}\` until then.`,
      ].join("\n"),
    );
  },
};
