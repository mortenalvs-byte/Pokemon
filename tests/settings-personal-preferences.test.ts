// PR 27 — Personlig app section in the Settings view.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import {
  SETTINGS_CHANGED_EVENT,
  mountSettingsView,
} from '../src/views/settings';
import { createSettingsRepo } from '../src/repositories/settings-repo';
import { createPersonalPreferencesService } from '../src/services/personal-preferences-service';
import { closeAndDelete } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Settings — Personlig app section (PR 27)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    window.location.hash = '';
  });

  afterEach(async () => {
    await settle(20);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  it('renders every personal-preferences input region', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountSettingsView(root);
    await settle();
    const expected = [
      'app-display-name',
      'default-start-route',
      'dashboard-focus-mode',
      'master-gap-density',
      'master-gap-default-filter',
      'master-gap-hide-complete',
      'master-gap-only-actionable',
      'command-center-max-items',
      'command-center-show-all-clear',
      'show-shortcut-hints',
      'show-personal-workspace-summary',
    ];
    for (const region of expected) {
      expect(
        root.querySelector(`[data-region="${region}"]`),
      ).not.toBeNull();
    }
  });

  it('hydrates form fields from stored preferences', async () => {
    const repo = createSettingsRepo(db);
    const svc = createPersonalPreferencesService(repo);
    await svc.updatePreferences({
      appDisplayName: 'Pokesamler',
      defaultStartRoute: 'master-gap',
      masterGapDensity: 'comfortable',
      masterGapHideComplete: true,
      commandCenterMaxItems: 8,
      showShortcutHints: false,
    });
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountSettingsView(root);
    await settle(120);
    expect(
      (root.querySelector<HTMLInputElement>('[data-region="app-display-name"]'))?.value,
    ).toBe('Pokesamler');
    expect(
      (root.querySelector<HTMLSelectElement>('[data-region="default-start-route"]'))?.value,
    ).toBe('master-gap');
    expect(
      (root.querySelector<HTMLSelectElement>('[data-region="master-gap-density"]'))?.value,
    ).toBe('comfortable');
    expect(
      (root.querySelector<HTMLInputElement>('[data-region="master-gap-hide-complete"]'))?.checked,
    ).toBe(true);
    expect(
      (root.querySelector<HTMLSelectElement>('[data-region="command-center-max-items"]'))?.value,
    ).toBe('8');
    expect(
      (root.querySelector<HTMLInputElement>('[data-region="show-shortcut-hints"]'))?.checked,
    ).toBe(false);
  });

  it('save button writes preferences and dispatches SETTINGS_CHANGED_EVENT', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    const eventSpy = vi.fn();
    window.addEventListener(SETTINGS_CHANGED_EVENT, eventSpy);
    mountSettingsView(root);
    await settle(120);
    const nameInput = root.querySelector<HTMLInputElement>(
      '[data-region="app-display-name"]',
    );
    nameInput!.value = 'Mortens samling';
    const saveBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="save-personal-preferences"]',
    );
    saveBtn!.click();
    await vi.waitFor(() => {
      const fb = root.querySelector('[data-region="personal-preferences-feedback"]');
      expect(fb?.textContent).toContain('Personlige valg lagret');
    });
    expect(eventSpy).toHaveBeenCalled();
    const svc = createPersonalPreferencesService(createSettingsRepo(db));
    const prefs = await svc.getPreferences();
    expect(prefs.appDisplayName).toBe('Mortens samling');
    window.removeEventListener(SETTINGS_CHANGED_EVENT, eventSpy);
  });

  it('shows error feedback if a preference write fails', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountSettingsView(root);
    await settle(120);
    // Force the save path to throw by closing the DB.
    db.close();
    const saveBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="save-personal-preferences"]',
    );
    saveBtn!.click();
    await vi.waitFor(() => {
      const fb = root.querySelector(
        '[data-region="personal-preferences-feedback"]',
      );
      expect(fb?.classList.contains('settings-view__feedback--error')).toBe(
        true,
      );
    });
  });

  it('SETTINGS_CHANGED_EVENT only fires after a successful save', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    const eventSpy = vi.fn();
    window.addEventListener(SETTINGS_CHANGED_EVENT, eventSpy);
    mountSettingsView(root);
    await settle(120);
    db.close();
    const saveBtn = root.querySelector<HTMLButtonElement>(
      '[data-action="save-personal-preferences"]',
    );
    saveBtn!.click();
    await settle(80);
    expect(eventSpy).not.toHaveBeenCalled();
    window.removeEventListener(SETTINGS_CHANGED_EVENT, eventSpy);
  });

  it('app-display-name input enforces maxlength=60', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountSettingsView(root);
    await settle(120);
    const nameInput = root.querySelector<HTMLInputElement>(
      '[data-region="app-display-name"]',
    );
    expect(nameInput?.getAttribute('maxlength')).toBe('60');
  });
});
