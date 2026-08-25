import type { ItemSlot } from "./types.js";

/**
 * Everything the realm says about itself.
 *
 * The original ships these as an editable `events.txt`, and this file is the
 * equivalent: prose only, no mechanics, so it can be rewritten to suit a
 * server's humour without touching a rule. The lines here are this port's own
 * -- the game is jotun's, the jokes are not.
 *
 * Calamity and godsend lines complete the sentence "<player> ...", so they
 * begin with a past-tense verb and carry no final punctuation. Quest lines
 * complete "chosen by the gods to ...".
 */

/** Misfortunes that cost time rather than equipment. */
export const CALAMITIES: readonly string[] = [
  "took a shortcut through a bog that was, on closer inspection, a mouth",
  "argued with a bridge troll about the definition of a bridge and lost on a technicality",
  "read the whole scroll aloud before checking which end was the warning",
  "was adopted by a goose with strong opinions about their route",
  "slept beneath a tree that turned out to be a very patient predator",
  "accepted a map drawn from memory by someone who had never been there",
  "haggled for a lantern and was sold a jar of the dark",
  "stepped confidently into a room whose floor was a rumour",
  "was cursed by a wizard who admitted afterwards it had been a case of mistaken identity",
  "found a shortcut, took it twice, and arrived before they had left",
  "was billed for a night at an inn they had merely dreamed about",
  "attempted to pet something that had been getting away with looking soft",
  "was talked into a duel by their own reflection and did not win convincingly",
  "walked into a tavern brawl that had been waiting all week for a fourth",
  "was recruited into a militia, a choir, and a pyramid scheme within a single afternoon",
  "opened a door marked DO NOT, having stopped reading at the second word",
  "was mistaken for a statue and left in a garden for some hours",
  "trusted a signpost that had been turned by children",
  "drank from a stream that flowed uphill and thought nothing of it at the time",
  "picked a fight with the weather and was answered",
];

/** Windfalls that buy time rather than equipment. */
export const GODSENDS: readonly string[] = [
  "was handed a purse by a stranger who insisted they had dropped it",
  "found a door in a hill that opened onto the far side of the mountain",
  "was blessed by a passing pilgrim who mistook them for someone important",
  "cleared a debt by answering a riddle nobody had asked them",
  "was carried three days downriver by an unusually agreeable current",
  "woke to find their pack repacked, mended, and slightly heavier",
  "was fed for a week by a village that had misread the prophecy in their favour",
  "traded a rumour for a horse and got the better of it",
  "slept under a tree that dropped exactly the right fruit at exactly the right hour",
  "was pulled from a crowd and given the good seat at a coronation",
  "found the road already swept, the bridge already lowered, the gate already open",
  "beat a bard at cards and took the song as well as the coin",
  "was owed a favour by a god with a long memory and poor accounting",
  "found a shortcut that was, for once, exactly as short as advertised",
  "was healed by a hedge-witch who refused payment on principle",
  "discovered their name already carved into the milestone ahead",
  "inherited a small estate from a relative they cannot place",
  "walked out of a storm into three consecutive days of good weather",
  "was let through the toll gate because the keeper liked their face",
  "found the ferryman in a generous mood, which had never happened before",
];

/** How each fragile slot gets ruined. Completes "<player> ...". */
export const ITEM_CALAMITY: Record<ItemSlot, string> = {
  ring: "let their ring go through the wash",
  amulet: "cracked the stone in their amulet on a doorframe",
  charm: "dropped their charm down a well and fished it out with a stick",
  weapon: "left their weapon out in the rain to think about what it had done",
  helm: "used their helm as a cooking pot, then as a bucket, then as a helm again",
  tunic: "washed their tunic in water hot enough to offend it",
  gloves: "wore their gloves to move something that was still on fire",
  leggings: "snagged their leggings on every fence between here and the coast",
  shield: "used their shield as a sledge and the hill as a whetstone",
  boots: "walked their boots through a river of something that was not water",
};

/** How each fragile slot gets improved. */
export const ITEM_GODSEND: Record<ItemSlot, string> = {
  ring: "had their ring resized by a jeweller who owed the gods a favour",
  amulet: "let their amulet swallow a bolt of lightning whole",
  charm: "had their charm blessed by a cleric with nothing better to do",
  weapon: "sat up all night putting a proper edge on their weapon",
  helm: "had their helm lined with something soft and improbably tough",
  tunic: "had a spell of rigidity laid over their tunic by a bored magician",
  gloves: "had their gloves oiled and stitched by a saddler of some skill",
  leggings: "had their leggings reinforced against the exact thing that got them last time",
  shield: "had their shield rebound in a hide nobody could name",
  boots: "had their boots resoled by a cobbler who works only at night",
};

/** Timed quests. Completes "... have been chosen by the gods to ...". */
export const TIMED_QUESTS: readonly string[] = [
  "sit with the last speaker of a dying language until the grammar is written down",
  "carry a sealed letter to a lighthouse that has not been lit in forty years",
  "count the bells of the drowned city and report which one is missing",
  "keep a candle alight from dusk to dawn on the windiest headland in the realm",
  "escort a very old tortoise back to the beach where it was hatched",
  "argue the case for spring before a court of extremely literal frost giants",
  "stand watch over a bridge nobody uses on the one night somebody might",
  "return a borrowed constellation to the sky it was taken from",
  "talk a dragon out of a grudge it has been polishing for two centuries",
  "witness a treaty between two villages that agree on everything except a fence",
  "sing the harvest through, badly, because the good singers have all left",
  "find out what the well is answering, and whether anyone has been asking",
  "guard a door that opens only inward, from the side that has no handle",
  "walk the perimeter of a forest that has been getting larger when unobserved",
  "deliver an apology four generations late to whoever is left to receive it",
];

/** Map quests. Same sentence frame; the waypoints are generated, not written. */
export const MAP_QUESTS: readonly string[] = [
  "chase a rumour of open water to its source and then to its mouth",
  "follow the old pilgrim road to its two remaining waystones",
  "carry fire from the eastern shrine to the western one without letting it out",
  "retrace the route of a caravan that set out and never arrived",
  "visit both ends of a wall and determine which side it was built to keep out",
  "deliver one half of a key to each of two people who no longer speak",
  "walk the length of a river that has changed its mind twice",
  "confirm that the second lighthouse exists at all",
  "take the census of two villages that each believe they are the only one",
  "find where the road stops, and then find where it starts again",
];

/** Hand of God, when it is kind. Completes "the hand of God carried <player> ...". */
export const HOG_MERCY: readonly string[] = [
  "the heavens opened and something enormous and gentle took them a long way",
  "a hand the size of a weather front closed around them and set them down further on",
  "the sky leaned down, considered them, and approved",
];

/** Hand of God, when it is not. */
export const HOG_WRATH: readonly string[] = [
  "a single finger came down out of a clear sky and pressed",
  "the heavens declined to explain, and simply undid some of the walking",
  "something looked at them the way one looks at an ant on a map",
];
