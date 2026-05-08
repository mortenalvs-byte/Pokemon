// PR 24 — binder-assignment-service. Pure repo-driven tests over a
// fresh DB. No UI, no event-loop coupling. Covers:
//   - per-slot candidate lookup (target / blank / soft-deleted /
//     finish-aware reverse template)
//   - assign-write contract (cardId match, finish gate, target backfill)
//   - bulk auto-assign (1:1 deterministic, ambiguous skip,
//     never-overwrite-owned, never-touch-blank, no double-assign)
//   - direct-add (target slot only, holding+slot atomicity rollback)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REVERSE_HOLO_TEMPLATE_MARKER,
  SlotAssignmentError,
  assignHoldingToSlot,
  autoAssignBinder,
  createHoldingForSlotAndAssign,
  findAssignableHoldingsForSlot,
} from '../src/services/binder-assignment-service';
import { createBindersRepo } from '../src/repositories/binders-repo';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { makeCard } from './helpers/cards';
import type {
  BinderRecord,
  BinderSlotRecord,
  SetRecord,
  SlotsPerPage,
} from '../src/domain/types';
import type { HoldingInput } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

const baseSet: SetRecord = {
  id: 'base1',
  name: 'Base',
  series: 'Base',
  printedTotal: 102,
  total: 102,
  releaseDate: '1999-01-09',
  symbolUrl: null,
  logoUrl: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

function holdingInput(overrides: Partial<HoldingInput> = {}): HoldingInput {
  return {
    cardId: 'base1-4',
    quantity: 1,
    conditionType: 'raw',
    rawCondition: 'NM',
    gradingCompany: null,
    grade: null,
    certNumber: null,
    certUrl: null,
    gradedDate: null,
    finish: 'normal',
    edition: 'unlimited',
    language: 'en',
    purchasePrice: null,
    purchaseCurrency: null,
    estimatedValue: null,
    valueCurrency: null,
    valueSource: 'unknown',
    valueNote: null,
    valueUpdatedAt: null,
    source: 'manual',
    note: null,
    specialVariant: false,
    tags: [],
    lotId: null,
    status: 'owned',
    ...overrides,
  };
}

function buildDeps(db: PokemonTrackerDB) {
  return {
    bindersRepo: createBindersRepo(db),
    binderSlotsRepo: createBinderSlotsRepo(db),
    holdingsRepo: createHoldingsRepo(db),
    cardsRepo: createCardsRepo(db),
  };
}

const SLOTS_PER_PAGE: SlotsPerPage = 9;

describe('binder-assignment-service (PR 24)', () => {
  let db: PokemonTrackerDB;
  let binder: BinderRecord;

  beforeEach(async () => {
    db = await freshDb();
    await createSetsRepo(db).upsert(baseSet);
    await createCardsRepo(db).upsert(
      makeCard('base1-4', { overrides: { name: 'Charizard', number: '4' } }),
    );
    await createCardsRepo(db).upsert(
      makeCard('base1-58', { overrides: { name: 'Pikachu', number: '58' } }),
    );
    binder = await createBindersRepo(db).create({
      name: 'Test binder',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: SLOTS_PER_PAGE,
      binderPreset: 'custom',
      completionMode: 'master',
      sourceSetId: null,
    });
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  async function makeSlot(
    overrides: Partial<{
      pageNumber: number;
      slotNumber: number;
      targetCardId: string | null;
      holdingId: string | null;
      status: BinderSlotRecord['status'];
      note: string | null;
    }> = {},
  ): Promise<BinderSlotRecord> {
    return createBinderSlotsRepo(db).create(
      {
        binderId: binder.id,
        pageNumber: overrides.pageNumber ?? 1,
        slotNumber: overrides.slotNumber ?? 1,
        // Use `in`-check so `targetCardId: null` (explicit blank slot)
        // doesn't fall back to the default cardId via `??`.
        targetCardId:
          'targetCardId' in overrides
            ? (overrides.targetCardId as string | null)
            : 'base1-4',
        holdingId: overrides.holdingId ?? null,
        status: overrides.status ?? 'wanted',
        note: overrides.note ?? null,
      },
      SLOTS_PER_PAGE,
    );
  }

  // -- findAssignableHoldingsForSlot --------------------------------

  it('target slot with one matching holding → 1 candidate', async () => {
    const deps = buildDeps(db);
    const h = await deps.holdingsRepo.create(holdingInput());
    const slot = await makeSlot();
    const cands = await findAssignableHoldingsForSlot(deps, slot);
    expect(cands).toHaveLength(1);
    expect(cands[0]?.holding.id).toBe(h.id);
  });

  it('target slot with wrong-card holding → 0 candidates', async () => {
    const deps = buildDeps(db);
    await deps.holdingsRepo.create(holdingInput({ cardId: 'base1-58' }));
    const slot = await makeSlot({ targetCardId: 'base1-4' });
    expect(await findAssignableHoldingsForSlot(deps, slot)).toEqual([]);
  });

  it('blank slot returns 0 candidates (use modal instead)', async () => {
    const deps = buildDeps(db);
    await deps.holdingsRepo.create(holdingInput());
    const slot = await makeSlot({ targetCardId: null, status: 'empty' });
    expect(await findAssignableHoldingsForSlot(deps, slot)).toEqual([]);
  });

  it('already-owned slot returns 0 candidates', async () => {
    const deps = buildDeps(db);
    const h = await deps.holdingsRepo.create(holdingInput());
    const slot = await makeSlot({ holdingId: h.id, status: 'owned' });
    expect(await findAssignableHoldingsForSlot(deps, slot)).toEqual([]);
  });

  it('soft-deleted holding is ignored', async () => {
    const deps = buildDeps(db);
    const h = await deps.holdingsRepo.create(holdingInput());
    await deps.holdingsRepo.softDelete(h.id);
    const slot = await makeSlot();
    expect(await findAssignableHoldingsForSlot(deps, slot)).toEqual([]);
  });

  it('reverse-holo template slot only accepts reverse_holo finish', async () => {
    const deps = buildDeps(db);
    await deps.holdingsRepo.create(holdingInput({ finish: 'normal' }));
    const reverseHolding = await deps.holdingsRepo.create(
      holdingInput({ finish: 'reverse_holo' }),
    );
    const slot = await makeSlot({
      note: REVERSE_HOLO_TEMPLATE_MARKER,
    });
    const cands = await findAssignableHoldingsForSlot(deps, slot);
    expect(cands).toHaveLength(1);
    expect(cands[0]?.holding.id).toBe(reverseHolding.id);
  });

  // -- assignHoldingToSlot -----------------------------------------

  it('assignHoldingToSlot rejects holding for the wrong target card', async () => {
    const deps = buildDeps(db);
    const h = await deps.holdingsRepo.create(holdingInput({ cardId: 'base1-58' }));
    const slot = await makeSlot({ targetCardId: 'base1-4' });
    await expect(
      assignHoldingToSlot(deps, slot, h, SLOTS_PER_PAGE),
    ).rejects.toBeInstanceOf(SlotAssignmentError);
    const refreshed = await deps.binderSlotsRepo.get(slot.id);
    expect(refreshed?.holdingId).toBeNull();
  });

  it('assignHoldingToSlot rejects non-reverse_holo into reverse template slot', async () => {
    const deps = buildDeps(db);
    const h = await deps.holdingsRepo.create(holdingInput({ finish: 'normal' }));
    const slot = await makeSlot({ note: REVERSE_HOLO_TEMPLATE_MARKER });
    await expect(
      assignHoldingToSlot(deps, slot, h, SLOTS_PER_PAGE),
    ).rejects.toBeInstanceOf(SlotAssignmentError);
  });

  it('assignHoldingToSlot backfills targetCardId on a blank manual slot', async () => {
    const deps = buildDeps(db);
    const h = await deps.holdingsRepo.create(holdingInput({ cardId: 'base1-58' }));
    const blank = await makeSlot({
      targetCardId: null,
      status: 'empty',
      pageNumber: 1,
      slotNumber: 2,
    });
    const updated = await assignHoldingToSlot(deps, blank, h, SLOTS_PER_PAGE);
    expect(updated.holdingId).toBe(h.id);
    expect(updated.targetCardId).toBe('base1-58');
    expect(updated.status).toBe('owned');
  });

  // -- autoAssignBinder --------------------------------------------

  it('one eligible holding → auto-assign sets holdingId + status owned', async () => {
    const deps = buildDeps(db);
    const h = await deps.holdingsRepo.create(holdingInput());
    const slot = await makeSlot();
    const result = await autoAssignBinder(deps, { binderId: binder.id });
    expect(result.assigned).toHaveLength(1);
    expect(result.assigned[0]?.slotId).toBe(slot.id);
    expect(result.assigned[0]?.holdingId).toBe(h.id);
    const refreshed = await deps.binderSlotsRepo.get(slot.id);
    expect(refreshed?.holdingId).toBe(h.id);
    expect(refreshed?.status).toBe('owned');
  });

  it('multiple eligible holdings → skipped ambiguous, no assignment', async () => {
    const deps = buildDeps(db);
    await deps.holdingsRepo.create(holdingInput());
    await deps.holdingsRepo.create(holdingInput({ rawCondition: 'LP' }));
    const slot = await makeSlot();
    const result = await autoAssignBinder(deps, { binderId: binder.id });
    expect(result.assigned).toEqual([]);
    expect(result.skippedAmbiguous).toBe(1);
    const refreshed = await deps.binderSlotsRepo.get(slot.id);
    expect(refreshed?.holdingId).toBeNull();
  });

  it('blank slots are not auto-assigned', async () => {
    const deps = buildDeps(db);
    await deps.holdingsRepo.create(holdingInput());
    await makeSlot({ targetCardId: null, status: 'empty' });
    const result = await autoAssignBinder(deps, { binderId: binder.id });
    expect(result.assigned).toEqual([]);
    expect(result.skippedNoTarget).toBe(1);
  });

  it('already-owned slots are not overwritten', async () => {
    const deps = buildDeps(db);
    const h1 = await deps.holdingsRepo.create(holdingInput());
    const h2 = await deps.holdingsRepo.create(holdingInput({ rawCondition: 'LP' }));
    const slot = await makeSlot({ holdingId: h1.id, status: 'owned' });
    const result = await autoAssignBinder(deps, { binderId: binder.id });
    expect(result.assigned).toEqual([]);
    expect(result.skippedAlreadyOwned).toBe(1);
    const refreshed = await deps.binderSlotsRepo.get(slot.id);
    expect(refreshed?.holdingId).toBe(h1.id);
    void h2;
  });

  it('one holding cannot be auto-assigned to two slots in the same run', async () => {
    const deps = buildDeps(db);
    await deps.holdingsRepo.create(holdingInput());
    await makeSlot({ pageNumber: 1, slotNumber: 1 });
    await makeSlot({ pageNumber: 1, slotNumber: 2 });
    const result = await autoAssignBinder(deps, { binderId: binder.id });
    expect(result.assigned).toHaveLength(1);
    // Second slot saw zero unassigned holdings → skippedNoHolding.
    expect(result.skippedNoHolding).toBe(1);
  });

  it('reverse-holo template slot does not auto-assign normal holding', async () => {
    const deps = buildDeps(db);
    await deps.holdingsRepo.create(holdingInput({ finish: 'normal' }));
    await makeSlot({ note: REVERSE_HOLO_TEMPLATE_MARKER });
    const result = await autoAssignBinder(deps, { binderId: binder.id });
    expect(result.assigned).toEqual([]);
    expect(result.skippedWrongVariant).toBe(1);
  });

  it('reverse-holo template slot auto-assigns the matching reverse_holo holding', async () => {
    const deps = buildDeps(db);
    const h = await deps.holdingsRepo.create(
      holdingInput({ finish: 'reverse_holo' }),
    );
    await makeSlot({ note: REVERSE_HOLO_TEMPLATE_MARKER });
    const result = await autoAssignBinder(deps, { binderId: binder.id });
    expect(result.assigned).toHaveLength(1);
    expect(result.assigned[0]?.holdingId).toBe(h.id);
  });

  it('autoAssignBinder does not dispatch USER_DATA_CHANGED_EVENT (UI does)', async () => {
    const deps = buildDeps(db);
    await deps.holdingsRepo.create(holdingInput());
    await makeSlot();
    const spy = vi.fn();
    window.addEventListener('pokemon:user-data-changed', spy);
    try {
      await autoAssignBinder(deps, { binderId: binder.id });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('pokemon:user-data-changed', spy);
    }
  });

  // -- createHoldingForSlotAndAssign -------------------------------

  it('direct-add creates a holding then flips slot to owned', async () => {
    const deps = buildDeps(db);
    const slot = await makeSlot();
    const result = await createHoldingForSlotAndAssign(
      deps,
      slot,
      SLOTS_PER_PAGE,
      {
        conditionType: 'raw',
        rawCondition: 'NM',
        gradingCompany: null,
        grade: null,
        certNumber: null,
        certUrl: null,
        gradedDate: null,
        finish: 'normal',
        edition: 'unlimited',
        language: 'en',
        quantity: 1,
        purchasePrice: null,
        purchaseCurrency: null,
        note: null,
        specialVariant: false,
        tags: [],
      },
    );
    expect(result.holding.cardId).toBe('base1-4');
    expect(result.slot.holdingId).toBe(result.holding.id);
    expect(result.slot.status).toBe('owned');
  });

  it('direct-add throws if the slot has no targetCardId', async () => {
    const deps = buildDeps(db);
    const blank = await makeSlot({ targetCardId: null, status: 'empty' });
    await expect(
      createHoldingForSlotAndAssign(deps, blank, SLOTS_PER_PAGE, {
        conditionType: 'raw',
        rawCondition: 'NM',
        gradingCompany: null,
        grade: null,
        certNumber: null,
        certUrl: null,
        gradedDate: null,
        finish: 'normal',
        edition: 'unlimited',
        language: 'en',
        quantity: 1,
        purchasePrice: null,
        purchaseCurrency: null,
        note: null,
        specialVariant: false,
        tags: [],
      }),
    ).rejects.toBeInstanceOf(SlotAssignmentError);
  });

  it('direct-add reverse template enforces finish=reverse_holo', async () => {
    const deps = buildDeps(db);
    const slot = await makeSlot({ note: REVERSE_HOLO_TEMPLATE_MARKER });
    await expect(
      createHoldingForSlotAndAssign(deps, slot, SLOTS_PER_PAGE, {
        conditionType: 'raw',
        rawCondition: 'NM',
        gradingCompany: null,
        grade: null,
        certNumber: null,
        certUrl: null,
        gradedDate: null,
        finish: 'normal',
        edition: 'unlimited',
        language: 'en',
        quantity: 1,
        purchasePrice: null,
        purchaseCurrency: null,
        note: null,
        specialVariant: false,
        tags: [],
      }),
    ).rejects.toBeInstanceOf(SlotAssignmentError);
    // No holding should have been created since the rejection happens
    // before `holdingsRepo.create`.
    const holdings = await deps.holdingsRepo.list();
    expect(holdings.filter((h) => h.deletedAt === null)).toEqual([]);
  });

  it('direct-add rolls back the holding when assign fails after holding create', async () => {
    const deps = buildDeps(db);
    // Stash the real assign function.
    const realUpdate = deps.binderSlotsRepo.update.bind(deps.binderSlotsRepo);
    let calls = 0;
    deps.binderSlotsRepo.update = (async () => {
      calls += 1;
      throw new Error('boom — simulated assign failure');
    }) as typeof deps.binderSlotsRepo.update;
    const slot = await makeSlot();
    await expect(
      createHoldingForSlotAndAssign(deps, slot, SLOTS_PER_PAGE, {
        conditionType: 'raw',
        rawCondition: 'NM',
        gradingCompany: null,
        grade: null,
        certNumber: null,
        certUrl: null,
        gradedDate: null,
        finish: 'normal',
        edition: 'unlimited',
        language: 'en',
        quantity: 1,
        purchasePrice: null,
        purchaseCurrency: null,
        note: null,
        specialVariant: false,
        tags: [],
      }),
    ).rejects.toThrow(/simulated assign failure/);
    expect(calls).toBe(1);
    // Rollback path uses a different repo method (holdingsRepo.softDelete);
    // verify the holding was soft-deleted, not left live.
    const liveHoldings = (await deps.holdingsRepo.list()).filter(
      (h) => h.deletedAt === null,
    );
    expect(liveHoldings).toEqual([]);
    // Restore the original update so any afterEach cleanup paths work.
    deps.binderSlotsRepo.update = realUpdate;
  });

  // -- additional coverage --

  it('soft-deleted slots are excluded from auto-assign', async () => {
    const deps = buildDeps(db);
    await deps.holdingsRepo.create(holdingInput());
    const slot = await makeSlot();
    await deps.binderSlotsRepo.softDelete(slot.id);
    const result = await autoAssignBinder(deps, { binderId: binder.id });
    expect(result.assigned).toEqual([]);
    expect(result.skippedAlreadyOwned).toBe(0);
    expect(result.skippedNoHolding).toBe(0);
  });

  it('autoAssign with deleted binder returns empty result', async () => {
    const deps = buildDeps(db);
    await deps.holdingsRepo.create(holdingInput());
    await makeSlot();
    await deps.bindersRepo.softDelete(binder.id);
    const result = await autoAssignBinder(deps, { binderId: binder.id });
    expect(result.assigned).toEqual([]);
  });

  // -- PR 24 review patch: one-holding-one-slot enforcement --------

  it('assignHoldingToSlot rejects holding already assigned to another live slot', async () => {
    const deps = buildDeps(db);
    const h = await deps.holdingsRepo.create(holdingInput());
    const slotA = await makeSlot({
      pageNumber: 1,
      slotNumber: 1,
      holdingId: h.id,
      status: 'owned',
    });
    const slotB = await makeSlot({
      pageNumber: 1,
      slotNumber: 2,
      // Same target card so cardId match passes — the only blocker
      // should be the one-holding-one-slot rule.
      targetCardId: 'base1-4',
    });
    await expect(
      assignHoldingToSlot(deps, slotB, h, SLOTS_PER_PAGE),
    ).rejects.toBeInstanceOf(SlotAssignmentError);
    const slotBAfter = await deps.binderSlotsRepo.get(slotB.id);
    expect(slotBAfter?.holdingId).toBeNull();
    void slotA;
  });

  it('assignHoldingToSlot allows reassigning the same holding to its current slot (no-op style)', async () => {
    const deps = buildDeps(db);
    const h = await deps.holdingsRepo.create(holdingInput());
    const slot = await makeSlot({
      holdingId: h.id,
      status: 'owned',
    });
    // Same holding, same slot → should NOT throw (legitimate update).
    const updated = await assignHoldingToSlot(deps, slot, h, SLOTS_PER_PAGE);
    expect(updated.holdingId).toBe(h.id);
    expect(updated.status).toBe('owned');
  });

  it('assignHoldingToSlot ignores soft-deleted slot assignments when checking exclusivity', async () => {
    const deps = buildDeps(db);
    const h = await deps.holdingsRepo.create(holdingInput());
    const orphanSlot = await makeSlot({
      pageNumber: 1,
      slotNumber: 1,
      holdingId: h.id,
      status: 'owned',
    });
    // Soft-delete the orphan slot. Its `holdingId` lingers in the row
    // but the slot is no longer "live", so the holding should be
    // assignable to a fresh slot.
    await deps.binderSlotsRepo.softDelete(orphanSlot.id);
    const newSlot = await makeSlot({
      pageNumber: 1,
      slotNumber: 2,
    });
    const updated = await assignHoldingToSlot(deps, newSlot, h, SLOTS_PER_PAGE);
    expect(updated.holdingId).toBe(h.id);
  });

  it('findAssignableHoldingsForSlot filters out holdings already assigned to another live slot', async () => {
    const deps = buildDeps(db);
    const h = await deps.holdingsRepo.create(holdingInput());
    const slotA = await makeSlot({
      pageNumber: 1,
      slotNumber: 1,
      holdingId: h.id,
      status: 'owned',
    });
    const slotB = await makeSlot({
      pageNumber: 1,
      slotNumber: 2,
      targetCardId: 'base1-4',
    });
    const cands = await findAssignableHoldingsForSlot(deps, slotB);
    expect(cands).toEqual([]);
    void slotA;
  });

  it('direct-add fails cleanly when holdingsRepo.create rejects (case 15)', async () => {
    const deps = buildDeps(db);
    const slot = await makeSlot();
    // Quantity 0 violates `validateHoldingInput` ("must be an integer
    // >= 1") so the holding-create throws before slot assignment.
    await expect(
      createHoldingForSlotAndAssign(deps, slot, SLOTS_PER_PAGE, {
        conditionType: 'raw',
        rawCondition: 'NM',
        gradingCompany: null,
        grade: null,
        certNumber: null,
        certUrl: null,
        gradedDate: null,
        finish: 'normal',
        edition: 'unlimited',
        language: 'en',
        quantity: 0, // ← invalid
        purchasePrice: null,
        purchaseCurrency: null,
        note: null,
        specialVariant: false,
        tags: [],
      }),
    ).rejects.toThrow();
    // No holding row should exist (validator runs before db.add).
    const live = (await deps.holdingsRepo.list()).filter(
      (h) => h.deletedAt === null,
    );
    expect(live).toEqual([]);
    // Slot is untouched.
    const slotAfter = await deps.binderSlotsRepo.get(slot.id);
    expect(slotAfter?.holdingId).toBeNull();
    expect(slotAfter?.status).toBe('wanted');
  });
});
