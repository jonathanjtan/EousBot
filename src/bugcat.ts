/**
 * Bugcat Capoo stickers and the URL that fetches one.
 * Deliberately free of imports.
 *
 * Discord only lets a bot send stickers its own guilds own, so `/bugcat` posts
 * the sticker image instead. The ids below are LINE sticker ids taken from the
 * official BugCat-Capoo packs by the artist Yara; bundling the ids rather than
 * scraping the LINE store at request time keeps a joke command from failing
 * because a search endpoint changed shape. Kept outside the command handler so
 * the suite can test it without booting config (which exits the process when
 * secrets are absent).
 */

/** LINE sticker ids, ten from each of eight of Yara's static Capoo packs. */
export const STICKER_IDS = [
  // BugCat-Capoo (LINE pack 1043153)
  1806801, 1806805, 1806809, 1806813, 1806817, 1806821, 1806825, 1806829, 1806833, 1806837,
  // BugCat-capoo 2 (LINE pack 1092056)
  3777407, 3777411, 3777415, 3777419, 3777423, 3777427, 3777431, 3777435, 3777439, 3777443,
  // BugCat Capoo - very useful (LINE pack 3195138)
  34521464, 34521468, 34521472, 34521476, 34521480, 34521484, 34521488, 34521492, 34521496,
  34521500,
  // BugCat-Capoo: BugCat Encyclopedia (LINE pack 7007511)
  165624468, 165624481, 165624484, 165624487, 165624490, 165624493, 165624496, 165624499,
  165624502, 165624505,
  // BugCat-Capoo Easy to chat (LINE pack 13279602)
  350755774, 350755778, 350755782, 350755786, 350755790, 350755794, 350755798, 350755802,
  350755806, 350755810,
  // Bugcat-capoo sketch style (LINE pack 19716012)
  505815846, 505815849, 505815852, 505815855, 505815858, 505815861, 505815864, 505815867,
  505815870, 505815873,
  // BugCat-Capoo meme style (LINE pack 24494354)
  622939950, 622939953, 622939956, 622939959, 622939962, 622939965, 622939968, 622939971,
  622939974, 622939977,
  // BugCat-Capoo Fat Sadness (LINE pack 29524559)
  747146409, 747146412, 747146415, 747146418, 747146421, 747146424, 747146427, 747146430,
  747146433, 747146436,
] as const;

export type StickerId = (typeof STICKER_IDS)[number];

/** Where the LINE sticker shop serves the plain PNG for a sticker. */
export function stickerUrl(id: number): string {
  return `https://stickershop.line-scdn.net/stickershop/v1/sticker/${id}/android/sticker.png`;
}

/** `random` is injectable so tests can pin the outcome. */
export function pickSticker(random: () => number = Math.random): StickerId {
  return STICKER_IDS[Math.floor(random() * STICKER_IDS.length)]!;
}
