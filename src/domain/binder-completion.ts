// Pure binder-completion math. No I/O, no IndexedDB, deterministic on
// input. The only authoritative implementation of KRAVSPEC §6's
// completion rule:
//
//   A slot counts as complete only when:
//     - status === 'owned'
//     - holdingId !== null
//     - the referenced holding is not soft-deleted
//
// Duplicates / wanted / ordered / missing / upgrade_needed do NOT count
// as complete, even if a holding is assigned. Slots with
// `targetCardId === null` are not part of the completion denominator —
// an empty slot in a manual binder doesn't drag the percentage down.

import type { BinderSlotRecord } from './types';

export interface BinderCompletion {
  readonly totalTargetSlots: number;
  readonly completedSlots: number;
  readonly missingSlots: number;
  /** Whole-number percentage in [0, 100]. */
  readonly percentage: number;
}

export function calculateBinderCompletion(
  slots: readonly BinderSlotRecord[],
  liveHoldingIds: ReadonlySet<string>,
): BinderCompletion {
  let totalTargetSlots = 0;
  let completedSlots = 0;

  for (const slot of slots) {
    if (slot.deletedAt !== null) continue;
    if (slot.targetCardId === null) continue;
    totalTargetSlots += 1;
    if (
      slot.status === 'owned' &&
      slot.holdingId !== null &&
      liveHoldingIds.has(slot.holdingId)
    ) {
      completedSlots += 1;
    }
  }

  const missingSlots = totalTargetSlots - completedSlots;
  const percentage =
    totalTargetSlots === 0
      ? 0
      : Math.round((completedSlots / totalTargetSlots) * 100);

  return { totalTargetSlots, completedSlots, missingSlots, percentage };
}
