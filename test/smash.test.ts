import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tests for the roster matching and page parsing behind /smash framedata.
 *
 * Imported directly rather than through the command module so the suite
 * doesn't pull in src/config.ts, which exits the process on missing
 * environment variables. Nothing here touches the network: the fixture below
 * reproduces the markup Ultimate Frame Data actually serves, including the
 * "--" it writes in a column a move has nothing for, the sentence it puts in
 * the landing-lag column of a throw, and the Misc Info entries that are a
 * hitbox picture and nothing else.
 */

const {
  PAGE_BUDGET,
  ROSTER,
  SECTION_CHOICES,
  characterFor,
  frameDataPages,
  matchCharacters,
  pageUrl,
  parseFrameData,
  renderSection,
} = await import("../src/smash.ts");

const CHARACTER = { slug: "mario", name: "Mario" };

const PAGE = `
<h1 class="charactername">Mario</h1>
<h2 class="movecategory" id="groundattacks">Ground Attacks</h2>
<div class="moves">
	<div class="movecontainer">
		<div class="hitbox">
			<a class="hitboximg" data-featherlight="hitboxes/mario/MarioJab1.gif"><img alt="Hitbox Image" src="x.gif"></a>
		</div>
		<div class="movename">
		Jab 1
		</div>
		<div class="startup">
		2
		</div>
		<div class="totalframes">
		19
		</div>
		<div class="landinglag">
		--
		</div>
		<div class="notes">
		Transitions to Jab 2 as early as frame 5
		</div>
		<div class="basedamage">
		2.2
		</div>
		<div class="whichhitbox">
		--
		</div>
		<div class="advantage">
		-14
		</div>
		<div class="activeframes">
		2&mdash;3
		</div>
	<div class="endlag"> 16</div></div>

	<div class="movecontainer">
		<div class="movename">
		Up Smash
		</div>
		<div class="startup">
		9
		</div>
		<div class="totalframes">
		39
		</div>
		<div class="landinglag">
		--
		</div>
		<div class="basedamage">
		14.0
		</div>
		<div class="advantage">
		-20
		</div>
		<div class="activeframes">
		9—12
		</div>
	</div>
</div>

<h2 class="movecategory" id="grabs">
Grabs / Throws
</h2>
<div class="moves">
	<div class="movecontainer">
		<div class="movename">
		Pummel
		</div>
		<div class="startup">
		1
		</div>
		<div class="totalframes">
		19
		</div>
		<div class="landinglag">
		Total frames includes 14 frames of hitlag.
		</div>
		<div class="basedamage">
		1.3
		</div>
	</div>
</div>

<h2 class="movecategory" id="misc">
Misc Info
</h2>
<div class="moves">
	<div class="movecontainer plain misc">
	<div class="movename">
			Stats
		</div>
	<div>Weight — 98</div>
	<div>Run Speed — 1.76</div>
	<div class="oos1">Out of Shield, Up B — 3 frames</div>
	</div>

	<div class="movecontainer ">
		<div class="movename">
				Ledge Grab
			</div>
		<div class="hitbox">
			<a class="hitboximg" data-featherlight="ledgegrabs/Mario Ledgegrab 1.png"><img alt="Hitbox Image" src="y.png"></a>
		</div>
	</div>
</div>
`;

const DATA = parseFrameData(CHARACTER, PAGE);

test("the roster is the fighters the site has pages for", () => {
  assert.equal(ROSTER.length, 88);
  assert.equal(new Set(ROSTER.map((c) => c.slug)).size, ROSTER.length);
  assert.ok(ROSTER.every((c) => /^[a-z0-9_]+$/.test(c.slug)));
});

test("matching is by name, slug and shorthand, best first", () => {
  assert.equal(matchCharacters("mario")[0]?.slug, "mario");
  assert.equal(matchCharacters("MARIO")[0]?.slug, "mario");
  assert.equal(matchCharacters("zss")[0]?.slug, "zero_suit_samus");
  assert.equal(matchCharacters("gnw")[0]?.slug, "mr_game_and_watch");
  // Punctuation is noise: "R.O.B." and "rob" are the same fighter.
  assert.equal(matchCharacters("rob")[0]?.slug, "rob");
  // A substring nobody starts with still finds its fighter.
  assert.ok(matchCharacters("kazooie").some((c) => c.slug === "banjo_and_kazooie"));
  assert.deepEqual(matchCharacters("nobody"), []);
});

test("matching never offers Discord more choices than it accepts", () => {
  assert.equal(matchCharacters("").length, 25);
  assert.ok(matchCharacters("a").length <= 25);
});

test("an option value resolves to a fighter, typed or picked", () => {
  assert.equal(characterFor("pt_squirtle")?.name, "Squirtle");
  assert.equal(characterFor("Donkey Kong")?.slug, "donkey_kong");
  assert.equal(characterFor("dk")?.slug, "donkey_kong");
  assert.equal(characterFor("not a fighter"), null);
  assert.equal(pageUrl(CHARACTER), "https://ultimateframedata.com/mario");
});

test("parsing reads one section per heading and one move per container", () => {
  assert.deepEqual(
    DATA.sections.map((section) => [section.id, section.moves.length]),
    [
      ["groundattacks", 2],
      ["grabs", 1],
    ],
  );
  const jab = DATA.sections[0]?.moves[0];
  assert.equal(jab?.name, "Jab 1");
  assert.equal(jab?.startup, "2");
  assert.equal(jab?.totalFrames, "19");
  assert.equal(jab?.baseDamage, "2.2");
  assert.equal(jab?.advantage, "-14");
  // Entities are decoded, so an em-dash range reads as one.
  assert.equal(jab?.activeFrames, "2—3");
  // "--" is a column the move has nothing for, not a value.
  assert.equal(jab?.landingLag, null);
});

test("parsing labels sections the way the command's options do", () => {
  for (const section of DATA.sections) {
    assert.equal(section.label, SECTION_CHOICES.find((c) => c.id === section.id)?.label);
  }
});

test("parsing lifts the stats box out of Misc Info", () => {
  assert.deepEqual(DATA.stats, [
    "Weight — 98",
    "Run Speed — 1.76",
    "Out of Shield, Up B — 3 frames",
  ]);
  // Ledge Grab is a picture with no numbers, so it is not a row.
  assert.ok(!DATA.sections.some((section) => section.id === "misc"));
});

test("a table drops the columns no move in it fills", () => {
  const ground = DATA.sections[0];
  assert.ok(ground);
  const lines = renderSection(ground);
  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? "", /^Move\s+Start\s+Active\s+Total\s+Dmg\s+Shield$/);
  assert.match(lines[1] ?? "", /^Jab 1\s+2\s+2—3\s+19\s+2\.2\s+-14$/);
  // Nothing has landing lag here, so there is no Land column.
  assert.doesNotMatch(lines[0] ?? "", /Land/);
});

test("prose in the landing-lag column of a throw is left to the site", () => {
  const grabs = DATA.sections[1];
  assert.ok(grabs);
  assert.equal(grabs.moves[0]?.landingLag, "Total frames includes 14 frames of hitlag.");
  assert.doesNotMatch(renderSection(grabs).join("\n"), /hitlag/);
});

test("pages carry every section, and the stats with Misc Info", () => {
  const all = frameDataPages(DATA, null).join("\n");
  assert.match(all, /\*\*Ground Attacks\*\*/);
  assert.match(all, /\*\*Grabs \/ Throws\*\*/);
  assert.match(all, /\*\*Stats\*\*/);
  assert.match(all, /Weight — 98/);
});

test("a section filter shows that section and nothing else", () => {
  const grabs = frameDataPages(DATA, "grabs").join("\n");
  assert.match(grabs, /Pummel/);
  assert.doesNotMatch(grabs, /Jab 1/);
  assert.doesNotMatch(grabs, /Weight/);
  // Misc Info is the stats, since its other entries are pictures.
  assert.match(frameDataPages(DATA, "misc").join("\n"), /Weight — 98/);
  assert.deepEqual(frameDataPages(DATA, "specialattacks"), []);
});

test("a fighter too big for one embed spills onto further pages", () => {
  const moves = Array.from({ length: 400 }, (_, index) => ({
    name: `Move ${index}`,
    startup: "12",
    activeFrames: "12—14",
    totalFrames: "40",
    landingLag: null,
    baseDamage: "9.5",
    advantage: "-11",
  }));
  const big = {
    character: CHARACTER,
    sections: [{ id: "specialattacks", label: "Special Attacks", moves }],
    stats: [],
  };

  const pages = frameDataPages(big, null);
  assert.ok(pages.length > 1);
  assert.ok(pages.every((page) => page.length <= PAGE_BUDGET));
  // Every move is somewhere, and every continued table still has its heading.
  const all = pages.join("\n");
  for (const move of moves) assert.match(all, new RegExp(`^${move.name} `, "m"));
  for (const page of pages.slice(1)) assert.match(page, /^\*\*Special Attacks \(cont\.\)\*\*/);
  // Code fences balance, or Discord renders the rest of the page as code.
  for (const page of pages) assert.equal((page.match(/```/g) ?? []).length % 2, 0);
});

test("a page that isn't the site's any more costs columns, not the reply", () => {
  const data = parseFrameData(CHARACTER, "<html><body>Nothing we know here.</body></html>");
  assert.deepEqual(data.sections, []);
  assert.deepEqual(data.stats, []);
  assert.deepEqual(frameDataPages(data, null), []);
});
