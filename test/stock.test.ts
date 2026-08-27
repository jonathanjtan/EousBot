import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for the quote parsing and chart building behind /stock.
 *
 * Imported directly rather than through the command module so the suite
 * doesn't pull in src/config.ts, which exits the process on missing
 * environment variables. Nothing here touches the network: the fixtures below
 * reproduce the shapes Yahoo's chart endpoint actually returns, including the
 * null closes it pads untraded bars with and the 200-with-an-error body it
 * answers an unknown ticker with.
 */

const {
  DEFAULT_RANGE,
  MAX_POINTS,
  RANGE_CHOICES,
  axisLabel,
  changeColour,
  chartConfig,
  chartUrl,
  downsample,
  formatChange,
  formatPrice,
  formatRange,
  formatVolume,
  normaliseSymbol,
  parseChart,
  priceChange,
  rangeFor,
} = await import("../src/stock.ts");

/** Market open on 2026-08-05, New York (UTC-4). */
const OPEN = Date.parse("2026-08-05T13:30:00Z") / 1000;

const PAYLOAD = {
  chart: {
    result: [
      {
        meta: {
          currency: "USD",
          symbol: "AAPL",
          exchangeName: "NMS",
          fullExchangeName: "NasdaqGS",
          regularMarketPrice: 311,
          chartPreviousClose: 309.38,
          previousClose: 309.38,
          regularMarketDayHigh: 311.708,
          regularMarketDayLow: 305.67,
          fiftyTwoWeekHigh: 344.57,
          fiftyTwoWeekLow: 205.59,
          regularMarketVolume: 44330978,
          longName: "Apple Inc.",
          shortName: "Apple Inc.",
          gmtoffset: -14400,
        },
        timestamp: [OPEN, OPEN + 300, OPEN + 600, OPEN + 900],
        indicators: {
          quote: [{ close: [309.5, null, 310.25, 311] }],
        },
      },
    ],
    error: null,
  },
};

test("parseChart reads the quote out of meta", () => {
  const result = parseChart(PAYLOAD);
  assert.ok(!("error" in result));
  assert.equal(result.quote.symbol, "AAPL");
  assert.equal(result.quote.name, "Apple Inc.");
  assert.equal(result.quote.currency, "USD");
  assert.equal(result.quote.exchange, "NasdaqGS");
  assert.equal(result.quote.price, 311);
  assert.equal(result.quote.previousClose, 309.38);
  assert.equal(result.quote.fiftyTwoWeekLow, 205.59);
  assert.equal(result.quote.volume, 44330978);
  assert.equal(result.quote.gmtoffset, -14400);
});

test("parseChart drops bars that didn't trade", () => {
  const result = parseChart(PAYLOAD);
  assert.ok(!("error" in result));
  assert.deepEqual(result.series.prices, [309.5, 310.25, 311]);
  assert.deepEqual(result.series.times, [OPEN, OPEN + 600, OPEN + 900]);
});

test("parseChart reports an unknown ticker rather than throwing", () => {
  const result = parseChart({
    chart: {
      result: null,
      error: { code: "Not Found", description: "No data found, symbol may be delisted" },
    },
  });
  assert.deepEqual(result, { error: "No such ticker." });
});

test("parseChart passes on an error it has no wording for", () => {
  const result = parseChart({
    chart: { result: null, error: { code: "Bad Request", description: "Invalid input" } },
  });
  assert.deepEqual(result, { error: "Invalid input" });
});

test("parseChart treats an empty result list as an unknown ticker", () => {
  assert.deepEqual(parseChart({ chart: { result: [], error: null } }), { error: "No such ticker." });
});

test("parseChart rejects a payload that isn't a chart response", () => {
  assert.throws(() => parseChart({ nope: true }), /Unrecognised/);
  assert.throws(() => parseChart("not json at all"), /Unrecognised/);
});

test("parseChart needs a price, series or no series", () => {
  const noPrice = structuredClone(PAYLOAD) as typeof PAYLOAD & {
    chart: { result: [{ meta: { regularMarketPrice: number | null } }] };
  };
  noPrice.chart.result[0].meta.regularMarketPrice = null;
  const result = parseChart(noPrice);
  assert.ok("error" in result);

  const noSeries = { chart: { result: [{ meta: PAYLOAD.chart.result[0].meta }], error: null } };
  const quoteOnly = parseChart(noSeries);
  assert.ok(!("error" in quoteOnly));
  assert.deepEqual(quoteOnly.series.prices, []);
});

test("priceChange measures a period against its first drawn point", () => {
  const result = parseChart(PAYLOAD);
  assert.ok(!("error" in result));
  const { from, delta, percent } = priceChange(result);
  assert.equal(from, 309.5);
  assert.equal(delta.toFixed(2), "1.50");
  assert.equal(percent.toFixed(3), "0.485");
});

test("priceChange falls back to the previous close with nothing drawn", () => {
  const result = parseChart({
    chart: { result: [{ meta: PAYLOAD.chart.result[0].meta }], error: null },
  });
  assert.ok(!("error" in result));
  assert.equal(priceChange(result).from, 309.38);
});

test("normaliseSymbol accepts the punctuation Yahoo symbols use", () => {
  assert.equal(normaliseSymbol(" aapl "), "AAPL");
  assert.equal(normaliseSymbol("brk-b"), "BRK-B");
  assert.equal(normaliseSymbol("^gspc"), "^GSPC");
  assert.equal(normaliseSymbol("7203.T"), "7203.T");
  assert.equal(normaliseSymbol("EURUSD=X"), "EURUSD=X");
});

test("normaliseSymbol rejects anything else", () => {
  assert.equal(normaliseSymbol(""), null);
  assert.equal(normaliseSymbol("   "), null);
  assert.equal(normaliseSymbol("AAPL/../secrets"), null);
  assert.equal(normaliseSymbol("AA PL"), null);
  assert.equal(normaliseSymbol("A".repeat(21)), null);
});

test("rangeFor covers every offered period and defaults to 1D", () => {
  assert.deepEqual(
    RANGE_CHOICES.map((choice) => choice.label),
    ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "Max"],
  );
  assert.equal(rangeFor(null).value, DEFAULT_RANGE);
  assert.equal(rangeFor("nonsense").value, DEFAULT_RANGE);
  assert.equal(rangeFor("ytd").label, "YTD");
  assert.equal(rangeFor("5y").interval, "1wk");
});

test("chartUrl asks Yahoo for the chosen period", () => {
  const url = new URL(chartUrl("^GSPC", rangeFor("6mo")));
  assert.equal(url.pathname, "/v8/finance/chart/%5EGSPC");
  assert.equal(url.searchParams.get("range"), "6mo");
  assert.equal(url.searchParams.get("interval"), "1d");
});

test("downsample keeps both ends and the point cap", () => {
  const count = 1000;
  const series = {
    times: Array.from({ length: count }, (_, i) => OPEN + i * 60),
    prices: Array.from({ length: count }, (_, i) => i),
  };
  const thinned = downsample(series);
  assert.equal(thinned.prices.length, MAX_POINTS);
  assert.equal(thinned.prices[0], 0);
  assert.equal(thinned.prices.at(-1), count - 1);
  assert.equal(thinned.times[0], series.times[0]);
  assert.equal(thinned.times.at(-1), series.times.at(-1));
});

test("downsample leaves a short series alone", () => {
  const series = { times: [OPEN, OPEN + 60], prices: [1, 2] };
  assert.equal(downsample(series), series);
});

test("axisLabel reads in exchange-local time", () => {
  // 13:30 UTC is 09:30 in New York, where the bell rings.
  assert.equal(axisLabel(OPEN, -14400, true), "09:30");
  assert.equal(axisLabel(OPEN, -14400, false), "Aug 5, 26");
  assert.equal(axisLabel(OPEN, 32400, true), "22:30");
});

test("formatChange states the direction and the sign", () => {
  assert.equal(formatChange(1.5, 0.4849, "USD"), "▲ +$1.50 (+0.48%)");
  assert.equal(formatChange(-1.5, -0.4849, "USD"), "▼ -$1.50 (-0.48%)");
  assert.equal(formatChange(0, 0, "USD"), "▬ $0.00 (0.00%)");
});

test("formatPrice uses the instrument's currency and copes without one", () => {
  assert.equal(formatPrice(311, "USD"), "$311.00");
  assert.equal(formatPrice(311, "JPY"), "¥311.00");
  assert.equal(formatPrice(311, null), "311.00");
  assert.equal(formatPrice(311, "NOTACURRENCY"), "311.00");
  // Sub-dollar instruments would round to nothing at two places.
  assert.equal(formatPrice(0.00004321, "USD"), "$0.000043");
});

test("formatRange needs both ends", () => {
  assert.equal(formatRange(1, 2, "USD"), "$1.00 to $2.00");
  assert.equal(formatRange(null, 2, "USD"), null);
  assert.equal(formatRange(1, null, "USD"), null);
});

test("formatVolume keeps share counts short", () => {
  assert.equal(formatVolume(44330978), "44.33M");
  assert.equal(formatVolume(1200), "1.2K");
});

test("changeColour is green up, red down, grey flat", () => {
  assert.equal(changeColour(1), 0x3fb950);
  assert.equal(changeColour(-1), 0xf85149);
  assert.equal(changeColour(0), 0x8b949e);
});

interface RenderedChart {
  data: { labels: string[]; datasets: { data: number[]; borderDash?: number[] }[] };
}

test("chartConfig draws one labelled line, with a 1D previous-close baseline", () => {
  const result = parseChart(PAYLOAD);
  assert.ok(!("error" in result));

  const day = chartConfig(result, rangeFor("1d")) as RenderedChart;
  assert.deepEqual(day.data.labels, ["09:30", "09:40", "09:45"]);
  assert.deepEqual(day.data.datasets[0]?.data, [309.5, 310.25, 311]);
  assert.deepEqual(day.data.datasets[1]?.data, [309.38, 309.38, 309.38]);
  assert.deepEqual(day.data.datasets[1]?.borderDash, [6, 4]);

  // Over a longer period the previous close isn't where the line starts, so
  // there's nothing to compare against.
  const year = chartConfig(result, rangeFor("1y")) as RenderedChart;
  assert.equal(year.data.datasets.length, 1);
  assert.deepEqual(year.data.labels, ["Aug 5, 26", "Aug 5, 26", "Aug 5, 26"]);
});
