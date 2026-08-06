import { AttachmentBuilder, EmbedBuilder, MessageFlags, SlashCommandBuilder } from "discord.js";
import { log } from "../log.js";
import {
  DEFAULT_RANGE,
  RANGE_CHOICES,
  changeColour,
  chartConfig,
  fetchChart,
  formatChange,
  formatPrice,
  formatRange,
  formatVolume,
  normaliseSymbol,
  priceChange,
  rangeFor,
  renderChart,
} from "../stock.js";
import type { Command } from "./types.js";

/**
 * Quotes a ticker with a price chart over a chosen period. Open to everyone in
 * the guild -- it reads public market data and takes no action on anyone's
 * behalf.
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("stock")
    .setDescription("Show a ticker's price, key figures and a chart")
    .addStringOption((o) =>
      o
        .setName("ticker")
        .setDescription("Ticker symbol, e.g. 'AAPL', 'BRK-B', '^GSPC', 'BTC-USD'")
        .setRequired(true)
        .setMaxLength(20),
    )
    .addStringOption((o) =>
      o
        .setName("range")
        .setDescription(`Period to chart (default ${DEFAULT_RANGE.toUpperCase()})`)
        .addChoices(...RANGE_CHOICES.map(({ label, value }) => ({ name: label, value })))
        .setRequired(false),
    ),

  async execute(interaction) {
    const raw = interaction.options.getString("ticker", true);
    const choice = rangeFor(interaction.options.getString("range"));

    const symbol = normaliseSymbol(raw);
    if (symbol === null) {
      // The user's own typo, so keep it out of everyone else's channel.
      await interaction.reply({
        content: `\`${raw.slice(0, 40)}\` isn't a ticker symbol.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Two round trips -- Yahoo for the numbers, QuickChart for the picture --
    // so the three seconds Discord allows for a reply are not enough.
    await interaction.deferReply();

    let result;
    try {
      result = await fetchChart(symbol, choice);
    } catch (err) {
      log.warn("Could not reach Yahoo Finance", { symbol, err });
      await interaction.editReply("Couldn't reach Yahoo Finance just now.");
      return;
    }

    if ("error" in result) {
      await interaction.editReply(`${result.error} (\`${symbol}\`)`);
      return;
    }

    const { quote, series } = result;
    const { delta, percent } = priceChange(result);
    const currency = quote.currency;

    const fields = [
      {
        name: `${choice.label} change`,
        value: formatChange(delta, percent, currency),
        inline: true,
      },
      { name: "Day range", value: formatRange(quote.dayLow, quote.dayHigh, currency), inline: true },
      {
        name: "52-week range",
        value: formatRange(quote.fiftyTwoWeekLow, quote.fiftyTwoWeekHigh, currency),
        inline: true,
      },
      {
        name: "Previous close",
        value: quote.previousClose === null ? null : formatPrice(quote.previousClose, currency),
        inline: true,
      },
      {
        name: "Volume",
        value: quote.volume === null ? null : formatVolume(quote.volume),
        inline: true,
      },
    ].filter((field): field is { name: string; value: string; inline: boolean } => {
      return field.value !== null;
    });

    const embed = new EmbedBuilder()
      .setColor(changeColour(delta))
      .setTitle(`${quote.symbol || symbol} · ${formatPrice(quote.price, currency)}`)
      .setURL(`https://finance.yahoo.com/quote/${encodeURIComponent(quote.symbol || symbol)}`)
      .addFields(fields)
      .setFooter({
        text: [quote.name, quote.exchange, "Yahoo Finance"].filter((part) => part).join(" · "),
      });

    const files: AttachmentBuilder[] = [];
    // A chart needs two points to be a line; below that the numbers stand
    // alone rather than the reply failing.
    if (series.prices.length >= 2) {
      try {
        const png = await renderChart(chartConfig(result, choice));
        files.push(new AttachmentBuilder(png, { name: "chart.png" }));
        embed.setImage("attachment://chart.png");
      } catch (err) {
        log.warn("Could not render the price chart; replying without it", { symbol, err });
      }
    }

    await interaction.editReply({ embeds: [embed], files });
  },
};
