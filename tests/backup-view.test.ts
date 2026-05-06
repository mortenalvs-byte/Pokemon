// Light-weight smoke test for the Backup view. The full data-flow tests
// live in backup-export/validate/restore/roundtrip — here we only check
// that the view mounts the expected DOM, exposes the right buttons,
// renders dynamic content via textContent (not via innerHTML
// interpolation), and that the file picker handler rejects invalid
// JSON without touching the database.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mountBackupView } from '../src/views/backup';
import { initializeDataLayer } from '../src/db/init';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { closeAndDelete } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';

describe('Backup view (smoke)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
  });

  afterEach(async () => {
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
  });

  it('mounts the four panels (intro, status, export, restore)', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');

    mountBackupView(root);

    // Status renders asynchronously inside mountBackupView. Yield a
    // microtask so the appMeta reads can settle, then assert.
    await Promise.resolve();

    expect(root.querySelector('h1')?.textContent).toBe('Backup');
    expect(
      root.querySelector('[data-action="export"]')?.textContent?.trim(),
    ).toBe('Eksporter full backup');
    expect(
      (root.querySelector('[data-action="confirm-restore"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (root.querySelector('[data-action="merge-restore"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      root.querySelector('[data-action="merge-restore"]')?.getAttribute('title'),
    ).toMatch(/later release/i);
  });

  it('renders status via textContent without HTML injection risk', async () => {
    // Plant a "lastBackupAt" value containing characters that would
    // be dangerous if interpolated into innerHTML.
    await db.appMeta.put({
      key: 'lastBackupAt',
      value: '<script>alert(1)</script>',
      updatedAt: '2026-05-06T00:00:00.000Z',
    });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBackupView(root);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The string is rendered as text, not interpreted as HTML — no
    // <script> element should exist anywhere in the view.
    expect(root.querySelector('script')).toBeNull();
    expect(root.textContent).toContain('<script>alert(1)</script>');
  });

  it('rejecting an invalid backup file leaves the database untouched', async () => {
    // Seed a baseline so we can verify nothing changes.
    await db.appMeta.put({
      key: 'baseline',
      value: 'before-restore',
      updatedAt: '2026-05-06T00:00:00.000Z',
    });
    const beforeCount = await db.appMeta.count();

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBackupView(root);
    await Promise.resolve();

    const fileInput = root.querySelector(
      '[data-region="file-input"]',
    ) as HTMLInputElement;
    const restoreFeedback = root.querySelector(
      '[data-region="restore-feedback"]',
    ) as HTMLElement;
    const confirmButton = root.querySelector(
      '[data-action="confirm-restore"]',
    ) as HTMLButtonElement;

    // Drive the file input with an invalid JSON file.
    const file = new File(['{not json'], 'broken.json', {
      type: 'application/json',
    });
    Object.defineProperty(fileInput, 'files', {
      value: [file],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event('change'));

    // Wait for the async file.text() + parse pipeline. 50ms is plenty
    // for jsdom; the pipeline does no I/O beyond the in-memory blob.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(restoreFeedback.classList.contains('backup-view__feedback--error')).toBe(
      true,
    );
    expect(restoreFeedback.textContent ?? '').toMatch(/ugyldig|gyldig|invalid/i);
    expect(confirmButton.disabled).toBe(true);

    // DB is unchanged.
    expect(await db.appMeta.count()).toBe(beforeCount);
    const baseline = await db.appMeta.get('baseline');
    expect(baseline?.value).toBe('before-restore');
  });
});
