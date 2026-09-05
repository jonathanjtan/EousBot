import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { log } from "../log.js";
import { GAMES, activeCodesFor, codeLines, gamesFor } from "../redeem.js";
import type { GameCodes } from "../redeem.js";
import type { Command } from "./types.js";

/** Discord's cap on an embed field's value. */
const FIELD_LIMIT = 1024;

/** The line a game with nothing live, or nothing readable, gets instead. */
function emptyField(entry: GameCodes): string {
  return entry.error === null ? "No live codes right now." : "List unavailable just now.";
}

/**
 * Lists the HoYoverse gift codes that are currently live, each one already a
 * link that fills the redemption box in. Open to everyone in the guild -- it
 * reads a public list and builds URLs.
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("codes")
    .setDescription("List the live Genshin, Star Rail and Zenless gift codes as redemption links")
    .addStringOption((o) =>
      o
        .setName("game")
        .setDescription("Only one game's codes (default all three)")
        .addChoices(...GAMES.map(({ name, value }) => ({ name, value })))
        .setRequired(false),
    ),

  async execute(interaction) {
    const games = gamesFor(interaction.options.getString("game"));

    // A round trip per game, so the three seconds Discord allows for a reply
    // are not enough.
    await interaction.deferReply();

    const listed = await activeCodesFor(games);
    for (const entry of listed) {
      if (entry.error !== null) {
        log.warn("Could not read the published gift codes", {
          game: entry.game.name,
          err: entry.error,
        });
      }
    }

    if (listed.every((entry) => entry.error !== null)) {
      await interaction.editReply("Couldn't reach the gift code list just now.");
      return;
    }

    const total = listed.reduce((count, entry) => count + entry.codes.length, 0);
    const embed = new EmbedBuilder()
      .setColor(total > 0 ? 0x2f9e44 : 0xe0a458)
      .setTitle(total === 1 ? "1 live gift code" : `${total} live gift codes`)
      .setDescription(
        total > 0
          ? "Click a code to open its redemption page with the box filled in. You still have to be logged in."
          : "Nothing live on these lists right now.",
      )
      .addFields(
        listed.map((entry) => ({
          name: entry.game.name,
          value:
            entry.codes.length > 0
              ? codeLines(entry.game, entry.codes, FIELD_LIMIT)
              : emptyField(entry),
        })),
      )
      .setFooter({ text: "Unofficial list from hoyo-codes.seria.moe; codes expire without notice" });

    await interaction.editReply({ embeds: [embed] });
  },
};
