// Card Detail "Binder-lokasjoner" section. Verifies it shows every
// binder slot that mentions the current card — both via targetCardId
// and via an assigned holding for that card.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mountCardDetailView } from '../src/views/card-detail';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createBinderService } from '../src/services/binder-service';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { closeAndDelete } from './helpers/fresh-db';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { HoldingInput } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

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

const sampleCard: CardRecord = {
  id: 'base1-1',
  setId: 'base1',
  name: 'Test card',
  number: '1',
  rarity: 'Common',
  supertype: 'Pokémon',
  subtypes: [],
  types: [],
  imageSmall: null,
  imageLarge: null,
  tcgplayer: null,
  cardmarket: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

const baseHolding: HoldingInput = {
  cardId: 'base1-1',
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
};

describe('Card Detail "Binder-lokasjoner" section', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createSetsRepo(db).upsert(sampleSet);
    await createCardsRepo(db).upsertMany([sampleCard]);
    window.location.hash = '';
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  it('shows the empty message when no binder slot mentions the card', async () => {
    window.location.hash = 'card/base1-1';
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    expect(
      root.querySelector('.card-detail-view__binders-empty')?.textContent,
    ).toMatch(/ikke tilordnet/);
    expect(root.querySelectorAll('.card-detail-view__binders-table tr').length).toBe(
      0,
    );
  });

  it('lists rows for both target and assigned matches', async () => {
    const created = await createBinderService(db).createManualBinder({
      name: 'Match binder',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      completionMode: 'standard',
      sourceSetId: null,
    });
    const slotsRepo = createBinderSlotsRepo(db);
    const targetSlot = created.slots[0];
    const assignedSlot = created.slots[1];
    if (targetSlot === undefined || assignedSlot === undefined) {
      throw new Error('test bootstrap failed');
    }
    await slotsRepo.update(
      targetSlot.id,
      { targetCardId: 'base1-1', status: 'wanted' },
      9,
    );
    const holding = await createHoldingsRepo(db).create(baseHolding);
    await slotsRepo.update(
      assignedSlot.id,
      { holdingId: holding.id, status: 'owned' },
      9,
    );

    window.location.hash = 'card/base1-1';
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    const rows = root.querySelectorAll<HTMLTableRowElement>(
      '.card-detail-view__binders-table tbody tr',
    );
    expect(rows.length).toBe(2);

    // Both rows should reference the same binder name.
    for (const row of rows) {
      expect(row.cells[0]?.textContent).toBe('Match binder');
    }

    // The match-by column should include both 'Mål-kort' and 'Tilordnet holding'.
    const matchedBy = Array.from(rows).map((row) => row.cells[4]?.textContent);
    expect(matchedBy.sort()).toEqual(
      ['Mål-kort', 'Tilordnet holding'].sort(),
    );
  });

  it('does not include slots from soft-deleted binders', async () => {
    const created = await createBinderService(db).createManualBinder({
      name: 'Deleted binder',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      completionMode: 'standard',
      sourceSetId: null,
    });
    const slotsRepo = createBinderSlotsRepo(db);
    const slot = created.slots[0];
    if (slot === undefined) throw new Error('test bootstrap failed');
    await slotsRepo.update(
      slot.id,
      { targetCardId: 'base1-1', status: 'wanted' },
      9,
    );
    // Soft-delete the binder
    await db.binders.put({
      ...(await db.binders.get(created.binder.id))!,
      deletedAt: '2026-05-06T00:00:00.000Z',
      updatedAt: '2026-05-06T00:00:00.000Z',
    });

    window.location.hash = 'card/base1-1';
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountCardDetailView(root);
    await settle();

    expect(
      root.querySelector('.card-detail-view__binders-empty')?.textContent,
    ).toMatch(/ikke tilordnet/);
  });
});
