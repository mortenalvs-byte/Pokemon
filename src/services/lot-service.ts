// Lot service. Two atomic write paths live here:
//
//   - applyAllocation(lotId)
//       Runs the pure allocation engine over live, NOT-yet-materialized
//       items. Materialized items (holdingId !== null) keep their
//       existing allocatedCost. The engine is given
//       `remainingTotalCost = lot.totalCost - sum(allocatedCost of
//       materialized live items)` so unmaterialized items split the
//       remaining cost, not the whole lot.
//       Writes one `lot_allocation_applied` audit row plus a bulkPut of
//       the affected lotItems in a single Dexie transaction. Per-item
//       `lot_item_updated` audits are deliberately skipped — the bulk
//       audit row reflects the higher-level operation.
//
//   - materializeHoldings(lotId)
//       Builds HoldingRecord[] for every live item where
//       `holdingId === null` and `allocatedCost !== null`, validates
//       every input BEFORE opening the transaction, then atomically
//       bulkAdds the holdings, bulkPuts the lot items with their new
//       holdingId, and writes one `lot_holdings_materialized` audit
//       row. Per-holding `holding_created` audits are deliberately
//       skipped — the bulk audit captures the operation.
//
// Both paths are idempotent. Materialize re-runs skip already-
// materialized items; if there is nothing to do the service is a no-op
// and writes no audit row.

import { appendAudit } from '../db/audit';
import type { PokemonTrackerDB } from '../db/database';
import { allocateLot, round2 } from '../domain/lot-allocation';
import type { AllocationResult } from '../domain/lot-allocation';
import {
  validateHoldingInput,
  validateHoldingVariants,
  type HoldingInput,
} from '../domain/validators';
import type { HoldingRecord, LotItemRecord, LotRecord } from '../domain/types';
import { nowIso } from '../utils/dates';
import { newId } from '../utils/ids';

export interface ApplyAllocationResult {
  readonly lot: LotRecord;
  readonly allocation: AllocationResult;
  readonly applied: boolean;
  readonly updatedItems: readonly LotItemRecord[];
}

export interface MaterializeResult {
  readonly created: readonly HoldingRecord[];
  readonly updatedItems: readonly LotItemRecord[];
  /** True if there was nothing to materialize (no audit row written). */
  readonly noop: boolean;
  /**
   * Number of items the caller asked us to materialise but skipped
   * because they were already materialised (`holdingId !== null`).
   * Useful for surfacing "5 items var allerede i samlingen" feedback.
   */
  readonly skippedAlreadyMaterialised: number;
  /**
   * Number of items the caller asked us to materialise but skipped
   * because they were not in the lot's live items (e.g. a stale id
   * from an older snapshot of the lot). 0 in normal flows.
   */
  readonly skippedNotFound: number;
}

export interface MaterializeOptions {
  /**
   * PR 18 — when present, only the listed lot-item ids are candidates
   * for materialisation. Items already materialised are still skipped
   * (the operation stays idempotent). When absent, every
   * unmaterialised live item in the lot is materialised — this is the
   * "Legg hele loten i samling" path.
   */
  readonly itemIds?: readonly string[];
}

export interface LotService {
  applyAllocation(lotId: string): Promise<ApplyAllocationResult>;
  materializeHoldings(
    lotId: string,
    options?: MaterializeOptions,
  ): Promise<MaterializeResult>;
}

export function createLotService(db: PokemonTrackerDB): LotService {
  return {
    async applyAllocation(lotId) {
      const lot = await db.lots.get(lotId);
      if (lot === undefined || lot.deletedAt !== null) {
        throw new Error(`lot ${lotId} not found or soft-deleted`);
      }

      const liveItems = (
        await db.lotItems.where('lotId').equals(lotId).toArray()
      ).filter((i) => i.deletedAt === null);

      const materialized = liveItems.filter((i) => i.holdingId !== null);
      const candidates = liveItems.filter((i) => i.holdingId === null);

      const lockedCost = round2(
        materialized.reduce((acc, i) => acc + (i.allocatedCost ?? 0), 0),
      );
      const remainingTotalCost = round2(lot.totalCost - lockedCost);

      if (remainingTotalCost < -0.01) {
        // Materialised items already account for more than the lot
        // total — any allocation now would have to be negative. Bail
        // out without writing.
        return {
          lot,
          allocation: {
            status: 'error',
            allocations: [],
            totalAllocated: lockedCost,
            residual: round2(lot.totalCost - lockedCost),
            warnings: [],
            errors: [
              `Materialised items already account for more than lot.totalCost ` +
                `(${lockedCost.toFixed(2)} > ${lot.totalCost.toFixed(2)})`,
            ],
          },
          applied: false,
          updatedItems: [],
        };
      }

      const allocation = allocateLot(
        {
          totalCost: remainingTotalCost,
          allocationMethod: lot.allocationMethod,
          currency: lot.currency,
        },
        candidates,
      );

      // Errors block writes; warnings do not.
      if (allocation.status === 'error') {
        return { lot, allocation, applied: false, updatedItems: [] };
      }

      const allocationByItemId = new Map<string, number>();
      for (const a of allocation.allocations) {
        allocationByItemId.set(a.itemId, a.allocatedCost);
      }

      const now = nowIso();
      const updated: LotItemRecord[] = candidates.map((item) => ({
        ...item,
        allocatedCost: allocationByItemId.get(item.id) ?? null,
        updatedAt: now,
      }));

      await db.transaction('rw', db.lotItems, db.auditLog, async () => {
        if (updated.length > 0) {
          await db.lotItems.bulkPut(updated);
        }
        await appendAudit(db, {
          action: 'lot_allocation_applied',
          entityType: 'lot',
          entityId: lot.id,
          message: `applied ${lot.allocationMethod} to lot "${lot.name}" (${updated.length} items, total=${remainingTotalCost.toFixed(2)} ${lot.currency})`,
        });
      });

      return { lot, allocation, applied: true, updatedItems: updated };
    },

    async materializeHoldings(lotId, options) {
      const lot = await db.lots.get(lotId);
      if (lot === undefined || lot.deletedAt !== null) {
        throw new Error(`lot ${lotId} not found or soft-deleted`);
      }

      const liveItems = (
        await db.lotItems.where('lotId').equals(lotId).toArray()
      ).filter((i) => i.deletedAt === null);

      const liveItemsById = new Map<string, LotItemRecord>();
      for (const item of liveItems) liveItemsById.set(item.id, item);

      // PR 18 — partial materialise. When the caller passes `itemIds`,
      // candidates are limited to those ids. Items already materialised
      // (holdingId !== null) are still skipped so the operation remains
      // idempotent regardless of the path. We track skipped counts so
      // the UI can render "X allerede i samlingen" feedback.
      //
      // PR 18 hardening — dedupe `itemIds` BEFORE the lookup so
      // `[i1, i1]` produces exactly one holding (and one
      // `skippedAlreadyMaterialised` count if the caller passes the
      // same materialised id twice). The service must not trust the
      // caller to send unique ids — a future bulk / CSV-import flow
      // could legitimately produce duplicates.
      let skippedAlreadyMaterialised = 0;
      let skippedNotFound = 0;
      let candidatePool: readonly LotItemRecord[];
      if (options?.itemIds !== undefined) {
        const seen = new Set<string>();
        const requested: LotItemRecord[] = [];
        for (const id of options.itemIds) {
          if (seen.has(id)) continue;
          seen.add(id);
          const item = liveItemsById.get(id);
          if (item === undefined) {
            skippedNotFound += 1;
            continue;
          }
          if (item.holdingId !== null) {
            skippedAlreadyMaterialised += 1;
            continue;
          }
          requested.push(item);
        }
        candidatePool = requested;
      } else {
        candidatePool = liveItems.filter((i) => i.holdingId === null);
      }

      const candidates = candidatePool;
      if (candidates.length === 0) {
        return {
          created: [],
          updatedItems: [],
          noop: true,
          skippedAlreadyMaterialised,
          skippedNotFound,
        };
      }

      const missingAllocation = candidates.filter(
        (c) => c.allocatedCost === null,
      );
      if (missingAllocation.length > 0) {
        throw new Error(
          `Cannot materialise: ${missingAllocation.length} item(s) have no allocatedCost. Apply allocation first.`,
        );
      }

      const now = nowIso();
      const drafts: { item: LotItemRecord; input: HoldingInput }[] = [];
      for (const item of candidates) {
        const input: HoldingInput = {
          cardId: item.cardId,
          quantity: item.quantity,
          conditionType: item.conditionType,
          rawCondition: item.rawCondition,
          gradingCompany: item.gradingCompany,
          grade: item.grade,
          certNumber: null,
          certUrl: null,
          gradedDate: null,
          finish: item.finish,
          edition: item.edition,
          language: 'en',
          purchasePrice: item.allocatedCost,
          purchaseCurrency: lot.currency,
          estimatedValue: null,
          valueCurrency: null,
          valueSource: 'unknown',
          valueNote: null,
          valueUpdatedAt: null,
          source: 'lot',
          note: item.note,
          // Lot-items already enforce strict variant validation; if the
          // item used an escape-hatch finish/edition, it had a manual
          // marker (note) which we propagate. specialVariant=true here
          // when the item is missing a note, so the holding clears
          // strict variant validation by the same rule.
          specialVariant: item.note === null || item.note.trim().length === 0,
          tags: [],
          lotId: lot.id,
          status: 'owned',
        };
        validateHoldingInput(input);
        // Same strict variant rule as the holdings repo runs: a lot
        // item with finish/edition that the API doesn't list will have
        // already failed at lot-item create, so this is a defence in
        // depth that catches legacy lot items imported via JSON
        // restore from before PR 11.
        const card = (await db.cards.get(item.cardId)) ?? null;
        validateHoldingVariants(input, { card });
        drafts.push({ item, input });
      }

      const newHoldings: HoldingRecord[] = drafts.map((d) => ({
        ...d.input,
        id: newId(),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }));

      const updatedItems: LotItemRecord[] = drafts.map((d, idx) => {
        const holding = newHoldings[idx];
        if (holding === undefined) {
          // Should never happen — drafts and newHoldings have the same
          // length by construction.
          throw new Error('internal materialise mismatch');
        }
        return {
          ...d.item,
          holdingId: holding.id,
          updatedAt: now,
        };
      });

      await db.transaction(
        'rw',
        db.holdings,
        db.lotItems,
        db.auditLog,
        async () => {
          await db.holdings.bulkAdd(newHoldings);
          await db.lotItems.bulkPut(updatedItems);
          // PR 18 — audit message reflects partial vs full and any
          // already-materialised skips, so the audit log stays
          // diagnosable when the user tries to add the same items
          // twice.
          const partialSuffix = options?.itemIds !== undefined ? ' (selected)' : '';
          const skipSuffix =
            skippedAlreadyMaterialised > 0
              ? `, skipped ${skippedAlreadyMaterialised} already in collection`
              : '';
          await appendAudit(db, {
            action: 'lot_holdings_materialized',
            entityType: 'lot',
            entityId: lot.id,
            message: `materialized ${newHoldings.length} holdings from lot "${lot.name}"${partialSuffix}${skipSuffix}`,
          });
        },
      );

      return {
        created: newHoldings,
        updatedItems,
        noop: false,
        skippedAlreadyMaterialised,
        skippedNotFound,
      };
    },
  };
}
