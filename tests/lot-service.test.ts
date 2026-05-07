// lot-service: applyAllocation + materializeHoldings.
//
// Covers:
//   - one bulk audit per applyAllocation, no per-item lot_item_updated
//   - materialize writes N holdings + updates N lotItems + 1 audit
//   - no per-holding holding_created spam
//   - rollback on validation failure
//   - re-allocation excludes already-materialized items and preserves
//     their allocatedCost / holding.purchasePrice
//   - re-running materialize is a no-op when nothing left to do

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { createLotService } from '../src/services/lot-service';
import {
  createLotItemsRepo,
  createLotsRepo,
} from './helpers/repos';
import type { LotInput, LotItemInput } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

const baseLotInput: LotInput = {
  name: 'Test lot',
  purchaseDate: '2026-04-01T00:00:00.000Z',
  totalCost: 100,
  currency: 'NOK',
  allocationMethod: 'equal',
  notes: null,
};

function lotItem(
  lotId: string,
  cardId: string,
  overrides: Partial<LotItemInput> = {},
): LotItemInput {
  return {
    lotId,
    cardId,
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
    ...overrides,
  };
}

describe('lot-service.applyAllocation', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('writes one lot_allocation_applied audit (no per-item lot_item_updated)', async () => {
    const lotsRepo = createLotsRepo(db);
    const itemsRepo = createLotItemsRepo(db);
    const lot = await lotsRepo.create(baseLotInput);
    await itemsRepo.create(lotItem(lot.id, 'card-1'));
    await itemsRepo.create(lotItem(lot.id, 'card-2'));

    const itemUpdatedBefore = await db.auditLog
      .where('action')
      .equals('lot_item_updated')
      .count();

    const result = await createLotService(db).applyAllocation(lot.id);
    expect(result.applied).toBe(true);
    expect(result.allocation.status).toBe('ok');

    const allocAudits = await db.auditLog
      .where('action')
      .equals('lot_allocation_applied')
      .count();
    const itemAuditsAfter = await db.auditLog
      .where('action')
      .equals('lot_item_updated')
      .count();
    expect(allocAudits).toBe(1);
    expect(itemAuditsAfter).toBe(itemUpdatedBefore);

    const items = await itemsRepo.listByLotId(lot.id);
    expect(items.every((i) => i.allocatedCost !== null)).toBe(true);
    const total = items.reduce((acc, i) => acc + (i.allocatedCost ?? 0), 0);
    expect(Math.round(total * 100) / 100).toBe(100);
  });

  it('errors and writes nothing when weighted has all-zero market estimates', async () => {
    const lotsRepo = createLotsRepo(db);
    const itemsRepo = createLotItemsRepo(db);
    const lot = await lotsRepo.create({
      ...baseLotInput,
      allocationMethod: 'weighted_by_market_price',
    });
    await itemsRepo.create(lotItem(lot.id, 'card-1'));
    await itemsRepo.create(lotItem(lot.id, 'card-2'));

    const result = await createLotService(db).applyAllocation(lot.id);
    expect(result.applied).toBe(false);
    expect(result.allocation.status).toBe('error');
    const items = await itemsRepo.listByLotId(lot.id);
    expect(items.every((i) => i.allocatedCost === null)).toBe(true);
    const allocAudits = await db.auditLog
      .where('action')
      .equals('lot_allocation_applied')
      .count();
    expect(allocAudits).toBe(0);
  });

  it('preserves materialized items and only allocates remaining cost', async () => {
    const lotsRepo = createLotsRepo(db);
    const itemsRepo = createLotItemsRepo(db);
    const lot = await lotsRepo.create({ ...baseLotInput, totalCost: 300 });
    const a = await itemsRepo.create(lotItem(lot.id, 'card-1'));
    const b = await itemsRepo.create(lotItem(lot.id, 'card-2'));
    const c = await itemsRepo.create(lotItem(lot.id, 'card-3'));

    // First allocation gives 100 / 100 / 100.
    await createLotService(db).applyAllocation(lot.id);

    // Materialize a's holding manually (without the materialise path
    // touching db.holdings.bulkAdd — we just lock its state).
    await db.lotItems.put({
      ...(await itemsRepo.list()).filter((i) => i.id === a.id)[0]!,
      holdingId: 'fake-holding',
      updatedAt: '2026-04-02T00:00:00.000Z',
    });

    // Re-allocate. lot.totalCost = 300, locked = 100, remaining = 200,
    // remaining unmaterialized items = b, c → 100 each.
    const result = await createLotService(db).applyAllocation(lot.id);
    expect(result.applied).toBe(true);
    const items = await itemsRepo.listByLotId(lot.id);
    const byId = new Map(items.map((i) => [i.id, i.allocatedCost]));
    expect(byId.get(a.id)).toBe(100); // materialised — unchanged
    expect(byId.get(b.id)).toBe(100);
    expect(byId.get(c.id)).toBe(100);
  });
});

describe('lot-service.materializeHoldings', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('writes N holdings + updates N lotItems + one bulk audit', async () => {
    const lotsRepo = createLotsRepo(db);
    const itemsRepo = createLotItemsRepo(db);
    const lot = await lotsRepo.create({ ...baseLotInput, totalCost: 300 });
    await itemsRepo.create(lotItem(lot.id, 'card-1'));
    await itemsRepo.create(lotItem(lot.id, 'card-2'));
    await itemsRepo.create(lotItem(lot.id, 'card-3'));

    await createLotService(db).applyAllocation(lot.id);

    const beforeHoldingCreated = await db.auditLog
      .where('action')
      .equals('holding_created')
      .count();
    const beforeBulk = await db.auditLog
      .where('action')
      .equals('lot_holdings_materialized')
      .count();

    const result = await createLotService(db).materializeHoldings(lot.id);
    expect(result.noop).toBe(false);
    expect(result.created.length).toBe(3);

    expect(await db.holdings.count()).toBe(3);
    const items = await itemsRepo.listByLotId(lot.id);
    expect(items.every((i) => i.holdingId !== null)).toBe(true);

    // No per-holding audit row from holdingsRepo.create.
    expect(
      await db.auditLog.where('action').equals('holding_created').count(),
    ).toBe(beforeHoldingCreated);
    expect(
      await db.auditLog
        .where('action')
        .equals('lot_holdings_materialized')
        .count(),
    ).toBe(beforeBulk + 1);

    const holdings = await db.holdings.toArray();
    for (const h of holdings) {
      expect(h.source).toBe('lot');
      expect(h.lotId).toBe(lot.id);
      expect(h.purchasePrice).toBe(100);
      expect(h.purchaseCurrency).toBe('NOK');
      expect(h.status).toBe('owned');
      expect(h.tags).toEqual([]);
      expect(h.valueSource).toBe('unknown');
    }
  });

  it('skips items that are already materialized, no-ops if all are', async () => {
    const lotsRepo = createLotsRepo(db);
    const itemsRepo = createLotItemsRepo(db);
    const lot = await lotsRepo.create({ ...baseLotInput, totalCost: 200 });
    await itemsRepo.create(lotItem(lot.id, 'card-1'));
    await itemsRepo.create(lotItem(lot.id, 'card-2'));
    await createLotService(db).applyAllocation(lot.id);

    const first = await createLotService(db).materializeHoldings(lot.id);
    expect(first.created.length).toBe(2);
    expect(first.noop).toBe(false);

    // Second call: nothing to do.
    const second = await createLotService(db).materializeHoldings(lot.id);
    expect(second.noop).toBe(true);
    expect(second.created.length).toBe(0);

    expect(await db.holdings.count()).toBe(2);
    const bulkAudits = await db.auditLog
      .where('action')
      .equals('lot_holdings_materialized')
      .count();
    expect(bulkAudits).toBe(1); // first call only
  });

  it('throws when an item has no allocatedCost — leaves db unchanged', async () => {
    const lotsRepo = createLotsRepo(db);
    const itemsRepo = createLotItemsRepo(db);
    const lot = await lotsRepo.create(baseLotInput);
    await itemsRepo.create(lotItem(lot.id, 'card-1'));
    // No applyAllocation; allocatedCost is null.
    await expect(
      createLotService(db).materializeHoldings(lot.id),
    ).rejects.toThrow();
    expect(await db.holdings.count()).toBe(0);
    const items = await itemsRepo.listByLotId(lot.id);
    expect(items.every((i) => i.holdingId === null)).toBe(true);
  });

  it('re-allocation after partial materialise preserves holding.purchasePrice', async () => {
    const lotsRepo = createLotsRepo(db);
    const itemsRepo = createLotItemsRepo(db);
    const lot = await lotsRepo.create({ ...baseLotInput, totalCost: 300 });
    await itemsRepo.create(lotItem(lot.id, 'card-1'));
    await itemsRepo.create(lotItem(lot.id, 'card-2'));
    await itemsRepo.create(lotItem(lot.id, 'card-3'));

    await createLotService(db).applyAllocation(lot.id); // 100/100/100
    await createLotService(db).materializeHoldings(lot.id);
    const allocsBefore = (await itemsRepo.listByLotId(lot.id))
      .map((i) => i.allocatedCost)
      .sort();
    const holdingsBefore = await db.holdings.toArray();
    const holdingPricesBefore = holdingsBefore
      .map((h) => h.purchasePrice)
      .sort();

    // Switch lot to weighted with no market data → should be noop or
    // graceful (status=error) and leave allocations + holdings alone.
    await lotsRepo.update(lot.id, {
      allocationMethod: 'weighted_by_market_price',
    });
    const reallocResult = await createLotService(db).applyAllocation(lot.id);
    // No unmaterialised items left — the engine sees 0 candidates and
    // treats it as ok with empty allocations.
    expect(reallocResult.applied).toBe(true);

    const allocsAfter = (await itemsRepo.listByLotId(lot.id))
      .map((i) => i.allocatedCost)
      .sort();
    const holdingsAfter = await db.holdings.toArray();
    const holdingPricesAfter = holdingsAfter
      .map((h) => h.purchasePrice)
      .sort();
    expect(allocsAfter).toEqual(allocsBefore);
    expect(holdingPricesAfter).toEqual(holdingPricesBefore);
  });
});
