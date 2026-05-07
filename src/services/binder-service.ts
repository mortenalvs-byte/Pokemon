// Binder creation service. Wraps the binder + binderSlots stores so that
// creating a manual binder is atomic: the binder row, every empty slot
// (`totalPages * slotsPerPage` of them) and the audit entry land in one
// Dexie transaction. If anything throws midway through, the transaction
// rolls back and IndexedDB never sees a half-built binder.
//
// PR 8a only ships manual binders. The "from-set" wizard that pre-fills
// `targetCardId` for each slot lives in PR 8b and will reuse the same
// transactional shape — just with non-null `targetCardId` values and a
// different audit message.

import { appendAudit } from '../db/audit';
import type { PokemonTrackerDB } from '../db/database';
import { nowIso } from '../utils/dates';
import { newId } from '../utils/ids';
import {
  validateBinderInput,
  validateBinderSlotInput,
  type BinderInput,
} from '../domain/validators';
import type {
  BinderRecord,
  BinderSlotRecord,
} from '../domain/types';

export interface BinderService {
  /**
   * Create a binder and its `totalPages * slotsPerPage` empty slots in a
   * single transaction. Returns the persisted binder + slots.
   */
  createManualBinder(input: BinderInput): Promise<{
    binder: BinderRecord;
    slots: BinderSlotRecord[];
  }>;
}

export function createBinderService(db: PokemonTrackerDB): BinderService {
  return {
    async createManualBinder(input) {
      validateBinderInput(input);

      const now = nowIso();
      const binder: BinderRecord = {
        ...input,
        id: newId(),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };

      const slots: BinderSlotRecord[] = [];
      for (let page = 1; page <= input.totalPages; page += 1) {
        for (let slot = 1; slot <= input.slotsPerPage; slot += 1) {
          const slotInput = {
            binderId: binder.id,
            pageNumber: page,
            slotNumber: slot,
            targetCardId: null,
            holdingId: null,
            status: 'empty' as const,
            note: null,
          };
          // Validate before opening the transaction so a bad shape never
          // produces a half-rolled-back side effect on auditLog.
          validateBinderSlotInput(slotInput, input.slotsPerPage);
          slots.push({
            ...slotInput,
            id: newId(),
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          });
        }
      }

      await db.transaction(
        'rw',
        db.binders,
        db.binderSlots,
        db.auditLog,
        async () => {
          await db.binders.add(binder);
          if (slots.length > 0) {
            await db.binderSlots.bulkAdd(slots);
          }
          await appendAudit(db, {
            action: 'binder_created',
            entityType: 'binder',
            entityId: binder.id,
            message: `created manual binder "${binder.name}" with ${slots.length} empty slots`,
          });
        },
      );

      return { binder, slots };
    },
  };
}
