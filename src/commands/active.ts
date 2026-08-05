import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { effectiveVisibility, isActive, setActive } from "../active.js";
import { config } from "../config.js";
import type { Command } from "./types.js";

/**
 * Toggles active mode: "I'm around, make builds steerable".
 *
 * On, builds open the Remote Control bridge so a run can be steered from the
 * Claude app instead of being watched helplessly through Discord progress
 * text. docs/usage.md puts steering mid-flight as the last lever precisely
 * because it is the interactive session's real advantage and it was already
 * available -- just off, and awkward to turn on for one build.
 *
 * It is a toggle rather than a permanent setting because it uploads session
 * transcripts to claude.ai, which is the wrong default for unattended runs
 * nobody is looking at.
 */
export const command: Command = {
  adminOnly: true,
  data: new SlashCommandBuilder()
    .setName("active")
    .setDescription("Make builds steerable from the Claude app while you're around (admin only)")
    .addStringOption((o) =>
      o
        .setName("state")
        .setDescription("Turn it on or off; omit to see where it stands")
        .setRequired(false)
        .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }),
    ),

  async execute(interaction) {
    const state = interaction.options.getString("state");

    if (state === null) {
      await interaction.reply({
        content: [
          `Active mode is **${isActive() ? "on" : "off"}**.`,
          `Sessions are currently \`${effectiveVisibility()}\` (configured default: \`${config.agent.sessionVisibility}\`).`,
          isActive()
            ? "Builds open the Remote Control bridge — steer them from the Claude app's Code tab."
            : "Builds run unattended. `/active state:on` if you want to watch and steer one.",
        ].join("\n"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const on = state === "on";

    // Active mode can only raise visibility. Someone who set `off` wants
    // nothing leaving the box, and a convenience toggle shouldn't override it.
    if (on && config.agent.sessionVisibility === "off") {
      await interaction.reply({
        content:
          "`AGENT_SESSION_VISIBILITY=off` keeps everything on the box, and this toggle won't override that. Change it in `.env` if you want steerable builds.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    setActive(on);

    await interaction.reply({
      content: on
        ? [
            "Active mode **on**. New builds open the Remote Control bridge — pair from the Claude app's Code tab to steer one mid-run.",
            "`/stop` interrupts a run from here. Turn this off when you step away; it uploads session transcripts.",
          ].join("\n")
        : "Active mode **off**. Builds run unattended again.",
      flags: MessageFlags.Ephemeral,
    });
  },
};
