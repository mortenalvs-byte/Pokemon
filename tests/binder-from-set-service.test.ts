// Tests for binderService.createBinderFromSet — atomic, sourceSetId
// preserved, slot drafts persisted, audit message reflects from-set.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { ValidationError } from '../src/domain/validators';
import { REVERSE_HOLO_TEMPLATE_MARKER } from '../src/domain/card-variants';
import { createBinderService } from '../src/services/binder-service';
import type { PokemonTrackerDB } from '../src/db/database';

describe('binder-service.createBinderFromSet', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('writes binder + every slot + one binder_created audit row in one transaction', async () => {
    const service = createBinderService(db);
    const result = await service.createBinderFromSet({
      binder: {
        name: 'Base Set (master)',
        description: null,
        binderType: null,
        slotsPerPage: 18,
        completionMode: 'master',
        sourceSetId: 'base1',
      },
      slots: [
        { pageNumber: 1, slotNumber: 1, targetCardId: 'base1-1', note: null },
        {
          pageNumber: 1,
          slotNumber: 2,
          targetCardId: 'base1-1',
          note: REVERSE_HOLO_TEMPLATE_MARKER,
        },
        { pageNumber: 1, slotNumber: 3, targetCardId: 'base1-2', note: null },
      ],
    });

    expect(result.binder.id).toBeDefined();
    expect(result.binder.sourceSetId).toBe('base1');
    expect(result.binder.completionMode).toBe('master');
    // totalPages derived from slots length (3 slots / 18 per page = 1)
    expect(result.binder.totalPages).toBe(1);
    expect(result.slots.length).toBe(3);
    expect(result.slots[1]?.note).toBe(REVERSE_HOLO_TEMPLATE_MARKER);
    expect(result.slots.every((s) => s.status === 'wanted')).toBe(true);
    expect(result.slots.every((s) => s.holdingId === null)).toBe(true);

    const stored = await db.binderSlots
      .where('binderId')
      .equals(result.binder.id)
      .toArray();
    expect(stored.length).toBe(3);

    const audits = await db.auditLog
      .where('action')
      .equals('binder_created')
      .toArray();
    expect(audits.length).toBe(1);
    expect(audits[0]?.message).toContain('from-set');
    expect(audits[0]?.message).toContain('base1');
    expect(audits[0]?.message).toContain('master');
    expect(audits[0]?.message).toContain('3');
  });

  it('derives totalPages = ceil(slots / slotsPerPage)', async () => {
    const service = createBinderService(db);
    const slots = Array.from({ length: 25 }, (_v, i) => ({
      pageNumber: Math.floor(i / 9) + 1,
      slotNumber: (i % 9) + 1,
      targetCardId: `base1-${i + 1}`,
      note: null,
    }));
    const result = await service.createBinderFromSet({
      binder: {
        name: 'Big',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        completionMode: 'standard',
        sourceSetId: 'base1',
      },
      slots,
    });
    expect(result.binder.totalPages).toBe(3); // 25 / 9 = 2.78 → 3
  });

  it('rolls back when validation fails — no rows in any store', async () => {
    const service = createBinderService(db);
    await expect(
      service.createBinderFromSet({
        binder: {
          name: '   ', // invalid
          description: null,
          binderType: null,
          slotsPerPage: 9,
          completionMode: 'standard',
          sourceSetId: 'base1',
        },
        slots: [
          { pageNumber: 1, slotNumber: 1, targetCardId: 'x', note: null },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await db.binders.count()).toBe(0);
    expect(await db.binderSlots.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(0);
  });

  it('rejects empty slot list', async () => {
    const service = createBinderService(db);
    await expect(
      service.createBinderFromSet({
        binder: {
          name: 'Empty',
          description: null,
          binderType: null,
          slotsPerPage: 9,
          completionMode: 'standard',
          sourceSetId: 'base1',
        },
        slots: [],
      }),
    ).rejects.toThrow();
    expect(await db.binders.count()).toBe(0);
  });

  it('rolls back when a slot draft is invalid (slotNumber out of range)', async () => {
    const service = createBinderService(db);
    await expect(
      service.createBinderFromSet({
        binder: {
          name: 'Bad slot',
          description: null,
          binderType: null,
          slotsPerPage: 9,
          completionMode: 'standard',
          sourceSetId: 'base1',
        },
        slots: [
          { pageNumber: 1, slotNumber: 1, targetCardId: 'a', note: null },
          {
            pageNumber: 1,
            slotNumber: 99, // > slotsPerPage = 9
            targetCardId: 'b',
            note: null,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await db.binders.count()).toBe(0);
    expect(await db.binderSlots.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(0);
  });
});
