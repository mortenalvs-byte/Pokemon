import { nowIso } from '../utils/dates';
import { newId } from '../utils/ids';
import type { LotRecord } from '../domain/types';
import { validateLotInput, type LotInput } from '../domain/validators';
import { appendAudit } from '../db/audit';
import type { PokemonTrackerDB } from '../db/database';
import {
  listLive,
  restoreRecord,
  softDeleteRecord,
} from '../db/soft-delete';

export interface LotsRepo {
  create(input: LotInput): Promise<LotRecord>;
  get(id: string): Promise<LotRecord | undefined>;
  list(): Promise<LotRecord[]>;
  listLive(): Promise<LotRecord[]>;
  update(id: string, changes: Partial<LotInput>): Promise<LotRecord>;
  softDelete(id: string, reason?: string): Promise<void>;
  restore(id: string, reason?: string): Promise<void>;
}

export function createLotsRepo(db: PokemonTrackerDB): LotsRepo {
  return {
    async create(input) {
      validateLotInput(input);
      const now = nowIso();
      const record: LotRecord = {
        ...input,
        id: newId(),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      await db.lots.add(record);
      await appendAudit(db, {
        action: 'lot_created',
        entityType: 'lot',
        entityId: record.id,
        message: `created lot "${record.name}"`,
      });
      return record;
    },

    async get(id) {
      return db.lots.get(id);
    },

    async list() {
      return db.lots.toArray();
    },

    async listLive() {
      return listLive(db.lots);
    },

    async update(id, changes) {
      const existing = await db.lots.get(id);
      if (existing === undefined) {
        throw new Error(`lot ${id} not found`);
      }
      const merged: LotRecord = {
        ...existing,
        ...changes,
        id: existing.id,
        createdAt: existing.createdAt,
        deletedAt: existing.deletedAt,
        updatedAt: nowIso(),
      };
      validateLotInput(merged);
      await db.lots.put(merged);
      await appendAudit(db, {
        action: 'lot_updated',
        entityType: 'lot',
        entityId: id,
        message: `updated lot "${merged.name}"`,
      });
      return merged;
    },

    async softDelete(id, reason) {
      await softDeleteRecord(
        db,
        db.lots,
        'lot',
        id,
        reason ?? 'soft-deleted lot',
      );
    },

    async restore(id, reason) {
      await restoreRecord(
        db,
        db.lots,
        'lot',
        id,
        reason ?? 'restored lot',
      );
    },
  };
}
