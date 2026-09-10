import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { log } from "../log.js";
import { newGame } from "./engine.js";
import { emptyCrates } from "./rules.js";
import { RARITIES, type Character, type GameState, type Item } from "./types.js";

/**
 * The world, on disk.
 *
 * Same shape and same reasoning as idlerpg/store.ts: a JSON file held in
 * memory, written atomically, and never silently replaced when it fails to
 * parse. Its own file because the two games are separate worlds that happen to
 * share a process, and a bug in one must not be able to eat the other.
 */

const storePath = join(config.runtime.repoPath, "state", "rpg.json");

let cache: GameState | null = null;
let dirty = false;

/**
 * Gives every item a character holds its own number, and moves nextItemId past
 * all of them. Returns how many items changed number.
 *
 * Saves from before give and buy renumbered incoming items can hold two items
 * under one number, or a number above nextItemId that a later drop would reuse.
 * The first holder of a number keeps it, in the order weapon, armor, backpack,
 * listings. So a listed item is the one that moves when it clashes, and players
 * address listings by the listing's number anyway.
 */
function renumber(character: Character, listed: Item[]): number {
  const held = [character.weapon, character.armor, ...character.backpack, ...listed].filter(
    (item): item is Item => item !== null,
  );
  let next = Math.max(character.nextItemId, ...held.map((item) => item.id + 1));
  const seen = new Set<number>();
  let moved = 0;
  for (const item of held) {
    if (seen.has(item.id)) {
      item.id = next;
      next += 1;
      moved += 1;
    }
    seen.add(item.id);
  }
  character.nextItemId = next;
  return moved;
}

/** Fills in whatever a schema change added. A save from an older build is normal. */
export function hydrate(raw: Partial<GameState>): GameState {
  const characters: Record<string, Character> = {};
  for (const [id, saved] of Object.entries(raw.characters ?? {})) {
    if (!saved || typeof saved !== "object") continue;
    const crates = emptyCrates();
    for (const rarity of RARITIES) {
      const held = saved.crates?.[rarity];
      if (typeof held === "number") crates[rarity] = held;
    }
    characters[id] = {
      ...saved,
      userId: saved.userId ?? id,
      race: saved.race ?? "human",
      god: saved.god ?? null,
      favor: saved.favor ?? 0,
      guildId: saved.guildId ?? null,
      spouse: saved.spouse ?? null,
      loveScore: saved.loveScore ?? 0,
      crates,
      backpack: Array.isArray(saved.backpack) ? saved.backpack : [],
      expedition: saved.expedition ?? null,
      nextItemId: saved.nextItemId ?? 1,
      stats: {
        won: saved.stats?.won ?? 0,
        lost: saved.stats?.lost ?? 0,
        duelsWon: saved.stats?.duelsWon ?? 0,
        duelsLost: saved.stats?.duelsLost ?? 0,
      },
    };
  }

  const market = Array.isArray(raw.market) ? raw.market : [];
  for (const character of Object.values(characters)) {
    const before = character.nextItemId;
    const listed = market.filter((l) => l.sellerId === character.userId).map((l) => l.item);
    const moved = renumber(character, listed);
    if (moved > 0 || character.nextItemId !== before) {
      log.info("Renumbered RPG items", {
        character: character.name,
        moved,
        nextItemId: character.nextItemId,
      });
    }
  }

  return {
    characters,
    guilds: raw.guilds ?? {},
    market,
    nextListingId: raw.nextListingId ?? 1,
    raid: raw.raid ?? null,
    tournament: raw.tournament ?? null,
    arena: raw.arena ?? null,
    event: raw.event ?? null,
    chess: Array.isArray(raw.chess) ? raw.chess : [],
    nextChessId: raw.nextChessId ?? 1,
    werewolf: raw.werewolf ?? null,
  };
}

export function world(): GameState {
  if (cache) return cache;
  try {
    cache = hydrate(JSON.parse(readFileSync(storePath, "utf8")) as Partial<GameState>);
    log.info("RPG world loaded", { characters: Object.keys(cache.characters).length });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Never fall back to an empty world on a parse error: that is somebody's
      // save being deleted without anyone being told.
      throw new Error(`RPG save is unreadable (${storePath}): ${String(err)}`);
    }
    cache = newGame();
    log.info("RPG world created");
  }
  return cache;
}

export function touch(): void {
  dirty = true;
}

export function flush(force = false): void {
  if (!cache || (!dirty && !force)) return;
  mkdirSync(dirname(storePath), { recursive: true });
  const tmp = `${storePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  renameSync(tmp, storePath);
  dirty = false;
}

/**
 * Saves immediately.
 *
 * Unlike the IRC game there is no tick to piggyback a periodic write on, so
 * every mutation flushes. The file is small and the write is a rename; the
 * alternative is losing an adventure to a deploy, which players notice.
 */
export function save(): void {
  touch();
  try {
    flush();
  } catch (err) {
    log.error("Could not save the RPG world", { err: String(err) });
  }
}

export function reset(): void {
  cache = null;
  dirty = false;
}
