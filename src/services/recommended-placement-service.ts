// PR 28 — bulk safe placement service. Walks every ambiguous row in
// a `MasterGapReport` whose best-copy overlay says `recommended`,
// reads the slot + holding fresh from the repo (so a stale report
// never lets us write through outdated data), and assigns via PR
// 24's `assignHoldingToSlot`. We never touch `binderSlotsRepo.update`
// directly — the assignment contract (cardId match, finish gate,
// one-holding-one-slot) lives in PR 24 and stays the single source
// of truth.
//
// Failures are recorded individually and never abort the loop. The
// caller (master-gap view) shows a summary chip with placed /
// skipped / failed counts so the user can see exactly what
// happened.

import {
  assignHoldingToSlot,
  loadAssignedHoldingIdsSnapshot,
} from './binder-assignment-service';
import type { BinderAssignmentDeps } from './binder-assignment-service';
import type {
  MasterGapReport,
  MasterGapRow,
} from '../domain/master-set-gap';
import type { SlotsPerPage } from '../domain/types';

export interface PlaceRecommendedResult {
  readonly placed: ReadonlyArray<{
    readonly slotId: string;
    readonly holdingId: string;
  }>;
  readonly skippedManualRequired: number;
  readonly skippedNoRecommendation: number;
  readonly failed: ReadonlyArray<{
    readonly slotId: string;
    readonly reason: string;
  }>;
}

export interface PlaceRecommendedInput {
  readonly report: MasterGapReport;
  readonly deps: BinderAssignmentDeps;
}

/**
 * Place every safe best-copy recommendation from `report`.
 *
 * Skips:
 *   - Non-ambiguous rows (only `ambiguous_owned` qualifies).
 *   - `manual_required` and `no_candidates` rows.
 *   - Rows whose `recommendedHoldingId` is null (defensive — should
 *     not happen for `recommended`, but the guard makes the intent
 *     explicit).
 *
 * Failures (slot deleted, holding deleted, contract violation) are
 * recorded with their reason and do not stop processing.
 */
export async function placeRecommendedForReport(
  input: PlaceRecommendedInput,
): Promise<PlaceRecommendedResult> {
  const placed: Array<{ slotId: string; holdingId: string }> = [];
  const failed: Array<{ slotId: string; reason: string }> = [];
  let skippedManualRequired = 0;
  let skippedNoRecommendation = 0;

  // Cache the binder.slotsPerPage so we don't re-read the binder for
  // every row in the same binder.
  const slotsPerPageByBinder = new Map<string, SlotsPerPage>();

  // PR 38a — Pre-load the assigned-holdings snapshot ONCE. Each
  // assignHoldingToSlot call below trusts this set via the
  // `context.assignedHoldingIds` argument so it can skip its own
  // `binderSlotsRepo.listLive()`. We maintain the set after each
  // successful placement (replace previous slot.holdingId with the
  // new holdingId) so the one-holding-one-slot invariant from PR 24
  // stays correctly enforced inside the batch. Closes
  // F-PERF-LISTLIVE-N-PLUS-1: bulk path drops from O(N · slots) to
  // O(N + slots).
  const assignedHoldingIds = await loadAssignedHoldingIdsSnapshot(input.deps);

  for (const row of input.report.rows) {
    const decision = classifyRowForBulk(row);
    if (decision === 'skip-not-ambiguous') continue;
    if (decision === 'skip-no-recommendation') {
      skippedNoRecommendation += 1;
      continue;
    }
    if (decision === 'skip-manual-required') {
      skippedManualRequired += 1;
      continue;
    }
    // decision === 'place'
    const holdingId = row.bestCopyRecommendation?.recommendedHoldingId;
    if (holdingId === null || holdingId === undefined) {
      skippedNoRecommendation += 1;
      continue;
    }

    try {
      // Re-read slot + holding from the repo. The cached report can
      // go stale between render and click — e.g. another action
      // already filled the slot. Always trust the live state, never
      // the snapshot.
      const slot = await input.deps.binderSlotsRepo.get(row.slotId);
      if (slot === undefined || slot.deletedAt !== null) {
        failed.push({
          slotId: row.slotId,
          reason: 'Slot finnes ikke lenger.',
        });
        continue;
      }
      const holding = await input.deps.holdingsRepo.get(holdingId);
      if (holding === undefined || holding.deletedAt !== null) {
        failed.push({
          slotId: row.slotId,
          reason: 'Anbefalt holding finnes ikke lenger.',
        });
        continue;
      }
      let slotsPerPage = slotsPerPageByBinder.get(slot.binderId);
      if (slotsPerPage === undefined) {
        const binder = await input.deps.bindersRepo.get(slot.binderId);
        if (binder === undefined || binder.deletedAt !== null) {
          failed.push({
            slotId: row.slotId,
            reason: 'Permen finnes ikke lenger.',
          });
          continue;
        }
        slotsPerPage = binder.slotsPerPage as SlotsPerPage;
        slotsPerPageByBinder.set(slot.binderId, slotsPerPage);
      }
      await assignHoldingToSlot(input.deps, slot, holding, slotsPerPage, {
        assignedHoldingIds,
      });
      // PR 38a — maintain the snapshot for the next iteration. If the
      // slot already held a different holding, that holding is now
      // free; if the slot was blank, nothing to remove. Always add the
      // new holdingId.
      if (slot.holdingId !== null && slot.holdingId !== holdingId) {
        assignedHoldingIds.delete(slot.holdingId);
      }
      assignedHoldingIds.add(holdingId);
      placed.push({ slotId: row.slotId, holdingId });
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : 'Ukjent feil.';
      failed.push({ slotId: row.slotId, reason: message });
    }
  }

  return {
    placed,
    skippedManualRequired,
    skippedNoRecommendation,
    failed,
  };
}

type BulkRowDecision =
  | 'place'
  | 'skip-not-ambiguous'
  | 'skip-manual-required'
  | 'skip-no-recommendation';

function classifyRowForBulk(row: MasterGapRow): BulkRowDecision {
  if (row.status !== 'ambiguous_owned') return 'skip-not-ambiguous';
  const rec = row.bestCopyRecommendation;
  if (rec === null) return 'skip-no-recommendation';
  if (rec.status === 'manual_required') return 'skip-manual-required';
  if (rec.status === 'no_candidates') return 'skip-no-recommendation';
  if (rec.recommendedHoldingId === null) return 'skip-no-recommendation';
  return 'place';
}
