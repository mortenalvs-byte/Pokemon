import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountSettingsView } from '../src/views/settings';
import { initializeDataLayer } from '../src/db/init';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { SETTINGS_KEYS } from '../src/domain/types';
import { closeAndDelete } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 80): Promise<void> {
  // Allow async hydration / async click handlers to complete. Dexie
  // operations resolve on a microtask + IDB tick, so a short timeout
  // is enough.
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Settings view', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
  });

  afterEach(async () => {
    // Drain any pending async work before closing — view hydration is
    // fire-and-forget by design, but we don't want it racing the
    // teardown.
    await settle(50);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
  });

  it('mounts API, Sync, Defaults, and Storage panels', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');

    mountSettingsView(root);
    await settle();

    expect(root.querySelector('h1')?.textContent).toBe('Innstillinger');
    expect(
      root.querySelector('[data-action="save-api-key"]')?.textContent?.trim(),
    ).toBe('Lagre');
    expect(
      root.querySelector('[data-action="test-api-key"]')?.textContent?.trim(),
    ).toBe('Test tilkobling');
    expect(
      root.querySelector('[data-action="sync-now"]')?.textContent?.trim(),
    ).toBe('Synk nå');
    expect(
      root.querySelector('[data-action="save-defaults"]')?.textContent?.trim(),
    ).toBe('Lagre standardvalg');
  });

  it('renders the API key input as type=password', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountSettingsView(root);
    await settle();

    const input = root.querySelector<HTMLInputElement>(
      '[data-region="api-key-input"]',
    );
    expect(input).not.toBeNull();
    expect(input?.type).toBe('password');
  });

  it('Save writes the API key to settings via the repo (audit message redacts the value)', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountSettingsView(root);
    await settle();

    const input = root.querySelector<HTMLInputElement>(
      '[data-region="api-key-input"]',
    ) as HTMLInputElement;
    const saveBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="save-api-key"]',
    ) as HTMLButtonElement;
    const feedback = root.querySelector<HTMLElement>(
      '[data-region="api-feedback"]',
    ) as HTMLElement;

    input.value = 'super-secret-api-key';
    saveBtn.click();
    // Wait for the click handler to render its success message — that
    // is the last side effect of the save flow, so by the time it
    // appears the DB write must already have committed.
    await vi.waitFor(() => {
      expect(feedback.textContent).toMatch(/lagret/i);
    });

    const stored = await db.settings.get(SETTINGS_KEYS.pokemonTcgApiKey);
    expect(stored?.value).toBe('super-secret-api-key');
    expect(feedback.textContent).toMatch(/lagret/i);
    expect(feedback.classList.contains('settings-view__feedback--error')).toBe(
      false,
    );

    // Audit message must not include the raw API key (settingsRepo
    // redacts it).
    const audits = await db.auditLog
      .where('action')
      .equals('api_key_changed')
      .toArray();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.message).not.toContain('super-secret-api-key');
  });

  it('renders status text via textContent — no innerHTML interpolation of the key or error', async () => {
    // Plant an error message in `lastSyncError` containing characters
    // that would be dangerous if interpolated into innerHTML, plus
    // the literal string of a fake API key — the view must not echo
    // either as HTML.
    await db.appMeta.put({
      key: 'lastSyncError',
      value: '<script>alert("api-key=abc")</script>',
      updatedAt: '2026-05-06T00:00:00.000Z',
    });
    await db.appMeta.put({
      key: 'lastSyncStatus',
      value: 'failed',
      updatedAt: '2026-05-06T00:00:00.000Z',
    });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountSettingsView(root);
    await settle();

    expect(root.querySelector('script')).toBeNull();
    expect(root.textContent).toContain('<script>alert("api-key=abc")</script>');
  });

  it('Save defaults persists preferred currency, condition, and slots-per-page', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountSettingsView(root);
    await settle();

    (root.querySelector<HTMLSelectElement>('[data-region="preferred-currency"]') as HTMLSelectElement).value = 'USD';
    (root.querySelector<HTMLSelectElement>('[data-region="default-condition"]') as HTMLSelectElement).value = 'LP';
    (root.querySelector<HTMLSelectElement>('[data-region="default-slots"]') as HTMLSelectElement).value = '9';

    (root.querySelector<HTMLButtonElement>('[data-action="save-defaults"]') as HTMLButtonElement).click();
    await vi.waitFor(async () => {
      const slots = await db.settings.get(SETTINGS_KEYS.defaultBinderSlotsPerPage);
      expect(slots?.value).toBe(9);
    });

    const currency = await db.settings.get(SETTINGS_KEYS.preferredCurrency);
    const condition = await db.settings.get(SETTINGS_KEYS.defaultCondition);
    const slots = await db.settings.get(SETTINGS_KEYS.defaultBinderSlotsPerPage);
    expect(currency?.value).toBe('USD');
    expect(condition?.value).toBe('LP');
    expect(slots?.value).toBe(9);
  });

  it('hydrates inputs from existing settings rows on mount', async () => {
    await db.settings.put({
      key: SETTINGS_KEYS.preferredCurrency,
      value: 'EUR',
      updatedAt: '2026-05-06T00:00:00.000Z',
    });
    await db.settings.put({
      key: SETTINGS_KEYS.pokemonTcgApiKey,
      value: 'pre-existing',
      updatedAt: '2026-05-06T00:00:00.000Z',
    });

    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountSettingsView(root);
    // Hydration is async; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const apiKeyInput = root.querySelector<HTMLInputElement>(
      '[data-region="api-key-input"]',
    ) as HTMLInputElement;
    const currencySelect = root.querySelector<HTMLSelectElement>(
      '[data-region="preferred-currency"]',
    ) as HTMLSelectElement;
    expect(apiKeyInput.value).toBe('pre-existing');
    expect(currencySelect.value).toBe('EUR');
  });
});
