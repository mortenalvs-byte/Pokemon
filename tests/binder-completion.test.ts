// Pure-math tests for KRAVSPEC §6 binder completion. No DB needed.

import { describe, expect, it } from 'vitest';

import { calculateBinderCompletion } from '../src/domain/binder-completion';
import type { BinderSlotRecord } from '../src/domain/types';

function makeSlot(overrides: Partial<BinderSlotRecord> = {}): BinderSlotRecord {
  return {
    id: 'slot-x',
    binderId: 'binder-x',
    pageNumber: 1,
    slotNumber: 1,
    targetCardId: 'base1-1',
    holdingId: null,
    status: 'wanted',
    note: null,
    createdAt: '2026-05-06T00:00:00.000Z',
    updatedAt: '2026-05-06T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

describe('calculateBinderCompletion', () => {
  it('returns 0/0/0/0 for an empty array', () => {
    const result = calculateBinderCompletion([], new Set());
    expect(result).toEqual({
      totalTargetSlots: 0,
      completedSlots: 0,
      missingSlots: 0,
      percentage: 0,
    });
  });

  it('only counts target slots in the denominator', () => {
    // Two with targetCardId, one without. Denominator = 2.
    const slots = [
      makeSlot({ id: '1', targetCardId: 'a', status: 'wanted' }),
      makeSlot({ id: '2', targetCardId: 'b', status: 'wanted' }),
      makeSlot({ id: '3', targetCardId: null, status: 'empty' }),
    ];
    const result = calculateBinderCompletion(slots, new Set());
    expect(result.totalTargetSlots).toBe(2);
    expect(result.completedSlots).toBe(0);
    expect(result.missingSlots).toBe(2);
    expect(result.percentage).toBe(0);
  });

  it('a slot is complete only when status=owned + holdingId set + holding live', () => {
    const liveHoldingIds = new Set(['h1', 'h2']);
    const slots = [
      // Owned + live → complete
      makeSlot({ id: '1', targetCardId: 'a', holdingId: 'h1', status: 'owned' }),
      // Owned + dead holding → not complete
      makeSlot({ id: '2', targetCardId: 'b', holdingId: 'h-deleted', status: 'owned' }),
      // Owned + null holdingId → not complete (defensive: should not happen in practice)
      makeSlot({ id: '3', targetCardId: 'c', holdingId: null, status: 'owned' }),
      // duplicate + live holding → not complete (only 'owned' counts)
      makeSlot({ id: '4', targetCardId: 'd', holdingId: 'h2', status: 'duplicate' }),
    ];
    const result = calculateBinderCompletion(slots, liveHoldingIds);
    expect(result.totalTargetSlots).toBe(4);
    expect(result.completedSlots).toBe(1);
    expect(result.missingSlots).toBe(3);
    expect(result.percentage).toBe(25);
  });

  it('skips soft-deleted slots entirely', () => {
    const liveHoldingIds = new Set(['h1']);
    const slots = [
      makeSlot({ id: '1', targetCardId: 'a', holdingId: 'h1', status: 'owned' }),
      makeSlot({
        id: '2',
        targetCardId: 'b',
        holdingId: 'h1',
        status: 'owned',
        deletedAt: '2026-05-06T00:00:00.000Z',
      }),
    ];
    const result = calculateBinderCompletion(slots, liveHoldingIds);
    expect(result.totalTargetSlots).toBe(1);
    expect(result.completedSlots).toBe(1);
    expect(result.percentage).toBe(100);
  });

  it('rounds percentage to whole number', () => {
    // 1 of 3 = 33.33% → 33
    const liveHoldingIds = new Set(['h1']);
    const slots = [
      makeSlot({ id: '1', targetCardId: 'a', holdingId: 'h1', status: 'owned' }),
      makeSlot({ id: '2', targetCardId: 'b', status: 'wanted' }),
      makeSlot({ id: '3', targetCardId: 'c', status: 'wanted' }),
    ];
    const result = calculateBinderCompletion(slots, liveHoldingIds);
    expect(result.percentage).toBe(33);
  });

  it('returns 100% when every target slot is complete', () => {
    const liveHoldingIds = new Set(['h1', 'h2']);
    const slots = [
      makeSlot({ id: '1', targetCardId: 'a', holdingId: 'h1', status: 'owned' }),
      makeSlot({ id: '2', targetCardId: 'b', holdingId: 'h2', status: 'owned' }),
    ];
    const result = calculateBinderCompletion(slots, liveHoldingIds);
    expect(result.percentage).toBe(100);
    expect(result.missingSlots).toBe(0);
  });

  it('returns percentage 0 when there are no target slots at all', () => {
    const slots = [
      makeSlot({ id: '1', targetCardId: null, status: 'empty' }),
      makeSlot({ id: '2', targetCardId: null, status: 'empty' }),
    ];
    const result = calculateBinderCompletion(slots, new Set(['h1']));
    expect(result.totalTargetSlots).toBe(0);
    expect(result.percentage).toBe(0);
    expect(result.missingSlots).toBe(0);
  });
});
