import sharp from "sharp";
import type { GameState, Player, Tuning } from "./types.js";

/**
 * The realm's map, as a PNG.
 *
 * idlerpg.net publishes the map as a web page; a Discord bot has no web page,
 * so it draws one on request. Rendered locally through sharp -- already a
 * dependency for avatars -- rather than posted to a chart service, because the
 * whole picture is a few hundred circles and shipping player positions to a
 * third party to draw dots would be an odd thing to do.
 */

const CANVAS = 720;
const MARGIN = 24;
const PLOT = CANVAS - MARGIN * 2;

const INK = "#c8d0dc";
const GRID = "#2b3240";
const BACKDROP = "#171b23";
const QUEST_INK = "#f5c542";
const WAYPOINT_INK = "#e5533d";

/** XML text is user-supplied (character names), so it cannot go in raw. */
function escapeXml(text: string): string {
  return text.replace(
    /[<>&'"]/g,
    (c) =>
      (({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }) as Record<
        string,
        string
      >)[c] ?? c,
  );
}

export async function renderMap(state: GameState, tuning: Tuning): Promise<Buffer> {
  const online = Object.values(state.players).filter((p) => p.online);
  const quest = state.quest;
  const questers = new Set(quest.kind === "idle" ? [] : quest.questers);

  const px = (x: number) => MARGIN + (x / tuning.mapX) * PLOT;
  const py = (y: number) => MARGIN + (y / tuning.mapY) * PLOT;

  const grid: string[] = [];
  for (let i = 0; i <= 10; i += 1) {
    const at = MARGIN + (i / 10) * PLOT;
    grid.push(
      `<line x1="${at}" y1="${MARGIN}" x2="${at}" y2="${MARGIN + PLOT}" stroke="${GRID}" stroke-width="1"/>`,
      `<line x1="${MARGIN}" y1="${at}" x2="${MARGIN + PLOT}" y2="${at}" stroke="${GRID}" stroke-width="1"/>`,
    );
  }

  const waypoints: string[] = [];
  if (quest.kind === "map") {
    for (const [index, point] of [quest.p1, quest.p2].entries()) {
      const active = quest.stage === index + 1;
      waypoints.push(
        `<circle cx="${px(point.x)}" cy="${py(point.y)}" r="9" fill="none" ` +
          `stroke="${WAYPOINT_INK}" stroke-width="2" ${active ? "" : 'stroke-dasharray="3 3"'}/>`,
        `<text x="${px(point.x)}" y="${py(point.y) - 14}" fill="${WAYPOINT_INK}" ` +
          `font-family="monospace" font-size="11" text-anchor="middle">${index + 1}</text>`,
      );
    }
  }

  const dots = online.map((p: Player) => {
    const questing = questers.has(p.userId);
    const colour = questing ? QUEST_INK : INK;
    // Names sit to the right of their dot, except near the right edge, where
    // they would be cropped off the canvas -- there they flip to the left.
    const flip = px(p.x) > CANVAS * 0.72;
    return (
      `<circle cx="${px(p.x)}" cy="${py(p.y)}" r="${questing ? 5 : 3.5}" fill="${colour}"/>` +
      `<text x="${px(p.x) + (flip ? -8 : 8)}" y="${py(p.y) + 4}" fill="${colour}" ` +
      `text-anchor="${flip ? "end" : "start"}" font-family="monospace" ` +
      `font-size="11">${escapeXml(p.name)}</text>`
    );
  });

  const caption =
    online.length === 0
      ? "nobody is idling"
      : `${online.length} idling${questers.size > 0 ? `, ${questers.size} on a quest` : ""}`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}">
<rect width="${CANVAS}" height="${CANVAS}" fill="${BACKDROP}"/>
${grid.join("\n")}
<rect x="${MARGIN}" y="${MARGIN}" width="${PLOT}" height="${PLOT}" fill="none" stroke="${GRID}" stroke-width="2"/>
${waypoints.join("\n")}
${dots.join("\n")}
<text x="${MARGIN}" y="${CANVAS - 8}" fill="${GRID}" font-family="monospace" font-size="12">${tuning.mapX}x${tuning.mapY}, ${escapeXml(caption)}</text>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
