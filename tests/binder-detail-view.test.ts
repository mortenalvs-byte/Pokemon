// Binder detail view integration tests. Verifies the page/slot grid
// renders, status changes via the slot action menu work, and assigning
// a holding sets status='owned' + targetCardId backfilled.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountBinderDetailView } from '../src/views/binder-detail';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createBinderService } from '../src/services/binder-service';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { closeAndDelete } from './helpers/fresh-db';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { HoldingInput } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

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

const sampleCard: CardRecord = {
  id: 'base1-1',
  setId: 'base1',
  name: 'Test card',
  number: '1',
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

describe('Binder detail view', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createSetsRepo(db).upsert(sampleSet);
    await createCardsRepo(db).upsertMany([sampleCard]);
    window.location.hash = '';
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  it('shows a not-found message when the hash points to an unknown id', async () => {
    window.location.hash = 'binder/does-not-exist';
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();

    expect(
      root.querySelector('.binder-detail-view__message')?.textContent,
    ).toMatch(/finnes ikke/);
  });

  it('renders a 9-slot grid for a 1-page binder', async () => {
    const created = await createBinderService(db).createManualBinder({
      name: 'Detail binder',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      binderPreset: null,
      completionMode: 'standard',
      sourceSetId: null,
    });
    window.location.hash = `binder/${encodeURIComponent(created.binder.id)}`;

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();

    expect(
      root.querySelector('.binder-detail-view__title')?.textContent,
    ).toBe('Detail binder');
    expect(root.querySelectorAll('.binder-slot').length).toBe(9);
    expect(
      root.querySelector('.binder-page__grid--9'),
    ).not.toBeNull();
  });

  it('opens the slot action menu and applies a status change', async () => {
    const created = await createBinderService(db).createManualBinder({
      name: 'Action menu binder',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      binderPreset: null,
      completionMode: 'standard',
      sourceSetId: null,
    });
    window.location.hash = `binder/${encodeURIComponent(created.binder.id)}`;

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();

    const firstMenuBtn = root.querySelector<HTMLButtonElement>(
      '.binder-slot [data-action="open-menu"]',
    );
    expect(firstMenuBtn).not.toBeNull();
    firstMenuBtn?.click();
    await settle();

    const dialog = document.querySelector('dialog.app-dialog');
    expect(dialog).not.toBeNull();
    // No "Mark owned" — owned only via assignment.
    const labels = Array.from(
      dialog!.querySelectorAll<HTMLButtonElement>('.slot-action-menu__option'),
    ).map((b) => b.textContent?.trim());
    expect(labels.some((label) => label?.includes('Eid'))).toBe(false);

    // Click "Marker som ønsket" (wanted) — find by data-status.
    const wantedBtn = dialog!.querySelector<HTMLButtonElement>(
      '[data-action="set-status"][data-status="wanted"]',
    );
    expect(wantedBtn).not.toBeNull();
    wantedBtn?.click();

    await vi.waitFor(async () => {
      const slots = await db.binderSlots
        .where('binderId')
        .equals(created.binder.id)
        .toArray();
      const wantedCount = slots.filter((s) => s.status === 'wanted').length;
      expect(wantedCount).toBe(1);
    });

    const slotsAudit = await db.auditLog
      .where('action')
      .equals('binder_slot_status_changed')
      .count();
    expect(slotsAudit).toBeGreaterThanOrEqual(1);
  });

  it('"Tilordne holding" sets holdingId, backfills targetCardId, and status=owned', async () => {
    const created = await createBinderService(db).createManualBinder({
      name: 'Assign binder',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      binderPreset: null,
      completionMode: 'standard',
      sourceSetId: null,
    });
    const holding = await createHoldingsRepo(db).create(baseHolding);
    window.location.hash = `binder/${encodeURIComponent(created.binder.id)}`;

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();

    const assignBtn = root.querySelector<HTMLButtonElement>(
      '.binder-slot [data-action="assign"]',
    );
    expect(assignBtn).not.toBeNull();
    assignBtn?.click();
    await settle();

    const dialog = document.querySelector('dialog.app-dialog');
    expect(dialog).not.toBeNull();
    const select = dialog!.querySelector<HTMLSelectElement>(
      '[data-region="holding-select"]',
    );
    expect(select).not.toBeNull();
    expect(select?.options.length).toBe(1);
    expect(select?.value).toBe(holding.id);

    const form = dialog!.querySelector<HTMLFormElement>('form');
    form!.requestSubmit();

    await vi.waitFor(async () => {
      const slots = await db.binderSlots
        .where('binderId')
        .equals(created.binder.id)
        .toArray();
      const owned = slots.find((s) => s.status === 'owned');
      expect(owned).toBeDefined();
      expect(owned?.holdingId).toBe(holding.id);
      expect(owned?.targetCardId).toBe(holding.cardId); // backfilled
    });

    const assignedAudit = await db.auditLog
      .where('action')
      .equals('binder_slot_assigned')
      .count();
    expect(assignedAudit).toBe(1);
  });

  it('"Tøm slot" preserves targetCardId and note, resets to wanted', async () => {
    const created = await createBinderService(db).createManualBinder({
      name: 'Clear binder',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      binderPreset: null,
      completionMode: 'standard',
      sourceSetId: null,
    });
    const slotsRepo = createBinderSlotsRepo(db);
    const slot = created.slots[0];
    if (slot === undefined) throw new Error('test bootstrap failed');
    // Set up an assigned slot with a user-authored note to clear later.
    const holding = await createHoldingsRepo(db).create(baseHolding);
    await slotsRepo.update(
      slot.id,
      {
        holdingId: holding.id,
        targetCardId: 'base1-1',
        status: 'owned',
        note: 'keep this note',
      },
      9,
    );

    window.location.hash = `binder/${encodeURIComponent(created.binder.id)}`;
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBinderDetailView(root);
    await settle();

    // Open the action menu on the assigned slot (slot 1 since we set it).
    const menuBtn = root.querySelector<HTMLButtonElement>(
      '.binder-slot[data-status="owned"] [data-action="open-menu"]',
    );
    expect(menuBtn).not.toBeNull();
    menuBtn?.click();
    await settle();

    const dialog = document.querySelector('dialog.app-dialog');
    const clearBtn = dialog!.querySelector<HTMLButtonElement>(
      '[data-action="clear"]',
    );
    expect(clearBtn).not.toBeNull();
    clearBtn?.click();

    await vi.waitFor(async () => {
      const updated = await db.binderSlots.get(slot.id);
      expect(updated?.holdingId).toBeNull();
      expect(updated?.status).toBe('wanted');
      expect(updated?.targetCardId).toBe('base1-1'); // preserved
      // User-authored note must survive the clear — it's user data.
      expect(updated?.note).toBe('keep this note');
    });
  });
});
