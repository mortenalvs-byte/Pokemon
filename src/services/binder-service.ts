// Binder creation service. Wraps the binder + binderSlots stores so that
// creating a binder is atomic: the binder row, every slot, and the
// audit entry land in one Dexie transaction. If anything throws midway
// through, the transaction rolls back and IndexedDB never sees a
// half-built binder.
//
// Two creation paths live here:
//
//   - createManualBinder(input)
//       Generates `totalPages * slotsPerPage` empty slots
//       (`status='empty'`, `targetCardId=null`).
//
//   - createBinderFromSet({ binder, slots })
//       Used by PR 8b's from-set wizard. The wizard runs
//       `binder-template.generateFromSetSlots()` against the cards
//       fetched for the chosen set and hands the result here. The
//       service derives `totalPages` from the slot drafts so the
//       binder's metadata always matches what was actually written.
//       Master-mode reverse-holo template slots arrive with
//       `note = REVERSE_HOLO_TEMPLATE_MARKER` already set; the service
//       does not interpret the marker — that is the UI's job.

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
import type { SlotDraft } from '../domain/binder-template';

export interface FromSetBinderInput {
  /**
   * Binder fields the wizard collected. `totalPages` is overwritten to
   * `Math.ceil(slots.length / slotsPerPage)` so the persisted binder
   * always matches the actual slot population. `sourceSetId` is
   * required and must be the id of the cached set that produced the
   * drafts.
   */
  readonly binder: Omit<BinderInput, 'totalPages'> & {
    readonly sourceSetId: string;
  };
  readonly slots: readonly SlotDraft[];
}

export interface BinderService {
  /**
   * Create a binder and its `totalPages * slotsPerPage` empty slots in a
   * single transaction. Returns the persisted binder + slots.
   */
  createManualBinder(input: BinderInput): Promise<{
    binder: BinderRecord;
    slots: BinderSlotRecord[];
  }>;

  /**
   * Create a binder pre-populated with target slots for every card in a
   * set (or every card + reverse holo for master mode). Atomic: binder
   * row, every slot, and one `binder_created` audit row land in one
   * Dexie transaction.
   */
  createBinderFromSet(input: FromSetBinderInput): Promise<{
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

    async createBinderFromSet(fromSetInput) {
      if (fromSetInput.slots.length === 0) {
        throw new Error('createBinderFromSet requires at least one slot');
      }
      const totalPages = Math.max(
        1,
        Math.ceil(fromSetInput.slots.length / fromSetInput.binder.slotsPerPage),
      );
      const binderInput: BinderInput = {
        name: fromSetInput.binder.name,
        description: fromSetInput.binder.description,
        binderType: fromSetInput.binder.binderType,
        totalPages,
        slotsPerPage: fromSetInput.binder.slotsPerPage,
        completionMode: fromSetInput.binder.completionMode,
        sourceSetId: fromSetInput.binder.sourceSetId,
      };
      validateBinderInput(binderInput);

      const now = nowIso();
      const binder: BinderRecord = {
        ...binderInput,
        id: newId(),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };

      const slots: BinderSlotRecord[] = [];
      for (const draft of fromSetInput.slots) {
        const slotInput = {
          binderId: binder.id,
          pageNumber: draft.pageNumber,
          slotNumber: draft.slotNumber,
          targetCardId: draft.targetCardId,
          holdingId: null,
          status: 'wanted' as const,
          note: draft.note,
        };
        // Validate before opening the transaction so a bad shape never
        // produces a half-rolled-back side effect on auditLog.
        validateBinderSlotInput(slotInput, binderInput.slotsPerPage);
        slots.push({
          ...slotInput,
          id: newId(),
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
      }

      await db.transaction(
        'rw',
        db.binders,
        db.binderSlots,
        db.auditLog,
        async () => {
          await db.binders.add(binder);
          await db.binderSlots.bulkAdd(slots);
          await appendAudit(db, {
            action: 'binder_created',
            entityType: 'binder',
            entityId: binder.id,
            message: `created from-set binder "${binder.name}" (mode=${binderInput.completionMode}, set=${fromSetInput.binder.sourceSetId}) with ${slots.length} target slots`,
          });
        },
      );

      return { binder, slots };
    },
  };
}
