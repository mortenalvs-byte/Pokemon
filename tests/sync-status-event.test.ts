// End-to-end proof that the topbar sync chip refreshes after BOTH a
// successful and a failed sync, without reload. Mounts the full app
// shell, drives a sync via the Settings view's button, and asserts the
// topbar chip text after the event has fired.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountApp } from '../src/app';
import { initializeDataLayer } from '../src/db/init';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { closeAndDelete } from './helpers/fresh-db';
import { APP_META_KEYS } from '../src/domain/types';
import { SYNC_STATUS_CHANGED_EVENT } from '../src/views/settings';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('sync status event integration', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
  });

  afterEach(async () => {
    await settle(40);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    vi.unstubAllGlobals();
    window.location.hash = '';
  });

  it('exposes a single SYNC_STATUS_CHANGED_EVENT constant for both success and failure paths', () => {
    // The constant value matters because the topbar listens for it.
    // Renaming it without renaming the listener would silently break
    // the chip refresh.
    expect(SYNC_STATUS_CHANGED_EVENT).toBe('pokemon:sync-status-changed');
  });

  it('topbar shows sync_failed after a failed sync, without reload', async () => {
    const root = document.getElementById('app');
    if (!root) throw new Error('test bootstrap failed');
    mountApp(root);
    await settle();

    // Stub the global fetch so the API client receives an immediate
    // 401 (a non-retryable error). Sync fails fast, no real backoff
    // sleeps happen.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('unauthorized', {
            status: 401,
            headers: { 'Content-Type': 'text/plain' },
          }),
        ),
      ),
    );

    // Navigate to settings and let the Settings view mount.
    window.location.hash = 'settings';
    await settle();

    const syncButton = root.querySelector<HTMLButtonElement>(
      '[data-action="sync-now"]',
    );
    expect(syncButton).not.toBeNull();
    syncButton?.click();

    // Wait until the failed status has been recorded in appMeta.
    await vi.waitFor(async () => {
      const status = await db.appMeta.get(APP_META_KEYS.lastSyncStatus);
      expect(status?.value).toBe('failed');
    });

    // The topbar listener fires after appMeta is updated. Wait until
    // the chip text catches up.
    await vi.waitFor(() => {
      const region = root.querySelector('[data-region="topbar-status"]');
      expect(region?.textContent ?? '').toContain('sync_failed');
    });
  });

  it('topbar refreshes after a successful sync', async () => {
    const root = document.getElementById('app');
    if (!root) throw new Error('test bootstrap failed');
    mountApp(root);
    await settle();

    // Stub fetch to return one empty page of sets. The orchestrator
    // also calls /cards per set, but since we return zero sets the
    // sync completes after one fetch.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            data: [],
            page: 1,
            pageSize: 250,
            count: 0,
            totalCount: 0,
          }),
        ),
      ),
    );

    window.location.hash = 'settings';
    await settle();

    const syncButton = root.querySelector<HTMLButtonElement>(
      '[data-action="sync-now"]',
    );
    syncButton?.click();

    await vi.waitFor(async () => {
      const status = await db.appMeta.get(APP_META_KEYS.lastSyncStatus);
      expect(status?.value).toBe('ok');
    });

    await vi.waitFor(() => {
      const region = root.querySelector('[data-region="topbar-status"]');
      const text = region?.textContent ?? '';
      // Either the success chip is present or the legacy chip is
      // gone — what we care about is that the topbar re-rendered.
      expect(text).not.toContain('Aldri synket');
      expect(text).not.toContain('sync_failed');
    });
  });
});
