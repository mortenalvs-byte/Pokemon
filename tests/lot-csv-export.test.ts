// Lot CSV export — output shape, BOM, slug, audit row.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { createLotCsvExporter } from '../src/services/lot-csv-export';
import { createLotService } from '../src/services/lot-service';
import {
  createCardsRepo,
  createHoldingsRepo,
  createLotItemsRepo,
  createLotsRepo,
  createSetsRepo,
} from './helpers/repos';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { LotItemInput } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

const sampleSet: SetRecord = {
  id: 'base1',
  name: 'Base',
  series: 'Base',
  printedTotal: 102,
  total: 102,
  releaseDate: '1999-01-09',
  symbolUrl: null,
  logoUrl: null,
  updatedAt: '2026-05-06T00:00:00.000Z',
};

function makeCard(n: string): CardRecord {
  return {
    id: `base1-${n}`,
    setId: 'base1',
    name: `Card ${n}`,
    number: n,
    rarity: 'Common',
    supertype: 'Pokémon',
    subtypes: [],
    types: [],
    imageSmall: null,
    imageLarge: null,
    tcgplayer: { prices: { normal: { market: 1 }, holofoil: { market: 1 }, reverseHolofoil: { market: 1 }, "1stEditionNormal": { market: 1 }, "1stEditionHolofoil": { market: 1 } } },
    cardmarket: null,
    updatedAt: '2026-05-06T00:00:00.000Z',
  };
}

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

describe('lot-csv-export', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
    await createSetsRepo(db).upsert(sampleSet);
    await createCardsRepo(db).upsertMany([makeCard('1'), makeCard('2')]);
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  function buildExporter(): ReturnType<typeof createLotCsvExporter> {
    return createLotCsvExporter(
      db,
      createLotsRepo(db),
      createLotItemsRepo(db),
      createHoldingsRepo(db),
      createCardsRepo(db),
    );
  }

  it('emits BOM + header + one row per live item', async () => {
    const lotsRepo = createLotsRepo(db);
    const itemsRepo = createLotItemsRepo(db);
    const lot = await lotsRepo.create({
      name: 'My lot',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 200,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    await itemsRepo.create(lotItem(lot.id, 'base1-1'));
    await itemsRepo.create(lotItem(lot.id, 'base1-2'));

    const result = await buildExporter().build(lot.id);
    expect(result).not.toBeNull();
    expect(result!.rowCount).toBe(2);
    expect(result!.content.charCodeAt(0)).toBe(0xfeff);

    const lines = result!.content.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toContain('lot_id');
    expect(lines[0]).toContain('lot_name');
    expect(lines[0]).toContain('card_name');
    expect(lines[0]).toContain('allocated_cost');
    expect(lines[0]).toContain('materialized');
    // header + 2 rows + trailing empty
    expect(lines.length).toBe(4);
    expect(lines[1]).toContain('My lot');
    expect(lines[1]).toContain('base1-1');
  });

  it('marks materialized=true after holdings are created', async () => {
    const lotsRepo = createLotsRepo(db);
    const itemsRepo = createLotItemsRepo(db);
    const lot = await lotsRepo.create({
      name: 'M',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 100,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    await itemsRepo.create(lotItem(lot.id, 'base1-1'));
    await createLotService(db).applyAllocation(lot.id);
    await createLotService(db).materializeHoldings(lot.id);

    const result = await buildExporter().build(lot.id);
    expect(result).not.toBeNull();
    expect(result!.content).toMatch(/,true,/); // materialized column
  });

  it('filename uses safe slug + date stamp', async () => {
    const lotsRepo = createLotsRepo(db);
    const itemsRepo = createLotItemsRepo(db);
    const lot = await lotsRepo.create({
      name: 'Min ebay-bunke #1',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 100,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    await itemsRepo.create(lotItem(lot.id, 'base1-1'));

    const result = await buildExporter().build(lot.id);
    expect(result).not.toBeNull();
    expect(result!.filename).toMatch(
      /^lot-min-ebay-bunke-1-\d{8}\.csv$/,
    );
  });

  it('returns null for soft-deleted or missing lot', async () => {
    const lotsRepo = createLotsRepo(db);
    const lot = await lotsRepo.create({
      name: 'Trash',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 100,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    await lotsRepo.softDelete(lot.id);
    expect(await buildExporter().build(lot.id)).toBeNull();
    expect(await buildExporter().build('nonexistent')).toBeNull();
  });

  it('recordExport writes one lot_csv_exported audit row', async () => {
    const lotsRepo = createLotsRepo(db);
    const lot = await lotsRepo.create({
      name: 'Audit lot',
      purchaseDate: '2026-04-01T00:00:00.000Z',
      totalCost: 100,
      currency: 'NOK',
      allocationMethod: 'equal',
      notes: null,
    });
    await buildExporter().recordExport(lot, 5);
    const audits = await db.auditLog
      .where('action')
      .equals('lot_csv_exported')
      .toArray();
    expect(audits.length).toBe(1);
    expect(audits[0]?.entityId).toBe(lot.id);
    expect(audits[0]?.message).toContain('Audit lot');
    expect(audits[0]?.message).toContain('5');
  });
});
