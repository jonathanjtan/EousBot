import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { log } from "../log.js";
import { GAMES, gameFor, identifyGame, normaliseCode, redeemUrl } from "../redeem.js";
import type { RedeemGame } from "../redeem.js";
import type { Command } from "./types.js";

/** One game's line: the name, then the link with the code already in it. */
function link(game: RedeemGame, code: string): string {
  return `${game.name} · ${redeemUrl(game, code)}`;
}

/**
 * Turns a HoYoverse gift code into the link that redeems it, working out which
 * game it belongs to when the option is left off. Open to everyone in the
 * guild -- it builds a URL and reads a public list.
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("code")
    .setDescription("Build the redemption link for a Genshin, Star Rail or Zenless gift code")
    .addStringOption((o) =>
      o
        .setName("code")
        .setDescription("The gift code, e.g. 'GENSHINGIFT'")
        .setRequired(true)
        .setMaxLength(40),
    )
    .addStringOption((o) =>
      o
        .setName("game")
        .setDescription("Which game it's for (default: worked out from the code)")
        .addChoices(...GAMES.map(({ name, value }) => ({ name, value })))
        .setRequired(false),
    ),

  async execute(interaction) {
    const raw = interaction.options.getString("code", true);
    const code = normaliseCode(raw);
    if (code === null) {
      // The user's own typo, so keep it out of everyone else's channel.
      await interaction.reply({
        content: `\`${raw.slice(0, 40)}\` isn't a gift code.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const chosen = gameFor(interaction.options.getString("game"));
    if (chosen !== null) {
      await interaction.reply(link(chosen, code));
      return;
    }

    // Working the game out is a request per game, so the three seconds Discord
    // allows for a reply are not enough.
    await interaction.deferReply();

    const { game, failures } = await identifyGame(code);
    for (const failure of failures) {
      log.warn("Could not read the published gift codes", {
        game: failure.game,
        err: failure.error,
      });
    }

    if (game !== null) {
      await interaction.editReply(link(game, code));
      return;
    }

    // Three link previews would bury the links themselves, so this one goes
    // out plain.
    await interaction.editReply({
      content: [
        `Can't tell which game \`${code}\` is for. Take your pick:`,
        ...GAMES.map((each) => link(each, code)),
      ].join("\n"),
      flags: MessageFlags.SuppressEmbeds,
    });
  },
};
