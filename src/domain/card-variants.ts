// Card-variant helpers for the binder template generator.
//
// `cardHasReverseHolo(card)` is a narrow runtime check — does the card's
// raw `tcgplayer.prices.reverseHolofoil` price entry exist? It is the
// only signal pokemontcg.io exposes that consistently flags whether a
// reverse-holo printing was produced for a given card. We deliberately
// do not consult `cardmarket` (less reliable for this signal) and do
// not estimate value here — this module is about variant existence,
// not pricing.
//
// PR 8b uses this only when generating master-mode template slots. The
// helper returns `false` for unknown shapes, so a card sitting in the
// cache without TCGplayer data is treated as "no known reverse-holo
// printing" and gets a single template slot instead of two.

import type { CardRecord } from './types';

/**
 * Slot.note marker used to flag a generated reverse-holo template slot.
 *
 * `BinderSlotRecord` has no `finish` field, so we encode the variant
 * in `note` as a stable internal token. The UI renders this as the
 * finish "Reverse holo" and never shows the raw token to the user.
 *
 * Tøm slot in PR 8a preserves `note`, so the marker survives the
 * status-reset round-trip. assign-holding-modal in PR 8a does not
 * touch `note`, so the marker also survives an assignment.
 */
export const REVERSE_HOLO_TEMPLATE_MARKER = 'template:reverse_holo';

export function cardHasReverseHolo(card: CardRecord): boolean {
  const tcgplayer = card.tcgplayer;
  if (!isPlainObject(tcgplayer)) return false;
  const prices = tcgplayer['prices'];
  if (!isPlainObject(prices)) return false;
  const reverseHolofoil = prices['reverseHolofoil'];
  return isPlainObject(reverseHolofoil);
}

export function isReverseHoloTemplateSlot(note: string | null): boolean {
  return note === REVERSE_HOLO_TEMPLATE_MARKER;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
