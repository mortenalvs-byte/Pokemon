// PR 28 review patch (Phase 6) — dashboard must refresh after a
// `SYNC_STATUS_CHANGED_EVENT`. The earlier "0/0 first paint"
// confusion came from the dashboard rendering once on mount and
// not updating when a sync (or local fixture import) changed the
// cache. This test pins the contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { mountDashboardView } from '../src/views/dashboard';
import { SYNC_STATUS_CHANGED_EVENT } from '../src/views/settings';
import { importLocalSyncFixture } from '../src/qa/local-sync-fixture';
import { closeAndDelete } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';
import type { CardRecord, SetRecord } from '../src/domain/types';

function settle(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fixtureCard(id: string, setId: string): CardRecord {
  return {
    id,
    setId,
    name: `Card ${id}`,
    number: '1',
    rarity: 'Common',
    supertype: 'Pokémon',
    subtypes: [],
    types: [],
    imageSmall: `https://images.pokemontcg.io/${setId}/${id}.png`,
    imageLarge: null,
    tcgplayer: null,
    cardmarket: null,
    updatedAt: '2026-05-09T00:00:00.000Z',
  };
}

function fixtureSet(id: string): SetRecord {
  return {
    id,
    name: `Set ${id}`,
    series: 'Test',
    printedTotal: 1,
    total: 1,
    releaseDate: '2026-01-01',
    symbolUrl: null,
    logoUrl: null,
    updatedAt: '2026-05-09T00:00:00.000Z',
  };
}

describe('Dashboard refresh after SYNC_STATUS_CHANGED_EVENT (Phase 6)', () => {
  let db: PokemonTrackerDB;
  let root: HTMLElement;
  let abort: AbortController;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    root = document.getElementById('content') as HTMLElement;
    abort = new AbortController();
  });

  afterEach(async () => {
    abort.abort();
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
  });

  it('shows 0/0 cache counts on first paint with empty DB', async () => {
    mountDashboardView(root, abort.signal);
    await settle(250);
    const text = root.textContent ?? '';
    // Card cache and Set cache stats are rendered as labelled chips.
    expect(text).toMatch(/Card cache/);
    expect(text).toMatch(/Set cache/);
  });

  it('updates cache counts after a fixture import + SYNC_STATUS_CHANGED_EVENT', async () => {
    mountDashboardView(root, abort.signal);
    await settle(250);
    const before = root.textContent ?? '';
    expect(before).toMatch(/Card cache.*0/s);

    const importResult = await importLocalSyncFixture(db, {
      description: 'phase-6-test',
      sets: [fixtureSet('base1'), fixtureSet('jungle')],
      cards: [
        fixtureCard('base1-1', 'base1'),
        fixtureCard('base1-2', 'base1'),
        fixtureCard('jungle-1', 'jungle'),
      ],
    });
    expect(importResult.ok).toBe(true);

    // Mirror what `handleSyncNow` does after a successful sync — the
    // dashboard listens for this event to re-fetch its snapshot.
    window.dispatchEvent(new CustomEvent(SYNC_STATUS_CHANGED_EVENT));
    await settle(400);

    const after = root.textContent ?? '';
    // 3 cards, 2 sets cached after the import.
    expect(after).toMatch(/Card cache[^\d]*3/);
    expect(after).toMatch(/Set cache[^\d]*2/);
  });

  it('correctly reflects DB content after route leave/return without manual refresh', async () => {
    // Pre-import cache.
    await importLocalSyncFixture(db, {
      description: 'phase-6-test-pre',
      sets: [fixtureSet('s1')],
      cards: [fixtureCard('s1-1', 's1')],
    });
    mountDashboardView(root, abort.signal);
    await settle(300);
    const initial = root.textContent ?? '';
    expect(initial).toMatch(/Card cache[^\d]*1/);

    // Simulate "navigate away and back": abort + remount.
    abort.abort();
    document.body.innerHTML = '<div id="content"></div>';
    root = document.getElementById('content') as HTMLElement;
    abort = new AbortController();
    mountDashboardView(root, abort.signal);
    await settle(300);
    const after = root.textContent ?? '';
    expect(after).toMatch(/Card cache[^\d]*1/);
  });
});
