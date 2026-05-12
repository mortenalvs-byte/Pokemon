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

  // PR 38a (revised) — Pre-load the assigned-holdings count snapshot
  // ONCE. Each assignHoldingToSlot call below trusts this map via the
  // `context.assignedHoldingCounts` argument so it can skip its own
  // `binderSlotsRepo.listLive()`. We maintain the counts after each
  // successful placement (decrement the previous slot.holdingId,
  // increment the new holdingId) so the one-holding-one-slot
  // invariant from PR 24 stays correctly enforced inside the batch.
  // Counts (not just a presence Set) are required to preserve the
  // legacy exclude-slot semantics when pre-existing data already
  // duplicates a holdingId across two live slots. Closes
  // F-PERF-LISTLIVE-N-PLUS-1: bulk path drops from O(N · slots) to
  // O(N + slots).
  const assignedHoldingCounts = await loadAssignedHoldingIdsSnapshot(input.deps);

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
        assignedHoldingCounts,
      });
      // PR 38a (revised) — maintain the counts for the next iteration.
      // If the slot held a previous (different) holding, decrement
      // its count (and drop the key at 0); always increment the new
      // holdingId. A blank slot (slot.holdingId === null) contributes
      // nothing to decrement.
      if (slot.holdingId !== null && slot.holdingId !== holdingId) {
        const prev = assignedHoldingCounts.get(slot.holdingId) ?? 0;
        if (prev <= 1) {
          assignedHoldingCounts.delete(slot.holdingId);
        } else {
          assignedHoldingCounts.set(slot.holdingId, prev - 1);
        }
      }
      // For a same-holding re-assignment (slot.holdingId === holdingId)
      // the count stays at its current value — the slot still holds
      // exactly one copy after the no-op-style write.
      if (slot.holdingId !== holdingId) {
        const cur = assignedHoldingCounts.get(holdingId) ?? 0;
        assignedHoldingCounts.set(holdingId, cur + 1);
      }
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
