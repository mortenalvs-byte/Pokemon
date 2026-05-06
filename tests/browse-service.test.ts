import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initializeDataLayer } from '../src/db/init';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { createBrowseService } from '../src/services/browse-service';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { PokemonTrackerDB } from '../src/db/database';

const baseSet: Omit<SetRecord, 'id' | 'name' | 'releaseDate'> = {
  series: 'Test',
  printedTotal: 100,
  total: 100,
  symbolUrl: null,
  logoUrl: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

const baseCard: Omit<CardRecord, 'id' | 'setId' | 'name' | 'number'> = {
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

function makeSet(id: string, name: string, releaseDate: string): SetRecord {
  return { ...baseSet, id, name, releaseDate };
}

function makeCard(
  id: string,
  setId: string,
  name: string,
  number: string,
  rarity: string | null = 'Common',
): CardRecord {
  return { ...baseCard, id, setId, name, number, rarity };
}

async function seed(db: PokemonTrackerDB): Promise<void> {
  const setsRepo = createSetsRepo(db);
  const cardsRepo = createCardsRepo(db);

  await setsRepo.upsertMany([
    makeSet('base1', 'Base', '1999-01-09'),
    makeSet('jungle', 'Jungle', '1999-06-16'),
    makeSet('sv1', 'Scarlet & Violet', '2023-03-31'),
  ]);

  await cardsRepo.upsertMany([
    makeCard('base1-4', 'base1', 'Charizard', '4', 'Rare Holo'),
    makeCard('base1-15', 'base1', 'Beedrill', '15'),
    makeCard('base1-58', 'base1', 'Pikachu', '58'),
    makeCard('jungle-1', 'jungle', 'Clefable', '1', 'Rare Holo'),
    makeCard('jungle-25', 'jungle', 'Pidgeot', '25'),
    makeCard('sv1-1', 'sv1', 'Sprigatito', '1', 'Common'),
    makeCard('sv1-238', 'sv1', 'Charizard ex', '238', 'Special Illustration Rare'),
  ]);
}

describe('browse service', () => {
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
    return createBrowseService(createCardsRepo(db), createSetsRepo(db));
  }

  it('counts every cached card', async () => {
    expect(await service().countTotalCards()).toBe(7);
  });

  it('lists sets sorted by release date desc for the filter dropdown', async () => {
    const sets = await service().listSetsForFilter();
    expect(sets.map((s) => s.id)).toEqual(['sv1', 'jungle', 'base1']);
  });

  it('lists distinct rarities sorted alphabetically', async () => {
    const rarities = await service().listRaritiesForFilter();
    expect(rarities).toEqual([
      'Common',
      'Rare Holo',
      'Special Illustration Rare',
    ]);
  });

  it('returns rows joined with their SetRecord (no N+1 lookups)', async () => {
    const result = await service().browse({
      sort: 'name',
      sortDirection: 'asc',
      page: 0,
      pageSize: 50,
    });
    const charizard = result.rows.find((r) => r.card.id === 'base1-4');
    expect(charizard?.set?.name).toBe('Base');
  });

  it('default sort is set release date desc, then card number asc', async () => {
    const result = await service().browse({
      sort: 'set-release',
      sortDirection: 'desc',
      page: 0,
      pageSize: 50,
    });
    const ids = result.rows.map((r) => r.card.id);
    // sv1 first (newest set), with cards in number order:
    // sv1-1, sv1-238 — Number.parseInt sorts 1 before 238 numerically.
    // Then jungle (1, 25), then base1 (4, 15, 58).
    expect(ids).toEqual([
      'sv1-1',
      'sv1-238',
      'jungle-1',
      'jungle-25',
      'base1-4',
      'base1-15',
      'base1-58',
    ]);
  });

  it('filters by setId via the indexed listBySet path', async () => {
    const result = await service().browse({
      setId: 'base1',
      sort: 'set-number',
      sortDirection: 'asc',
      page: 0,
      pageSize: 50,
    });
    expect(result.total).toBe(3);
    expect(result.rows.map((r) => r.card.id)).toEqual([
      'base1-4',
      'base1-15',
      'base1-58',
    ]);
  });

  it('filters by rarity via the indexed listByRarity path', async () => {
    const result = await service().browse({
      rarity: 'Rare Holo',
      sort: 'name',
      sortDirection: 'asc',
      page: 0,
      pageSize: 50,
    });
    expect(result.total).toBe(2);
    expect(result.rows.map((r) => r.card.id).sort()).toEqual([
      'base1-4',
      'jungle-1',
    ]);
  });

  it('combines filters: setId AND rarity AND search', async () => {
    const result = await service().browse({
      setId: 'base1',
      rarity: 'Rare Holo',
      search: 'char',
      sort: 'name',
      sortDirection: 'asc',
      page: 0,
      pageSize: 50,
    });
    expect(result.total).toBe(1);
    expect(result.rows[0]?.card.id).toBe('base1-4');
  });

  it('search is case-insensitive and trims whitespace', async () => {
    const result = await service().browse({
      search: '  CHAR  ',
      sort: 'name',
      sortDirection: 'asc',
      page: 0,
      pageSize: 50,
    });
    const ids = result.rows.map((r) => r.card.id).sort();
    expect(ids).toEqual(['base1-4', 'sv1-238']);
  });

  it('paginates correctly', async () => {
    const page0 = await service().browse({
      sort: 'name',
      sortDirection: 'asc',
      page: 0,
      pageSize: 25,
    });
    expect(page0.total).toBe(7);
    expect(page0.rows).toHaveLength(7);

    const small0 = await service().browse({
      sort: 'name',
      sortDirection: 'asc',
      page: 0,
      pageSize: 25,
    });
    const small1 = await service().browse({
      sort: 'name',
      sortDirection: 'asc',
      page: 1,
      pageSize: 25,
    });
    expect(small1.rows).toHaveLength(0);
    expect(small0.rows).toHaveLength(7);
  });

  it('returns empty result for an empty cache', async () => {
    await db.cards.clear();
    await db.sets.clear();
    const result = await service().browse({
      sort: 'name',
      sortDirection: 'asc',
      page: 0,
      pageSize: 50,
    });
    expect(result).toEqual({ rows: [], total: 0 });
  });

  it('sort by name asc and rarity asc are deterministic', async () => {
    const byName = await service().browse({
      sort: 'name',
      sortDirection: 'asc',
      page: 0,
      pageSize: 50,
    });
    const names = byName.rows.map((r) => r.card.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);

    const byRarity = await service().browse({
      sort: 'rarity',
      sortDirection: 'asc',
      page: 0,
      pageSize: 50,
    });
    const rarities = byRarity.rows.map((r) => r.card.rarity ?? '');
    const rarSorted = [...rarities].sort((a, b) => a.localeCompare(b));
    expect(rarities).toEqual(rarSorted);
  });
});
