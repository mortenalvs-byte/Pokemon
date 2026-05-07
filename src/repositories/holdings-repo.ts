// User-owned. Soft delete only. Validation runs before every write. Every
// mutation appends an audit entry.

import { nowIso } from '../utils/dates';
import { newId } from '../utils/ids';
import type { HoldingRecord } from '../domain/types';
import {
  validateHoldingInput,
  validateHoldingVariants,
  type HoldingInput,
} from '../domain/validators';
import { appendAudit } from '../db/audit';
import type { PokemonTrackerDB } from '../db/database';
import {
  listLive,
  restoreRecord,
  softDeleteRecord,
} from '../db/soft-delete';

/**
 * Result of `upsertByVariant`. `action: 'merged'` means the input
 * matched an existing live holding and quantity was incremented;
 * `previousQuantity` is the holding's quantity *before* the merge so
 * the caller can render "Antall: 4 → 5" feedback. `action: 'created'`
 * means no match was found and a fresh holding row was added.
 */
export interface UpsertHoldingResult {
  readonly holding: HoldingRecord;
  readonly action: 'created' | 'merged';
  readonly previousQuantity?: number;
}

export interface HoldingsRepo {
  create(input: HoldingInput): Promise<HoldingRecord>;
  /**
   * PR 15A — F-7. Quantity-merge when a live holding with the same
   * variant tuple already exists; otherwise create. The match key is
   * documented in `holdingMatchesVariant` below — notes, prices,
   * value-tracking fields and tags are NOT part of the key, so the
   * caller's policy on those fields is preserved on the existing row.
   *
   * Variant validation runs as for `create`, so the unmatched
   * `escape-hatch + note/specialVariant` rule still applies.
   */
  upsertByVariant(input: HoldingInput): Promise<UpsertHoldingResult>;
  get(id: string): Promise<HoldingRecord | undefined>;
  list(): Promise<HoldingRecord[]>;
  listLive(): Promise<HoldingRecord[]>;
  listByCardId(cardId: string): Promise<HoldingRecord[]>;
  update(
    id: string,
    changes: Partial<HoldingInput>,
  ): Promise<HoldingRecord>;
  softDelete(id: string, reason?: string): Promise<void>;
  restore(id: string, reason?: string): Promise<void>;
}

export function createHoldingsRepo(db: PokemonTrackerDB): HoldingsRepo {
  return {
    async create(input) {
      validateHoldingInput(input);
      // Strict variant validation against the cached card. Looks up
      // the card from the local cache (no API call). When the card is
      // not cached, the validator treats it as unverified and forces
      // the user into the escape-hatch path.
      const card = (await db.cards.get(input.cardId)) ?? null;
      validateHoldingVariants(input, { card });
      const now = nowIso();
      const record: HoldingRecord = {
        ...input,
        id: newId(),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      await db.holdings.add(record);
      await appendAudit(db, {
        action: 'holding_created',
        entityType: 'holding',
        entityId: record.id,
        message: `created holding for card ${record.cardId}`,
      });
      return record;
    },

    async upsertByVariant(input) {
      validateHoldingInput(input);
      const card = (await db.cards.get(input.cardId)) ?? null;
      validateHoldingVariants(input, { card });

      // Atomic find-then-write so two concurrent upserts cannot both
      // create a fresh row that then duplicates each other. Looking up
      // by `cardId` uses the existing index; the variant filter is a
      // small in-memory pass over rows for that card.
      return db.transaction(
        'rw',
        db.holdings,
        db.auditLog,
        async (): Promise<UpsertHoldingResult> => {
          const candidates = await db.holdings
            .where('cardId')
            .equals(input.cardId)
            .toArray();
          const existing = candidates.find(
            (h) => h.deletedAt === null && holdingMatchesVariant(h, input),
          );

          if (existing !== undefined) {
            const previousQuantity = existing.quantity;
            const merged: HoldingRecord = {
              ...existing,
              quantity: previousQuantity + input.quantity,
              // Preserve the existing note unless it is empty AND the
              // input carries one. Same rule for prices / values:
              // existing wins.
              note: existing.note ?? input.note,
              updatedAt: nowIso(),
            };
            await db.holdings.put(merged);
            await appendAudit(db, {
              action: 'holding_qty_incremented',
              entityType: 'holding',
              entityId: merged.id,
              message: `merged holding for card ${merged.cardId}: quantity ${previousQuantity} → ${merged.quantity}`,
            });
            return {
              holding: merged,
              action: 'merged',
              previousQuantity,
            };
          }

          const now = nowIso();
          const record: HoldingRecord = {
            ...input,
            id: newId(),
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          };
          await db.holdings.add(record);
          await appendAudit(db, {
            action: 'holding_created',
            entityType: 'holding',
            entityId: record.id,
            message: `created holding for card ${record.cardId} (upsertByVariant)`,
          });
          return { holding: record, action: 'created' };
        },
      );
    },

    async get(id) {
      return db.holdings.get(id);
    },

    async list() {
      return db.holdings.toArray();
    },

    async listLive() {
      return listLive(db.holdings);
    },

    async listByCardId(cardId) {
      return db.holdings.where('cardId').equals(cardId).toArray();
    },

    async update(id, changes) {
      const existing = await db.holdings.get(id);
      if (existing === undefined) {
        throw new Error(`holding ${id} not found`);
      }
      const merged: HoldingRecord = {
        ...existing,
        ...changes,
        id: existing.id,
        createdAt: existing.createdAt,
        deletedAt: existing.deletedAt,
        updatedAt: nowIso(),
      };
      validateHoldingInput(merged);
      // Re-validate variants on update too: a user who edits an old
      // record (or imports legacy data) cannot quietly persist a finish
      // the API doesn't recognise.
      const card = (await db.cards.get(merged.cardId)) ?? null;
      validateHoldingVariants(merged, { card });
      await db.holdings.put(merged);
      await appendAudit(db, {
        action: 'holding_updated',
        entityType: 'holding',
        entityId: id,
        message: `updated holding for card ${merged.cardId}`,
      });
      return merged;
    },

    async softDelete(id, reason) {
      await softDeleteRecord(
        db,
        db.holdings,
        'holding',
        id,
        reason ?? 'soft-deleted holding',
      );
    },

    async restore(id, reason) {
      await restoreRecord(
        db,
        db.holdings,
        'holding',
        id,
        reason ?? 'restored holding',
      );
    },
  };
}

/**
 * Match key for `upsertByVariant`. Two live holdings are considered
 * the same physical-stack when they agree on every field below. Notes,
 * prices, value-tracking fields, gradedDate / certUrl, tags and source
 * are deliberately NOT part of the key — they describe a specific
 * acquisition rather than the variant identity.
 */
function holdingMatchesVariant(
  existing: HoldingRecord,
  input: HoldingInput,
): boolean {
  return (
    existing.cardId === input.cardId &&
    existing.conditionType === input.conditionType &&
    existing.rawCondition === input.rawCondition &&
    existing.gradingCompany === input.gradingCompany &&
    existing.grade === input.grade &&
    // certNumber: a different cert means a different physical card,
    // even when grade + company match.
    existing.certNumber === input.certNumber &&
    existing.finish === input.finish &&
    existing.edition === input.edition &&
    existing.language === input.language &&
    existing.status === input.status &&
    existing.lotId === input.lotId &&
    existing.specialVariant === input.specialVariant
  );
}
