// Audit-action precedence tests for binder-slots-repo.update().
//
// The repo decides which audit row to write based on which fields are
// in `changes`:
//   - holdingId (non-null) → binder_slot_assigned
//   - status only          → binder_slot_status_changed
//   - anything else        → binder_slot_updated
// And: assigned wins over status when both change in the same call.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { createBinderService } from '../src/services/binder-service';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import type { PokemonTrackerDB } from '../src/db/database';

const baseHoldingInput = {
  cardId: 'base1-1',
  quantity: 1,
  conditionType: 'raw' as const,
  rawCondition: 'NM' as const,
  gradingCompany: null,
  grade: null,
  certNumber: null,
  certUrl: null,
  gradedDate: null,
  finish: 'normal' as const,
  edition: 'unlimited' as const,
  language: 'en',
  purchasePrice: null,
  purchaseCurrency: null,
  estimatedValue: null,
  valueCurrency: null,
  valueSource: 'unknown' as const,
  valueNote: null,
  valueUpdatedAt: null,
  source: 'manual' as const,
  note: null,
  specialVariant: false,
  tags: [],
  lotId: null,
  status: 'owned' as const,
};

async function lastBinderSlotAuditAction(db: PokemonTrackerDB): Promise<string> {
  const audits = await db.auditLog
    .where('entityType')
    .equals('binderSlot')
    .toArray();
  audits.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const last = audits[audits.length - 1];
  if (last === undefined) throw new Error('no audit row found');
  return last.action;
}

describe('binder-slots-repo audit precedence', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
    // PR 11 strict variant validation: seed the test card so the
    // baseHoldingInput passes through holdingsRepo.create.
    await db.cards.put({
      id: 'base1-1',
      setId: 'base1',
      name: 'Bulbasaur',
      number: '1',
      rarity: 'Rare',
      supertype: 'Pokémon',
      subtypes: [],
      types: [],
      imageSmall: null,
      imageLarge: null,
      tcgplayer: {
        prices: {
          normal: { market: 1 },
          holofoil: { market: 1 },
          reverseHolofoil: { market: 1 },
        },
      },
      cardmarket: null,
      updatedAt: '2026-05-06T00:00:00.000Z',
    });
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('writes binder_slot_assigned when holdingId is set', async () => {
    const binder = await createBinderService(db).createManualBinder({
      name: 'B',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      binderPreset: null,
      completionMode: 'standard',
      sourceSetId: null,
    });
    const slot = binder.slots[0];
    if (slot === undefined) throw new Error('test bootstrap failed');
    const holding = await createHoldingsRepo(db).create(baseHoldingInput);

    await createBinderSlotsRepo(db).update(
      slot.id,
      { holdingId: holding.id, status: 'owned' },
      9,
    );
    expect(await lastBinderSlotAuditAction(db)).toBe('binder_slot_assigned');
  });

  it('writes binder_slot_status_changed when only status changes', async () => {
    const binder = await createBinderService(db).createManualBinder({
      name: 'B',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      binderPreset: null,
      completionMode: 'standard',
      sourceSetId: null,
    });
    const slot = binder.slots[0];
    if (slot === undefined) throw new Error('test bootstrap failed');

    await createBinderSlotsRepo(db).update(
      slot.id,
      { status: 'wanted' },
      9,
    );
    expect(await lastBinderSlotAuditAction(db)).toBe('binder_slot_status_changed');
  });

  it('writes binder_slot_updated when neither holdingId nor status changes', async () => {
    const binder = await createBinderService(db).createManualBinder({
      name: 'B',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      binderPreset: null,
      completionMode: 'standard',
      sourceSetId: null,
    });
    const slot = binder.slots[0];
    if (slot === undefined) throw new Error('test bootstrap failed');

    await createBinderSlotsRepo(db).update(
      slot.id,
      { note: 'a note' },
      9,
    );
    expect(await lastBinderSlotAuditAction(db)).toBe('binder_slot_updated');
  });

  it('clearing holdingId (null) does NOT count as assigned', async () => {
    // Setting holdingId to null is a clear, not an assign — the audit
    // should be status_changed (because status also changes) or updated.
    const binder = await createBinderService(db).createManualBinder({
      name: 'B',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      binderPreset: null,
      completionMode: 'standard',
      sourceSetId: null,
    });
    const slot = binder.slots[0];
    if (slot === undefined) throw new Error('test bootstrap failed');
    const holding = await createHoldingsRepo(db).create(baseHoldingInput);

    const slotsRepo = createBinderSlotsRepo(db);
    await slotsRepo.update(
      slot.id,
      { holdingId: holding.id, status: 'owned' },
      9,
    );
    // Clearing — pass holdingId: null and a fresh status.
    await slotsRepo.update(
      slot.id,
      { holdingId: null, status: 'wanted' },
      9,
    );
    expect(await lastBinderSlotAuditAction(db)).toBe('binder_slot_status_changed');
  });
});
