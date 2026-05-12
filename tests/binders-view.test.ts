// Binders list view integration tests. Verifies:
//   1. Empty state when there are no binders.
//   2. After creating a binder, a card appears with completion 0%.
//   3. The "Ny perm" button opens the form modal; submitting creates a
//      binder + 1 audit + slotsPerPage*totalPages slots in one go.
//   4. Mount + render is read-only on user data.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountBindersView } from '../src/views/binders';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createBinderService } from '../src/services/binder-service';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { closeAndDelete } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';
import type { SetRecord } from '../src/domain/types';

// PR A1: manual-binder creation requires a `sourceSetId`. The "Ny perm"
// flow test pre-seeds a set in IndexedDB and selects it in the form so
// the validator at submit accepts the input.
const fixtureSet: SetRecord = {
  id: 'base1',
  name: 'Base Set',
  series: 'Base',
  printedTotal: 102,
  total: 102,
  releaseDate: '1999-01-09',
  symbolUrl: null,
  logoUrl: null,
  updatedAt: '2026-05-11T00:00:00.000Z',
};

async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Binders list view', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    window.location.hash = '';
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  it('shows the empty state when there are no binders', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBindersView(root);
    await settle();

    expect(root.querySelector('.binders-view__empty')?.textContent).toMatch(
      /Ingen permer/,
    );
    expect(root.querySelectorAll('.binder-card').length).toBe(0);
  });

  it('renders a card for each live binder with 0% completion when no targets', async () => {
    await createBinderService(db).createManualBinder({
      name: 'Test perm',
      description: 'En testperm',
      binderType: 'VaultX',
      totalPages: 2,
      slotsPerPage: 9,
      binderPreset: null,
      completionMode: 'standard',
      sourceSetId: null,
    });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBindersView(root);
    await settle();

    const cards = root.querySelectorAll<HTMLElement>('.binder-card');
    expect(cards.length).toBe(1);
    const card = cards[0];
    expect(card?.querySelector('.binder-card__title')?.textContent).toBe(
      'Test perm',
    );
    expect(
      card?.querySelector('.binder-card__progress')?.getAttribute('aria-valuenow'),
    ).toBe('0');
  });

  it('"Ny perm" button creates a binder and slots in a single transaction', async () => {
    // PR A1: pre-seed a set so the form's required sourceSetId picker
    // can be satisfied.
    await createSetsRepo(db).upsert(fixtureSet);

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBindersView(root);
    await settle();

    const newBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="new-binder"]',
    );
    expect(newBtn).not.toBeNull();
    newBtn?.click();
    // Wait long enough for the form's async set load to populate the picker.
    await settle(120);

    const form = document.querySelector<HTMLFormElement>('form.binder-form');
    expect(form).not.toBeNull();
    const nameInput = form!.querySelector<HTMLInputElement>(
      'input[name="name"]',
    );
    nameInput!.value = 'Min nye perm';
    // PR A1: select the pre-seeded set.
    const setSelect = form!.querySelector<HTMLSelectElement>(
      'select[name="sourceSetId"]',
    );
    expect(setSelect).not.toBeNull();
    setSelect!.value = 'base1';
    // Drive a small custom binder so the test stays cheap.
    const presetSelect = form!.querySelector<HTMLSelectElement>(
      'select[name="binderPreset"]',
    );
    presetSelect!.value = 'custom';
    presetSelect!.dispatchEvent(new Event('change'));
    const slotsSelect = form!.querySelector<HTMLSelectElement>(
      'select[name="slotsPerPage"]',
    );
    slotsSelect!.value = '9';
    const totalPagesInput = form!.querySelector<HTMLInputElement>(
      'input[name="totalPages"]',
    );
    totalPagesInput!.value = '2';

    form!.requestSubmit();

    await vi.waitFor(async () => {
      const audits = await db.auditLog
        .where('action')
        .equals('binder_created')
        .count();
      expect(audits).toBe(1);
    });

    const binders = await db.binders.toArray();
    expect(binders.length).toBe(1);
    expect(binders[0]?.name).toBe('Min nye perm');

    const slots = await db.binderSlots
      .where('binderId')
      .equals(binders[0]!.id)
      .toArray();
    expect(slots.length).toBe(18); // custom 2 pages × 9 slots
    expect(slots.every((s) => s.status === 'empty')).toBe(true);
  });

  it('mount + render is read-only on user data', async () => {
    await createBinderService(db).createManualBinder({
      name: 'Untouched',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      binderPreset: null,
      completionMode: 'standard',
      sourceSetId: null,
    });
    const beforeBinders = await db.binders.toArray();
    const beforeSlots = await db.binderSlots.toArray();
    const beforeAudits = await db.auditLog.toArray();

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBindersView(root);
    await settle();

    expect(await db.binders.toArray()).toEqual(beforeBinders);
    expect(await db.binderSlots.toArray()).toEqual(beforeSlots);
    expect(await db.auditLog.toArray()).toEqual(beforeAudits);
  });

  // PR 14 review patch: a binder row that ended up in the database
  // with `binderPreset: null` (e.g. via a tampered or pre-PR-14
  // restore that bypassed the normaliser) must not crash the list
  // view. The view treats `null` as "no preset chip" and keeps
  // rendering the rest of the card.
  it('list view does not crash when an existing row has binderPreset=null', async () => {
    // Stuff the row in directly via the table so we sidestep the
    // service's normalisation; this models a backup-loaded row that
    // somehow escaped the restore guard.
    await db.binders.put({
      id: 'orphan-binder',
      name: 'Old binder without preset',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      binderPreset: null,
      completionMode: 'standard',
      sourceSetId: null,
      createdAt: '2025-11-01T00:00:00.000Z',
      updatedAt: '2025-11-01T00:00:00.000Z',
      deletedAt: null,
    });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBindersView(root);
    await settle();

    const cards = root.querySelectorAll('.binder-card');
    expect(cards.length).toBe(1);
    expect(cards[0]?.textContent).toContain('Old binder without preset');
    // No "Permtype" stat should be emitted for a null preset.
    expect(cards[0]?.textContent ?? '').not.toContain('Permtype');
  });

  // C6 — Phase-2 Plan C: binders list-view row action wiring.
  // Existing 5 tests cover empty/render/Ny-perm/read-only/null-preset.
  // C6 pins the per-row open + soft-delete buttons that the existing
  // tests didn't exercise.

  it('C6: clicking the binder title opens the binder detail (#binder/<id>)', async () => {
    const { binder } = await createBinderService(db).createManualBinder({
      name: 'Open me',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      binderPreset: null,
      completionMode: 'standard',
      sourceSetId: null,
    });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBindersView(root);
    await settle();

    const openBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="open"]',
    );
    expect(openBtn).not.toBeNull();
    openBtn!.click();
    expect(window.location.hash).toBe(
      `#binder/${encodeURIComponent(binder.id)}`,
    );
  });

  it('C6: row Slett button confirms, soft-deletes the binder, and removes the card', async () => {
    const { binder } = await createBinderService(db).createManualBinder({
      name: 'Delete me',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      binderPreset: null,
      completionMode: 'standard',
      sourceSetId: null,
    });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBindersView(root);
    await settle();
    expect(root.querySelectorAll('.binder-card').length).toBe(1);

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const deleteBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="soft-delete"]',
    );
    expect(deleteBtn).not.toBeNull();
    deleteBtn!.click();

    await vi.waitFor(async () => {
      expect(root.querySelectorAll('.binder-card').length).toBe(0);
    });

    const stored = await db.binders.get(binder.id);
    expect(stored?.deletedAt).not.toBeNull();
    confirmSpy.mockRestore();
  });

  it('C6: "Ny perm fra sett" button is present alongside "Ny perm"', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBindersView(root);
    await settle();

    const newBinder = root.querySelector<HTMLButtonElement>(
      '[data-action="new-binder"]',
    );
    const newFromSet = root.querySelector<HTMLButtonElement>(
      '[data-action="new-from-set"]',
    );
    expect(newBinder).not.toBeNull();
    expect(newFromSet).not.toBeNull();
    // Both buttons render their visible label.
    expect(newBinder!.textContent?.trim().length).toBeGreaterThan(0);
    expect(newFromSet!.textContent?.trim().length).toBeGreaterThan(0);
  });
});
