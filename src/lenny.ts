/**
 * The Lenny faces and the escaping that gets them through Discord intact.
 * Deliberately free of imports.
 *
 * The faces are bundled rather than fetched from lennyfac.es: the site has no
 * API, and a joke command should not be able to fail because a third party is
 * down. Kept outside the command handler so the suite can test it without
 * booting config (which exits the process when secrets are absent).
 */

/** The canonical Lenny, returned by a bare `/lenny`. */
export const LENNY = "( ͡° ͜ʖ ͡°)";

/**
 * A selection of the faces listed on https://www.lennyfac.es/, with the
 * canonical Lenny first. Not exhaustive — the site runs to hundreds — just
 * enough variety that `/lenny random` rarely repeats itself.
 */
export const FACES = [
  LENNY,
  "( ͡~ ͜ʖ ͡°)",
  "( ͡ʘ ͜ʖ ͡ʘ)",
  "( ͡◉ ͜ʖ ͡◉)",
  "( ͡⊙ ͜ʖ ͡⊙)",
  "( ͡ᵔ ͜ʖ ͡ᵔ )",
  "( ͡• ͜ʖ ͡• )",
  "( ͠° ͟ʖ ͡°)",
  "(⌐ ͡■ ͜ʖ ͡■)",
  "( ͡°╭͜ʖ╮ ͡° )",
  "ᕦ( ͡° ͜ʖ ͡°)ᕤ",
  "乁( ͡° ͜ʖ ͡°)ㄏ",
  "ヽ( ͝° ͜ʖ͡°)ﾉ",
  "(づ ͡° ͜ʖ ͡°)づ",
  "(ง ͠° ͟ل͜ ͡°)ง",
  "¯\\_( ͡° ͜ʖ ͡°)_/¯",
  "( ͡° ͜ʖ ͡°)ﾉ⌐■-■",
  "(ﾉ ͡° ͜ʖ ͡°)ﾉ*:･ﾟ✧",
  "┴┬┴┤( ͡° ͜ʖ├┬┴┬",
  "( ͡°( ͡° ͜ʖ( ͡° ͜ʖ ͡°)ʖ ͡°) ͡°)",
] as const;

export type Face = (typeof FACES)[number];

/** `random` is injectable so tests can pin the outcome. */
export function pickFace(random: () => number = Math.random): Face {
  return FACES[Math.floor(random() * FACES.length)]!;
}

/**
 * Some faces are built from characters Discord reads as markdown — the shrug's
 * underscores would italicise the arms clean off — so escape them before the
 * reply goes out.
 */
export function formatFace(face: string): string {
  return face.replace(/[\\`*_~|]/g, (char) => `\\${char}`);
}
