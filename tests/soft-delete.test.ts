import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { HoldingInput } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

const sampleHolding: HoldingInput = {
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

describe('soft delete + restore', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('softDelete() sets deletedAt and audits', async () => {
    const repo = createHoldingsRepo(db);
    const created = await repo.create(sampleHolding);

    await repo.softDelete(created.id, 'test delete');

    const fetched = await repo.get(created.id);
    expect(fetched?.deletedAt).not.toBeNull();
    expect(typeof fetched?.deletedAt).toBe('string');

    const audit = await db.auditLog
      .where('action')
      .equals('holding_soft_deleted')
      .toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.entityId).toBe(created.id);
  });

  it('listLive() filters out soft-deleted records', async () => {
    const repo = createHoldingsRepo(db);
    const a = await repo.create(sampleHolding);
    const b = await repo.create({ ...sampleHolding, cardId: 'base1-5' });
    await repo.softDelete(a.id);

    const live = await repo.listLive();
    expect(live.map((h) => h.id)).toEqual([b.id]);
  });

  it('list() includes soft-deleted records', async () => {
    const repo = createHoldingsRepo(db);
    const a = await repo.create(sampleHolding);
    await repo.softDelete(a.id);

    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.deletedAt).not.toBeNull();
  });

  it('restore() nulls deletedAt and audits', async () => {
    const repo = createHoldingsRepo(db);
    const created = await repo.create(sampleHolding);
    await repo.softDelete(created.id);
    await repo.restore(created.id, 'whoops');

    const fetched = await repo.get(created.id);
    expect(fetched?.deletedAt).toBeNull();

    const restoreEntries = await db.auditLog
      .where('action')
      .equals('holding_restored')
      .toArray();
    expect(restoreEntries).toHaveLength(1);
  });

  it('softDelete() is idempotent and does not double-audit', async () => {
    const repo = createHoldingsRepo(db);
    const created = await repo.create(sampleHolding);
    await repo.softDelete(created.id);
    await repo.softDelete(created.id);

    const audit = await db.auditLog
      .where('action')
      .equals('holding_soft_deleted')
      .toArray();
    expect(audit).toHaveLength(1);
  });

  it('throws when soft-deleting an unknown id', async () => {
    const repo = createHoldingsRepo(db);
    await expect(repo.softDelete('does-not-exist')).rejects.toThrow(
      /not found/,
    );
  });
});
