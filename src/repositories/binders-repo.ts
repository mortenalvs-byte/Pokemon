import { nowIso } from '../utils/dates';
import { newId } from '../utils/ids';
import type { BinderRecord } from '../domain/types';
import {
  validateBinderInput,
  type BinderInput,
} from '../domain/validators';
import { appendAudit } from '../db/audit';
import type { PokemonTrackerDB } from '../db/database';
import {
  listLive,
  restoreRecord,
  softDeleteRecord,
} from '../db/soft-delete';

export interface BindersRepo {
  create(input: BinderInput): Promise<BinderRecord>;
  get(id: string): Promise<BinderRecord | undefined>;
  list(): Promise<BinderRecord[]>;
  listLive(): Promise<BinderRecord[]>;
  update(id: string, changes: Partial<BinderInput>): Promise<BinderRecord>;
  softDelete(id: string, reason?: string): Promise<void>;
  restore(id: string, reason?: string): Promise<void>;
}

export function createBindersRepo(db: PokemonTrackerDB): BindersRepo {
  return {
    async create(input) {
      validateBinderInput(input);
      const now = nowIso();
      const record: BinderRecord = {
        ...input,
        id: newId(),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      await db.binders.add(record);
      await appendAudit(db, {
        action: 'binder_created',
        entityType: 'binder',
        entityId: record.id,
        message: `created binder "${record.name}"`,
      });
      return record;
    },

    async get(id) {
      return db.binders.get(id);
    },

    async list() {
      return db.binders.toArray();
    },

    async listLive() {
      return listLive(db.binders);
    },

    async update(id, changes) {
      const existing = await db.binders.get(id);
      if (existing === undefined) {
        throw new Error(`binder ${id} not found`);
      }
      const merged: BinderRecord = {
        ...existing,
        ...changes,
        id: existing.id,
        createdAt: existing.createdAt,
        deletedAt: existing.deletedAt,
        updatedAt: nowIso(),
      };
      validateBinderInput(merged);
      await db.binders.put(merged);
      await appendAudit(db, {
        action: 'binder_updated',
        entityType: 'binder',
        entityId: id,
        message: `updated binder "${merged.name}"`,
      });
      return merged;
    },

    async softDelete(id, reason) {
      await softDeleteRecord(
        db,
        db.binders,
        'binder',
        id,
        reason ?? 'soft-deleted binder',
      );
    },

    async restore(id, reason) {
      await restoreRecord(
        db,
        db.binders,
        'binder',
        id,
        reason ?? 'restored binder',
      );
    },
  };
}
