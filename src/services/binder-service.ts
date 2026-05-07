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
//       Used by the from-set wizard. The wizard runs
//       `binder-template.generateFromSetSlots()` against the cards
//       fetched for the chosen set and hands the drafts here. PR 14
//       changed the contract: the service now mirrors the chosen
//       physical Vault X binder by creating the FULL slot grid (every
//       page × slot in the chosen preset's capacity), placing the
//       target drafts into the first N positions and leaving the
//       rest empty. If the drafts exceed the preset's capacity the
//       service throws a validation error before opening the
//       transaction.
//       Master-mode reverse-holo template slots arrive with
//       `note = REVERSE_HOLO_TEMPLATE_MARKER` already set; the service
//       does not interpret the marker — that is the UI's job.

import { appendAudit } from '../db/audit';
import type { PokemonTrackerDB } from '../db/database';
import { nowIso } from '../utils/dates';
import { newId } from '../utils/ids';
import {
  ValidationError,
  validateBinderInput,
  validateBinderSlotInput,
  type BinderInput,
} from '../domain/validators';
import type {
  BinderRecord,
  BinderSlotRecord,
  SlotsPerPage,
} from '../domain/types';
import type { SlotDraft } from '../domain/binder-template';
import { getBinderPresetDefinition } from '../domain/binder-presets';

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
      const slotsPerPage: SlotsPerPage = fromSetInput.binder.slotsPerPage;
      const preset = fromSetInput.binder.binderPreset;

      // PR 14 — capacity-fill rule. For a Vault X (or legacy) preset
      // the total page count is fixed by the physical product; we
      // create every page × slot in that grid and place the drafts
      // into the first positions. For `custom` (or null preset, e.g.
      // restored old backups) we keep the previous behaviour and
      // size the binder to the drafts.
      let totalPages: number;
      let capacity: number;
      if (preset !== null && preset !== 'custom') {
        const def = getBinderPresetDefinition(preset);
        totalPages = def.totalPages;
        capacity = def.capacity;
        // Guard: sanity-check the preset's slotsPerPage matches what
        // the wizard sent. The validator catches the same case but
        // bailing out early gives a cleaner error.
        if (def.slotsPerPage !== slotsPerPage) {
          throw new ValidationError(
            'slotsPerPage',
            `preset ${preset} requires slotsPerPage=${def.slotsPerPage}`,
          );
        }
      } else {
        totalPages = Math.max(
          1,
          Math.ceil(fromSetInput.slots.length / slotsPerPage),
        );
        capacity = totalPages * slotsPerPage;
      }

      if (fromSetInput.slots.length > capacity) {
        throw new ValidationError(
          'slots',
          `target slots (${fromSetInput.slots.length}) exceed binder capacity (${capacity})`,
        );
      }
      // Reject any draft that points outside the chosen physical
      // grid. The loop below would otherwise silently drop it,
      // which would hide the user's mistake.
      for (const draft of fromSetInput.slots) {
        if (
          !Number.isInteger(draft.pageNumber) ||
          draft.pageNumber < 1 ||
          draft.pageNumber > totalPages ||
          !Number.isInteger(draft.slotNumber) ||
          draft.slotNumber < 1 ||
          draft.slotNumber > slotsPerPage
        ) {
          throw new ValidationError(
            'slots',
            `draft at page=${draft.pageNumber} slot=${draft.slotNumber} is outside the binder grid (${totalPages} pages × ${slotsPerPage} slots)`,
          );
        }
      }

      const binderInput: BinderInput = {
        name: fromSetInput.binder.name,
        description: fromSetInput.binder.description,
        binderType: fromSetInput.binder.binderType,
        totalPages,
        slotsPerPage,
        binderPreset: preset,
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

      // Build a quick lookup keyed by physical position so the drafts
      // map cleanly into the full grid.
      const draftByPosition = new Map<string, SlotDraft>();
      for (const draft of fromSetInput.slots) {
        draftByPosition.set(
          `${draft.pageNumber}:${draft.slotNumber}`,
          draft,
        );
      }

      const slots: BinderSlotRecord[] = [];
      let targetCount = 0;
      for (let page = 1; page <= totalPages; page += 1) {
        for (let slot = 1; slot <= slotsPerPage; slot += 1) {
          const draft = draftByPosition.get(`${page}:${slot}`) ?? null;
          const slotInput = {
            binderId: binder.id,
            pageNumber: page,
            slotNumber: slot,
            targetCardId: draft?.targetCardId ?? null,
            holdingId: null,
            status: (draft !== null ? 'wanted' : 'empty') as
              | 'wanted'
              | 'empty',
            note: draft?.note ?? null,
          };
          validateBinderSlotInput(slotInput, slotsPerPage);
          if (draft !== null) targetCount += 1;
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
          await db.binderSlots.bulkAdd(slots);
          await appendAudit(db, {
            action: 'binder_created',
            entityType: 'binder',
            entityId: binder.id,
            message:
              `created from-set binder "${binder.name}" ` +
              `(mode=${binderInput.completionMode}, ` +
              `set=${fromSetInput.binder.sourceSetId}, ` +
              `preset=${preset ?? 'custom'}) ` +
              `with ${slots.length} slots, ${targetCount} targets`,
          });
        },
      );

      return { binder, slots };
    },
  };
}
