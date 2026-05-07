import { nowIso } from '../utils/dates';
import { newId } from '../utils/ids';
import type { BinderSlotRecord } from '../domain/types';
import {
  validateBinderSlotInput,
  type BinderSlotInput,
} from '../domain/validators';
import { appendAudit } from '../db/audit';
import type { PokemonTrackerDB } from '../db/database';
import {
  listLive,
  restoreRecord,
  softDeleteRecord,
} from '../db/soft-delete';

export interface BinderSlotsRepo {
  create(
    input: BinderSlotInput,
    slotsPerPage: 9 | 18,
  ): Promise<BinderSlotRecord>;
  createMany(
    inputs: readonly BinderSlotInput[],
    slotsPerPage: 9 | 18,
  ): Promise<BinderSlotRecord[]>;
  get(id: string): Promise<BinderSlotRecord | undefined>;
  list(): Promise<BinderSlotRecord[]>;
  listLive(): Promise<BinderSlotRecord[]>;
  listByBinderId(binderId: string): Promise<BinderSlotRecord[]>;
  update(
    id: string,
    changes: Partial<BinderSlotInput>,
    slotsPerPage: 9 | 18,
  ): Promise<BinderSlotRecord>;
  softDelete(id: string, reason?: string): Promise<void>;
  restore(id: string, reason?: string): Promise<void>;
}

export function createBinderSlotsRepo(db: PokemonTrackerDB): BinderSlotsRepo {
  return {
    async create(input, slotsPerPage) {
      validateBinderSlotInput(input, slotsPerPage);
      const record = buildSlot(input);
      await db.binderSlots.add(record);
      await appendAudit(db, {
        action: 'binder_slot_created',
        entityType: 'binderSlot',
        entityId: record.id,
        message: `slot p${record.pageNumber}/${record.slotNumber} of binder ${record.binderId}`,
      });
      return record;
    },

    async createMany(inputs, slotsPerPage) {
      for (const input of inputs) {
        validateBinderSlotInput(input, slotsPerPage);
      }
      const records = inputs.map(buildSlot);
      await db.binderSlots.bulkAdd(records);
      // One audit entry per bulk creation, not per slot, to keep the log
      // readable when generating a binder from a 200+ card set.
      const first = records[0];
      if (first !== undefined) {
        await appendAudit(db, {
          action: 'binder_slots_bulk_created',
          entityType: 'binder',
          entityId: first.binderId,
          message: `created ${records.length} slots`,
        });
      }
      return records;
    },

    async get(id) {
      return db.binderSlots.get(id);
    },

    async list() {
      return db.binderSlots.toArray();
    },

    async listLive() {
      return listLive(db.binderSlots);
    },

    async listByBinderId(binderId) {
      return db.binderSlots.where('binderId').equals(binderId).toArray();
    },

    async update(id, changes, slotsPerPage) {
      const existing = await db.binderSlots.get(id);
      if (existing === undefined) {
        throw new Error(`binderSlot ${id} not found`);
      }
      const merged: BinderSlotRecord = {
        ...existing,
        ...changes,
        id: existing.id,
        binderId: existing.binderId,
        createdAt: existing.createdAt,
        deletedAt: existing.deletedAt,
        updatedAt: nowIso(),
      };
      validateBinderSlotInput(merged, slotsPerPage);
      await db.binderSlots.put(merged);

      // Audit precedence: an assignment (holdingId set to a real id) is the
      // most meaningful event, so it wins even when status also changes.
      // A bare status flip (e.g. wanted -> ordered) is the next most
      // interesting; everything else is a generic update.
      const action =
        changes.holdingId !== undefined && changes.holdingId !== null
          ? 'binder_slot_assigned'
          : changes.status !== undefined
            ? 'binder_slot_status_changed'
            : 'binder_slot_updated';
      await appendAudit(db, {
        action,
        entityType: 'binderSlot',
        entityId: id,
        message: `slot p${merged.pageNumber}/${merged.slotNumber} status=${merged.status}`,
      });
      return merged;
    },

    async softDelete(id, reason) {
      await softDeleteRecord(
        db,
        db.binderSlots,
        'binderSlot',
        id,
        reason ?? 'soft-deleted binder slot',
      );
    },

    async restore(id, reason) {
      await restoreRecord(
        db,
        db.binderSlots,
        'binderSlot',
        id,
        reason ?? 'restored binder slot',
      );
    },
  };
}

function buildSlot(input: BinderSlotInput): BinderSlotRecord {
  const now = nowIso();
  return {
    ...input,
    id: newId(),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}
