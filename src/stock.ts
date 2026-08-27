/**
 * Prices and price history behind /stock.
 *
 * Yahoo Finance's chart endpoint is the source: it is unauthenticated, it
 * answers for equities, ETFs, indices, futures and crypto pairs under the same
 * symbol scheme, and one call returns both the current quote (in `meta`) and
 * the series to draw. The alternatives all wanted something we don't have --
 * Yahoo's own `v7/finance/quote` now demands a crumb cookie, Alpha Vantage and
 * Finnhub want an API key and cap the free tier at a handful of calls a
 * minute, and Stooq serves daily bars only, which can't draw a 1D chart. So
 * this reads `v8/finance/chart` and nothing else, and the command degrades to
 * numbers-only if the drawing step fails.
 *
 * The picture is rendered by QuickChart, which takes a Chart.js config and
 * returns a PNG. Drawing one here would mean writing a PNG encoder or adding a
 * canvas dependency, neither of which a price chart is worth. The PNG is
 * fetched and attached to the message rather than linked as an embed image, so
 * a QuickChart outage costs the chart and not the reply.
 *
 * Imports nothing, like the other data modules: pulling in log.ts would drag
 * config.ts along, and config exits the process when secrets are absent, which
 * would take the test suite with it. The command handler does the logging.
 */

/** A period the user can ask for, and what Yahoo needs to serve it. */
export interface RangeChoice {
  /** What the option shows in Discord. */
  label: string;
  /** The option's value, which is also Yahoo's `range` parameter. */
  value: string;
  /** Yahoo's `interval`: the bar size, chosen to land near 100-250 points. */
  interval: string;
  /** Whether points are finer than a day, which decides how they're labelled. */
  intraday: boolean;
}

/** The periods /stock offers, in the order the option lists them. */
export const RANGE_CHOICES: RangeChoice[] = [
  { label: "1D", value: "1d", interval: "5m", intraday: true },
  { label: "5D", value: "5d", interval: "30m", intraday: true },
  { label: "1M", value: "1mo", interval: "90m", intraday: true },
  { label: "6M", value: "6mo", interval: "1d", intraday: false },
  { label: "YTD", value: "ytd", interval: "1d", intraday: false },
  { label: "1Y", value: "1y", interval: "1d", intraday: false },
  { label: "5Y", value: "5y", interval: "1wk", intraday: false },
  { label: "Max", value: "max", interval: "1mo", intraday: false },
];

/** What you get without picking: today. */
export const DEFAULT_RANGE = "1d";

/** The range for an option value, falling back to the default. */
export function rangeFor(value: string | null): RangeChoice {
  return (
    RANGE_CHOICES.find((choice) => choice.value === value) ??
    (RANGE_CHOICES.find((choice) => choice.value === DEFAULT_RANGE) as RangeChoice)
  );
}

/**
 * Tickers as Yahoo spells them: upper case, and beyond letters and digits only
 * the punctuation its symbols actually use -- `.` for exchange suffixes
 * (`7203.T`), `-` for share classes and crypto pairs (`BRK-B`, `BTC-USD`),
 * `^` for indices (`^GSPC`), `=` for futures and FX (`GC=F`, `EURUSD=X`).
 * Anything else is a typo or an injection attempt, and both deserve the same
 * "no such ticker" answer without a round trip.
 */
export function normaliseSymbol(raw: string): string | null {
  const symbol = raw.trim().toUpperCase();
  if (symbol.length === 0 || symbol.length > 20) return null;
  return /^[A-Z0-9.\-^=]+$/.test(symbol) ? symbol : null;
}

/** The current state of the instrument, as `meta` reports it. */
export interface Quote {
  symbol: string;
  /** The company or instrument name, when Yahoo gives one. */
  name: string | null;
  currency: string | null;
  exchange: string | null;
  price: number;
  /** Close before the series starts -- the baseline a 1D move is measured from. */
  previousClose: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  volume: number | null;
  /** Seconds to add to a timestamp to get exchange-local wall clock. */
  gmtoffset: number;
}

/** The line to draw: one price per timestamp, oldest first. */
export interface Series {
  /** Unix seconds. */
  times: number[];
  prices: number[];
}

export interface ChartResult {
  quote: Quote;
  series: Series;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Reads the chart payload into a quote and a series.
 *
 * Yahoo answers 200 with an `error` object for an unknown ticker, and pads its
 * close array with nulls for bars that didn't trade, so both are handled here
 * rather than at the call site. Returns a message instead of throwing when the
 * payload is a legible "no such thing"; throws when it is a shape we don't
 * recognise at all.
 */
export function parseChart(payload: unknown): ChartResult | { error: string } {
  const root = asRecord(payload);
  const chart = asRecord(root?.["chart"]);
  if (!chart) throw new Error("Unrecognised response from Yahoo Finance");

  const error = asRecord(chart["error"]);
  if (error) {
    const code = asString(error["code"]) ?? "";
    if (code === "Not Found") return { error: "No such ticker." };
    return { error: asString(error["description"]) ?? "Yahoo Finance couldn't answer that." };
  }

  const results = chart["result"];
  const result = asRecord(Array.isArray(results) ? results[0] : null);
  const meta = asRecord(result?.["meta"]);
  if (!result || !meta) return { error: "No such ticker." };

  const price = asNumber(meta["regularMarketPrice"]);
  if (price === null) return { error: "Yahoo Finance has no price for that ticker." };

  const timestamps = Array.isArray(result["timestamp"]) ? result["timestamp"] : [];
  const indicators = asRecord(result["indicators"]);
  const quotes = indicators?.["quote"];
  const closes = asRecord(Array.isArray(quotes) ? quotes[0] : null)?.["close"];
  const closeList = Array.isArray(closes) ? closes : [];

  const times: number[] = [];
  const prices: number[] = [];
  for (const [index, stamp] of timestamps.entries()) {
    const time = asNumber(stamp);
    const close = asNumber(closeList[index]);
    // Bars with no trade come back null; dropping them leaves a continuous
    // line rather than a gap, which is what every price chart does.
    if (time !== null && close !== null) {
      times.push(time);
      prices.push(close);
    }
  }

  const quote: Quote = {
    symbol: asString(meta["symbol"]) ?? "",
    name: asString(meta["longName"]) ?? asString(meta["shortName"]),
    currency: asString(meta["currency"]),
    exchange: asString(meta["fullExchangeName"]) ?? asString(meta["exchangeName"]),
    price,
    previousClose: asNumber(meta["chartPreviousClose"]) ?? asNumber(meta["previousClose"]),
    dayHigh: asNumber(meta["regularMarketDayHigh"]),
    dayLow: asNumber(meta["regularMarketDayLow"]),
    fiftyTwoWeekHigh: asNumber(meta["fiftyTwoWeekHigh"]),
    fiftyTwoWeekLow: asNumber(meta["fiftyTwoWeekLow"]),
    volume: asNumber(meta["regularMarketVolume"]),
    gmtoffset: asNumber(meta["gmtoffset"]) ?? 0,
  };

  return { quote, series: { times, prices } };
}

/** Yahoo's chart endpoint for one symbol over one period. */
export function chartUrl(symbol: string, choice: RangeChoice): string {
  const query = new URLSearchParams({
    range: choice.value,
    interval: choice.interval,
    includePrePost: "false",
  });
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`;
}

/**
 * Yahoo serves this endpoint to anyone, but answers 429 to a caller that looks
 * like a script, so ask the way a browser would.
 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TIMEOUT_MS = 10_000;

/** Fetches and parses one symbol's chart. Throws if Yahoo can't be reached. */
export async function fetchChart(
  symbol: string,
  choice: RangeChoice,
): Promise<ChartResult | { error: string }> {
  const response = await fetch(chartUrl(symbol, choice), {
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 404 carries the "no such ticker" body, so read it rather than bailing.
  if (!response.ok && response.status !== 404) {
    throw new Error(`Yahoo Finance answered ${response.status}`);
  }
  return parseChart(await response.json());
}

/** The move over the drawn period, against the close the period starts from. */
export function priceChange(result: ChartResult): { from: number; delta: number; percent: number } {
  const { quote, series } = result;
  // The previous close is the right baseline for a 1D chart, but for longer
  // periods it's yesterday's close, not the start of the period, so the first
  // drawn point is what the line is actually measured against.
  const from = series.prices[0] ?? quote.previousClose ?? quote.price;
  const delta = quote.price - from;
  return { from, delta, percent: from === 0 ? 0 : (delta / from) * 100 };
}

/** Discord embed colours: green up, red down, grey flat. */
export function changeColour(delta: number): number {
  if (delta > 0) return 0x3fb950;
  if (delta < 0) return 0xf85149;
  return 0x8b949e;
}

/** Money with the instrument's own currency symbol, falling back to the code. */
export function formatPrice(value: number, currency: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        // Sub-cent instruments (penny stocks, most crypto) round to nothing at
        // two places, so give them more room without padding normal prices.
        minimumFractionDigits: 2,
        maximumFractionDigits: Math.abs(value) < 1 ? 6 : 2,
      }).format(value);
    } catch {
      // Yahoo occasionally returns a code Intl doesn't know (older crypto).
    }
  }
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** The headline move, e.g. "▲ +2.31 (+0.75%)". */
export function formatChange(delta: number, percent: number, currency: string | null): string {
  const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "▬";
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const magnitude = formatPrice(Math.abs(delta), currency);
  return `${arrow} ${sign}${magnitude} (${sign}${Math.abs(percent).toFixed(2)}%)`;
}

/** Share counts, short: 44.3M rather than 44,330,978. */
export function formatVolume(volume: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(
    volume,
  );
}

/** A low-high pair, or null when Yahoo gave neither end. */
export function formatRange(
  low: number | null,
  high: number | null,
  currency: string | null,
): string | null {
  if (low === null || high === null) return null;
  return `${formatPrice(low, currency)} to ${formatPrice(high, currency)}`;
}

/** How many points a chart draws before the line stops gaining detail. */
export const MAX_POINTS = 180;

/**
 * Thins a series to at most `max` points, keeping the first and last so the
 * line still starts and ends where the numbers say it does.
 */
export function downsample(series: Series, max = MAX_POINTS): Series {
  const count = series.prices.length;
  if (count <= max || max < 2) return series;

  const times: number[] = [];
  const prices: number[] = [];
  const step = (count - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    const index = Math.round(i * step);
    const time = series.times[index];
    const price = series.prices[index];
    if (time !== undefined && price !== undefined) {
      times.push(time);
      prices.push(price);
    }
  }
  return { times, prices };
}

/**
 * An axis label in exchange-local time: clock times for intraday charts, dates
 * for the rest. Built by shifting into UTC and formatting there, because the
 * exchange's IANA zone isn't something a fixed offset can be turned back into.
 */
export function axisLabel(time: number, gmtoffset: number, intraday: boolean): string {
  const local = new Date((time + gmtoffset) * 1000);
  if (intraday) {
    const hours = String(local.getUTCHours()).padStart(2, "0");
    const minutes = String(local.getUTCMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  }
  return local.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "2-digit",
  });
}

/** A Chart.js config for QuickChart to render. */
export function chartConfig(result: ChartResult, choice: RangeChoice): unknown {
  const series = downsample(result.series);
  const { delta } = priceChange(result);
  const up = delta >= 0;
  const line = up ? "#3fb950" : "#f85149";
  const fill = up ? "rgba(63, 185, 80, 0.16)" : "rgba(248, 81, 73, 0.16)";
  const ink = "#8b949e";

  const datasets: unknown[] = [
    {
      data: series.prices,
      borderColor: line,
      backgroundColor: fill,
      fill: true,
      borderWidth: 2,
      pointRadius: 0,
      lineTension: 0,
    },
  ];

  // On a 1D chart the previous close is the line everyone reads the day
  // against, so draw it. Over longer periods it means nothing.
  const baseline = result.quote.previousClose;
  if (choice.value === "1d" && baseline !== null) {
    datasets.push({
      data: series.prices.map(() => baseline),
      borderColor: ink,
      borderWidth: 1,
      borderDash: [6, 4],
      fill: false,
      pointRadius: 0,
    });
  }

  return {
    type: "line",
    data: {
      labels: series.times.map((time) =>
        axisLabel(time, result.quote.gmtoffset, choice.intraday),
      ),
      datasets,
    },
    options: {
      legend: { display: false },
      layout: { padding: { top: 8, right: 12, bottom: 4, left: 4 } },
      scales: {
        xAxes: [
          {
            gridLines: { display: false, drawBorder: false },
            ticks: { fontColor: ink, maxRotation: 0, maxTicksLimit: 6, autoSkip: true },
          },
        ],
        yAxes: [
          {
            gridLines: { color: "rgba(139, 148, 158, 0.18)", drawBorder: false },
            ticks: { fontColor: ink, maxTicksLimit: 6 },
          },
        ],
      },
    },
  };
}

/** QuickChart's dark surface, so the picture matches a Discord embed. */
const CHART_BACKGROUND = "#1e1f22";
const CHART_WIDTH = 720;
const CHART_HEIGHT = 320;

/**
 * Renders a config to PNG. Posted rather than put in the URL: a few hundred
 * points of config outgrows what a query string should carry.
 */
export async function renderChart(config: unknown): Promise<Buffer> {
  const response = await fetch("https://quickchart.io/chart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chart: config,
      width: CHART_WIDTH,
      height: CHART_HEIGHT,
      backgroundColor: CHART_BACKGROUND,
      format: "png",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`QuickChart answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
