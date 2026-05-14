// Tests for the bulk-add-holdings service: parser + apply.
//
// The parser must:
//   - skip blank lines and #-comments
//   - apply documented defaults (quantity=1, finish=normal, edition=unlimited, condition=NM)
//   - reject unknown cardIds, non-positive quantities, illegal enum values
//   - cache cardId lookups so repeated lines don't repeat repo round-trips
//
// The apply step must:
//   - upsert (merge same-variant rows rather than duplicate them)
//   - keep going past per-row failures
//   - write exactly one summary audit row at the end

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAndDelete, freshDb } from './helpers/fresh-db';
import {
  applyBulkAddHoldings,
  parseBulkAddHoldings,
} from '../src/services/bulk-add-holdings-service';
import { createCardsRepo } from '../src/repositories/cards-repo';
import type { PokemonTrackerDB } from '../src/db/database';
import type { CardRecord } from '../src/domain/types';

function makeCard(id: string): CardRecord {
  return {
    id,
    setId: id.split('-')[0] ?? 'base1',
    name: `Card ${id}`,
    number: '1',
    rarity: 'Common',
    supertype: 'Pokémon',
    subtypes: [],
    types: [],
    imageSmall: null,
    imageLarge: null,
    tcgplayer: { prices: { normal: { market: 1 } } },
    cardmarket: null,
    updatedAt: '2026-05-14T00:00:00.000Z',
  };
}

describe('parseBulkAddHoldings', () => {
  let db: PokemonTrackerDB;
  beforeEach(async () => { db = await freshDb(); });
  afterEach(async () => { await closeAndDelete(db); });

  it('parses minimal one-line input with defaults', async () => {
    await db.cards.add(makeCard('base1-1'));
    const repo = createCardsRepo(db);
    const out = await parseBulkAddHoldings('base1-1', repo);
    expect(out.resolved).toHaveLength(1);
    expect(out.errors).toEqual([]);
    const draft = out.resolved[0]?.input;
    expect(draft?.cardId).toBe('base1-1');
    expect(draft?.quantity).toBe(1);
    expect(draft?.finish).toBe('normal');
    expect(draft?.edition).toBe('unlimited');
    expect(draft?.rawCondition).toBe('NM');
    expect(draft?.conditionType).toBe('raw');
    expect(draft?.status).toBe('owned');
  });

  it('skips blank lines and #-comments without flagging them', async () => {
    await db.cards.add(makeCard('base1-1'));
    const out = await parseBulkAddHoldings(
      '\n# this is a comment\nbase1-1\n\n# another comment',
      createCardsRepo(db),
    );
    expect(out.resolved).toHaveLength(1);
    expect(out.skippedBlank).toBe(2);
    expect(out.skippedComment).toBe(2);
    expect(out.errors).toEqual([]);
  });

  it('honours per-line overrides and defaults', async () => {
    await db.cards.add(makeCard('base1-1'));
    const repo = createCardsRepo(db);
    const out = await parseBulkAddHoldings(
      'base1-1,3,holo,unlimited,LP',
      repo,
    );
    expect(out.resolved).toHaveLength(1);
    const d = out.resolved[0]?.input;
    expect(d?.quantity).toBe(3);
    expect(d?.finish).toBe('holo');
    expect(d?.rawCondition).toBe('LP');
  });

  it('rejects unknown cardId', async () => {
    await db.cards.add(makeCard('base1-1'));
    const out = await parseBulkAddHoldings(
      'unknownset-9999',
      createCardsRepo(db),
    );
    expect(out.resolved).toEqual([]);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]?.reason).toMatch(/ukjent cardId/);
  });

  it('rejects bad quantity (zero, negative, decimal, trailing chars)', async () => {
    await db.cards.add(makeCard('base1-1'));
    const out = await parseBulkAddHoldings(
      'base1-1,0\nbase1-1,-1\nbase1-1,1.5\nbase1-1,2x',
      createCardsRepo(db),
    );
    expect(out.resolved).toEqual([]);
    expect(out.errors).toHaveLength(4);
    for (const e of out.errors) {
      expect(e.reason).toMatch(/ugyldig quantity/);
    }
  });

  it('rejects illegal finish/edition/condition values', async () => {
    await db.cards.add(makeCard('base1-1'));
    const out = await parseBulkAddHoldings(
      'base1-1,1,sparkly\nbase1-1,1,normal,fancy\nbase1-1,1,normal,unlimited,perfect',
      createCardsRepo(db),
    );
    expect(out.resolved).toEqual([]);
    expect(out.errors).toHaveLength(3);
    expect(out.errors[0]?.reason).toMatch(/finish/);
    expect(out.errors[1]?.reason).toMatch(/edition/);
    expect(out.errors[2]?.reason).toMatch(/condition/);
  });

  it('caches repeated cardId lookups (one repo round-trip per unique id)', async () => {
    await db.cards.add(makeCard('base1-1'));
    let callCount = 0;
    const baseRepo = createCardsRepo(db);
    const counted = {
      ...baseRepo,
      get: async (id: string) => { callCount += 1; return baseRepo.get(id); },
    };
    await parseBulkAddHoldings(
      'base1-1,1\nbase1-1,2\nbase1-1,3,holo',
      counted,
    );
    expect(callCount).toBe(1);
  });
});

describe('applyBulkAddHoldings', () => {
  let db: PokemonTrackerDB;
  beforeEach(async () => { db = await freshDb(); });
  afterEach(async () => { await closeAndDelete(db); });

  it('creates new holdings + merges same-variant lines, writes one summary audit row', async () => {
    await db.cards.add(makeCard('base1-1'));
    await db.cards.add(makeCard('base1-2'));
    const cards = createCardsRepo(db);

    // base1-1 twice = first creates, second merges (same variant).
    // base1-2 once = creates.
    const parsed = await parseBulkAddHoldings(
      'base1-1,2\nbase1-1,3\nbase1-2,1',
      cards,
    );
    expect(parsed.resolved).toHaveLength(3);

    const before = await db.auditLog.count();
    const result = await applyBulkAddHoldings(db, parsed);
    const after = await db.auditLog.count();

    expect(result.created).toHaveLength(2);
    expect(result.merged).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(after - before).toBe(4); // 2 create + 1 merge + 1 summary

    const holdings = await db.holdings.toArray();
    expect(holdings).toHaveLength(2);
    const base1_1 = holdings.find((h) => h.cardId === 'base1-1');
    expect(base1_1?.quantity).toBe(5); // 2 + 3 merged
    const base1_2 = holdings.find((h) => h.cardId === 'base1-2');
    expect(base1_2?.quantity).toBe(1);

    const summary = await db.auditLog
      .where('action').equals('holdings_bulk_added').toArray();
    expect(summary).toHaveLength(1);
    expect(summary[0]?.message).toContain('2 opprettet');
    expect(summary[0]?.message).toContain('1 merget');
  });

  it('fires onProgress with create vs merge action', async () => {
    await db.cards.add(makeCard('base1-1'));
    const cards = createCardsRepo(db);
    const parsed = await parseBulkAddHoldings(
      'base1-1\nbase1-1,5',
      cards,
    );
    const events: Array<{ index: number; action: 'created' | 'merged' }> = [];
    await applyBulkAddHoldings(db, parsed, {
      onProgress: (e) => { events.push({ index: e.index, action: e.action }); },
    });
    expect(events).toEqual([
      { index: 1, action: 'created' },
      { index: 2, action: 'merged' },
    ]);
  });

  it('handles many cards efficiently (200 rows finish under 5 seconds)', async () => {
    for (let i = 1; i <= 200; i += 1) {
      await db.cards.add(makeCard(`base1-${i}`));
    }
    const lines = Array.from({ length: 200 }, (_v, i) => `base1-${i + 1}`).join('\n');
    const parsed = await parseBulkAddHoldings(lines, createCardsRepo(db));
    expect(parsed.resolved).toHaveLength(200);

    const start = Date.now();
    const result = await applyBulkAddHoldings(db, parsed);
    const elapsed = Date.now() - start;
    expect(result.created).toHaveLength(200);
    expect(elapsed).toBeLessThan(5000);
  });
});
