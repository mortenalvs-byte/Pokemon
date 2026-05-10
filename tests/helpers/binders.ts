// PR 36 — shared binder-with-slots seeding helper.
//
// Before PR 36, every action-audit-style test built a binder via
// `binderService.createManualBinder(...)` then immediately read
// the slots back via `binderSlotsRepo.listByBinderId(...)` and
// sorted them. The block was identical across files; only the
// `name` / `slotsPerPage` / `totalPages` changed.
//
// `seedBinderWithSlots()` collapses that boilerplate. Returns
// the `BinderRecord` plus the freshly-created slots, sorted by
// (page, slot). Optional `targetCardIds` array assigns
// `targetCardId` + `status: 'wanted'` to the first N slots in
// order, mirroring what tests want when they build a "9-slot
// binder where every slot has a target card".
//
// Pure factory — does not seed cards (use `tests/helpers/cards.ts`)
// or holdings (use `tests/helpers/holdings.ts`).

import type {
  BinderPreset,
  BinderRecord,
  BinderSlotRecord,
  CompletionMode,
  SlotsPerPage,
} from '../../src/domain/types';
import { createBinderService } from '../../src/services/binder-service';
import { createBinderSlotsRepo } from '../../src/repositories/binder-slots-repo';
import type { PokemonTrackerDB } from '../../src/db/database';

export interface SeedBinderOptions {
  readonly name?: string;
  readonly slotsPerPage?: SlotsPerPage;
  readonly totalPages?: number;
  readonly binderPreset?: BinderPreset | null;
  readonly completionMode?: CompletionMode;
  readonly description?: string | null;
  readonly binderType?: string | null;
  readonly sourceSetId?: string | null;
  /**
   * Optional list of card ids to assign as `targetCardId` on the
   * first N slots in (page, slot) order. The slot's `status` is
   * flipped to `'wanted'` to match what `master-set-gap`
   * classification expects.
   */
  readonly targetCardIds?: readonly string[];
}

export interface SeededBinder {
  readonly binder: BinderRecord;
  readonly slots: readonly BinderSlotRecord[];
}

export async function seedBinderWithSlots(
  db: PokemonTrackerDB,
  options: SeedBinderOptions = {},
): Promise<SeededBinder> {
  const created = await createBinderService(db).createManualBinder({
    name: options.name ?? 'Test binder',
    description: options.description ?? null,
    binderType: options.binderType ?? null,
    totalPages: options.totalPages ?? 1,
    slotsPerPage: options.slotsPerPage ?? 9,
    binderPreset: options.binderPreset ?? null,
    completionMode: options.completionMode ?? 'standard',
    sourceSetId: options.sourceSetId ?? null,
  });

  const slotsRepo = createBinderSlotsRepo(db);
  const sorted = (await slotsRepo.listByBinderId(created.binder.id)).sort(
    (a, b) =>
      a.pageNumber !== b.pageNumber
        ? a.pageNumber - b.pageNumber
        : a.slotNumber - b.slotNumber,
  );

  const slotsPerPage = options.slotsPerPage ?? 9;
  if (options.targetCardIds && options.targetCardIds.length > 0) {
    for (let i = 0; i < options.targetCardIds.length; i += 1) {
      const slot = sorted[i];
      const cardId = options.targetCardIds[i];
      if (slot === undefined || cardId === undefined) {
        throw new Error(
          `seedBinderWithSlots: targetCardIds[${i}] cannot be applied — only ${sorted.length} slots exist`,
        );
      }
      await slotsRepo.update(
        slot.id,
        { targetCardId: cardId, status: 'wanted', note: null },
        slotsPerPage,
      );
    }
  }

  // Re-read so callers see the post-update slot state.
  const finalSlots = (await slotsRepo.listByBinderId(created.binder.id)).sort(
    (a, b) =>
      a.pageNumber !== b.pageNumber
        ? a.pageNumber - b.pageNumber
        : a.slotNumber - b.slotNumber,
  );

  return { binder: created.binder, slots: finalSlots };
}
