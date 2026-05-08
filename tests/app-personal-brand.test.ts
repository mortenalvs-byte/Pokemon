// PR 27 — app shell brand + default-start-route + SETTINGS_CHANGED_EVENT
// reactions. Verified through real DB so the prefs service path is
// exercised end-to-end.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { mountApp } from '../src/app';
import { resetKeyboardShortcutsForTests } from '../src/components/keyboard-shortcuts';
import { createPersonalPreferencesService } from '../src/services/personal-preferences-service';
import { createSettingsRepo } from '../src/repositories/settings-repo';
import {
  SETTINGS_CHANGED_EVENT,
} from '../src/views/settings';
import { closeAndDelete } from './helpers/fresh-db';
import { DEFAULT_PERSONAL_PREFERENCES } from '../src/domain/personal-preferences';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function freshRoot(): HTMLElement {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.getElementById('app');
  if (!root) throw new Error('test bootstrap failed');
  return root;
}

describe('app shell — personal brand + default-start-route (PR 27)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    window.location.hash = '';
    resetKeyboardShortcutsForTests();
  });

  afterEach(async () => {
    await settle(20);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
    resetKeyboardShortcutsForTests();
  });

  it('falls back to the default brand when nothing is stored', async () => {
    const root = freshRoot();
    mountApp(root);
    await settle(120);
    const brand = root.querySelector<HTMLAnchorElement>(
      '[data-region="topbar-brand"]',
    );
    expect(brand?.textContent).toBe(
      DEFAULT_PERSONAL_PREFERENCES.appDisplayName,
    );
    expect(brand?.getAttribute('href')).toBe(
      `#${DEFAULT_PERSONAL_PREFERENCES.defaultStartRoute}`,
    );
  });

  it('renders the stored brand text on mount', async () => {
    const svc = createPersonalPreferencesService(createSettingsRepo(db));
    await svc.updatePreferences({ appDisplayName: 'Mortens samling' });
    const root = freshRoot();
    mountApp(root);
    await vi.waitFor(() => {
      const brand = root.querySelector<HTMLAnchorElement>(
        '[data-region="topbar-brand"]',
      );
      expect(brand?.textContent).toBe('Mortens samling');
    });
  });

  it('brand href reflects the stored defaultStartRoute', async () => {
    const svc = createPersonalPreferencesService(createSettingsRepo(db));
    await svc.updatePreferences({ defaultStartRoute: 'master-gap' });
    const root = freshRoot();
    mountApp(root);
    await vi.waitFor(() => {
      const brand = root.querySelector<HTMLAnchorElement>(
        '[data-region="topbar-brand"]',
      );
      expect(brand?.getAttribute('href')).toBe('#master-gap');
    });
  });

  it('navigates to defaultStartRoute when the hash is empty on mount', async () => {
    const svc = createPersonalPreferencesService(createSettingsRepo(db));
    await svc.updatePreferences({ defaultStartRoute: 'master-gap' });
    window.location.hash = '';
    const root = freshRoot();
    mountApp(root);
    await vi.waitFor(() => {
      expect(window.location.hash).toBe('#master-gap');
    });
  });

  it('does NOT override an existing hash', async () => {
    const svc = createPersonalPreferencesService(createSettingsRepo(db));
    await svc.updatePreferences({ defaultStartRoute: 'master-gap' });
    window.location.hash = '#browse';
    const root = freshRoot();
    mountApp(root);
    await settle(120);
    expect(window.location.hash).toBe('#browse');
  });

  it('does NOT override deep-link hashes', async () => {
    const svc = createPersonalPreferencesService(createSettingsRepo(db));
    await svc.updatePreferences({ defaultStartRoute: 'master-gap' });
    window.location.hash = '#card/base1-4';
    const root = freshRoot();
    mountApp(root);
    await settle(120);
    expect(window.location.hash).toBe('#card/base1-4');
  });

  it('refreshes brand on SETTINGS_CHANGED_EVENT without remounting', async () => {
    const root = freshRoot();
    mountApp(root);
    await settle(120);
    const svc = createPersonalPreferencesService(createSettingsRepo(db));
    await svc.updatePreferences({ appDisplayName: 'Annet navn' });
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT));
    await vi.waitFor(() => {
      const brand = root.querySelector<HTMLAnchorElement>(
        '[data-region="topbar-brand"]',
      );
      expect(brand?.textContent).toBe('Annet navn');
    });
  });

  it('shortcut-help button shows by default', async () => {
    const root = freshRoot();
    mountApp(root);
    await vi.waitFor(() => {
      const help = root.querySelector('[data-action="open-shortcuts-help"]');
      expect(help).not.toBeNull();
    });
  });

  it('shortcut-help button disappears when showShortcutHints=false', async () => {
    const svc = createPersonalPreferencesService(createSettingsRepo(db));
    await svc.updatePreferences({ showShortcutHints: false });
    const root = freshRoot();
    mountApp(root);
    await settle(160);
    expect(
      root.querySelector('[data-action="open-shortcuts-help"]'),
    ).toBeNull();
  });

  it('SETTINGS_CHANGED_EVENT toggles shortcut-help visibility', async () => {
    const root = freshRoot();
    mountApp(root);
    await vi.waitFor(() => {
      expect(
        root.querySelector('[data-action="open-shortcuts-help"]'),
      ).not.toBeNull();
    });
    const svc = createPersonalPreferencesService(createSettingsRepo(db));
    await svc.updatePreferences({ showShortcutHints: false });
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT));
    await vi.waitFor(() => {
      expect(
        root.querySelector('[data-action="open-shortcuts-help"]'),
      ).toBeNull();
    });
  });
});
