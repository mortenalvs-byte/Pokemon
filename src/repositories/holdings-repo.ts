// User-owned. Soft delete only. Validation runs before every write. Every
// mutation appends an audit entry.

import { nowIso } from '../utils/dates';
import { newId } from '../utils/ids';
import type { HoldingRecord } from '../domain/types';
import {
  validateHoldingInput,
  type HoldingInput,
} from '../domain/validators';
import { appendAudit } from '../db/audit';
import type { PokemonTrackerDB } from '../db/database';
import {
  listLive,
  restoreRecord,
  softDeleteRecord,
} from '../db/soft-delete';

export interface HoldingsRepo {
  create(input: HoldingInput): Promise<HoldingRecord>;
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
