import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  type ButtonInteraction,
  type InteractionEditReplyOptions,
} from "discord.js";
import { log } from "../log.js";
import { GAMES, activeCodesFor, codePages, gamesFor } from "../redeem.js";
import type { Command } from "./types.js";

/** `codes:page:<game>:<index>`, where `<game>` is an option value or "all". */
export const CODES_PREFIX = "codes:page";

export function encodeCodesPage(game: string | null, page: number): string {
  return `${CODES_PREFIX}:${game ?? "all"}:${page}`;
}

export function decodeCodesPage(customId: string): { game: string | null; page: number } | null {
  const parts = customId.split(":");
  if (parts.length !== 4 || `${parts[0]}:${parts[1]}` !== CODES_PREFIX) return null;
  const page = Number(parts[3]);
  if (!Number.isInteger(page) || page < 0) return null;
  return { game: parts[2] === "all" ? null : parts[2]!, page };
}

/** Previous and next, or no buttons at all when the list fits one page. */
function pageButtons(
  game: string | null,
  index: number,
  count: number,
): ActionRowBuilder<ButtonBuilder>[] {
  if (count <= 1) return [];

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(encodeCodesPage(game, Math.max(index - 1, 0)))
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(index === 0),
      new ButtonBuilder()
        .setCustomId(encodeCodesPage(game, index + 1))
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(index === count - 1),
    ),
  ];
}

/**
 * One page of the list, as Discord takes it.
 *
 * The lists are read again on every page turn rather than the pages being kept
 * in memory. This bot redeploys itself, and pages held in a process that has
 * gone away leave buttons on screen that answer nothing. The cost is a round
 * trip per turn, which is what the command already spends to say anything at
 * all. A page number that no longer exists -- the lists change under a message
 * that stays up for days -- lands on the nearest one that does.
 */
async function renderPage(
  game: string | null,
  page: number,
): Promise<InteractionEditReplyOptions> {
  const listed = await activeCodesFor(gamesFor(game));
  for (const entry of listed) {
    if (entry.error !== null) {
      log.warn("Could not read the published gift codes", {
        game: entry.game.name,
        err: entry.error,
      });
    }
  }

  if (listed.every((entry) => entry.error !== null)) {
    return { content: "Couldn't reach the gift code list just now.", embeds: [], components: [] };
  }

  const pages = codePages(listed);
  const index = Math.min(page, pages.length - 1);
  const total = listed.reduce((count, entry) => count + entry.codes.length, 0);

  const embed = new EmbedBuilder()
    .setColor(total > 0 ? 0x2f9e44 : 0xe0a458)
    .setTitle(total === 1 ? "1 live gift code" : `${total} live gift codes`)
    .setDescription(
      total > 0
        ? "Click a code to open its redemption page with the box filled in. You still have to be logged in."
        : "Nothing live on these lists right now.",
    )
    .addFields(pages[index]!)
    .setFooter({
      text:
        (pages.length > 1 ? `Page ${index + 1} of ${pages.length} · ` : "") +
        "Unofficial list from hoyo-codes.seria.moe; codes expire without notice",
    });

  return { embeds: [embed], components: pageButtons(game, index, pages.length) };
}

/**
 * Turns the page.
 *
 * Open to anyone who can see the message. Nothing here is privileged: the list
 * is public, and the buttons show a different part of the same reply.
 */
export async function handleCodesPage(
  interaction: ButtonInteraction,
  target: { game: string | null; page: number },
): Promise<void> {
  // Reading the lists again outlasts the three seconds Discord allows for a
  // response, and deferUpdate leaves the current page up while it happens.
  await interaction.deferUpdate();
  await interaction.editReply(await renderPage(target.game, target.page));
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
    const game = interaction.options.getString("game");

    // A round trip per game, so the three seconds Discord allows for a reply
    // are not enough.
    await interaction.deferReply();

    await interaction.editReply(await renderPage(game, 0));
  },
};
