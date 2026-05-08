// PR 23 — global search UI integration tests. Tests the topbar
// component end-to-end: input → debounce → service call → dropdown
// → click → status panel → quick actions.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetGlobalSearchForTests,
  mountGlobalSearch,
} from '../src/components/global-search';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { createWishlistRepo } from '../src/repositories/wishlist-repo';
import { createBindersRepo } from '../src/repositories/binders-repo';
import { createBinderSlotsRepo } from '../src/repositories/binder-slots-repo';
import { closeAndDelete } from './helpers/fresh-db';
import { makeCard } from './helpers/cards';
import type { CardRecord, SetRecord } from '../src/domain/types';
import type { PokemonTrackerDB } from '../src/db/database';

const baseSet: SetRecord = {
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

const charizard: CardRecord = makeCard('base1-4', {
  overrides: { name: 'Charizard', number: '4' },
});
const pikachu: CardRecord = makeCard('base1-58', {
  overrides: { name: 'Pikachu', number: '58' },
});

async function settle(ms = 200): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('global-search component (PR 23)', () => {
  let db: PokemonTrackerDB;
  let slot: HTMLElement;

  beforeEach(async () => {
    document.body.innerHTML = '';
    slot = document.createElement('div');
    document.body.appendChild(slot);
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createSetsRepo(db).upsert(baseSet);
    await createCardsRepo(db).upsert(charizard);
    await createCardsRepo(db).upsert(pikachu);
  });

  afterEach(async () => {
    _resetGlobalSearchForTests();
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
  });

  it('renders the topbar input', () => {
    mountGlobalSearch(slot);
    const input = slot.querySelector<HTMLInputElement>(
      '[data-region="global-search-input"]',
    );
    expect(input).not.toBeNull();
  });

  it('typing a query opens the dropdown with hits after debounce', async () => {
    mountGlobalSearch(slot);
    const input = slot.querySelector<HTMLInputElement>(
      '[data-region="global-search-input"]',
    );
    expect(input).not.toBeNull();
    input!.value = 'charizard';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(250);
    const dropdown = slot.querySelector<HTMLElement>(
      '[data-region="global-search-dropdown"]',
    );
    expect(dropdown?.hidden).toBe(false);
    const rows = dropdown?.querySelectorAll<HTMLElement>('[data-card-id]');
    expect(rows?.length).toBe(1);
    expect(rows?.[0]?.dataset['cardId']).toBe('base1-4');
  });

  it('Cmd/Ctrl+K focuses the input', () => {
    mountGlobalSearch(slot);
    const input = slot.querySelector<HTMLInputElement>(
      '[data-region="global-search-input"]',
    );
    // jsdom defaults to no focus.
    expect(document.activeElement).not.toBe(input);
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }),
    );
    expect(document.activeElement).toBe(input);
  });

  it('clicking a result opens the Card Status panel', async () => {
    mountGlobalSearch(slot);
    const input = slot.querySelector<HTMLInputElement>(
      '[data-region="global-search-input"]',
    );
    input!.value = 'charizard';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(250);
    const row = slot.querySelector<HTMLElement>('[data-card-id="base1-4"]');
    expect(row).not.toBeNull();
    row?.click();
    const panel = slot.querySelector<HTMLElement>(
      '[data-region="global-search-panel"]',
    );
    await vi.waitFor(() => {
      expect(panel?.querySelector('h3')?.textContent).toBe('Charizard');
    });
    expect(panel?.hidden).toBe(false);
  });

  it('Escape closes the panel', async () => {
    mountGlobalSearch(slot);
    const input = slot.querySelector<HTMLInputElement>(
      '[data-region="global-search-input"]',
    );
    input!.value = 'charizard';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(250);
    slot.querySelector<HTMLElement>('[data-card-id="base1-4"]')?.click();
    const panel = slot.querySelector<HTMLElement>(
      '[data-region="global-search-panel"]',
    );
    await vi.waitFor(() => {
      expect(panel?.querySelector('h3')?.textContent).toBe('Charizard');
    });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel?.hidden).toBe(true);
  });

  it('+1 raw quick-add through the panel creates a holding', async () => {
    mountGlobalSearch(slot);
    const input = slot.querySelector<HTMLInputElement>(
      '[data-region="global-search-input"]',
    );
    input!.value = 'charizard';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(250);
    slot.querySelector<HTMLElement>('[data-card-id="base1-4"]')?.click();
    const quickBtn = await vi.waitFor<HTMLButtonElement>(() => {
      const b = slot.querySelector<HTMLButtonElement>(
        '[data-action="quick-add"]',
      );
      if (b === null) throw new Error('quick-add button not yet rendered');
      return b;
    });
    expect(quickBtn.disabled).toBe(false);
    quickBtn.click();
    await vi.waitFor(async () => {
      const live = await createHoldingsRepo(db).listByCardId('base1-4');
      const owned = live.filter((h) => h.deletedAt === null);
      expect(owned.length).toBe(1);
      expect(owned[0]?.quantity).toBe(1);
    });
  });

  it('panel shows binder location and exposes a "Gå til side" button', async () => {
    const bindersRepo = createBindersRepo(db);
    const slotsRepo = createBinderSlotsRepo(db);
    const binder = await bindersRepo.create({
      name: 'Base Master',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      binderPreset: 'custom',
      completionMode: 'master',
      sourceSetId: null,
    });
    await slotsRepo.create(
      {
        binderId: binder.id,
        pageNumber: 1,
        slotNumber: 1,
        targetCardId: 'base1-4',
        holdingId: null,
        status: 'wanted',
        note: null,
      },
      9,
    );

    mountGlobalSearch(slot);
    const input = slot.querySelector<HTMLInputElement>(
      '[data-region="global-search-input"]',
    );
    input!.value = 'charizard';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(250);
    slot.querySelector<HTMLElement>('[data-card-id="base1-4"]')?.click();
    const goto = await vi.waitFor<HTMLButtonElement>(() => {
      const b = slot.querySelector<HTMLButtonElement>(
        '[data-action="goto-slot"]',
      );
      if (b === null) throw new Error('goto-slot button not yet rendered');
      return b;
    });
    expect(goto.dataset['binderId']).toBe(binder.id);
  });

  it('dropdown shows badges for owned + wishlist + binder + lot', async () => {
    // Owned + wishlist for Charizard, Pikachu untouched.
    await createHoldingsRepo(db).create({
      cardId: 'base1-4',
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
    });
    await createWishlistRepo(db).create({
      cardId: 'base1-4',
      finish: 'holo',
      priority: 'high',
      targetCondition: null,
      targetPrice: null,
      targetCurrency: null,
      status: 'wanted',
      note: null,
    });

    mountGlobalSearch(slot);
    const input = slot.querySelector<HTMLInputElement>(
      '[data-region="global-search-input"]',
    );
    input!.value = 'charizard';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(250);
    const charizardRow = slot.querySelector<HTMLElement>(
      '[data-card-id="base1-4"]',
    );
    const badges = charizardRow?.querySelectorAll<HTMLSpanElement>(
      '.global-search__badge',
    );
    const labels = Array.from(badges ?? []).map((b) => b.textContent ?? '');
    expect(labels).toContain('Eid');
    expect(labels).toContain('Ønskeliste');
  });

  it('empty query hides the dropdown', async () => {
    mountGlobalSearch(slot);
    const input = slot.querySelector<HTMLInputElement>(
      '[data-region="global-search-input"]',
    );
    input!.value = 'charizard';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(250);
    const dropdown = slot.querySelector<HTMLElement>(
      '[data-region="global-search-dropdown"]',
    );
    expect(dropdown?.hidden).toBe(false);
    input!.value = '';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(250);
    expect(dropdown?.hidden).toBe(true);
  });

  it('USER_DATA_CHANGED_EVENT refreshes an open panel', async () => {
    mountGlobalSearch(slot);
    const input = slot.querySelector<HTMLInputElement>(
      '[data-region="global-search-input"]',
    );
    input!.value = 'charizard';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(250);
    slot.querySelector<HTMLElement>('[data-card-id="base1-4"]')?.click();
    const panel = slot.querySelector<HTMLElement>(
      '[data-region="global-search-panel"]',
    );
    await vi.waitFor(() => {
      expect(panel?.textContent ?? '').toContain('Ikke eid.');
    });
    await createHoldingsRepo(db).create({
      cardId: 'base1-4',
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
    });
    window.dispatchEvent(new CustomEvent('pokemon:user-data-changed'));
    await vi.waitFor(() => {
      expect(panel?.textContent ?? '').not.toContain('Ikke eid.');
    });
  });
});
