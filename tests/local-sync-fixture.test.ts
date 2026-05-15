// PR 28 review patch (Phase 4) — tests for the dev-only local fixture
// importer. These run against a real Dexie + fake-indexeddb instance
// so the atomic-rewrite contract is exercised end-to-end.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LOCAL_FIXTURE_AUDIT_ACTION,
  LOCAL_FIXTURE_SOURCE_VALUE,
  importLocalSyncFixture,
  parseLocalSyncFixture,
} from '../src/qa/local-sync-fixture';
import { APP_META_KEYS } from '../src/domain/types';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';
import type { CardRecord, SetRecord } from '../src/domain/types';

function fixtureCard(
  id: string,
  setId: string,
  overrides: Partial<CardRecord> = {},
): CardRecord {
  return {
    id,
    setId,
    name: `Card ${id}`,
    number: id.split('-').pop() ?? '0',
    rarity: 'Common',
    supertype: 'Pokémon',
    subtypes: [],
    types: [],
    imageSmall: `https://images.pokemontcg.io/${setId}/${id}.png`,
    imageLarge: `https://images.pokemontcg.io/${setId}/${id}_hires.png`,
    tcgplayer: { prices: { normal: { market: 1 } } },
    cardmarket: null,
    updatedAt: '2026-05-09T00:00:00.000Z',
    ...overrides,
  };
}

function fixtureSet(id: string, overrides: Partial<SetRecord> = {}): SetRecord {
  return {
    id,
    name: `Set ${id}`,
    series: 'Test',
    printedTotal: 100,
    total: 100,
    releaseDate: '2026-01-01',
    symbolUrl: null,
    logoUrl: null,
    updatedAt: '2026-05-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('parseLocalSyncFixture', () => {
  it('accepts the app-normalized shape', () => {
    const parsed = parseLocalSyncFixture(
      {
        sets: [fixtureSet('base1')],
        cards: [fixtureCard('base1-1', 'base1')],
      },
      'app shape',
    );
    expect(parsed.sets).toHaveLength(1);
    expect(parsed.cards).toHaveLength(1);
    expect(parsed.description).toBe('app shape');
  });

  it('accepts a backup-file shape (extra keys ignored)', () => {
    const parsed = parseLocalSyncFixture({
      app: 'Pokemon TCG Tracker',
      schemaVersion: 1,
      exportedAt: '2026-05-07T06:08:25.000Z',
      sets: [fixtureSet('base1'), fixtureSet('jungle')],
      cards: [
        fixtureCard('base1-1', 'base1'),
        fixtureCard('jungle-1', 'jungle'),
      ],
      // backup-only fields the importer must NOT try to write:
      holdings: [{ id: 'should-be-ignored' }],
      binders: [{ id: 'should-be-ignored' }],
      settings: [{ key: 'should-be-ignored' }],
    });
    expect(parsed.sets).toHaveLength(2);
    expect(parsed.cards).toHaveLength(2);
  });

  it('accepts a raw pokemontcg.io DTO dump and derives sets', () => {
    const parsed = parseLocalSyncFixture({
      data: [
        {
          id: 'base1-1',
          name: 'Alakazam',
          number: '1',
          rarity: 'Rare',
          supertype: 'Pokémon',
          subtypes: ['Stage 2'],
          types: ['Psychic'],
          set: { id: 'base1' },
        },
      ],
    });
    expect(parsed.cards).toHaveLength(1);
    expect(parsed.cards[0]?.id).toBe('base1-1');
    expect(parsed.sets).toHaveLength(1);
    expect(parsed.sets[0]?.id).toBe('base1');
  });

  it('throws on unrecognised shapes', () => {
    expect(() => parseLocalSyncFixture({})).toThrow(
      /sets.*cards|data.*array/,
    );
    expect(() => parseLocalSyncFixture(null)).toThrow();
    expect(() => parseLocalSyncFixture('not an object')).toThrow();
  });
});

describe('importLocalSyncFixture (live)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('writes sets, cards, appMeta, and auditLog atomically', async () => {
    const result = await importLocalSyncFixture(db, {
      description: 'unit-test',
      sets: [fixtureSet('base1'), fixtureSet('jungle')],
      cards: [
        fixtureCard('base1-1', 'base1'),
        fixtureCard('base1-2', 'base1'),
        fixtureCard('jungle-1', 'jungle'),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.setsCount).toBe(2);
    expect(result.cardsCount).toBe(3);
    expect(await db.sets.count()).toBe(2);
    expect(await db.cards.count()).toBe(3);
  });

  it('records lastSyncSource = local_fixture and the audit row', async () => {
    await importLocalSyncFixture(db, {
      description: 'unit-test',
      sets: [fixtureSet('base1')],
      cards: [fixtureCard('base1-1', 'base1')],
    });
    const source = await db.appMeta.get(APP_META_KEYS.lastSyncSource);
    expect(source?.value).toBe(LOCAL_FIXTURE_SOURCE_VALUE);
    const status = await db.appMeta.get(APP_META_KEYS.lastSyncStatus);
    expect(status?.value).toBe('ok');
    const audits = await db.auditLog
      .where('action')
      .equals(LOCAL_FIXTURE_AUDIT_ACTION)
      .toArray();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.message).toContain('1 sets, 1 cards');
  });

  it('does not touch user-owned stores (holdings/binders/lots/wishlist/settings)', async () => {
    // Pre-populate the user-owned stores so we can prove they survive.
    await db.holdings.put({ id: 'user-holding-1' } as any);
    await db.binders.put({ id: 'user-binder-1', name: 'Mine' } as any);
    await db.settings.put({
      key: 'preferredCurrency',
      value: 'NOK',
      updatedAt: '2026-05-09T00:00:00.000Z',
    });
    await importLocalSyncFixture(db, {
      description: 'unit-test',
      sets: [fixtureSet('base1')],
      cards: [fixtureCard('base1-1', 'base1')],
    });
    expect(await db.holdings.count()).toBe(1);
    expect(await db.binders.count()).toBe(1);
    expect((await db.settings.get('preferredCurrency'))?.value).toBe('NOK');
  });

  it('reports image-coverage counts on the result', async () => {
    const result = await importLocalSyncFixture(db, {
      description: 'unit-test',
      sets: [fixtureSet('base1')],
      cards: [
        fixtureCard('base1-1', 'base1'), // both
        fixtureCard('base1-2', 'base1', { imageSmall: null }), // large only
        fixtureCard('base1-3', 'base1', {
          imageSmall: null,
          imageLarge: null,
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cardsWithImageSmall).toBe(1);
    expect(result.cardsWithImageLarge).toBe(2);
    expect(result.cardsMissingBoth).toBe(1);
  });

  it('returns ok:false when the bulk write fails', async () => {
    // Force a write failure by closing the DB before the import.
    db.close();
    const result = await importLocalSyncFixture(db, {
      description: 'unit-test',
      sets: [fixtureSet('base1')],
      cards: [fixtureCard('base1-1', 'base1')],
    });
    expect(result.ok).toBe(false);
  });
});
