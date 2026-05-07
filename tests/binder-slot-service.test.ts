// Tests for the binder slot read service. Covers listSummaries with
// completion stats, getDetail joins with holdings + cards, and
// slotsForCardId matching by both target and assigned holding.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { createBinderService } from '../src/services/binder-service';
import { createBinderSlotService } from '../src/services/binder-slot-service';
import {
  createBindersRepo,
  createBinderSlotsRepo,
  createCardsRepo,
  createHoldingsRepo,
  createSetsRepo,
} from './helpers/repos';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { PokemonTrackerDB } from '../src/db/database';

const sampleSet: SetRecord = {
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

function makeCard(n: number): CardRecord {
  return {
    id: `base1-${n}`,
    setId: 'base1',
    name: `Card ${n}`,
    number: String(n),
    rarity: 'Common',
    supertype: 'Pokémon',
    subtypes: [],
    types: [],
    imageSmall: null,
    imageLarge: null,
    tcgplayer: { prices: { normal: { market: 1 }, holofoil: { market: 1 }, reverseHolofoil: { market: 1 }, "1stEditionNormal": { market: 1 }, "1stEditionHolofoil": { market: 1 } } },
    cardmarket: null,
    updatedAt: '2026-05-06T00:00:00.000Z',
  };
}

const baseHoldingInput = {
  cardId: 'base1-1',
  quantity: 1,
  conditionType: 'raw' as const,
  rawCondition: 'NM' as const,
  gradingCompany: null,
  grade: null,
  certNumber: null,
  certUrl: null,
  gradedDate: null,
  finish: 'normal' as const,
  edition: 'unlimited' as const,
  language: 'en',
  purchasePrice: null,
  purchaseCurrency: null,
  estimatedValue: null,
  valueCurrency: null,
  valueSource: 'unknown' as const,
  valueNote: null,
  valueUpdatedAt: null,
  source: 'manual' as const,
  note: null,
  specialVariant: false,
  tags: [],
  lotId: null,
  status: 'owned' as const,
};

describe('binder-slot-service', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
    await createSetsRepo(db).upsert(sampleSet);
    await createCardsRepo(db).upsertMany([
      makeCard(1),
      makeCard(2),
      makeCard(3),
    ]);
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('listSummaries returns one entry per live binder with completion stats', async () => {
    const service = createBinderService(db);
    const binderA = await service.createManualBinder({
      name: 'Binder A',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      completionMode: 'standard',
      sourceSetId: null,
    });
    const binderB = await service.createManualBinder({
      name: 'Binder B',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      completionMode: 'standard',
      sourceSetId: null,
    });

    // Set targets on first slot of each binder, then assign a holding
    // to one of them so completion goes to 1/1 = 100%.
    const slotsRepo = createBinderSlotsRepo(db);
    const firstA = binderA.slots[0];
    const firstB = binderB.slots[0];
    if (firstA === undefined || firstB === undefined) {
      throw new Error('test bootstrap failed');
    }
    await slotsRepo.update(
      firstA.id,
      { targetCardId: 'base1-1', status: 'wanted' },
      9,
    );
    await slotsRepo.update(
      firstB.id,
      { targetCardId: 'base1-2', status: 'wanted' },
      9,
    );

    const holding = await createHoldingsRepo(db).create(baseHoldingInput);
    await slotsRepo.update(
      firstA.id,
      { holdingId: holding.id, status: 'owned' },
      9,
    );

    const slotService = createBinderSlotService(
      createBindersRepo(db),
      slotsRepo,
      createHoldingsRepo(db),
      createCardsRepo(db),
    );
    const summaries = await slotService.listSummaries();
    expect(summaries.length).toBe(2);

    const summaryA = summaries.find((s) => s.binder.id === binderA.binder.id);
    const summaryB = summaries.find((s) => s.binder.id === binderB.binder.id);
    expect(summaryA?.completion).toEqual({
      totalTargetSlots: 1,
      completedSlots: 1,
      missingSlots: 0,
      percentage: 100,
    });
    expect(summaryB?.completion).toEqual({
      totalTargetSlots: 1,
      completedSlots: 0,
      missingSlots: 1,
      percentage: 0,
    });
  });

  it('listSummaries excludes soft-deleted binders', async () => {
    const service = createBinderService(db);
    const binder = await service.createManualBinder({
      name: 'Soon-to-be-deleted',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      completionMode: 'standard',
      sourceSetId: null,
    });
    await createBindersRepo(db).softDelete(binder.binder.id, 'test');

    const slotService = createBinderSlotService(
      createBindersRepo(db),
      createBinderSlotsRepo(db),
      createHoldingsRepo(db),
      createCardsRepo(db),
    );
    const summaries = await slotService.listSummaries();
    expect(summaries.length).toBe(0);
  });

  it('getDetail returns slots + joined holdings/cards and skips soft-deleted slots', async () => {
    const service = createBinderService(db);
    const binder = await service.createManualBinder({
      name: 'Detail binder',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      completionMode: 'standard',
      sourceSetId: null,
    });
    const slotsRepo = createBinderSlotsRepo(db);
    const slot1 = binder.slots[0];
    const slot2 = binder.slots[1];
    if (slot1 === undefined || slot2 === undefined) {
      throw new Error('test bootstrap failed');
    }
    const holding = await createHoldingsRepo(db).create(baseHoldingInput);
    await slotsRepo.update(
      slot1.id,
      {
        holdingId: holding.id,
        targetCardId: 'base1-1',
        status: 'owned',
      },
      9,
    );
    await slotsRepo.update(
      slot2.id,
      { targetCardId: 'base1-2', status: 'wanted' },
      9,
    );
    // Soft-delete the third slot — it should not appear in the detail.
    const slot3 = binder.slots[2];
    if (slot3 === undefined) throw new Error('test bootstrap failed');
    await slotsRepo.softDelete(slot3.id);

    const slotService = createBinderSlotService(
      createBindersRepo(db),
      slotsRepo,
      createHoldingsRepo(db),
      createCardsRepo(db),
    );
    const detail = await slotService.getDetail(binder.binder.id);
    expect(detail).not.toBeNull();
    expect(detail?.slots.length).toBe(8); // 9 - 1 soft-deleted
    expect(detail?.completion.totalTargetSlots).toBe(2);
    expect(detail?.completion.completedSlots).toBe(1);
    expect(detail?.holdingsById.get(holding.id)?.id).toBe(holding.id);
    expect(detail?.cardsById.get('base1-1')?.name).toBe('Card 1');
    expect(detail?.cardsById.get('base1-2')?.name).toBe('Card 2');
    // Sorted by page+slot ascending.
    expect(detail?.slots[0]?.slotNumber).toBe(1);
  });

  it('getDetail returns null for a deleted or missing binder', async () => {
    const slotService = createBinderSlotService(
      createBindersRepo(db),
      createBinderSlotsRepo(db),
      createHoldingsRepo(db),
      createCardsRepo(db),
    );
    expect(await slotService.getDetail('nonexistent')).toBeNull();
  });

  it('slotsForCardId matches both target and assigned-holding cardIds', async () => {
    const service = createBinderService(db);
    const binder = await service.createManualBinder({
      name: 'Match binder',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      completionMode: 'standard',
      sourceSetId: null,
    });
    const slotsRepo = createBinderSlotsRepo(db);
    const targetSlot = binder.slots[0];
    const assignedSlot = binder.slots[1];
    const unrelatedSlot = binder.slots[2];
    if (
      targetSlot === undefined ||
      assignedSlot === undefined ||
      unrelatedSlot === undefined
    ) {
      throw new Error('test bootstrap failed');
    }
    // Target only
    await slotsRepo.update(
      targetSlot.id,
      { targetCardId: 'base1-1', status: 'wanted' },
      9,
    );
    // Assigned only (no targetCardId)
    const holding = await createHoldingsRepo(db).create(baseHoldingInput);
    await slotsRepo.update(
      assignedSlot.id,
      { holdingId: holding.id, status: 'owned' },
      9,
    );
    // Unrelated
    await slotsRepo.update(
      unrelatedSlot.id,
      { targetCardId: 'base1-3', status: 'wanted' },
      9,
    );

    const slotService = createBinderSlotService(
      createBindersRepo(db),
      slotsRepo,
      createHoldingsRepo(db),
      createCardsRepo(db),
    );
    const matches = await slotService.slotsForCardId('base1-1');
    const matchedBy = matches.map((m) => m.matchedBy).sort();
    expect(matchedBy).toEqual(['assigned', 'target']);
  });

  it('slotsForCardId ignores soft-deleted slots and binders', async () => {
    const service = createBinderService(db);
    const binder = await service.createManualBinder({
      name: 'Skipped binder',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      completionMode: 'standard',
      sourceSetId: null,
    });
    const slotsRepo = createBinderSlotsRepo(db);
    const slot = binder.slots[0];
    if (slot === undefined) throw new Error('test bootstrap failed');
    await slotsRepo.update(
      slot.id,
      { targetCardId: 'base1-1', status: 'wanted' },
      9,
    );
    await createBindersRepo(db).softDelete(binder.binder.id, 'test');

    const slotService = createBinderSlotService(
      createBindersRepo(db),
      slotsRepo,
      createHoldingsRepo(db),
      createCardsRepo(db),
    );
    const matches = await slotService.slotsForCardId('base1-1');
    expect(matches).toEqual([]);
  });
});
