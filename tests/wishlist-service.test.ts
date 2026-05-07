import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initializeDataLayer } from '../src/db/init';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { createWishlistRepo } from '../src/repositories/wishlist-repo';
import { createWishlistService } from '../src/services/wishlist-service';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { WishlistInput } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

const baseInput: WishlistInput = {
  cardId: 'base1-4',
  finish: 'holo',
  priority: 'medium',
  targetCondition: null,
  targetPrice: null,
  targetCurrency: null,
  status: 'wanted',
  note: null,
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
  const repo = createWishlistRepo(db);
  await repo.create({ ...baseInput, cardId: 'base1-4', priority: 'grail' });
  await repo.create({
    ...baseInput,
    cardId: 'base1-5',
    priority: 'low',
    status: 'received',
  });
  await repo.create({
    ...baseInput,
    cardId: 'jungle-1',
    priority: 'high',
    status: 'ordered',
  });
  const fourth = await repo.create({
    ...baseInput,
    cardId: 'base1-4',
    priority: 'medium',
  });
  await repo.softDelete(fourth.id);
}

describe('wishlist service', () => {
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
    return createWishlistService(
      createWishlistRepo(db),
      createCardsRepo(db),
      createSetsRepo(db),
    );
  }

  it('counts live and deleted totals separately', async () => {
    const result = await service().list({
      sort: 'priority',
      sortDirection: 'desc',
      page: 0,
      pageSize: 50,
    });
    expect(result.liveTotal).toBe(3);
    expect(result.deletedTotal).toBe(1);
  });

  it('default filter excludes soft-deleted entries', async () => {
    const result = await service().list({
      sort: 'priority',
      sortDirection: 'desc',
      page: 0,
      pageSize: 50,
    });
    expect(result.rows.every((r) => r.wishlist.deletedAt === null)).toBe(true);
  });

  it('priority desc default places grail first, then high, then low', async () => {
    const result = await service().list({
      sort: 'priority',
      sortDirection: 'desc',
      page: 0,
      pageSize: 50,
    });
    expect(result.rows.map((r) => r.wishlist.priority)).toEqual([
      'grail',
      'high',
      'low',
    ]);
  });

  it('filters by status', async () => {
    const result = await service().list({
      status: 'ordered',
      sort: 'priority',
      sortDirection: 'desc',
      page: 0,
      pageSize: 50,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.wishlist.cardId).toBe('jungle-1');
  });

  it('filters by priority', async () => {
    const result = await service().list({
      priority: 'grail',
      sort: 'priority',
      sortDirection: 'desc',
      page: 0,
      pageSize: 50,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.wishlist.priority).toBe('grail');
  });

  it('search matches against card.name (case-insensitive, trimmed)', async () => {
    const result = await service().list({
      search: '  CHAR  ',
      sort: 'priority',
      sortDirection: 'desc',
      page: 0,
      pageSize: 50,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.wishlist.cardId).toBe('base1-4');
  });

  it('showDeleted=true returns only deleted entries', async () => {
    const result = await service().list({
      showDeleted: true,
      sort: 'priority',
      sortDirection: 'desc',
      page: 0,
      pageSize: 50,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.wishlist.deletedAt).not.toBeNull();
  });

  it('listForCard returns entries for that card with live first', async () => {
    const rows = await service().listForCard('base1-4');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.wishlist.deletedAt).toBeNull();
    expect(rows[1]?.wishlist.deletedAt).not.toBeNull();
  });
});
