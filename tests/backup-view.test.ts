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
    // PR 20: bumped from 10 ms — the async appMeta read + render
    // sometimes lost a race when this test ran late in a busy
    // suite (the prior wait was cutting it razor-thin).
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The string is rendered as text, not interpreted as HTML — no
    // <script> element should exist anywhere in the view.
    expect(root.querySelector('script')).toBeNull();
    expect(root.textContent).toContain('<script>alert(1)</script>');
  });

  // C5 — Phase-2 Plan C: backup view button + status + valid-file flow.
  // The existing 3 smoke tests cover panel render + XSS-safety + invalid
  // file reject. C5 pins the export-button click, valid-file enable
  // path, and status panel behavior so a future refactor cannot silently
  // drop these contracts.

  it('C5: export button click renders a success feedback message', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBackupView(root);
    await Promise.resolve();

    const exportBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="export"]',
    );
    const feedback = root.querySelector<HTMLElement>(
      '[data-region="export-feedback"]',
    );
    expect(exportBtn).not.toBeNull();
    expect(feedback).not.toBeNull();
    expect(feedback!.textContent ?? '').toBe('');

    exportBtn!.click();

    // Export flow is async (serializeBackupToJson → downloadTextFile).
    // Wait for feedback to settle.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(feedback!.textContent ?? '').toMatch(/Eksport ferdig/i);
    expect(feedback!.classList.contains('backup-view__feedback--error')).toBe(
      false,
    );
  });

  it('C5: a valid backup file enables the destructive restore button + shows preview', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBackupView(root);
    await Promise.resolve();

    const fileInput = root.querySelector<HTMLInputElement>(
      '[data-region="file-input"]',
    );
    const previewRegion = root.querySelector<HTMLElement>(
      '[data-region="preview"]',
    );
    const confirmButton = root.querySelector<HTMLButtonElement>(
      '[data-action="confirm-restore"]',
    );
    expect(fileInput).not.toBeNull();
    expect(previewRegion).not.toBeNull();
    expect(confirmButton).not.toBeNull();
    expect(confirmButton!.disabled).toBe(true);

    // Smallest possible structurally-valid backup. The validator
    // requires the 12 top-level keys + app marker + schemaVersion 2.
    const validBackup = {
      app: 'Pokemon TCG Tracker',
      schemaVersion: 2,
      exportedAt: '2026-05-12T12:00:00.000Z',
      appVersion: '0.0.0',
      sets: [],
      cards: [],
      holdings: [],
      lots: [],
      lotItems: [],
      binders: [],
      binderSlots: [],
      wishlist: [],
      auditLog: [],
      settings: [],
      appMeta: [],
    };
    const json = JSON.stringify(validBackup);
    const file = new File([json], 'valid.json', {
      type: 'application/json',
    });
    Object.defineProperty(fileInput!, 'files', {
      value: [file],
      configurable: true,
    });
    fileInput!.dispatchEvent(new Event('change'));

    // Async parse + validate.
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(confirmButton!.disabled).toBe(false);
    // Preview shows some content describing the validated backup.
    expect(previewRegion!.textContent ?? '').not.toBe('');
  });

  it('C5: status panel renders the lastBackupAt timestamp when set', async () => {
    const knownTimestamp = '2026-05-10T12:00:00.000Z';
    await db.appMeta.put({
      key: 'lastBackupAt',
      value: knownTimestamp,
      updatedAt: '2026-05-10T12:00:00.000Z',
    });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBackupView(root);
    // appMeta read is async.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const status = root.querySelector<HTMLElement>('[data-region="status"]');
    expect(status).not.toBeNull();
    const text = status!.textContent ?? '';
    // The view formats the timestamp; either the raw value or a
    // formatted variant must appear. Assert the date is recognizable.
    expect(text).toMatch(/2026-05-10|10\.05\.2026|10\/05\/2026|10 mai/i);
  });

  it('C5: status panel renders an "aldri"/"ingen" message when never backed up', async () => {
    // Don't seed lastBackupAt; the appMeta entry is absent.
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBackupView(root);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const status = root.querySelector<HTMLElement>('[data-region="status"]');
    expect(status).not.toBeNull();
    const text = (status!.textContent ?? '').toLowerCase();
    // Match either the Norwegian "aldri/ingen" or a hyphen placeholder.
    expect(text.match(/aldri|ingen|—|never/)).not.toBeNull();
  });

  it('C5: intro + export panel mention API-key preservation', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountBackupView(root);
    await Promise.resolve();

    // The intro paragraph and the export panel both document that the
    // API key is excluded from the standard backup. Pin both so a
    // future copy-edit can't silently drop this guarantee.
    const intro = root.querySelector('.backup-view__intro');
    expect(intro?.textContent ?? '').toMatch(/API-nøkkel/);
    const hints = Array.from(
      root.querySelectorAll<HTMLElement>('.backup-view__hint'),
    ).map((p) => p.textContent ?? '');
    expect(
      hints.some((t) => /API-nøkkel|ekskluder/i.test(t)),
    ).toBe(true);
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
