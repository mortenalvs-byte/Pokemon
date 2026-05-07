// MVP CSV exports — collection, wishlist, duplicates, missing-cards.
// Format invariants (BOM, CRLF, headers) and audit row.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { createBinderService } from '../src/services/binder-service';
import { createMvpCsvExporter } from '../src/services/mvp-csv-export';
import {
  createBindersRepo,
  createBinderSlotsRepo,
  createCardsRepo,
  createHoldingsRepo,
  createSetsRepo,
  createWishlistRepo,
} from './helpers/repos';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type {
  HoldingInput,
  WishlistInput,
} from '../src/domain/validators';
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
    tcgplayer: null,
    cardmarket: null,
    updatedAt: '2026-05-06T00:00:00.000Z',
  };
}

function holdingInput(
  cardId: string,
  overrides: Partial<HoldingInput> = {},
): HoldingInput {
  return {
    cardId,
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

function wishlistInput(
  cardId: string,
  overrides: Partial<WishlistInput> = {},
): WishlistInput {
  return {
    cardId,
    finish: 'normal',
    priority: 'medium',
    targetCondition: null,
    targetPrice: null,
    targetCurrency: null,
    status: 'wanted',
    note: null,
    ...overrides,
  };
}

function buildExporter(db: PokemonTrackerDB) {
  return createMvpCsvExporter({
    db,
    holdingsRepo: createHoldingsRepo(db),
    bindersRepo: createBindersRepo(db),
    binderSlotsRepo: createBinderSlotsRepo(db),
    cardsRepo: createCardsRepo(db),
    setsRepo: createSetsRepo(db),
    wishlistRepo: createWishlistRepo(db),
  });
}

function assertBomAndCrlf(content: string): void {
  expect(content.charCodeAt(0)).toBe(0xfeff);
  // After stripping the BOM, the trailing line ending is CRLF.
  const stripped = content.slice(1);
  expect(stripped.endsWith('\r\n')).toBe(true);
}

describe('mvp-csv-export', () => {
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

  it('collection.csv contains every live holding with header + BOM + CRLF', async () => {
    const holdingsRepo = createHoldingsRepo(db);
    await holdingsRepo.create(holdingInput('base1-1'));
    await holdingsRepo.create(holdingInput('base1-2'));
    const result = await buildExporter(db).buildCollection();
    expect(result.kind).toBe('collection');
    expect(result.rowCount).toBe(2);
    assertBomAndCrlf(result.content);
    const lines = result.content.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toContain('card_id');
    expect(lines[0]).toContain('purchase_currency');
    expect(lines[0]).toContain('value_currency');
    expect(lines[0]).not.toContain('profit'); // no tax/profit columns
    expect(lines[0]).not.toContain('tax');
    expect(result.filename).toMatch(/^collection-\d{8}\.csv$/);
  });

  it('wishlist.csv contains live wishlist rows only, with priority + target columns', async () => {
    const wishlistRepo = createWishlistRepo(db);
    await wishlistRepo.create(
      wishlistInput('base1-1', { priority: 'grail', status: 'wanted' }),
    );
    const cancelled = await wishlistRepo.create(
      wishlistInput('base1-2', { priority: 'low', status: 'cancelled' }),
    );
    void cancelled;
    const deleted = await wishlistRepo.create(
      wishlistInput('base1-3', { priority: 'medium' }),
    );
    await wishlistRepo.softDelete(deleted.id);

    const result = await buildExporter(db).buildWishlist();
    expect(result.kind).toBe('wishlist');
    // 2 live (one cancelled is still live with status=cancelled), 1 soft-deleted excluded.
    expect(result.rowCount).toBe(2);
    const headers = result.content
      .replace(/^﻿/, '')
      .split('\r\n')[0] ?? '';
    expect(headers).toContain('priority');
    expect(headers).toContain('target_price');
    expect(headers).toContain('target_currency');
    expect(headers).toContain('status');
  });

  it('duplicates.csv groups holdings by canonical key and respects status=duplicate', async () => {
    const holdingsRepo = createHoldingsRepo(db);
    // Group of 2 with same canonical key.
    await holdingsRepo.create(holdingInput('base1-1'));
    await holdingsRepo.create(holdingInput('base1-1'));
    // Single holding marked duplicate explicitly.
    await holdingsRepo.create(
      holdingInput('base1-2', { status: 'duplicate' }),
    );
    // Singleton with no duplicate flag — should not appear.
    await holdingsRepo.create(holdingInput('base1-3'));

    const result = await buildExporter(db).buildDuplicates();
    expect(result.kind).toBe('duplicates');
    expect(result.rowCount).toBe(2);
    assertBomAndCrlf(result.content);
    const lines = result.content.replace(/^﻿/, '').split('\r\n');
    const dataLines = lines.slice(1).filter((l) => l.length > 0);
    expect(dataLines.length).toBe(2);
  });

  it('missing-cards.csv lists every incomplete target slot across all live binders', async () => {
    const slotsRepo = createBinderSlotsRepo(db);
    const holdingsRepo = createHoldingsRepo(db);
    const fromSet = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'Base',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        completionMode: 'standard',
        sourceSetId: 'base1',
      },
      slots: [
        { pageNumber: 1, slotNumber: 1, targetCardId: 'base1-1', note: null },
        { pageNumber: 1, slotNumber: 2, targetCardId: 'base1-2', note: null },
        { pageNumber: 1, slotNumber: 3, targetCardId: 'base1-3', note: null },
      ],
    });
    // Complete slot 1.
    const holding = await holdingsRepo.create(holdingInput('base1-1'));
    const slot1 = fromSet.slots[0];
    if (slot1 === undefined) throw new Error('test bootstrap failed');
    await slotsRepo.update(
      slot1.id,
      { holdingId: holding.id, status: 'owned' },
      9,
    );

    const result = await buildExporter(db).buildMissingCards();
    expect(result.kind).toBe('missing-cards');
    expect(result.rowCount).toBe(2); // slots 2 and 3 are missing
    const lines = result.content.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toContain('binder_name');
    expect(lines[0]).toContain('card_id');
  });

  it('recordCsvExported writes one audit row per kind', async () => {
    const exporter = buildExporter(db);
    await exporter.recordCsvExported('collection', 5);
    await exporter.recordCsvExported('wishlist', 3);
    await exporter.recordCsvExported('duplicates', 1);
    await exporter.recordCsvExported('missing-cards', 2);
    const audits = await db.auditLog.toArray();
    const actions = audits.map((a) => a.action).sort();
    expect(actions).toEqual(
      [
        'collection_csv_exported',
        'duplicates_csv_exported',
        'missing_cards_csv_exported',
        'wishlist_csv_exported',
      ].sort(),
    );
  });
});
