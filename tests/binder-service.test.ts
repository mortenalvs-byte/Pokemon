// Tests for the atomic binder creation service. Covers:
//   1. createManualBinder builds totalPages * slotsPerPage empty slots
//      in one transaction and writes a single audit row.
//   2. ValidationError on bad input — and crucially, no rows leak into
//      any of binders, binderSlots, or auditLog when validation fails.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { ValidationError } from '../src/domain/validators';
import { createBinderService } from '../src/services/binder-service';
import type { PokemonTrackerDB } from '../src/db/database';

describe('binder-service.createManualBinder', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('creates binder + every empty slot in one transaction with one audit row', async () => {
    const service = createBinderService(db);
    const result = await service.createManualBinder({
      name: 'Master binder',
      description: null,
      binderType: 'VaultX',
      totalPages: 3,
      slotsPerPage: 9,
      completionMode: 'standard',
      sourceSetId: null,
    });

    expect(result.binder.id).toBeDefined();
    expect(result.binder.deletedAt).toBeNull();
    expect(result.slots.length).toBe(27);

    const stored = await db.binderSlots
      .where('binderId')
      .equals(result.binder.id)
      .toArray();
    expect(stored.length).toBe(27);
    expect(stored.every((s) => s.status === 'empty')).toBe(true);
    expect(stored.every((s) => s.targetCardId === null)).toBe(true);
    expect(stored.every((s) => s.holdingId === null)).toBe(true);
    expect(stored.every((s) => s.deletedAt === null)).toBe(true);

    // Pages 1..3 each have slots 1..9.
    const pages = new Set(stored.map((s) => s.pageNumber));
    expect(pages).toEqual(new Set([1, 2, 3]));
    const slotsOnPage1 = stored
      .filter((s) => s.pageNumber === 1)
      .map((s) => s.slotNumber)
      .sort((a, b) => a - b);
    expect(slotsOnPage1).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // Single audit row at the binder level.
    const audits = await db.auditLog
      .where('action')
      .equals('binder_created')
      .toArray();
    expect(audits.length).toBe(1);
    expect(audits[0]?.entityId).toBe(result.binder.id);
    expect(audits[0]?.message).toContain('27');
  });

  it('rolls back when binder validation fails — no rows in any store', async () => {
    const service = createBinderService(db);
    await expect(
      service.createManualBinder({
        name: '   ',
        description: null,
        binderType: null,
        totalPages: 1,
        slotsPerPage: 9,
        completionMode: 'standard',
        sourceSetId: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await db.binders.count()).toBe(0);
    expect(await db.binderSlots.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(0);
  });

  it('supports 18 slots per page', async () => {
    const service = createBinderService(db);
    const result = await service.createManualBinder({
      name: '18-slot binder',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 18,
      completionMode: 'standard',
      sourceSetId: null,
    });
    expect(result.slots.length).toBe(18);
    const stored = await db.binderSlots
      .where('binderId')
      .equals(result.binder.id)
      .toArray();
    const slotNumbers = stored.map((s) => s.slotNumber).sort((a, b) => a - b);
    expect(slotNumbers).toEqual(Array.from({ length: 18 }, (_v, i) => i + 1));
  });
});
