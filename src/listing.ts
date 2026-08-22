import type { Availability, ProductMetadata } from "./target.js";

/**
 * Presenting what we can read about a Target listing.
 *
 * Live stock and price are unreadable without defeating a CAPTCHA (see
 * targetapi.ts), so in practice these render the *static* half: title, purchase
 * limit, seller, release date. Every line is conditional, which is the whole
 * point -- an unknown price is omitted rather than shown as "$undefined" or,
 * worse, as a confident wrong number.
 *
 * Pure, with type-only imports, so the suite can drive it without a build.
 */

/**
 * Flags a preorder whose release is still ahead.
 *
 * "In stock" on an unreleased preorder is true and also not what someone woken
 * at 3am assumes it means, so the message says which it is.
 */
export function streetDateNote(meta: ProductMetadata, now: number): string | undefined {
  if (!meta.streetDate) return undefined;
  const at = Date.parse(`${meta.streetDate}T00:00:00Z`);
  if (Number.isNaN(at)) return undefined;

  const days = Math.round((at - now) / 86_400_000);
  if (days > 0) return `preorder — releases in ${days} day${days === 1 ? "" : "s"} (${meta.streetDate})`;
  if (days === 0) return `releases today (${meta.streetDate})`;
  return undefined;
}

/** The facts worth putting in front of someone deciding whether to sprint. */
export function describeListing(
  meta: ProductMetadata,
  avail: Availability,
  now: number,
): string[] {
  const lines: string[] = [];

  if (avail.unitPrice !== undefined) lines.push(`$${avail.unitPrice.toFixed(2)} each`);
  if (meta.purchaseLimit !== undefined) lines.push(`limit ${meta.purchaseLimit} per order`);

  if (avail.marketplace === true || (meta.relationshipTypeCode && meta.relationshipTypeCode !== "SA")) {
    // Called out rather than filtered: a third-party listing is exactly the
    // case where the price matters, so it belongs in front of you, not hidden.
    lines.push(`⚠️ third-party seller${avail.sellerName ? ` — ${avail.sellerName}` : ""}`);
  } else if (meta.relationshipTypeCode === "SA" || avail.marketplace === false) {
    lines.push("sold by Target");
  }

  if (avail.atpQuantity !== undefined) lines.push(`${avail.atpQuantity} available`);

  const street = streetDateNote(meta, now);
  if (street) lines.push(street);

  return lines;
}
