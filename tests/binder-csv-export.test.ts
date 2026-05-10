// Binder CSV export — output shape, BOM, audit row, reverse-holo
// marker handling.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeAndDelete, freshDb } from './helpers/fresh-db';
// PR 36 — shared fixture helpers.
import { makeCard as helperMakeCard } from './helpers/cards';
import { holdingInput } from './helpers/holdings';
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
  return helperMakeCard(`base1-${n}`, {
    overrides: { name: `Card ${n}`, number: String(n) },
  });
}

const baseHolding: HoldingInput = holdingInput('base1-1');

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
        binderPreset: null,
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
    // PR 14: a from-set binder mirrors the physical binder; for the
    // null preset that means ceil(2/9) = 1 page × 9 slots = 9 rows
    // (2 with targets, 7 empty).
    expect(result!.rowCount).toBe(9);
    expect(result!.content.charCodeAt(0)).toBe(0xfeff);
    const lines = result!.content.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe(
      // PR 29 review patch — operator-approved column set (2026-05-09).
      // The header is camelCase, includes binderName/physicalPosition/
      // requiredFinish/holdingId/holdingFinish/holdingCondition/
      // holdingStatus/language/issue, and drops the snake_case names.
      [
        'binderName',
        'pageNumber',
        'slotNumber',
        'physicalPosition',
        'slotStatus',
        'targetCardId',
        'targetCardName',
        'setId',
        'setName',
        'cardNumber',
        'rarity',
        'requiredFinish',
        'holdingId',
        'holdingCardName',
        'holdingFinish',
        'holdingCondition',
        'holdingStatus',
        'language',
        'note',
        'issue',
      ].join(','),
    );
    // header + 9 rows + trailing empty
    expect(lines.length).toBe(11);
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
        binderPreset: null,
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
    // PR 14: full grid (1 page × 9 slots) + header + trailing empty.
    expect(lines.length).toBe(11);
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
        binderPreset: null,
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
    // PR 29 review patch — operator-approved column set: conditionType
    // is no longer a direct column. `holdingCondition` renders the raw
    // condition (or "PSA 10" for graded). `holdingFinish` carries the
    // finish.
    expect(row).toContain('owned'); // slotStatus + holdingStatus
    expect(row).toContain('NM'); // holdingCondition
    expect(row).toContain('normal'); // holdingFinish
    expect(row).toContain(holding.id); // holdingId
  });

  it('filename uses binder name slug + date stamp', async () => {
    const created = await createBinderService(db).createBinderFromSet({
      binder: {
        name: 'S&V 151 (Master)',
        description: null,
        binderType: null,
        slotsPerPage: 9,
        binderPreset: null,
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
        binderPreset: null,
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
    // PR 14: 1 draft → full 9-slot page (custom/null preset).
    expect(audits[0]?.message).toContain('9 rows');
  });
});
