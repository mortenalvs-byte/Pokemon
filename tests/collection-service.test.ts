import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initializeDataLayer } from '../src/db/init';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { createCollectionService } from '../src/services/collection-service';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { HoldingInput } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

const baseHolding: HoldingInput = {
  cardId: 'base1-4',
  quantity: 1,
  conditionType: 'raw',
  rawCondition: 'NM',
  gradingCompany: null,
  grade: null,
  certNumber: null,
  certUrl: null,
  gradedDate: null,
  finish: 'holo',
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

function makeSet(id: string, releaseDate = '2024-01-01'): SetRecord {
  return {
    id,
    name: id.toUpperCase(),
    series: 'Test',
    printedTotal: 100,
    total: 100,
    releaseDate,
    symbolUrl: null,
    logoUrl: null,
    updatedAt: '2026-05-06T00:00:00.000Z',
  };
}

function makeCard(setId: string, n: number, name: string): CardRecord {
  return {
    id: `${setId}-${n}`,
    setId,
    name,
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

async function seed(db: PokemonTrackerDB): Promise<void> {
  await createSetsRepo(db).upsertMany([
    makeSet('base1', '1999-01-09'),
    makeSet('jungle', '1999-06-16'),
  ]);
  await createCardsRepo(db).upsertMany([
    makeCard('base1', 4, 'Charizard'),
    makeCard('base1', 5, 'Beedrill'),
    makeCard('jungle', 1, 'Clefable'),
  ]);

  const repo = createHoldingsRepo(db);
  await repo.create({
    ...baseHolding,
    cardId: 'base1-4',
    rawCondition: 'NM',
    estimatedValue: 1000,
    valueCurrency: 'NOK',
    valueSource: 'manual',
    tags: ['favorite'],
  });
  await repo.create({
    ...baseHolding,
    cardId: 'base1-5',
    conditionType: 'graded',
    rawCondition: null,
    gradingCompany: 'PSA',
    grade: 9,
    estimatedValue: null,
    valueSource: 'unknown',
  });
  await repo.create({
    ...baseHolding,
    cardId: 'jungle-1',
    rawCondition: 'UNKNOWN',
    estimatedValue: null,
    valueSource: 'unknown',
  });
  // One soft-deleted holding for showDeleted tests
  const fourth = await repo.create({
    ...baseHolding,
    cardId: 'base1-4',
    rawCondition: 'LP',
    quantity: 2,
  });
  await repo.softDelete(fourth.id);
}

describe('collection service', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await seed(db);
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  function service() {
    return createCollectionService(
      createHoldingsRepo(db),
      createCardsRepo(db),
      createSetsRepo(db),
    );
  }

  it('counts live and deleted totals separately', async () => {
    const result = await service().list({
      sort: 'updated',
      sortDirection: 'desc',
      page: 0,
      pageSize: 50,
    });
    expect(result.liveTotal).toBe(3);
    expect(result.deletedTotal).toBe(1);
    expect(result.total).toBe(3);
    expect(result.rows.length).toBe(3);
  });

  it('default filter excludes soft-deleted holdings', async () => {
    const result = await service().list({
      sort: 'updated',
      sortDirection: 'desc',
      page: 0,
      pageSize: 50,
    });
    expect(result.rows.every((row) => row.holding.deletedAt === null)).toBe(true);
  });

  it('showDeleted=true returns only deleted holdings', async () => {
    const result = await service().list({
      showDeleted: true,
      sort: 'updated',
      sortDirection: 'desc',
      page: 0,
      pageSize: 50,
    });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.holding.deletedAt).not.toBeNull();
  });

  it('filters by conditionType', async () => {
    const raw = await service().list({
      conditionType: 'raw',
      sort: 'updated',
      sortDirection: 'desc',
      page: 0,
      pageSize: 50,
    });
    expect(raw.rows.every((r) => r.holding.conditionType === 'raw')).toBe(true);

    const graded = await service().list({
      conditionType: 'graded',
      sort: 'updated',
      sortDirection: 'desc',
      page: 0,
      pageSize: 50,
    });
    expect(graded.rows.length).toBe(1);
    expect(graded.rows[0]?.holding.gradingCompany).toBe('PSA');
  });

  it('filters by setId via the cards join', async () => {
    const result = await service().list({
      setId: 'base1',
      sort: 'updated',
      sortDirection: 'desc',
      page: 0,
      pageSize: 50,
    });
    expect(result.total).toBe(2);
    for (const row of result.rows) {
      expect(row.card?.setId).toBe('base1');
    }
  });

  it('filters by missingCondition (raw + UNKNOWN)', async () => {
    const result = await service().list({
      missingCondition: true,
      sort: 'updated',
      sortDirection: 'desc',
      page: 0,
      pageSize: 50,
    });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.holding.cardId).toBe('jungle-1');
  });

  it('filters by missingValue (estimatedValue null OR valueSource unknown)', async () => {
    const result = await service().list({
      missingValue: true,
      sort: 'updated',
      sortDirection: 'desc',
      page: 0,
      pageSize: 50,
    });
    // All except the Charizard holding have valueSource='unknown' or estimatedValue=null.
    expect(result.rows.length).toBe(2);
    const cardIds = result.rows.map((r) => r.holding.cardId).sort();
    expect(cardIds).toEqual(['base1-5', 'jungle-1']);
  });

  it('search matches against card.name (case-insensitive, trimmed)', async () => {
    const result = await service().list({
      search: '  CHAR  ',
      sort: 'updated',
      sortDirection: 'desc',
      page: 0,
      pageSize: 50,
    });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.holding.cardId).toBe('base1-4');
  });

  it('default sort updated desc returns most recent first', async () => {
    const result = await service().list({
      sort: 'updated',
      sortDirection: 'desc',
      page: 0,
      pageSize: 50,
    });
    const updates = result.rows.map((r) => r.holding.updatedAt);
    const sorted = [...updates].sort((a, b) => (a < b ? 1 : -1));
    expect(updates).toEqual(sorted);
  });

  it('listForCard returns holdings for that card with live first, deleted last', async () => {
    const rows = await service().listForCard('base1-4');
    expect(rows.length).toBe(2);
    expect(rows[0]?.holding.deletedAt).toBeNull();
    expect(rows[1]?.holding.deletedAt).not.toBeNull();
    for (const row of rows) {
      expect(row.holding.cardId).toBe('base1-4');
      expect(row.card?.id).toBe('base1-4');
      expect(row.set?.id).toBe('base1');
    }
  });
});
