/**
 * Super Smash Bros. Ultimate frame data behind /smash framedata.
 *
 * Ultimate Frame Data is the source. It has no API, so this reads the
 * character page and pulls the numbers out of the markup, which is generated
 * and therefore regular: every move is a `movecontainer` div holding one div
 * per column, keyed by class name. The alternatives were worse -- Kurogane
 * Hammer's API has been dead for years, and the community spreadsheets are
 * Google Sheets exports that need a key and go stale independently of the site
 * everyone actually quotes.
 *
 * The roster is baked in rather than scraped: it changes when Nintendo ships a
 * fighter, which last happened in 2021, and having it locally is what lets
 * autocomplete answer inside Discord's three-second window without a round
 * trip. A slug that has drifted shows up as a failed fetch, not silence.
 *
 * Parsing is done with regexes over the markup. That is normally a mistake,
 * but the shape here is one flat div per field with no nesting inside the
 * fields we read, and the alternative is a DOM parser dependency for one
 * command. Anything unrecognised comes back as a missing cell rather than a
 * throw, so a layout change costs a column and not the reply.
 *
 * Imports nothing, like the other data modules: pulling in log.ts would drag
 * config.ts along, and config exits the process when secrets are absent, which
 * would take the test suite with it. The command handler does the logging.
 */

/** A fighter, as the site slugs them. */
export interface Character {
  /** The path segment on ultimateframedata.com. */
  slug: string;
  /** The name shown in Discord. */
  name: string;
  /** Shorthands people actually type, beyond the name itself. */
  aliases?: string[];
}

/** Every fighter in Ultimate, in the order the site lists them. */
export const ROSTER: Character[] = [
  { slug: "banjo_and_kazooie", name: "Banjo & Kazooie", aliases: ["banjo"] },
  { slug: "bayonetta", name: "Bayonetta", aliases: ["bayo"] },
  { slug: "bowser", name: "Bowser" },
  { slug: "bowser_jr", name: "Bowser Jr." },
  { slug: "byleth", name: "Byleth" },
  { slug: "captain_falcon", name: "Captain Falcon", aliases: ["falcon"] },
  { slug: "chrom", name: "Chrom" },
  { slug: "cloud", name: "Cloud" },
  { slug: "corrin", name: "Corrin" },
  { slug: "daisy", name: "Daisy" },
  { slug: "dark_pit", name: "Dark Pit" },
  { slug: "dark_samus", name: "Dark Samus" },
  { slug: "diddy_kong", name: "Diddy Kong", aliases: ["diddy"] },
  { slug: "donkey_kong", name: "Donkey Kong", aliases: ["dk"] },
  { slug: "dr_mario", name: "Dr. Mario", aliases: ["doc"] },
  { slug: "duck_hunt", name: "Duck Hunt" },
  { slug: "falco", name: "Falco" },
  { slug: "fox", name: "Fox" },
  { slug: "ganondorf", name: "Ganondorf", aliases: ["ganon"] },
  { slug: "greninja", name: "Greninja" },
  { slug: "hero", name: "Hero" },
  { slug: "ice_climbers", name: "Ice Climbers", aliases: ["ics"] },
  { slug: "ike", name: "Ike" },
  { slug: "incineroar", name: "Incineroar", aliases: ["incin"] },
  { slug: "inkling", name: "Inkling" },
  { slug: "isabelle", name: "Isabelle" },
  { slug: "jigglypuff", name: "Jigglypuff", aliases: ["puff", "jiggs"] },
  { slug: "joker", name: "Joker" },
  { slug: "kazuya", name: "Kazuya" },
  { slug: "ken", name: "Ken" },
  { slug: "king_dedede", name: "King Dedede", aliases: ["dedede", "ddd"] },
  { slug: "king_k_rool", name: "King K. Rool", aliases: ["krool"] },
  { slug: "kirby", name: "Kirby" },
  { slug: "link", name: "Link" },
  { slug: "little_mac", name: "Little Mac", aliases: ["mac"] },
  { slug: "lucario", name: "Lucario" },
  { slug: "lucas", name: "Lucas" },
  { slug: "lucina", name: "Lucina" },
  { slug: "luigi", name: "Luigi" },
  { slug: "mario", name: "Mario" },
  { slug: "marth", name: "Marth" },
  { slug: "mega_man", name: "Mega Man" },
  { slug: "meta_knight", name: "Meta Knight", aliases: ["mk"] },
  { slug: "mewtwo", name: "Mewtwo" },
  { slug: "mii_brawler", name: "Mii Brawler" },
  { slug: "mii_gunner", name: "Mii Gunner" },
  { slug: "mii_swordfighter", name: "Mii Swordfighter" },
  { slug: "minmin", name: "Min Min" },
  { slug: "mr_game_and_watch", name: "Mr. Game & Watch", aliases: ["gnw", "gw"] },
  { slug: "mythra", name: "Mythra" },
  { slug: "ness", name: "Ness" },
  { slug: "olimar", name: "Olimar" },
  { slug: "pac_man", name: "Pac Man" },
  { slug: "palutena", name: "Palutena", aliases: ["palu"] },
  { slug: "peach", name: "Peach" },
  { slug: "pichu", name: "Pichu" },
  { slug: "pikachu", name: "Pikachu", aliases: ["pika"] },
  { slug: "piranha_plant", name: "Piranha Plant", aliases: ["plant"] },
  { slug: "pit", name: "Pit" },
  { slug: "pt_charizard", name: "Charizard", aliases: ["zard"] },
  { slug: "pt_ivysaur", name: "Ivysaur" },
  { slug: "pt_squirtle", name: "Squirtle" },
  { slug: "pyra", name: "Pyra" },
  { slug: "richter", name: "Richter" },
  { slug: "ridley", name: "Ridley" },
  { slug: "rob", name: "R.O.B." },
  { slug: "robin", name: "Robin" },
  { slug: "rosalina_and_luma", name: "Rosalina and Luma", aliases: ["rosa"] },
  { slug: "roy", name: "Roy" },
  { slug: "ryu", name: "Ryu" },
  { slug: "samus", name: "Samus" },
  { slug: "sephiroth", name: "Sephiroth", aliases: ["seph"] },
  { slug: "sheik", name: "Sheik" },
  { slug: "shulk", name: "Shulk" },
  { slug: "simon", name: "Simon" },
  { slug: "snake", name: "Snake" },
  { slug: "sonic", name: "Sonic" },
  { slug: "steve", name: "Steve" },
  { slug: "terry", name: "Terry" },
  { slug: "toon_link", name: "Toon Link", aliases: ["tink"] },
  { slug: "villager", name: "Villager" },
  { slug: "wario", name: "Wario" },
  { slug: "wii_fit_trainer", name: "Wii Fit Trainer", aliases: ["wft"] },
  { slug: "wolf", name: "Wolf" },
  { slug: "yoshi", name: "Yoshi" },
  { slug: "young_link", name: "Young Link", aliases: ["yink"] },
  { slug: "zelda", name: "Zelda" },
  { slug: "zero_suit_samus", name: "Zero Suit Samus", aliases: ["zss"] },
];

/** Letters and digits only, so "R.O.B.", "rob" and "R O B" all meet. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The fighters matching what someone has typed so far, best first: exact name,
 * then names that start with it, then names that merely contain it, then
 * shorthands. Empty query gives the roster in order, which is what an
 * untouched autocomplete box should show.
 */
export function matchCharacters(query: string, limit = 25): Character[] {
  const needle = fold(query);
  if (needle.length === 0) return ROSTER.slice(0, limit);

  const scored: { character: Character; score: number }[] = [];
  for (const character of ROSTER) {
    const name = fold(character.name);
    const slug = fold(character.slug);
    const aliases = (character.aliases ?? []).map(fold);

    let score: number | null = null;
    if (name === needle || aliases.includes(needle)) score = 0;
    else if (name.startsWith(needle) || slug.startsWith(needle)) score = 1;
    else if (aliases.some((alias) => alias.startsWith(needle))) score = 2;
    else if (name.includes(needle) || slug.includes(needle)) score = 3;

    if (score !== null) scored.push({ character, score });
  }

  // Stable within a score band, so the roster's own order breaks ties.
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((entry) => entry.character);
}

/**
 * The fighter an option value names. Autocomplete sends back a slug, but
 * nothing stops someone typing free text and submitting it anyway, so fall
 * back to the same matching the suggestions use.
 */
export function characterFor(value: string): Character | null {
  const needle = fold(value);
  const exact = ROSTER.find((character) => fold(character.slug) === needle);
  return exact ?? matchCharacters(value)[0] ?? null;
}

/** A section of a character page, in the order the page lays them out. */
export interface SectionChoice {
  /** The anchor id on the page, which is also the option's value. */
  id: string;
  label: string;
}

/** The sections /smash framedata can show. */
export const SECTION_CHOICES: SectionChoice[] = [
  { id: "groundattacks", label: "Ground Attacks" },
  { id: "aerialattacks", label: "Aerial Attacks" },
  { id: "specialattacks", label: "Special Attacks" },
  { id: "grabs", label: "Grabs / Throws" },
  { id: "dodges", label: "Dodges / Rolls" },
  { id: "misc", label: "Misc Info" },
];

/** One row of the table: every cell is text, because the site's cells are. */
export interface Move {
  name: string;
  startup: string | null;
  activeFrames: string | null;
  totalFrames: string | null;
  landingLag: string | null;
  baseDamage: string | null;
  advantage: string | null;
}

export interface Section {
  id: string;
  label: string;
  moves: Move[];
}

export interface FrameData {
  character: Character;
  sections: Section[];
  /** The "Weight — 98" style lines from the stats box in Misc Info. */
  stats: string[];
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
};

/** Markup to plain text: tags dropped, entities decoded, whitespace collapsed. */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One field out of a move's markup. The site writes "--" for a column that
 * doesn't apply to the move, which is a missing cell rather than a value.
 */
function field(html: string, className: string): string | null {
  const match = new RegExp(`<div class="${className}"[^>]*>([\\s\\S]*?)</div>`).exec(html);
  if (!match?.[1]) return null;
  const value = text(match[1]);
  return value.length === 0 || /^-+$/.test(value) ? null : value;
}

/**
 * Reads a character page into sections of moves.
 *
 * Each `movecategory` heading opens a section and each `movecontainer` inside
 * it is a move; splitting on the container rather than trying to match its
 * closing tag avoids counting the nested divs the hitbox thumbnails sit in.
 */
export function parseFrameData(character: Character, html: string): FrameData {
  const sections: Section[] = [];
  const stats: string[] = [];

  const headings = [...html.matchAll(/<h2 class="movecategory" id="([a-z]+)"[^>]*>/g)];
  for (const [index, heading] of headings.entries()) {
    const id = heading[1] ?? "";
    const start = heading.index + heading[0].length;
    const end = headings[index + 1]?.index ?? html.length;
    const body = html.slice(start, end);

    const moves: Move[] = [];
    for (const chunk of body.split(/<div class="movecontainer/).slice(1)) {
      const name = field(chunk, "movename");
      if (name === null) continue;

      // The stats box in Misc Info is a move container by markup only: it has
      // no columns, just one "Weight — 98" line per div. Lift those out.
      if (/^\s*[^>]*\bmisc\b/.test(chunk)) {
        for (const line of chunk.matchAll(/<div(?: class="oos\d+")?>([^<]*—[^<]*)<\/div>/g)) {
          const value = text(line[1] ?? "");
          if (value.length > 0) stats.push(value);
        }
        continue;
      }

      const move: Move = {
        name,
        startup: field(chunk, "startup"),
        activeFrames: field(chunk, "activeframes"),
        totalFrames: field(chunk, "totalframes"),
        landingLag: field(chunk, "landinglag"),
        baseDamage: field(chunk, "basedamage"),
        advantage: field(chunk, "advantage"),
      };
      // Misc Info holds entries that are only a hitbox picture -- ledge grabs,
      // getup attacks -- which have no numbers to put in a row.
      if (COLUMNS.some((column) => column.of(move))) moves.push(move);
    }

    const label = SECTION_CHOICES.find((choice) => choice.id === id)?.label ?? id;
    if (moves.length > 0) sections.push({ id, label, moves });
  }

  return { character, sections, stats };
}

/** The character's page, which is also what the reply links to. */
export function pageUrl(character: Character): string {
  return `https://ultimateframedata.com/${character.slug}`;
}

const TIMEOUT_MS = 10_000;

/**
 * The site is a plain static page behind a filter that answers anything not
 * shaped like a browser with 406 -- a bare `Accept: text/html` is enough to
 * trip it -- so ask the way a browser would, as /stock does for Yahoo.
 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/** Fetches and parses one character's page. Throws if the site can't be read. */
export async function fetchFrameData(character: Character): Promise<FrameData> {
  const response = await fetch(pageUrl(character), {
    headers: { "User-Agent": BROWSER_UA, Accept: BROWSER_ACCEPT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Ultimate Frame Data answered ${response.status}`);
  return parseFrameData(character, await response.text());
}

/** A table column: its heading, and how to read it off a move. */
interface Column {
  heading: string;
  of: (move: Move) => string | null;
}

/** What a frame count looks like: digits, and the separators the site uses. */
const FRAMES = /^[\d\s./\-–—]+$/;

const COLUMNS: Column[] = [
  { heading: "Start", of: (move) => move.startup },
  { heading: "Active", of: (move) => move.activeFrames },
  { heading: "Total", of: (move) => move.totalFrames },
  // Grabs and throws have no landing lag, and the site fills that column with
  // a sentence about hitlag instead, so anything that isn't a frame count is
  // treated as the prose it is and left to the site.
  {
    heading: "Land",
    of: (move) => (FRAMES.test(move.landingLag ?? "") ? move.landingLag : null),
  },
  { heading: "Dmg", of: (move) => move.baseDamage },
  { heading: "Shield", of: (move) => move.advantage },
];

/** How wide a move name may get before it's cut; long ones are rare. */
const NAME_WIDTH = 22;

/**
 * How wide a cell may get. Frame counts are two or three characters, but a
 * multi-hit special lists one per hit -- Hero's Magic Burst has nine -- and one
 * such move would otherwise set the column width for the whole table. Those
 * get cut, with the page link for anyone who needs the rest.
 */
const CELL_WIDTH = 11;

/** A value cut to `width`, marked so it's clear something was cut. */
function clip(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}

/**
 * A section as a fixed-width table: a heading row, then one row per move.
 *
 * Columns no move in the section fills are dropped rather than printed empty,
 * which is what keeps Dodges / Rolls -- three columns of the twelve -- from
 * being mostly dashes, and keeps the narrow tables narrow.
 */
export function renderSection(section: Section): string[] {
  const columns = COLUMNS.filter((column) => section.moves.some((move) => column.of(move)));
  const cells = section.moves.map((move) =>
    columns.map((column) => clip(column.of(move) ?? "-", CELL_WIDTH)),
  );
  const names = section.moves.map((move) => clip(move.name, NAME_WIDTH));
  const nameWidth = Math.max(...names.map((name) => name.length), 4);
  const widths = columns.map((column, index) =>
    Math.max(column.heading.length, ...cells.map((row) => row[index]?.length ?? 0)),
  );

  const row = (first: string, rest: string[]): string =>
    [first.padEnd(nameWidth), ...rest.map((cell, i) => cell.padStart(widths[i] ?? 0))]
      .join("  ")
      .trimEnd();

  const lines = [row("Move", columns.map((column) => column.heading))];
  for (const [index, name] of names.entries()) {
    lines.push(row(name, cells[index] ?? []));
  }
  return lines;
}

/**
 * What one embed description carries. Discord's own ceiling is 4096; the
 * margin is for the block that gets closed and reopened when a table has to
 * straddle two of them.
 */
export const PAGE_BUDGET = 3800;

/** A block of text under a heading, ready to become part of a description. */
function block(label: string, lines: string[]): string {
  return `**${label}**\n\`\`\`\n${lines.join("\n")}\n\`\`\``;
}

/**
 * Lays the requested sections out as embed descriptions.
 *
 * A whole character doesn't fit in one embed -- Hero has twenty-five specials
 * on top of everything else -- and the request is for all of it, so the tables
 * spill onto further pages the command posts as follow-ups. Splitting is by
 * row, never mid-row, and a table continued on the next page repeats its
 * heading row so the columns still say what they are.
 */
export function frameDataPages(data: FrameData, only: string | null): string[] {
  const wanted = only === null ? data.sections : data.sections.filter((s) => s.id === only);
  const tables: { label: string; heading: string | null; rows: string[] }[] = wanted.map(
    (section) => {
      const [heading, ...rows] = renderSection(section);
      return { label: section.label, heading: heading ?? null, rows };
    },
  );

  // Stats belong to Misc Info, which is otherwise nothing but hitbox pictures,
  // so they ride along whenever Misc Info was asked for.
  if ((only === null || only === "misc") && data.stats.length > 0) {
    tables.push({ label: "Stats", heading: null, rows: data.stats });
  }

  const pages: string[] = [];
  let page = "";
  for (const table of tables) {
    let rows = table.rows;
    let first = true;
    while (rows.length > 0) {
      const label = first ? table.label : `${table.label} (cont.)`;
      const head = table.heading === null ? [] : [table.heading];
      const overhead = block(label, head).length + (page.length > 0 ? 1 : 0);

      // Take as many rows as the page has room for; if it can't hold even one,
      // the page is done and the table carries on at the top of the next.
      let taken = 0;
      let used = page.length + overhead;
      while (taken < rows.length && used + (rows[taken]?.length ?? 0) + 1 <= PAGE_BUDGET) {
        used += (rows[taken]?.length ?? 0) + 1;
        taken += 1;
      }
      if (taken === 0) {
        if (page.length === 0) break; // A single row wider than a page: give up on it.
        pages.push(page);
        page = "";
        continue;
      }

      const text = block(label, [...head, ...rows.slice(0, taken)]);
      page = page.length === 0 ? text : `${page}\n${text}`;
      rows = rows.slice(taken);
      first = false;
    }
  }
  if (page.length > 0) pages.push(page);

  return pages;
}
