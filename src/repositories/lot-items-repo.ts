import { nowIso } from '../utils/dates';
import { newId } from '../utils/ids';
import type { LotItemRecord } from '../domain/types';
import {
  validateLotItemInput,
  validateLotItemVariants,
  type LotItemInput,
} from '../domain/validators';
import { appendAudit } from '../db/audit';
import type { PokemonTrackerDB } from '../db/database';
import {
  listLive,
  restoreRecord,
  softDeleteRecord,
} from '../db/soft-delete';

export interface LotItemsRepo {
  create(input: LotItemInput): Promise<LotItemRecord>;
  get(id: string): Promise<LotItemRecord | undefined>;
  list(): Promise<LotItemRecord[]>;
  listLive(): Promise<LotItemRecord[]>;
  listByLotId(lotId: string): Promise<LotItemRecord[]>;
  update(id: string, changes: Partial<LotItemInput>): Promise<LotItemRecord>;
  softDelete(id: string, reason?: string): Promise<void>;
  restore(id: string, reason?: string): Promise<void>;
}

export function createLotItemsRepo(db: PokemonTrackerDB): LotItemsRepo {
  return {
    async create(input) {
      validateLotItemInput(input);
      const card = (await db.cards.get(input.cardId)) ?? null;
      validateLotItemVariants(input, { card });
      const now = nowIso();
      const record: LotItemRecord = {
        ...input,
        id: newId(),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      await db.lotItems.add(record);
      await appendAudit(db, {
        action: 'lot_item_created',
        entityType: 'lotItem',
        entityId: record.id,
        message: `added card ${record.cardId} to lot ${record.lotId}`,
      });
      return record;
    },

    async get(id) {
      return db.lotItems.get(id);
    },

    async list() {
      return db.lotItems.toArray();
    },

    async listLive() {
      return listLive(db.lotItems);
    },

    async listByLotId(lotId) {
      return db.lotItems.where('lotId').equals(lotId).toArray();
    },

    async update(id, changes) {
      const existing = await db.lotItems.get(id);
      if (existing === undefined) {
        throw new Error(`lotItem ${id} not found`);
      }
      const merged: LotItemRecord = {
        ...existing,
        ...changes,
        id: existing.id,
        createdAt: existing.createdAt,
        deletedAt: existing.deletedAt,
        updatedAt: nowIso(),
      };
      validateLotItemInput(merged);
      const card = (await db.cards.get(merged.cardId)) ?? null;
      validateLotItemVariants(merged, { card });
      await db.lotItems.put(merged);
      await appendAudit(db, {
        action: 'lot_item_updated',
        entityType: 'lotItem',
        entityId: id,
        message: `updated lot item ${id}`,
      });
      return merged;
    },

    async softDelete(id, reason) {
      await softDeleteRecord(
        db,
        db.lotItems,
        'lotItem',
        id,
        reason ?? 'soft-deleted lot item',
      );
    },

    async restore(id, reason) {
      await restoreRecord(
        db,
        db.lotItems,
        'lotItem',
        id,
        reason ?? 'restored lot item',
      );
    },
  };
}
