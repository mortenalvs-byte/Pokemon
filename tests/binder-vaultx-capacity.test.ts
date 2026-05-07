// PR 14 — service-level capacity-fill tests for the from-set wizard.
// Each Vault X preset must mirror the physical binder: target drafts
// fill the first slots and the rest are empty placeholders, regardless
// of how few cards the source set has.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { ValidationError } from '../src/domain/validators';
import { createBinderService } from '../src/services/binder-service';
import type { PokemonTrackerDB } from '../src/db/database';
import type { SlotDraft } from '../src/domain/binder-template';

function draftsForFirstSlots(count: number, slotsPerPage: number): SlotDraft[] {
  const out: SlotDraft[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      pageNumber: Math.floor(i / slotsPerPage) + 1,
      slotNumber: (i % slotsPerPage) + 1,
      targetCardId: `c-${i + 1}`,
      note: null,
    });
  }
  return out;
}

describe('binder-service.createBinderFromSet — Vault X capacity-fill', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('Vault X 9-pocket fills 360 slots regardless of draft count', async () => {
    const result = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'Base 9',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        binderPreset: 'vaultx_9_360',
        completionMode: 'standard',
        sourceSetId: 'base1',
      },
      slots: draftsForFirstSlots(102, 9),
    });
    expect(result.binder.totalPages).toBe(40);
    expect(result.binder.binderPreset).toBe('vaultx_9_360');
    expect(result.slots.length).toBe(360);
    const targets = result.slots.filter((s) => s.targetCardId !== null);
    expect(targets.length).toBe(102);
    const empties = result.slots.filter((s) => s.targetCardId === null);
    expect(empties.length).toBe(258);
    expect(empties.every((s) => s.status === 'empty')).toBe(true);
    expect(targets.every((s) => s.status === 'wanted')).toBe(true);
  });

  it('Vault X 12-pocket fills 480 slots', async () => {
    const result = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'B',
        description: null,
        binderType: null,
        slotsPerPage: 12,
        binderPreset: 'vaultx_12_480',
        completionMode: 'standard',
        sourceSetId: 'base1',
      },
      slots: draftsForFirstSlots(50, 12),
    });
    expect(result.binder.totalPages).toBe(40);
    expect(result.slots.length).toBe(480);
    expect(
      result.slots.filter((s) => s.targetCardId !== null).length,
    ).toBe(50);
  });

  it('Vault X 12-pocket XL fills 624 slots', async () => {
    const result = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'B',
        description: null,
        binderType: null,
        slotsPerPage: 12,
        binderPreset: 'vaultx_12xl_624',
        completionMode: 'master',
        sourceSetId: 'base1',
      },
      slots: draftsForFirstSlots(200, 12),
    });
    expect(result.binder.totalPages).toBe(52);
    expect(result.slots.length).toBe(624);
    expect(
      result.slots.filter((s) => s.targetCardId !== null).length,
    ).toBe(200);
  });

  it('Vault X 16-pocket XXL fills 1088 slots', async () => {
    const result = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'B',
        description: null,
        binderType: null,
        slotsPerPage: 16,
        binderPreset: 'vaultx_16xxl_1088',
        completionMode: 'master',
        sourceSetId: 'base1',
      },
      slots: draftsForFirstSlots(300, 16),
    });
    expect(result.binder.totalPages).toBe(68);
    expect(result.slots.length).toBe(1088);
    expect(
      result.slots.filter((s) => s.targetCardId !== null).length,
    ).toBe(300);
  });

  it('rejects when target drafts exceed Vault X capacity', async () => {
    await expect(
      createBinderService(db).createBinderFromSet({
        binder: {
          name: 'Too small',
          description: null,
          binderType: null,
          slotsPerPage: 9,
          binderPreset: 'vaultx_9_360',
          completionMode: 'standard',
          sourceSetId: 'base1',
        },
        // 360 + 1 = over capacity.
        slots: draftsForFirstSlots(361, 9),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await db.binders.count()).toBe(0);
    expect(await db.binderSlots.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(0);
  });

  it('audit message reports total slots and target count', async () => {
    const result = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'Auditable',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        binderPreset: 'vaultx_9_360',
        completionMode: 'standard',
        sourceSetId: 'base1',
      },
      slots: draftsForFirstSlots(5, 9),
    });
    const audits = await db.auditLog
      .where('action')
      .equals('binder_created')
      .toArray();
    expect(audits.length).toBe(1);
    expect(audits[0]?.message).toContain('360 slots');
    expect(audits[0]?.message).toContain('5 targets');
    expect(audits[0]?.message).toContain('vaultx_9_360');
    expect(result.slots[0]?.targetCardId).toBe('c-1');
    expect(result.slots[5]?.targetCardId).toBeNull();
  });

  it('custom preset still sizes the binder to the drafts', async () => {
    // Backwards-compatible behaviour for null/custom preset:
    // ceil(drafts / slotsPerPage) pages, the rest is filled empty.
    const result = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'Custom-sized',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        binderPreset: 'custom',
        completionMode: 'standard',
        sourceSetId: 'base1',
      },
      slots: draftsForFirstSlots(11, 9),
    });
    // 11 drafts at 9/page = 2 pages = 18 slots (11 targets + 7 empty).
    expect(result.binder.totalPages).toBe(2);
    expect(result.slots.length).toBe(18);
    expect(
      result.slots.filter((s) => s.targetCardId !== null).length,
    ).toBe(11);
  });

  it('rejects a draft that points outside the binder grid', async () => {
    await expect(
      createBinderService(db).createBinderFromSet({
        binder: {
          name: 'Bad',
          description: null,
          binderType: null,
          slotsPerPage: 9,
          binderPreset: 'vaultx_9_360',
          completionMode: 'standard',
          sourceSetId: 'base1',
        },
        slots: [
          { pageNumber: 1, slotNumber: 99, targetCardId: 'a', note: null },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await db.binders.count()).toBe(0);
  });

  // PR 14 review patch: two drafts pointing at the exact same physical
  // cell would otherwise be silently merged by the placement Map (the
  // second overwrites the first), losing user data without any signal.
  // The service must reject the input before opening the transaction.
  it('rejects two drafts that target the same physical slot', async () => {
    await expect(
      createBinderService(db).createBinderFromSet({
        binder: {
          name: 'Dup',
          description: null,
          binderType: null,
          slotsPerPage: 9,
          binderPreset: 'vaultx_9_360',
          completionMode: 'standard',
          sourceSetId: 'base1',
        },
        slots: [
          { pageNumber: 1, slotNumber: 1, targetCardId: 'a', note: null },
          { pageNumber: 1, slotNumber: 1, targetCardId: 'b', note: null },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await db.binders.count()).toBe(0);
    expect(await db.binderSlots.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(0);
  });
});
