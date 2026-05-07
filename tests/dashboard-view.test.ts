// Dashboard view: 7 sections, action strip filters info, navigation
// links work, refresh on USER_DATA_CHANGED_EVENT.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mountDashboardView } from '../src/views/dashboard';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { createAppMetaRepo } from '../src/repositories/app-meta-repo';
import { createBindersRepo } from '../src/repositories/binders-repo';
import { createCardsRepo } from '../src/repositories/cards-repo';
import { createSetsRepo } from '../src/repositories/sets-repo';
import { closeAndDelete } from './helpers/fresh-db';
import { APP_META_KEYS } from '../src/domain/types';
import { USER_DATA_CHANGED_EVENT } from '../src/components/events';
import type { CardRecord, SetRecord } from '../src/domain/types';
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

describe('Dashboard view', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    await createSetsRepo(db).upsert(sampleSet);
    window.location.hash = '';
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  it('renders the seven section cards plus the action strip', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await settle();

    expect(
      root.querySelector('[data-region="card-database-health"]'),
    ).not.toBeNull();
    expect(root.querySelector('[data-region="card-sync"]')).not.toBeNull();
    expect(root.querySelector('[data-region="card-backup"]')).not.toBeNull();
    expect(
      root.querySelector('[data-region="card-collection"]'),
    ).not.toBeNull();
    expect(root.querySelector('[data-region="card-binders"]')).not.toBeNull();
    expect(root.querySelector('[data-region="card-lots"]')).not.toBeNull();
    expect(
      root.querySelector('[data-region="card-wishlist"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('[data-region="action-strip"]'),
    ).not.toBeNull();
  });

  it('action strip renders only warning + critical items (info hidden)', async () => {
    // Set up: never-backed-up (critical) + storage-not-persistent
    // (warning) + missing-condition info via a dummy holding.
    const appMeta = createAppMetaRepo(db);
    await appMeta.set(APP_META_KEYS.persistentStorageGranted, false);

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await settle();

    const items = root.querySelectorAll<HTMLElement>(
      '[data-region="action-strip"] [data-action-id]',
    );
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const li of items) {
      expect(li.dataset['severity']).not.toBe('info');
    }
  });

  it('renders the friendly "ingenting krever oppmerksomhet" state when no warnings', async () => {
    const appMeta = createAppMetaRepo(db);
    // Backup just taken + persistent + sync ok → no warnings
    const now = new Date().toISOString();
    await appMeta.set(APP_META_KEYS.lastBackupAt, now);
    await appMeta.set(APP_META_KEYS.lastBackupHoldingCount, 0);
    await appMeta.set(APP_META_KEYS.persistentStorageGranted, true);
    await appMeta.set(APP_META_KEYS.lastSyncAt, now);
    await appMeta.set(APP_META_KEYS.lastSyncStatus, 'ok');

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await settle();

    expect(
      root.querySelector('.dashboard-strip--empty')?.textContent ?? '',
    ).toMatch(/Ingenting krever oppmerksomhet/);
  });

  it('navigates to a sidebar route when a card "Åpne" button is clicked', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await settle();

    const navBtn = root.querySelector<HTMLButtonElement>(
      '[data-region="card-collection"] [data-action="nav"]',
    );
    expect(navBtn?.dataset['route']).toBe('collection');
    navBtn?.click();
    expect(window.location.hash).toBe('#collection');
  });

  it('does not list 20k cards in the DOM (count path, not row render)', async () => {
    // Seed 200 cards and confirm the dashboard renders without
    // embedding any row markup for them.
    const cards: CardRecord[] = Array.from({ length: 200 }, (_v, idx) =>
      makeCard(idx + 1),
    );
    await createCardsRepo(db).upsertMany(cards);

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await settle();

    expect(root.textContent ?? '').not.toContain('Card 5'); // no card-row leak
    // The count IS rendered though.
    const dh = root.querySelector('[data-region="card-database-health"]');
    expect(dh?.textContent ?? '').toContain('200');
  });

  it('refreshes on USER_DATA_CHANGED_EVENT', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountDashboardView(root);
    await settle();

    expect(
      root
        .querySelector('[data-region="card-database-health"]')
        ?.textContent ?? '',
    ).toContain('0'); // no binders yet

    // Add a binder and dispatch the event — the view should re-render.
    await createBindersRepo(db).create({
      name: 'New binder',
      description: null,
      binderType: null,
      totalPages: 1,
      slotsPerPage: 9,
      binderPreset: null,
      completionMode: 'standard',
      sourceSetId: null,
    });
    window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
    await settle();

    expect(
      root.querySelector('[data-region="card-database-health"]')?.textContent ??
        '',
    ).toContain('1');
  });
});
