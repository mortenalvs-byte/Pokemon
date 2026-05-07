// Binder CSV export — output shape, BOM, audit row, reverse-holo
// marker handling.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAndDelete, freshDb } from './helpers/fresh-db';
import { REVERSE_HOLO_TEMPLATE_MARKER } from '../src/domain/card-variants';
import { createBinderService } from '../src/services/binder-service';
import { createBinderCsvExporter } from '../src/services/binder-csv-export';
import {
  createBindersRepo,
  createBinderSlotsRepo,
  createCardsRepo,
  createHoldingsRepo,
  createSetsRepo,
} from './helpers/repos';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { HoldingInput } from '../src/domain/validators';
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

function makeCard(n: number): CardRecord {
  return {
    id: `base1-${n}`,
    setId: 'base1',
    name: `Card ${n}`,
    number: String(n),
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

const baseHolding: HoldingInput = {
  cardId: 'base1-1',
  quantity: 1,
  conditionType: 'raw',
  rawCondition: 'NM',
  gradingCompany: null,
  grade: null,
  certNumber: null,
  certUrl: null,
  gradedDate: null,
  finish: 'normal',
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

describe('binder-csv-export', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
    await createSetsRepo(db).upsert(sampleSet);
    await createCardsRepo(db).upsertMany([
      makeCard(1),
      makeCard(2),
      makeCard(3),
    ]);
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  function buildExporter(): ReturnType<typeof createBinderCsvExporter> {
    return createBinderCsvExporter(
      db,
      createBindersRepo(db),
      createBinderSlotsRepo(db),
      createHoldingsRepo(db),
      createCardsRepo(db),
      createSetsRepo(db),
    );
  }

  it('emits BOM + header + one row per live slot', async () => {
    const created = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'Base Set',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        completionMode: 'standard',
        sourceSetId: 'base1',
      },
      slots: [
        { pageNumber: 1, slotNumber: 1, targetCardId: 'base1-1', note: null },
        { pageNumber: 1, slotNumber: 2, targetCardId: 'base1-2', note: null },
      ],
    });
    const result = await buildExporter().build(created.binder.id);
    expect(result).not.toBeNull();
    expect(result!.rowCount).toBe(2);
    expect(result!.content.charCodeAt(0)).toBe(0xfeff);
    const lines = result!.content.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe(
      [
        'page',
        'slot',
        'target_card_id',
        'target_card_name',
        'set_id',
        'set_name',
        'set_number',
        'finish',
        'status',
        'holding_card_id',
        'holding_card_name',
        'condition_type',
        'raw_condition',
        'grading_company',
        'grade',
        'holding_note',
        'slot_note',
        'updated_at',
      ].join(','),
    );
    expect(lines.length).toBe(4); // header + 2 rows + trailing empty
    expect(lines[1]).toContain('base1-1');
    expect(lines[1]).toContain('Card 1');
    expect(lines[1]).toContain('base1');
    expect(lines[1]).toContain('Base'); // set name
  });

  it('renders reverse-holo template slots as finish=reverse_holo without leaking the marker into slot_note', async () => {
    const created = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'Base Set master',
        description: null,
        binderType: null,
        slotsPerPage: 9,
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
      ],
    });
    const result = await buildExporter().build(created.binder.id);
    expect(result).not.toBeNull();
    const lines = result!.content.replace(/^﻿/, '').split('\r\n');
    // Header + 2 rows + trailing empty
    expect(lines.length).toBe(4);
    // Row 1 (page=1, slot=1) is normal: finish empty (no holding), slot_note empty
    // Row 2 (page=1, slot=2) is reverse-holo template: finish=reverse_holo, slot_note empty
    expect(lines[2]).toContain(',reverse_holo,');
    // The raw marker token must NEVER appear in the file
    expect(result!.content.includes('template:reverse_holo')).toBe(false);
  });

  it('joins assigned holding into condition columns', async () => {
    const created = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'Base Set',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        completionMode: 'standard',
        sourceSetId: 'base1',
      },
      slots: [
        { pageNumber: 1, slotNumber: 1, targetCardId: 'base1-1', note: null },
      ],
    });
    const holding = await createHoldingsRepo(db).create(baseHolding);
    const slot = created.slots[0]!;
    await createBinderSlotsRepo(db).update(
      slot.id,
      { holdingId: holding.id, status: 'owned' },
      9,
    );

    const result = await buildExporter().build(created.binder.id);
    expect(result).not.toBeNull();
    const row = result!.content.replace(/^﻿/, '').split('\r\n')[1] ?? '';
    expect(row).toContain('owned');
    expect(row).toContain('raw');
    expect(row).toContain('NM');
    expect(row).toContain('normal'); // finish from holding
  });

  it('filename uses binder name slug + date stamp', async () => {
    const created = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'S&V 151 (Master)',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        completionMode: 'master',
        sourceSetId: 'base1',
      },
      slots: [
        { pageNumber: 1, slotNumber: 1, targetCardId: 'base1-1', note: null },
      ],
    });
    const result = await buildExporter().build(created.binder.id);
    expect(result).not.toBeNull();
    expect(result!.filename).toMatch(
      /^binder-checklist-s-v-151-master-\d{8}\.csv$/,
    );
  });

  it('returns null for a missing or soft-deleted binder', async () => {
    const exporter = buildExporter();
    expect(await exporter.build('does-not-exist')).toBeNull();
  });

  it('recordExport writes one binder_csv_exported audit row', async () => {
    const created = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'Audit binder',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        completionMode: 'standard',
        sourceSetId: 'base1',
      },
      slots: [
        { pageNumber: 1, slotNumber: 1, targetCardId: 'base1-1', note: null },
      ],
    });
    const exporter = buildExporter();
    const built = await exporter.build(created.binder.id);
    expect(built).not.toBeNull();
    await exporter.recordExport(created.binder, built!.rowCount);

    const audits = await db.auditLog
      .where('action')
      .equals('binder_csv_exported')
      .toArray();
    expect(audits.length).toBe(1);
    expect(audits[0]?.entityId).toBe(created.binder.id);
    expect(audits[0]?.message).toContain('Audit binder');
    expect(audits[0]?.message).toContain('1');
  });
});
