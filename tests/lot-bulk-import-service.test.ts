// PR B1 — Tests for the lot bulk-import parser + resolver.
// Pure-function tests that exercise the parse + resolve path against a
// real DB seeded with two cards from two different sets.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { createCardsRepo, createSetsRepo } from './helpers/repos';
import { makeCard } from './helpers/cards';
import { parseAndResolveBulkImport } from '../src/services/lot-bulk-import-service';
import type { SetRecord } from '../src/domain/types';
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
  updatedAt: '2026-05-12T00:00:00.000Z',
};

describe('lot-bulk-import-service.parseAndResolveBulkImport', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
    await createSetsRepo(db).upsert(baseSet);
    await createCardsRepo(db).upsert(makeCard('base1-4', { overrides: { name: 'Charizard' } }));
    await createCardsRepo(db).upsert(makeCard('base1-58', { overrides: { name: 'Pikachu' } }));
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('parses cardId-only lines with defaults', async () => {
    const repo = createCardsRepo(db);
    const r = await parseAndResolveBulkImport('lot-1', 'base1-4\nbase1-58\n', repo);
    expect(r.resolved).toHaveLength(2);
    expect(r.errors).toHaveLength(0);
    expect(r.resolved[0]?.input.cardId).toBe('base1-4');
    expect(r.resolved[0]?.input.quantity).toBe(1);
    expect(r.resolved[0]?.input.finish).toBe('normal');
    expect(r.resolved[0]?.input.edition).toBe('unlimited');
    expect(r.resolved[0]?.input.rawCondition).toBe('NM');
    expect(r.resolved[0]?.input.conditionType).toBe('raw');
  });

  it('parses full lines with explicit quantity/finish/edition/condition', async () => {
    const repo = createCardsRepo(db);
    const r = await parseAndResolveBulkImport(
      'lot-1',
      'base1-4,4,reverse_holo,first_edition,LP\n',
      repo,
    );
    expect(r.resolved).toHaveLength(1);
    const item = r.resolved[0]?.input;
    expect(item?.quantity).toBe(4);
    expect(item?.finish).toBe('reverse_holo');
    expect(item?.edition).toBe('first_edition');
    expect(item?.rawCondition).toBe('LP');
  });

  it('skips blank lines and #-comments without reporting errors', async () => {
    const repo = createCardsRepo(db);
    const text = `
base1-4
# this is a comment line, ignored

base1-58,2

# trailing comment
`;
    const r = await parseAndResolveBulkImport('lot-1', text, repo);
    expect(r.resolved).toHaveLength(2);
    expect(r.errors).toHaveLength(0);
    expect(r.skippedBlank).toBeGreaterThan(0);
    expect(r.skippedComment).toBeGreaterThan(0);
  });

  it('reports per-line error for unknown cardId without consuming neighbours', async () => {
    const repo = createCardsRepo(db);
    const text = 'base1-4\nbase1-not-real\nbase1-58\n';
    const r = await parseAndResolveBulkImport('lot-1', text, repo);
    expect(r.resolved).toHaveLength(2);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.line).toBe(2);
    expect(r.errors[0]?.reason).toMatch(/ikke i kort-databasen/i);
  });

  it('reports per-line error for invalid quantity (not-a-number)', async () => {
    const repo = createCardsRepo(db);
    const r = await parseAndResolveBulkImport('lot-1', 'base1-4,not-a-number\n', repo);
    expect(r.resolved).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.reason).toMatch(/ugyldig quantity/i);
  });

  it.each([
    ['decimal value', 'base1-4,1.5\n'],
    ['comma decimal',  'base1-4,1.0\n'],
    ['trailing junk',  'base1-4,2x\n'],
    ['leading sign',   'base1-4,+3\n'],
    ['negative',       'base1-4,-1\n'],
    ['zero',           'base1-4,0\n'],
    ['leading zero',   'base1-4,01\n'],
    ['exponent',       'base1-4,1e2\n'],
    ['hex prefix',     'base1-4,0x10\n'],
  ])('rejects quantity %s (strict base-10 positive integer only)', async (_label, text) => {
    const repo = createCardsRepo(db);
    const r = await parseAndResolveBulkImport('lot-1', text, repo);
    expect(r.resolved).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.reason).toMatch(/ugyldig quantity/i);
  });

  it('keeps default quantity = 1 when the column is omitted or blank', async () => {
    const repo = createCardsRepo(db);
    // omitted (no comma)
    const r1 = await parseAndResolveBulkImport('lot-1', 'base1-4\n', repo);
    expect(r1.resolved[0]?.input.quantity).toBe(1);
    // explicit empty value (column present but empty between commas)
    const r2 = await parseAndResolveBulkImport('lot-1', 'base1-4,,normal\n', repo);
    expect(r2.resolved).toHaveLength(1);
    expect(r2.resolved[0]?.input.quantity).toBe(1);
  });

  it('accepts a range of valid base-10 positive integers', async () => {
    const repo = createCardsRepo(db);
    const r = await parseAndResolveBulkImport(
      'lot-1',
      'base1-4,1\nbase1-4,4\nbase1-4,25\nbase1-4,999\n',
      repo,
    );
    expect(r.errors).toHaveLength(0);
    expect(r.resolved.map((p) => p.input.quantity)).toEqual([1, 4, 25, 999]);
  });

  it('reports per-line error for invalid finish', async () => {
    const repo = createCardsRepo(db);
    const r = await parseAndResolveBulkImport('lot-1', 'base1-4,1,bad-finish\n', repo);
    expect(r.resolved).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.reason).toMatch(/ugyldig finish/i);
  });

  it('reports per-line error for invalid edition', async () => {
    const repo = createCardsRepo(db);
    const r = await parseAndResolveBulkImport(
      'lot-1',
      'base1-4,1,normal,bogus-edition\n',
      repo,
    );
    expect(r.resolved).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.reason).toMatch(/ugyldig edition/i);
  });

  it('reports per-line error for invalid condition', async () => {
    const repo = createCardsRepo(db);
    const r = await parseAndResolveBulkImport(
      'lot-1',
      'base1-4,1,normal,unlimited,XX\n',
      repo,
    );
    expect(r.resolved).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.reason).toMatch(/ugyldig condition/i);
  });

  it('handles CRLF line endings (Windows paste)', async () => {
    const repo = createCardsRepo(db);
    const r = await parseAndResolveBulkImport(
      'lot-1',
      'base1-4,1\r\nbase1-58,2\r\n',
      repo,
    );
    expect(r.resolved).toHaveLength(2);
    expect(r.errors).toHaveLength(0);
  });

  it('caches card lookups when the same cardId appears multiple times', async () => {
    const repo = createCardsRepo(db);
    let lookupCount = 0;
    const wrappedRepo = {
      ...repo,
      async get(id: string) {
        lookupCount++;
        return repo.get(id);
      },
    };
    const text = 'base1-4,1\nbase1-4,2,reverse_holo\nbase1-4,1,normal,first_edition\n';
    const r = await parseAndResolveBulkImport('lot-1', text, wrappedRepo);
    expect(r.resolved).toHaveLength(3);
    // Cache hit: only one DB lookup despite three input lines for the same card.
    expect(lookupCount).toBe(1);
  });

  it('attaches the supplied lotId to every resolved item', async () => {
    const repo = createCardsRepo(db);
    const r = await parseAndResolveBulkImport(
      'lot-XYZ-123',
      'base1-4\nbase1-58\n',
      repo,
    );
    for (const item of r.resolved) {
      expect(item.input.lotId).toBe('lot-XYZ-123');
    }
  });

  it('preserves input-line numbering when resolved + errors interleave', async () => {
    const repo = createCardsRepo(db);
    const text = 'base1-4\nbase1-bad\nbase1-58\n';
    const r = await parseAndResolveBulkImport('lot-1', text, repo);
    expect(r.resolved[0]?.line).toBe(1);
    expect(r.errors[0]?.line).toBe(2);
    expect(r.resolved[1]?.line).toBe(3);
  });
});
