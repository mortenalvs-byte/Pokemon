// PR 15A — F-7. Tests for `upsertHoldingByVariant` quantity-merge.
//
// Behaviour under test:
//   - Same `(cardId, conditionType, rawCondition, gradingCompany,
//     grade, certNumber, finish, edition, language, status, lotId,
//     specialVariant)` tuple → existing holding's quantity is
//     incremented by the input's quantity. Audit row gets
//     `holding_qty_incremented`.
//   - Any difference in the tuple → fresh holding row, audit
//     `holding_created`.
//   - Variant validation still runs — DOM bypass / unknown finish is
//     rejected, no row is touched.
//   - Existing row's note / prices / value-fields / tags / source are
//     preserved. Only quantity and updatedAt change on merge.
//   - Soft-deleted holdings do NOT match (they are not "live"). A new
//     row is created, no merge into the deleted row.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { ValidationError } from '../src/domain/validators';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { CardRecord } from '../src/domain/types';
import type { HoldingInput } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

const sampleCard: CardRecord = {
  id: 'base1-4',
  setId: 'base1',
  name: 'Charizard',
  number: '4',
  rarity: 'Rare Holo',
  supertype: 'Pokémon',
  subtypes: ['Stage 2'],
  types: ['Fire'],
  imageSmall: null,
  imageLarge: null,
  tcgplayer: {
    prices: {
      normal: { market: 1 },
      holofoil: { market: 1 },
      reverseHolofoil: { market: 1 },
      '1stEditionNormal': { market: 1 },
      '1stEditionHolofoil': { market: 1 },
    },
  },
  cardmarket: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

const baseInput: HoldingInput = {
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

describe('holdingsRepo.upsertByVariant (PR 15A — F-7)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
    await db.cards.put(sampleCard);
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('first call creates a new holding (action="created")', async () => {
    const repo = createHoldingsRepo(db);
    const result = await repo.upsertByVariant(baseInput);
    expect(result.action).toBe('created');
    expect(result.previousQuantity).toBeUndefined();
    expect(result.holding.quantity).toBe(1);
    expect(await db.holdings.count()).toBe(1);
  });

  it('second call with identical variant tuple merges quantity (action="merged")', async () => {
    const repo = createHoldingsRepo(db);
    const first = await repo.upsertByVariant(baseInput);
    const second = await repo.upsertByVariant(baseInput);
    expect(second.action).toBe('merged');
    expect(second.previousQuantity).toBe(1);
    expect(second.holding.id).toBe(first.holding.id);
    expect(second.holding.quantity).toBe(2);
    // Still one row in the DB — the merge updated, did not insert.
    expect(await db.holdings.count()).toBe(1);
  });

  it('quantity merge respects the input.quantity (not always +1)', async () => {
    const repo = createHoldingsRepo(db);
    await repo.upsertByVariant({ ...baseInput, quantity: 3 });
    const second = await repo.upsertByVariant({ ...baseInput, quantity: 5 });
    expect(second.action).toBe('merged');
    expect(second.holding.quantity).toBe(8);
  });

  it('different finish → separate holding (action="created")', async () => {
    const repo = createHoldingsRepo(db);
    await repo.upsertByVariant({ ...baseInput, finish: 'holo' });
    const second = await repo.upsertByVariant({
      ...baseInput,
      finish: 'reverse_holo',
    });
    expect(second.action).toBe('created');
    expect(await db.holdings.count()).toBe(2);
  });

  it('different rawCondition → separate holding', async () => {
    const repo = createHoldingsRepo(db);
    await repo.upsertByVariant({ ...baseInput, rawCondition: 'NM' });
    const second = await repo.upsertByVariant({
      ...baseInput,
      rawCondition: 'LP',
    });
    expect(second.action).toBe('created');
    expect(await db.holdings.count()).toBe(2);
  });

  it('different status → separate holding (e.g. owned vs duplicate)', async () => {
    const repo = createHoldingsRepo(db);
    await repo.upsertByVariant({ ...baseInput, status: 'owned' });
    const second = await repo.upsertByVariant({
      ...baseInput,
      status: 'duplicate',
    });
    expect(second.action).toBe('created');
    expect(await db.holdings.count()).toBe(2);
  });

  it('different lotId → separate holding (provenance matters)', async () => {
    const repo = createHoldingsRepo(db);
    await repo.upsertByVariant({ ...baseInput, lotId: null });
    const second = await repo.upsertByVariant({
      ...baseInput,
      lotId: 'lot-abc-123',
    });
    expect(second.action).toBe('created');
    expect(await db.holdings.count()).toBe(2);
  });

  it('different specialVariant flag → separate holding', async () => {
    const repo = createHoldingsRepo(db);
    await repo.upsertByVariant({
      ...baseInput,
      finish: 'holo',
      specialVariant: false,
    });
    const second = await repo.upsertByVariant({
      ...baseInput,
      finish: 'unknown',
      edition: 'unknown',
      specialVariant: true,
      note: 'odd printing',
    });
    expect(second.action).toBe('created');
    expect(await db.holdings.count()).toBe(2);
  });

  it('graded with same company + grade + cert → merge', async () => {
    const repo = createHoldingsRepo(db);
    const graded: HoldingInput = {
      ...baseInput,
      conditionType: 'graded',
      rawCondition: null,
      gradingCompany: 'PSA',
      grade: 9.5,
      certNumber: 'C-1',
      gradedDate: '2025-12-01',
    };
    await repo.upsertByVariant(graded);
    const second = await repo.upsertByVariant(graded);
    expect(second.action).toBe('merged');
    expect(second.holding.quantity).toBe(2);
  });

  it('graded with different cert → separate row (different physical card)', async () => {
    const repo = createHoldingsRepo(db);
    const baseGraded: HoldingInput = {
      ...baseInput,
      conditionType: 'graded',
      rawCondition: null,
      gradingCompany: 'PSA',
      grade: 10,
      gradedDate: '2025-12-01',
    };
    await repo.upsertByVariant({ ...baseGraded, certNumber: 'C-1' });
    const second = await repo.upsertByVariant({
      ...baseGraded,
      certNumber: 'C-2',
    });
    expect(second.action).toBe('created');
    expect(await db.holdings.count()).toBe(2);
  });

  it('variant validation still rejects unknown finish (no row written)', async () => {
    const repo = createHoldingsRepo(db);
    // sampleCard has no `non_holo` in tcgplayer.prices and `non_holo`
    // is NOT an escape hatch — repo must reject.
    await expect(
      repo.upsertByVariant({
        ...baseInput,
        finish: 'non_holo',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await db.holdings.count()).toBe(0);
    // No audit row either.
    const audits = await db.auditLog
      .where('action')
      .equals('holding_created')
      .toArray();
    expect(audits).toHaveLength(0);
  });

  it('merge preserves existing note when input has none', async () => {
    const repo = createHoldingsRepo(db);
    const first = await repo.upsertByVariant({
      ...baseInput,
      note: 'first scan',
    });
    expect(first.holding.note).toBe('first scan');
    const second = await repo.upsertByVariant({ ...baseInput, note: null });
    expect(second.action).toBe('merged');
    expect(second.holding.note).toBe('first scan');
  });

  it('merge takes input note when existing has none', async () => {
    const repo = createHoldingsRepo(db);
    await repo.upsertByVariant({ ...baseInput, note: null });
    const second = await repo.upsertByVariant({
      ...baseInput,
      note: 'late note',
    });
    expect(second.action).toBe('merged');
    expect(second.holding.note).toBe('late note');
  });

  it('merge preserves prices, value tracking, tags, source', async () => {
    const repo = createHoldingsRepo(db);
    await repo.upsertByVariant({
      ...baseInput,
      purchasePrice: 250,
      purchaseCurrency: 'NOK',
      estimatedValue: 500,
      valueCurrency: 'NOK',
      valueSource: 'manual',
      tags: ['favorite', 'high_value'],
      source: 'lot',
    });
    const second = await repo.upsertByVariant({
      ...baseInput,
      purchasePrice: null,
      purchaseCurrency: null,
      tags: [],
      source: 'manual',
    });
    expect(second.action).toBe('merged');
    expect(second.holding.purchasePrice).toBe(250);
    expect(second.holding.estimatedValue).toBe(500);
    expect(second.holding.tags).toEqual(['favorite', 'high_value']);
    expect(second.holding.source).toBe('lot');
  });

  it('soft-deleted holding does NOT match — creates a new row instead of resurrecting', async () => {
    const repo = createHoldingsRepo(db);
    const first = await repo.upsertByVariant(baseInput);
    await repo.softDelete(first.holding.id);
    const second = await repo.upsertByVariant(baseInput);
    expect(second.action).toBe('created');
    expect(second.holding.id).not.toBe(first.holding.id);
    // Total count = soft-deleted row + new live row = 2.
    expect(await db.holdings.count()).toBe(2);
    const live = await repo.listLive();
    expect(live).toHaveLength(1);
    expect(live[0]?.quantity).toBe(1);
  });

  it('writes a `holding_qty_incremented` audit on merge', async () => {
    const repo = createHoldingsRepo(db);
    await repo.upsertByVariant({ ...baseInput, quantity: 2 });
    await repo.upsertByVariant({ ...baseInput, quantity: 3 });
    const merged = await db.auditLog
      .where('action')
      .equals('holding_qty_incremented')
      .toArray();
    expect(merged).toHaveLength(1);
    expect(merged[0]?.message).toContain('2');
    expect(merged[0]?.message).toContain('5');
  });

  it('writes a `holding_created` audit on first call', async () => {
    const repo = createHoldingsRepo(db);
    await repo.upsertByVariant(baseInput);
    const created = await db.auditLog
      .where('action')
      .equals('holding_created')
      .toArray();
    expect(created).toHaveLength(1);
    expect(created[0]?.message).toContain('upsertByVariant');
  });

  it('explicit create() still produces a new row even when a matching live holding exists', async () => {
    // The legacy `create()` path is still available for callers that
    // want to register a SEPARATE row (e.g. one NM, one NM with a
    // distinct provenance the user wants to track manually). Only
    // `upsertByVariant()` merges.
    const repo = createHoldingsRepo(db);
    await repo.upsertByVariant(baseInput);
    await repo.create(baseInput);
    expect(await db.holdings.count()).toBe(2);
  });
});
