// PR 27 — Snarveier-knapp i topbar + dialog.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { mountKeyboardShortcutsHelp } from '../src/components/keyboard-shortcuts-help';
import { createPersonalPreferencesService } from '../src/services/personal-preferences-service';
import { createSettingsRepo } from '../src/repositories/settings-repo';
import { closeAndDelete } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 80): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTopbar(): HTMLElement {
  document.body.innerHTML = `
    <div data-region="app-shell">
      <header data-region="topbar">
        <a data-region="topbar-brand" href="#dashboard">Test</a>
        <div data-region="topbar-search"></div>
        <div data-region="topbar-status"></div>
      </header>
    </div>
  `;
  const topbar = document.querySelector<HTMLElement>(
    '[data-region="topbar"]',
  );
  if (topbar === null) throw new Error('topbar bootstrap failed');
  return topbar;
}

describe('keyboard shortcuts help (PR 27)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
  });

  afterEach(async () => {
    await settle(20);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
  });

  it('renders the Snarveier button when showShortcutHints=true (default)', async () => {
    makeTopbar();
    await mountKeyboardShortcutsHelp();
    const btn = document.querySelector<HTMLButtonElement>(
      '[data-action="open-shortcuts-help"]',
    );
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe('Snarveier');
  });

  it('does NOT render the Snarveier button when showShortcutHints=false', async () => {
    await createPersonalPreferencesService(
      createSettingsRepo(db),
    ).updatePreferences({ showShortcutHints: false });
    makeTopbar();
    await mountKeyboardShortcutsHelp();
    expect(
      document.querySelector('[data-action="open-shortcuts-help"]'),
    ).toBeNull();
  });

  it('mount is idempotent — repeated calls leave only one button', async () => {
    makeTopbar();
    await mountKeyboardShortcutsHelp();
    await mountKeyboardShortcutsHelp();
    await mountKeyboardShortcutsHelp();
    const buttons = document.querySelectorAll(
      '[data-action="open-shortcuts-help"]',
    );
    expect(buttons).toHaveLength(1);
  });

  it('flipping the preference removes the button on the next mount', async () => {
    makeTopbar();
    await mountKeyboardShortcutsHelp();
    expect(
      document.querySelector('[data-action="open-shortcuts-help"]'),
    ).not.toBeNull();
    await createPersonalPreferencesService(
      createSettingsRepo(db),
    ).updatePreferences({ showShortcutHints: false });
    await mountKeyboardShortcutsHelp();
    expect(
      document.querySelector('[data-action="open-shortcuts-help"]'),
    ).toBeNull();
  });

  it('clicking Snarveier opens the dialog with shortcut rows', async () => {
    makeTopbar();
    await mountKeyboardShortcutsHelp();
    const btn = document.querySelector<HTMLButtonElement>(
      '[data-action="open-shortcuts-help"]',
    );
    btn?.click();
    await vi.waitFor(() => {
      const dialog = document.querySelector('dialog.app-dialog');
      expect(dialog).not.toBeNull();
      const heading = dialog?.querySelector('h2');
      expect(heading?.textContent).toBe('Snarveier');
    });
    const list = document.querySelector('.shortcuts-help__list');
    expect(list).not.toBeNull();
    // Sample a few shortcut entries.
    const dts = Array.from(list!.querySelectorAll('dt')).map(
      (dt) => dt.textContent,
    );
    expect(dts).toContain('g d');
    expect(dts).toContain('g m');
    expect(dts).toContain('Ctrl/Cmd + K');
    expect(dts).toContain('Esc');
  });

  it('survives a missing topbar (no-op without throwing)', async () => {
    document.body.innerHTML = ''; // no topbar element
    await expect(mountKeyboardShortcutsHelp()).resolves.toBeUndefined();
  });
});
