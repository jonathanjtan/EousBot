import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import {
  DEFAULT_COUNT,
  GAMES,
  MAX_COUNT,
  eventFields,
  expiringSoonest,
  fetchEvents,
  urgencyColour,
} from "../hoyo.js";
import { log } from "../log.js";
import type { Command } from "./types.js";

/**
 * Lists the HoYoverse limited-time events closest to expiring, so the daily
 * question of what to clear first has an answer that isn't three notice
 * boards. Open to everyone in the guild.
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("hoyohell")
    .setDescription("Show the HoYoverse limited-time events expiring soonest")
    .addIntegerOption((o) =>
      o
        .setName("count")
        .setDescription(`How many events to list (default ${DEFAULT_COUNT})`)
        .setMinValue(1)
        .setMaxValue(MAX_COUNT)
        .setRequired(false),
    ),

  async execute(interaction) {
    const count = interaction.options.getInteger("count") ?? DEFAULT_COUNT;

    // Three round trips to HoYoverse, so the three seconds Discord allows for
    // a reply are not enough.
    await interaction.deferReply();

    const { events, failures } = await fetchEvents();
    for (const failure of failures) {
      log.warn("Could not read HoYoverse announcements", {
        game: failure.game,
        err: failure.error,
      });
    }

    if (failures.length === GAMES.length) {
      await interaction.editReply("Couldn't reach any of the HoYoverse notice boards just now.");
      return;
    }

    const now = Date.now();
    const soonest = expiringSoonest(events, now, count);
    if (soonest.length === 0) {
      await interaction.editReply("Nothing limited-time is running right now. Enjoy the lull.");
      return;
    }

    const missing = failures.map((f) => f.game);
    const footer = [
      "Asia server times, from the in-game announcements",
      missing.length > 0 ? `${missing.join(" and ")} unavailable` : null,
    ]
      .filter((part) => part !== null)
      .join(" · ");

    const embed = new EmbedBuilder()
      .setColor(urgencyColour(soonest, now))
      .setTitle(`The ${soonest.length} events expiring soonest`)
      .setDescription(
        "Genshin Impact, Honkai: Star Rail and Zenless Zone Zero, least time left first.",
      )
      .addFields(eventFields(soonest))
      .setFooter({ text: footer });

    await interaction.editReply({ embeds: [embed] });
  },
};
