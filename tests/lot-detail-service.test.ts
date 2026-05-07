// Read-side: lot-detail-service. Joins, status chip, allocation
// difference computation.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { createLotService } from '../src/services/lot-service';
import { createLotDetailService } from '../src/services/lot-detail-service';
import {
  createCardsRepo,
  createHoldingsRepo,
  createLotItemsRepo,
  createLotsRepo,
} from './helpers/repos';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { LotInput, LotItemInput } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

const baseLotInput: LotInput = {
  name: 'Lot under test',
  purchaseDate: '2026-04-01T00:00:00.000Z',
  totalCost: 300,
  currency: 'NOK',
  allocationMethod: 'equal',
  notes: null,
};

function makeCard(id: string): CardRecord {
  return {
    id,
    setId: 'base1',
    name: `Card ${id}`,
    number: '1',
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

function lotItem(
  lotId: string,
  cardId: string,
  overrides: Partial<LotItemInput> = {},
): LotItemInput {
  return {
    lotId,
    cardId,
    finish: 'normal',
    edition: 'unlimited',
    conditionType: 'raw',
    rawCondition: 'NM',
    gradingCompany: null,
    grade: null,
    quantity: 1,
    manualPriceOverride: null,
    marketEstimate: null,
    allocatedCost: null,
    holdingId: null,
    note: null,
    ...overrides,
  };
}

describe('lot-detail-service', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
    const setsRepo = (await import('../src/repositories/sets-repo')).createSetsRepo(db);
    await setsRepo.upsert(sampleSet);
    // PR 11: seed test cards before lot-item writes go through the
    // strict variant validator.
    const base = {
      setId: 'test',
      name: 'Test card',
      number: '1',
      rarity: 'Rare',
      supertype: 'Pokémon',
      subtypes: [],
      types: [],
      imageSmall: null,
      imageLarge: null,
      tcgplayer: {
        prices: {
          normal: { market: 1 },
          holofoil: { market: 1 },
          reverseHolofoil: { market: 1 },
        },
      },
      cardmarket: null,
      updatedAt: '2026-05-06T00:00:00.000Z',
    };
    for (const id of ['card-1', 'card-2', 'card-3']) {
      await db.cards.put({ ...base, id });
    }
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('listSummaries derives correct status chip', async () => {
    const lotsRepo = createLotsRepo(db);
    const itemsRepo = createLotItemsRepo(db);

    // unallocated lot
    const lotA = await lotsRepo.create({ ...baseLotInput, name: 'A' });
    await itemsRepo.create(lotItem(lotA.id, 'card-1'));

    // fully allocated lot
    const lotB = await lotsRepo.create({ ...baseLotInput, name: 'B' });
    await itemsRepo.create(lotItem(lotB.id, 'card-1'));
    await itemsRepo.create(lotItem(lotB.id, 'card-2'));
    await createLotService(db).applyAllocation(lotB.id);

    // partial allocation: one item with explicit allocatedCost, others null
    const lotC = await lotsRepo.create({ ...baseLotInput, name: 'C' });
    await itemsRepo.create(lotItem(lotC.id, 'card-1', { allocatedCost: 50 }));
    await itemsRepo.create(lotItem(lotC.id, 'card-2'));

    const detailService = createLotDetailService(
      lotsRepo,
      itemsRepo,
      createHoldingsRepo(db),
      createCardsRepo(db),
    );
    const summaries = await detailService.listSummaries();
    const byName = new Map(summaries.map((s) => [s.lot.name, s]));
    expect(byName.get('A')?.status).toBe('unallocated');
    expect(byName.get('B')?.status).toBe('allocated');
    expect(byName.get('C')?.status).toBe('partial');
  });

  it('getDetail returns null for missing or soft-deleted lots', async () => {
    const lotsRepo = createLotsRepo(db);
    const detailService = createLotDetailService(
      lotsRepo,
      createLotItemsRepo(db),
      createHoldingsRepo(db),
      createCardsRepo(db),
    );
    expect(await detailService.getDetail('does-not-exist')).toBeNull();

    const lot = await lotsRepo.create({ ...baseLotInput });
    await lotsRepo.softDelete(lot.id);
    expect(await detailService.getDetail(lot.id)).toBeNull();
  });

  it('getDetail joins cards + holdings and computes allocationDifference', async () => {
    const cardsRepo = createCardsRepo(db);
    await cardsRepo.upsertMany([makeCard('card-1'), makeCard('card-2')]);

    const lotsRepo = createLotsRepo(db);
    const itemsRepo = createLotItemsRepo(db);
    const lot = await lotsRepo.create({ ...baseLotInput, totalCost: 200 });
    await itemsRepo.create(lotItem(lot.id, 'card-1'));
    await itemsRepo.create(lotItem(lot.id, 'card-2'));
    await createLotService(db).applyAllocation(lot.id);

    const detailService = createLotDetailService(
      lotsRepo,
      itemsRepo,
      createHoldingsRepo(db),
      cardsRepo,
    );
    const detail = await detailService.getDetail(lot.id);
    expect(detail).not.toBeNull();
    expect(detail?.items.length).toBe(2);
    expect(detail?.cardsById.get('card-1')?.name).toBe('Card card-1');
    expect(detail?.summary.itemCount).toBe(2);
    expect(detail?.summary.allocatedTotal).toBe(200);
    expect(detail?.summary.allocationDifference).toBe(0);
    expect(detail?.summary.status).toBe('allocated');
  });

  it('marks status=materialized when every item has a holding link', async () => {
    const cardsRepo = createCardsRepo(db);
    await cardsRepo.upsertMany([makeCard('card-1'), makeCard('card-2')]);

    const lotsRepo = createLotsRepo(db);
    const itemsRepo = createLotItemsRepo(db);
    const lot = await lotsRepo.create({ ...baseLotInput, totalCost: 200 });
    await itemsRepo.create(lotItem(lot.id, 'card-1'));
    await itemsRepo.create(lotItem(lot.id, 'card-2'));
    await createLotService(db).applyAllocation(lot.id);
    await createLotService(db).materializeHoldings(lot.id);

    const detailService = createLotDetailService(
      lotsRepo,
      itemsRepo,
      createHoldingsRepo(db),
      cardsRepo,
    );
    const detail = await detailService.getDetail(lot.id);
    expect(detail?.summary.status).toBe('materialized');
    expect(detail?.summary.materializedCount).toBe(2);
    expect(detail?.summary.unmaterializedCount).toBe(0);
  });
});
