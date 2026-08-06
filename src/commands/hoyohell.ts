import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import {
  DEFAULT_COUNT,
  GAME_CHOICES,
  MAX_COUNT,
  eventFields,
  expiringSoonest,
  feedsFor,
  fetchEvents,
  urgencyColour,
} from "../hoyo.js";
import { log } from "../log.js";
import type { Command } from "./types.js";

/** The game's full name, for the line under the title. */
function fullName(label: string): string {
  return GAME_CHOICES.find((game) => game.label === label)?.name ?? label;
}

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
    )
    .addStringOption((o) =>
      o
        .setName("game")
        .setDescription("Only one game's events (default all three)")
        .addChoices(...GAME_CHOICES.map(({ name, value }) => ({ name, value })))
        .setRequired(false),
    )
    .addBooleanOption((o) =>
      o
        .setName("rewards")
        .setDescription("Only events whose announcement states a gem count (default true)")
        .setRequired(false),
    ),

  async execute(interaction) {
    const count = interaction.options.getInteger("count") ?? DEFAULT_COUNT;
    const feeds = feedsFor(interaction.options.getString("game"));
    const rewardsOnly = interaction.options.getBoolean("rewards") ?? true;

    // A round trip to HoYoverse per game, so the three seconds Discord allows
    // for a reply are not enough.
    await interaction.deferReply();

    const { events, failures, rewardFailures } = await fetchEvents(feeds);
    for (const failure of failures) {
      log.warn("Could not read HoYoverse announcements", {
        game: failure.game,
        err: failure.error,
      });
    }
    for (const failure of rewardFailures) {
      log.warn("Could not read HoYoverse announcement bodies; listing without gem counts", {
        game: failure.game,
        err: failure.error,
      });
    }

    if (failures.length === feeds.length) {
      await interaction.editReply("Couldn't reach any of the HoYoverse notice boards just now.");
      return;
    }

    const now = Date.now();
    const soonest = expiringSoonest(events, now, count, rewardsOnly);
    if (soonest.length === 0) {
      // An empty default list usually means things are running but none of
      // them printed a figure, which is a different answer from "nothing is
      // on" and needs to point at the way to see them.
      const hidden = rewardsOnly && expiringSoonest(events, now, 1, false).length > 0;
      await interaction.editReply(
        hidden
          ? "Nothing running right now says how many gems it pays. Pass `rewards: False` to see everything that's on."
          : "Nothing limited-time is running right now. Enjoy the lull.",
      );
      return;
    }

    const listed = feeds.map((feed) => fullName(feed.label)).join(", ");
    const missing = failures.map((f) => f.game);
    // Which of the two lists this is has to be said either way: under the
    // default a short list means announcements that named no figure rather
    // than a quiet week, and without it nobody should read a missing count as
    // a claim that the event pays nothing.
    const gems = rewardsOnly
      ? "only events that state a gem count"
      : soonest.some((event) => event.gems !== null)
        ? "gem counts where the announcement gives one"
        : null;

    const footer = [
      "Asia server times, from the in-game announcements",
      gems,
      missing.length > 0 ? `${missing.join(" and ")} unavailable` : null,
    ]
      .filter((part) => part !== null)
      .join(" · ");

    const embed = new EmbedBuilder()
      .setColor(urgencyColour(soonest, now))
      .setTitle(`The ${soonest.length} events expiring soonest`)
      .setDescription(`${listed}, least time left first.`)
      .addFields(eventFields(soonest))
      .setFooter({ text: footer });

    await interaction.editReply({ embeds: [embed] });
  },
};
