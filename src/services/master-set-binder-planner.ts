// Pure planner: pack the master-set slots of N Pokemon sets into the
// minimum number of `vaultx_16xxl_1088` physical binders, while keeping
// each set as a continuous logical section.
//
// Hard correctness rules (locked):
//   - A physical binder may contain multiple sets, but a logical slot
//     belongs to exactly one set and exactly one target card.
//   - Cards are matched by `card.id` and grouped by `card.setId`; never
//     by name, number, art, or apparent duplicate.
//   - Reverse-holo / master template slots stay inside the same section
//     as their base card (the underlying `generateFromSetSlots` keeps the
//     two slots adjacent in its draft list).
//
// Physical rules:
//   - Only `vaultx_16xxl_1088` is used. Capacity 1088, 16 slots/page,
//     68 pages.
//   - Each new set starts on a fresh page. The remainder of the previous
//     page is left empty when needed.
//   - When the next set will not fit in the current binder, a new binder
//     is opened and the entire set is placed there.
//   - A set bigger than 1088 (rare; legendary collections) is split
//     across binders — each binder gets one continuous section, the
//     split happens only at the binder boundary.
//
// Side-effect boundary: this module performs zero I/O. The output is a
// plan that the UI can show, the operator can approve, and a future
// write path can turn into real `binders` + `binderSlots` rows by
// calling `binderService.createBinderFromSet` (or a multi-set variant)
// per binder in the plan.

import { generateFromSetSlots, type SlotDraft } from '../domain/binder-template';
import { getBinderPresetDefinition } from '../domain/binder-presets';
import type {
  BinderPreset,
  CardRecord,
  SetRecord,
  SlotsPerPage,
} from '../domain/types';

export const MASTER_SET_BINDER_PRESET = 'vaultx_16xxl_1088' as const satisfies BinderPreset;

const PRESET_DEF = getBinderPresetDefinition(MASTER_SET_BINDER_PRESET);
const CAPACITY = PRESET_DEF.capacity; // 1088
const SLOTS_PER_PAGE = PRESET_DEF.slotsPerPage as SlotsPerPage; // 16
const TOTAL_PAGES = PRESET_DEF.totalPages; // 68

/**
 * A re-mapped slot inside a physical binder. `pageNumber` / `slotNumber`
 * are coordinates within the multi-set binder, not within the original
 * single-set template the slot came from.
 */
export interface MasterSetSlotPlan {
  readonly pageNumber: number;
  readonly slotNumber: number;
  readonly targetCardId: string;
  readonly note: string | null;
}

/**
 * One continuous block of slots inside one physical binder, dedicated to
 * exactly one set. A set may span multiple sections (one per binder)
 * only when its own slot count exceeds 1088.
 */
export interface MasterSetSectionPlan {
  readonly setId: string;
  readonly setName: string;
  readonly series: string;
  readonly releaseDate: string;
  /** 1-indexed page of the first slot in this section. */
  readonly startPage: number;
  /** 1-indexed slot-within-page of the first slot. */
  readonly startSlot: number;
  /** 1-indexed page of the last slot. */
  readonly endPage: number;
  /** 1-indexed slot-within-page of the last slot. */
  readonly endSlot: number;
  readonly baseSlotCount: number;
  readonly reverseHoloSlotCount: number;
  readonly totalSlotCount: number;
  /** True when this section is a continuation of the same set from the
   *  previous binder (i.e. the set exceeds 1088 slots). */
  readonly continuedFromPreviousBinder: boolean;
  /** True when this section is continued in the next binder. */
  readonly continuesIntoNextBinder: boolean;
  /** Re-mapped slot drafts, ready to write to `binderSlots`. */
  readonly slots: readonly MasterSetSlotPlan[];
}

export interface MasterSetBinderPlan {
  /** 1-indexed binder position in the plan. */
  readonly binderIndex: number;
  readonly preset: typeof MASTER_SET_BINDER_PRESET;
  readonly capacity: number;
  readonly slotsPerPage: number;
  readonly totalPages: number;
  readonly sections: readonly MasterSetSectionPlan[];
  /** Slots actually occupied by target cards (no empties). */
  readonly usedSlotCount: number;
  /**
   * Every empty slot in the 1088-grid, including mid-page gaps left
   * by the page-boundary rule between sections — not just trailing
   * empties after the last section. Always equals
   * `capacity - usedSlotCount`.
   */
  readonly unusedSlotCount: number;
}

export interface MasterSetSkippedSet {
  readonly setId: string;
  readonly reason: 'no_cards_in_cache' | 'empty_template';
}

export interface MasterSetPlanInput {
  readonly sets: readonly SetRecord[];
  readonly cardsBySetId: ReadonlyMap<string, readonly CardRecord[]>;
  /** Default true (master mode). When false, only base cards get slots. */
  readonly includeReverseHolos?: boolean;
}

export interface MasterSetPlanResult {
  readonly binders: readonly MasterSetBinderPlan[];
  readonly skippedSets: readonly MasterSetSkippedSet[];
  readonly totalSetCount: number;
  readonly totalCardCount: number;
  readonly totalSlotCount: number;
}

interface SectionSpec {
  readonly set: SetRecord;
  readonly drafts: readonly SlotDraft[];
}

/**
 * Build the binder plan. Pure: same input → same output, no I/O.
 *
 * Complexity is O(C + S log S) where C = total cards across all sets
 * and S = number of sets. Each card is touched once in
 * `generateFromSetSlots`; sorting sets adds the log factor.
 */
export function buildMasterSetPlan(
  input: MasterSetPlanInput,
): MasterSetPlanResult {
  const includeReverseHolos = input.includeReverseHolos ?? true;

  const orderedSets = orderSetsForPlanning(input.sets);

  const sectionSpecs: SectionSpec[] = [];
  const skippedSets: MasterSetSkippedSet[] = [];
  let totalCardCount = 0;

  for (const set of orderedSets) {
    const cards = input.cardsBySetId.get(set.id);
    if (cards === undefined || cards.length === 0) {
      skippedSets.push({ setId: set.id, reason: 'no_cards_in_cache' });
      continue;
    }
    totalCardCount += cards.length;
    const template = generateFromSetSlots(cards, {
      slotsPerPage: SLOTS_PER_PAGE,
      completionMode: 'master',
      includeReverseHolos,
    });
    if (template.slots.length === 0) {
      skippedSets.push({ setId: set.id, reason: 'empty_template' });
      continue;
    }
    sectionSpecs.push({ set, drafts: template.slots });
  }

  const binders = packSectionsIntoBinders(sectionSpecs);

  const totalSlotCount = binders.reduce((sum, b) => sum + b.usedSlotCount, 0);

  return {
    binders,
    skippedSets,
    totalSetCount: sectionSpecs.length,
    totalCardCount,
    totalSlotCount,
  };
}

/**
 * Series order is determined by the EARLIEST `releaseDate` among the
 * series' sets. Within a series, sets sort by `releaseDate` ascending,
 * with `setId` as a deterministic tiebreaker.
 */
function orderSetsForPlanning(
  sets: readonly SetRecord[],
): readonly SetRecord[] {
  const seriesEarliest = new Map<string, string>();
  for (const s of sets) {
    const existing = seriesEarliest.get(s.series);
    if (existing === undefined || s.releaseDate < existing) {
      seriesEarliest.set(s.series, s.releaseDate);
    }
  }
  return [...sets].sort((a, b) => {
    const aSeries = seriesEarliest.get(a.series) ?? '';
    const bSeries = seriesEarliest.get(b.series) ?? '';
    if (aSeries !== bSeries) return aSeries < bSeries ? -1 : 1;
    if (a.series !== b.series) {
      return a.series < b.series ? -1 : 1;
    }
    if (a.releaseDate !== b.releaseDate) {
      return a.releaseDate < b.releaseDate ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * The packing core. Uses a flat 0-indexed cursor inside each binder; the
 * remap to (pageNumber, slotNumber) only happens when emitting the final
 * `MasterSetSlotPlan` objects.
 */
function packSectionsIntoBinders(
  sectionSpecs: readonly SectionSpec[],
): readonly MasterSetBinderPlan[] {
  const binders: MasterSetBinderPlan[] = [];
  let currentBinderSections: MasterSetSectionPlan[] = [];
  let currentCursor = 0; // 0-indexed flat slot inside the current binder

  const openNewBinder = (): void => {
    if (currentBinderSections.length > 0) {
      binders.push(finishBinder(binders.length + 1, currentBinderSections));
    }
    currentBinderSections = [];
    currentCursor = 0;
  };

  for (const spec of sectionSpecs) {
    // Always start a set on a fresh page. If we're mid-page, advance to
    // the start of the next page; that leaves the remainder of the page
    // empty inside the physical binder.
    currentCursor = advanceToNextPage(currentCursor);
    if (currentCursor >= CAPACITY) {
      openNewBinder();
    }

    let remainingDrafts = spec.drafts;
    let continuedFromPrevBinder = false;

    while (remainingDrafts.length > 0) {
      const availableSlotsInBinder = CAPACITY - currentCursor;

      // Decision: does the WHOLE remaining set fit here?
      if (remainingDrafts.length <= availableSlotsInBinder) {
        const section = buildSection(
          spec.set,
          remainingDrafts,
          currentCursor,
          /* continuedFromPrev */ continuedFromPrevBinder,
          /* continuesIntoNext */ false,
        );
        currentBinderSections.push(section);
        currentCursor += remainingDrafts.length;
        remainingDrafts = [];
        continue;
      }

      // It does not fit. If the set as a whole would fit in a fresh
      // binder AND we have not yet started splitting, prefer the
      // cleaner "whole set in next binder" path.
      if (
        !continuedFromPrevBinder &&
        spec.drafts.length <= CAPACITY &&
        availableSlotsInBinder < CAPACITY
      ) {
        openNewBinder();
        currentCursor = 0;
        // Re-enter loop; the whole set now fits in the fresh binder.
        continue;
      }

      // The set is genuinely larger than 1088 (or we already started
      // splitting because it had to). Fill the current binder, mark it
      // "continues into next", and open a new binder.
      if (availableSlotsInBinder > 0) {
        const chunk = remainingDrafts.slice(0, availableSlotsInBinder);
        const section = buildSection(
          spec.set,
          chunk,
          currentCursor,
          continuedFromPrevBinder,
          /* continuesIntoNext */ true,
        );
        currentBinderSections.push(section);
        currentCursor += chunk.length;
        remainingDrafts = remainingDrafts.slice(availableSlotsInBinder);
        continuedFromPrevBinder = true;
      }

      openNewBinder();
      // The next loop iteration places the remainder in the fresh binder.
    }
  }

  if (currentBinderSections.length > 0) {
    binders.push(
      finishBinder(binders.length + 1, currentBinderSections),
    );
  }

  return binders;
}

function advanceToNextPage(cursor: number): number {
  const remainder = cursor % SLOTS_PER_PAGE;
  if (remainder === 0) return cursor;
  return cursor + (SLOTS_PER_PAGE - remainder);
}

function buildSection(
  set: SetRecord,
  drafts: readonly SlotDraft[],
  sectionStart: number,
  continuedFromPreviousBinder: boolean,
  continuesIntoNextBinder: boolean,
): MasterSetSectionPlan {
  const lastPos = sectionStart + drafts.length - 1;

  let baseSlotCount = 0;
  let reverseHoloSlotCount = 0;
  const slots: MasterSetSlotPlan[] = new Array(drafts.length);
  for (let i = 0; i < drafts.length; i += 1) {
    const d = drafts[i];
    if (d === undefined) continue;
    const pos = sectionStart + i;
    slots[i] = {
      pageNumber: Math.floor(pos / SLOTS_PER_PAGE) + 1,
      slotNumber: (pos % SLOTS_PER_PAGE) + 1,
      targetCardId: d.targetCardId,
      note: d.note,
    };
    if (d.note === null) baseSlotCount += 1;
    else reverseHoloSlotCount += 1;
  }

  return {
    setId: set.id,
    setName: set.name,
    series: set.series,
    releaseDate: set.releaseDate,
    startPage: Math.floor(sectionStart / SLOTS_PER_PAGE) + 1,
    startSlot: (sectionStart % SLOTS_PER_PAGE) + 1,
    endPage: Math.floor(lastPos / SLOTS_PER_PAGE) + 1,
    endSlot: (lastPos % SLOTS_PER_PAGE) + 1,
    baseSlotCount,
    reverseHoloSlotCount,
    totalSlotCount: drafts.length,
    continuedFromPreviousBinder,
    continuesIntoNextBinder,
    slots,
  };
}

function finishBinder(
  binderIndex: number,
  sections: readonly MasterSetSectionPlan[],
): MasterSetBinderPlan {
  // `usedSlotCount` counts every section's target slots; the rest of
  // the 1088-grid is physically empty in the binder we will write —
  // including the mid-page gaps the page-boundary rule leaves between
  // sections. The earlier cursor-based count missed those gaps.
  const usedSlotCount = sections.reduce((s, sec) => s + sec.totalSlotCount, 0);
  return {
    binderIndex,
    preset: MASTER_SET_BINDER_PRESET,
    capacity: CAPACITY,
    slotsPerPage: SLOTS_PER_PAGE,
    totalPages: TOTAL_PAGES,
    sections,
    usedSlotCount,
    unusedSlotCount: CAPACITY - usedSlotCount,
  };
}
