// Pure binder-template generator. Given a list of cards from a set and
// a completion mode, produce the slot drafts that will populate a
// freshly-created binder.
//
// No I/O, no IndexedDB, no DOM. The output is the canonical seed for
// `binderService.createBinderFromSet()` — each draft becomes exactly
// one row in `binderSlots` after the service wraps the writes in a
// single Dexie transaction.
//
// Master-mode behaviour: for every card with a known reverse-holo
// printing (see `card-variants.cardHasReverseHolo`), generate a
// SECOND draft for the same card with `note` set to the reverse-holo
// template marker. `BinderSlotRecord` has no `finish` field, so the
// note field is the only place to record the template variant without
// a schema change. The UI renders this marker as "Reverse holo" and
// never shows the raw token to the user.
//
// `grand_master` is intentionally not accepted — the wizard UI does
// not surface it, and the generator throws so a caller passing it can
// never silently produce an empty template.

import type { CardRecord, CompletionMode } from './types';
import {
  REVERSE_HOLO_TEMPLATE_MARKER,
  cardHasReverseHolo,
} from './card-variants';

export interface SlotDraft {
  readonly pageNumber: number;
  readonly slotNumber: number;
  readonly targetCardId: string;
  readonly note: string | null;
}

export interface TemplateOptions {
  readonly slotsPerPage: 9 | 18;
  readonly completionMode: Exclude<CompletionMode, 'grand_master'>;
  /** Master-only. Ignored when `completionMode === 'standard'`. */
  readonly includeReverseHolos: boolean;
}

export interface TemplateSummary {
  readonly baseSlotCount: number;
  readonly reverseHoloSlotCount: number;
  readonly totalSlotCount: number;
  readonly totalPages: number;
}

export interface TemplateResult {
  readonly slots: readonly SlotDraft[];
  readonly summary: TemplateSummary;
}

export function generateFromSetSlots(
  cards: readonly CardRecord[],
  options: TemplateOptions,
): TemplateResult {
  if (options.slotsPerPage !== 9 && options.slotsPerPage !== 18) {
    throw new Error(
      `slotsPerPage must be 9 or 18, got ${String(options.slotsPerPage)}`,
    );
  }
  // The CompletionMode union still includes `grand_master` for future
  // schema work, but PR 8b refuses it explicitly so a typo or stale
  // form value cannot silently produce an empty template.
  if (
    (options.completionMode as string) !== 'standard' &&
    (options.completionMode as string) !== 'master'
  ) {
    throw new Error(
      `completionMode must be 'standard' or 'master', got ${String(options.completionMode)}`,
    );
  }

  const sorted = [...cards].sort(compareCardsForTemplate);

  const drafts: SlotDraft[] = [];
  let baseSlotCount = 0;
  let reverseHoloSlotCount = 0;

  for (const card of sorted) {
    const baseSlot: Omit<SlotDraft, 'pageNumber' | 'slotNumber'> = {
      targetCardId: card.id,
      note: null,
    };
    drafts.push({
      ...baseSlot,
      ...placeAt(drafts.length, options.slotsPerPage),
    });
    baseSlotCount += 1;

    if (
      options.completionMode === 'master' &&
      options.includeReverseHolos &&
      cardHasReverseHolo(card)
    ) {
      drafts.push({
        targetCardId: card.id,
        note: REVERSE_HOLO_TEMPLATE_MARKER,
        ...placeAt(drafts.length, options.slotsPerPage),
      });
      reverseHoloSlotCount += 1;
    }
  }

  const totalSlotCount = drafts.length;
  const totalPages = Math.max(
    1,
    Math.ceil(totalSlotCount / options.slotsPerPage),
  );

  return {
    slots: drafts,
    summary: {
      baseSlotCount,
      reverseHoloSlotCount,
      totalSlotCount,
      totalPages,
    },
  };
}

/**
 * Stable comparator used both by the generator and (separately) by the
 * checklist view so the on-screen order matches the persisted order.
 *
 * Pokemon TCG card numbers are usually pure integers (`1`, `2`, …, `102`)
 * but special prints use prefixed strings (`TG01`, `SV001`, `H1`).
 * Pure integers sort numerically and come first; prefixed strings sort
 * lexicographically among themselves and come after.
 */
export function compareCardsForTemplate(a: CardRecord, b: CardRecord): number {
  const cmp = compareCardNumbers(a.number, b.number);
  if (cmp !== 0) return cmp;
  // Final tiebreak by id so the comparator is total/stable across runs.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function compareCardNumbers(a: string, b: string): number {
  const aInt = toIntOrNaN(a);
  const bInt = toIntOrNaN(b);
  const aIsInt = Number.isFinite(aInt);
  const bIsInt = Number.isFinite(bInt);
  if (aIsInt && bIsInt) {
    if (aInt !== bInt) return aInt - bInt;
    return a.localeCompare(b);
  }
  if (aIsInt) return -1;
  if (bIsInt) return 1;
  return a.localeCompare(b);
}

function toIntOrNaN(value: string): number {
  if (!/^\d+$/.test(value)) return Number.NaN;
  return Number.parseInt(value, 10);
}

function placeAt(
  index: number,
  slotsPerPage: 9 | 18,
): { pageNumber: number; slotNumber: number } {
  const pageNumber = Math.floor(index / slotsPerPage) + 1;
  const slotNumber = (index % slotsPerPage) + 1;
  return { pageNumber, slotNumber };
}
