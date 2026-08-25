import { GODS, RACES } from "./content.js";
import { find } from "./engine.js";
import {
  CRATE_PRICE,
  coin,
  godSwitchCost,
  rollItem,
  sacrificeValue,
  sellValue,
} from "./rules.js";
import type { Ctx } from "./engine.js";
import type { Character, GameState, GodId, Item, Listing, Rarity } from "./types.js";

/**
 * Coin, gods, and the ways value moves between players.
 *
 * Split from engine.ts because that file is the adventure loop and this one is
 * everything the loop's output can be spent on. Both are pure over injected
 * randomness and neither knows what Discord is.
 */

export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };

function ok<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

function no<T>(reason: string): Outcome<T> {
  return { ok: false, reason };
}

const NO_CHARACTER = "You have no character yet. `/idlerpg start` makes one.";

/** Pulls an item out of a character's backpack by its number. */
function takeFromPack(character: Character, itemId: number): Item | null {
  const index = character.backpack.findIndex((i) => i.id === itemId);
  if (index === -1) return null;
  return (character.backpack.splice(index, 1) as [Item])[0];
}

// ------------------------------------------------------------------- gods ---

export interface FollowResult {
  god: GodId;
  cost: number;
  previous: GodId | null;
  favorKept: number;
}

/**
 * Swears to a god, or changes gods.
 *
 * Changing costs half your favour, paid in coin, and keeps the favour itself.
 * Charging in the currency the player has been accumulating -- rather than
 * simply deleting it -- makes switching a real decision without ever undoing
 * work somebody has already done.
 */
export function followGod(
  state: GameState,
  userId: string,
  god: GodId,
): Outcome<FollowResult> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);
  if (!GODS[god]) return no("No such god.");
  if (character.god === god) return no(`You already follow ${GODS[god].title}.`);

  const cost = character.god ? godSwitchCost(character) : 0;
  if (character.money < cost) {
    return no(
      `Leaving ${GODS[character.god as GodId].title} costs ${coin(cost)} — half your favour, ` +
        `in coin. You have ${coin(character.money)}.`,
    );
  }

  const previous = character.god;
  character.money -= cost;
  character.god = god;
  return ok({ god, cost, previous, favorKept: character.favor });
}

export interface SacrificeResult {
  items: Item[];
  favor: number;
  total: number;
}

/**
 * Gives items to your god in exchange for favour, which buys better odds.
 *
 * This is why a good drop in the wrong slot is interesting. Without an altar
 * every unwearable item is simply coin, and the only question is how fast you
 * walk to the shop.
 */
export function sacrifice(
  state: GameState,
  userId: string,
  itemIds: number[],
): Outcome<SacrificeResult> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);
  if (!character.god) return no("You follow no god. `/idlerpg god follow` picks one.");
  if (itemIds.length === 0) return no("Name at least one item.");

  const items: Item[] = [];
  for (const id of itemIds) {
    const item = takeFromPack(character, id);
    if (item) items.push(item);
  }
  if (items.length === 0) return no("None of those are in your backpack.");

  const favor = items.reduce((sum, item) => sum + sacrificeValue(item), 0);
  character.favor += favor;
  return ok({ items, favor, total: character.favor });
}

// ------------------------------------------------------------------ store ---

export interface PurchaseResult {
  rarity: Rarity;
  count: number;
  paid: number;
}

export function buyCrates(
  state: GameState,
  userId: string,
  rarity: Rarity,
  count: number,
): Outcome<PurchaseResult> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);
  if (!Number.isInteger(count) || count < 1) return no("Buy at least one.");

  const price = CRATE_PRICE[rarity];
  if (price === undefined) return no("No such crate.");
  const paid = price * count;
  if (character.money < paid) {
    return no(`That costs ${coin(paid)}. You have ${coin(character.money)}.`);
  }

  character.money -= paid;
  character.crates[rarity] += count;
  return ok({ rarity, count, paid });
}

// ----------------------------------------------------------- transactions ---

export interface GiftResult {
  from: Character;
  to: Character;
  money: number;
  item: Item | null;
}

/**
 * Hands coin or an item to another player.
 *
 * No fee and no cooldown. This is a game played among people who know each
 * other, and taxing generosity between friends to protect an economy nobody is
 * farming would be solving a problem that does not exist here.
 */
export function give(
  state: GameState,
  fromId: string,
  toId: string,
  options: { money?: number; itemId?: number },
): Outcome<GiftResult> {
  const from = find(state, fromId);
  const to = find(state, toId);
  if (!from) return no(NO_CHARACTER);
  if (!to) return no("They have no character.");
  if (from.userId === to.userId) return no("You cannot give things to yourself.");

  const money = options.money ?? 0;
  if (money < 0 || !Number.isInteger(money)) return no("Coin must be a whole number.");
  if (money > from.money) return no(`You only have ${coin(from.money)}.`);

  let item: Item | null = null;
  if (options.itemId !== undefined) {
    item = takeFromPack(from, options.itemId);
    if (!item) return no(`You have no item #${options.itemId} in your backpack.`);
    to.backpack.push(item);
  }
  if (money === 0 && !item) return no("Give something: coin, an item, or both.");

  from.money -= money;
  to.money += money;
  return ok({ from, to, money, item });
}

// ---------------------------------------------------------------- trading ---

export const MARKET_MIN_PRICE = 1;
/** Listings any one player may have open. Keeps the board readable. */
export const MARKET_MAX_PER_PLAYER = 5;

export function listForSale(
  state: GameState,
  userId: string,
  itemId: number,
  price: number,
  ctx: Ctx,
): Outcome<Listing> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);
  if (!Number.isInteger(price) || price < MARKET_MIN_PRICE) {
    return no(`Price must be a whole number, at least ${MARKET_MIN_PRICE}.`);
  }
  const mine = state.market.filter((l) => l.sellerId === userId).length;
  if (mine >= MARKET_MAX_PER_PLAYER) {
    return no(`You already have ${mine} listings. Take one down first.`);
  }

  const item = takeFromPack(character, itemId);
  if (!item) return no(`You have no item #${itemId} in your backpack.`);

  const listing: Listing = {
    id: state.nextListingId,
    sellerId: userId,
    item,
    price,
    listedAt: ctx.now,
  };
  state.nextListingId += 1;
  state.market.push(listing);
  return ok(listing);
}

export interface BuyResult {
  listing: Listing;
  seller: Character | null;
}

export function buyListing(
  state: GameState,
  userId: string,
  listingId: number,
): Outcome<BuyResult> {
  const buyer = find(state, userId);
  if (!buyer) return no(NO_CHARACTER);

  const index = state.market.findIndex((l) => l.id === listingId);
  if (index === -1) return no(`Listing #${listingId} is gone.`);

  const listing = state.market[index] as Listing;
  if (listing.sellerId === userId) return no("That is your own listing.");
  if (buyer.money < listing.price) {
    return no(`That costs ${coin(listing.price)}. You have ${coin(buyer.money)}.`);
  }

  state.market.splice(index, 1);
  buyer.money -= listing.price;
  buyer.backpack.push(listing.item);

  // The seller may have been deleted since listing; the coin is simply not
  // paid rather than the sale failing, so a stale listing cannot wedge the board.
  const seller = find(state, listing.sellerId);
  if (seller) seller.money += listing.price;
  return ok({ listing, seller });
}

export function unlist(state: GameState, userId: string, listingId: number): Outcome<Listing> {
  const character = find(state, userId);
  if (!character) return no(NO_CHARACTER);

  const index = state.market.findIndex((l) => l.id === listingId && l.sellerId === userId);
  if (index === -1) return no(`You have no listing #${listingId}.`);

  const [listing] = state.market.splice(index, 1) as [Listing];
  character.backpack.push(listing.item);
  return ok(listing);
}

/** Cheapest first, so the board reads as a market rather than a log. */
export function browse(state: GameState, limit: number): Listing[] {
  return [...state.market].sort((a, b) => a.price - b.price).slice(0, limit);
}

export { RACES, sellValue, rollItem };
