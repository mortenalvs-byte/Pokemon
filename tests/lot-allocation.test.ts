// Pure tests for the lot allocation engine.

import { describe, expect, it } from 'vitest';

import { allocateLot } from '../src/domain/lot-allocation';
import type { LotItemRecord } from '../src/domain/types';

function makeItem(
  id: string,
  overrides: Partial<LotItemRecord> = {},
): LotItemRecord {
  return {
    id,
    lotId: 'lot-1',
    cardId: `card-${id}`,
    finish: 'normal',
    edition: 'unlimited',
    conditionType: 'raw',
    rawCondition: 'NM',
    gradingCompany: null,
    grade: null,
    quantity: 1,
    manualPriceOverride: null,
    marketEstimate: null,
    allocatedCost: null,
    holdingId: null,
    note: null,
    createdAt: '2026-05-06T00:00:00.000Z',
    updatedAt: '2026-05-06T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

describe('allocateLot — equal', () => {
  it('splits 100 NOK / 3 items into 33.33 / 33.33 / 33.34', () => {
    const result = allocateLot(
      { totalCost: 100, allocationMethod: 'equal', currency: 'NOK' },
      [makeItem('1'), makeItem('2'), makeItem('3')],
    );
    expect(result.status).toBe('ok');
    expect(result.allocations.map((a) => a.allocatedCost)).toEqual([
      33.33,
      33.33,
      33.34,
    ]);
    expect(result.totalAllocated).toBe(100);
    expect(result.residual).toBe(0);
  });

  it('handles 0 items with a warning, no errors', () => {
    const result = allocateLot(
      { totalCost: 100, allocationMethod: 'equal', currency: 'NOK' },
      [],
    );
    expect(result.status).toBe('ok');
    expect(result.allocations).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.totalAllocated).toBe(0);
    expect(result.residual).toBe(100);
  });

  it('handles totalCost = 0', () => {
    const result = allocateLot(
      { totalCost: 0, allocationMethod: 'equal', currency: 'NOK' },
      [makeItem('1'), makeItem('2')],
    );
    expect(result.status).toBe('ok');
    expect(result.allocations).toEqual([
      { itemId: '1', allocatedCost: 0 },
      { itemId: '2', allocatedCost: 0 },
    ]);
  });

  it('errors on negative totalCost', () => {
    const result = allocateLot(
      { totalCost: -5, allocationMethod: 'equal', currency: 'NOK' },
      [makeItem('1')],
    );
    expect(result.status).toBe('error');
    expect(result.errors.length).toBe(1);
  });
});

describe('allocateLot — weighted_by_market_price', () => {
  it('allocates proportionally to market estimate', () => {
    const items = [
      makeItem('1', { marketEstimate: 800 }),
      makeItem('2', { marketEstimate: 100 }),
      makeItem('3', { marketEstimate: 100 }),
    ];
    const result = allocateLot(
      {
        totalCost: 1000,
        allocationMethod: 'weighted_by_market_price',
        currency: 'NOK',
      },
      items,
    );
    expect(result.status).toBe('ok');
    expect(result.totalAllocated).toBe(1000);
    expect(result.residual).toBe(0);
    // 800 / 1000 * 1000 = 800; 100 / 1000 * 1000 = 100 each
    const byId = new Map(
      result.allocations.map((a) => [a.itemId, a.allocatedCost]),
    );
    expect(byId.get('1')).toBe(800);
    expect(byId.get('2')).toBeCloseTo(100, 2);
    expect(byId.get('3')).toBeCloseTo(100, 2);
  });

  it('gives 0 to items with null/zero market and routes residual to last non-zero', () => {
    const items = [
      makeItem('1', { marketEstimate: null }),
      makeItem('2', { marketEstimate: 0 }),
      makeItem('3', { marketEstimate: 50 }),
    ];
    const result = allocateLot(
      {
        totalCost: 100,
        allocationMethod: 'weighted_by_market_price',
        currency: 'NOK',
      },
      items,
    );
    expect(result.status).toBe('ok');
    const byId = new Map(
      result.allocations.map((a) => [a.itemId, a.allocatedCost]),
    );
    expect(byId.get('1')).toBe(0);
    expect(byId.get('2')).toBe(0);
    expect(byId.get('3')).toBe(100);
  });

  it('errors when every market estimate is null/zero', () => {
    const items = [
      makeItem('1', { marketEstimate: null }),
      makeItem('2', { marketEstimate: 0 }),
    ];
    const result = allocateLot(
      {
        totalCost: 100,
        allocationMethod: 'weighted_by_market_price',
        currency: 'NOK',
      },
      items,
    );
    expect(result.status).toBe('error');
    expect(result.errors.length).toBe(1);
    expect(result.totalAllocated).toBe(0);
  });
});

describe('allocateLot — manual', () => {
  it('errors when an item has no manual override', () => {
    const items = [
      makeItem('1', { manualPriceOverride: 50 }),
      makeItem('2', { manualPriceOverride: null }),
    ];
    const result = allocateLot(
      { totalCost: 100, allocationMethod: 'manual', currency: 'NOK' },
      items,
    );
    expect(result.status).toBe('error');
    expect(result.errors.length).toBe(1);
  });

  it('emits a warning (not error) when sum != total but allocations still returned', () => {
    const items = [
      makeItem('1', { manualPriceOverride: 50 }),
      makeItem('2', { manualPriceOverride: 30 }),
    ];
    const result = allocateLot(
      { totalCost: 100, allocationMethod: 'manual', currency: 'NOK' },
      items,
    );
    expect(result.status).toBe('warning');
    expect(result.warnings.length).toBe(1);
    expect(result.errors.length).toBe(0);
    expect(result.totalAllocated).toBe(80);
    expect(result.residual).toBe(20);
    expect(result.allocations).toEqual([
      { itemId: '1', allocatedCost: 50 },
      { itemId: '2', allocatedCost: 30 },
    ]);
  });

  it('emits no warning when sum exactly matches total', () => {
    const items = [
      makeItem('1', { manualPriceOverride: 60 }),
      makeItem('2', { manualPriceOverride: 40 }),
    ];
    const result = allocateLot(
      { totalCost: 100, allocationMethod: 'manual', currency: 'NOK' },
      items,
    );
    expect(result.status).toBe('ok');
    expect(result.warnings).toEqual([]);
  });

  it('tolerates a 1-cent rounding loss without warning (at-tolerance is OK)', () => {
    const items = [
      makeItem('1', { manualPriceOverride: 33.33 }),
      makeItem('2', { manualPriceOverride: 33.33 }),
      makeItem('3', { manualPriceOverride: 33.33 }),
    ];
    const result = allocateLot(
      { totalCost: 100, allocationMethod: 'manual', currency: 'NOK' },
      items,
    );
    // diff = 0.01 exactly; the engine accepts at-tolerance silently so
    // a manual split that hits a clean three-way fraction does not
    // bother the user.
    expect(result.status).toBe('ok');
    expect(result.totalAllocated).toBe(99.99);
    expect(result.warnings).toEqual([]);
  });
});
