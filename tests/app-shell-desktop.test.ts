// PR 26 — desktop app shell regions, sidebar nav, global search slot,
// active-route indicator, and the single keyboard-shortcut mount.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { mountApp } from '../src/app';
import { resetKeyboardShortcutsForTests } from '../src/components/keyboard-shortcuts';
import { closeAndDelete } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';

function freshRoot(): HTMLElement {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.getElementById('app');
  if (!root) throw new Error('test bootstrap failed: missing #app');
  return root;
}

async function settle(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('app shell desktop regions (PR 26)', () => {
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

  it('app shell wrapper has data-region="app-shell"', () => {
    const root = freshRoot();
    mountApp(root);
    expect(root.querySelector('[data-region="app-shell"]')).not.toBeNull();
  });

  it('topbar regions all render', () => {
    const root = freshRoot();
    mountApp(root);
    expect(root.querySelector('[data-region="topbar"]')).not.toBeNull();
    expect(root.querySelector('[data-region="topbar-brand"]')).not.toBeNull();
    expect(root.querySelector('[data-region="topbar-search"]')).not.toBeNull();
    expect(root.querySelector('[data-region="topbar-status"]')).not.toBeNull();
  });

  it('sidebar renders data-region="sidebar"', () => {
    const root = freshRoot();
    mountApp(root);
    expect(root.querySelector('[data-region="sidebar"]')).not.toBeNull();
  });

  it('content renders data-region="content"', () => {
    const root = freshRoot();
    mountApp(root);
    const content = root.querySelector<HTMLElement>('[data-region="content"]');
    expect(content).not.toBeNull();
    // The content region must keep the legacy id="content" hook so
    // existing CSS selectors and the router's mount target keep working.
    expect(content?.id).toBe('content');
  });

  it('topbar brand is an anchor pointing at #dashboard', () => {
    const root = freshRoot();
    mountApp(root);
    const brand = root.querySelector<HTMLAnchorElement>(
      '[data-region="topbar-brand"]',
    );
    expect(brand?.tagName).toBe('A');
    expect(brand?.getAttribute('href')).toBe('#dashboard');
  });

  it('all eight nav links still exist in the canonical order', () => {
    const root = freshRoot();
    mountApp(root);
    // PR 28 review patch (Phase 2 cleanup) — the dev-only QA harness
    // is no longer in the sidebar at all. It lives in a "Developer
    // QA" section inside `#settings` (DEV only) and via `g q`. The
    // sidebar shape is identical in dev and production.
    const sidebar = root.querySelector('.sidebar');
    const links = (sidebar ?? root).querySelectorAll<HTMLAnchorElement>(
      '[data-route]',
    );
    const labels = Array.from(links).map((link) => link.textContent?.trim());
    expect(labels).toEqual([
      'Dashboard',
      'Browse',
      'Min samling',
      'Permer',
      'Lotter',
      'Ønskeliste',
      'Backup',
      'Innstillinger',
    ]);
  });

  it('global search slot is preserved (not renamed)', () => {
    const root = freshRoot();
    mountApp(root);
    expect(root.querySelector('[data-region="topbar-search"]')).not.toBeNull();
  });

  it('active route class still updates on hash change', async () => {
    const root = freshRoot();
    mountApp(root);
    window.location.hash = '#browse';
    // hashchange is async in jsdom; let the listener run.
    await settle(20);
    const browseLink = root.querySelector<HTMLAnchorElement>(
      '[data-route="browse"]',
    );
    expect(browseLink?.classList.contains('sidebar__link--active')).toBe(true);
  });

  it('mountApp registers a keydown listener (keyboard shortcuts present)', () => {
    document.body.innerHTML = '<div id="app"></div>';
    const root = document.getElementById('app');
    if (!root) throw new Error('bootstrap failed');
    const spy = vi.spyOn(window, 'addEventListener');
    mountApp(root);
    const keydownCalls = spy.mock.calls.filter((c) => c[0] === 'keydown');
    // PR 23 global search adds one and PR 26 shortcuts add one. The
    // important contract is that a SECOND mountApp / shortcut mount
    // does not double-register; that is verified by the dedicated
    // keyboard-shortcuts.test.ts idempotency case.
    expect(keydownCalls.length).toBeGreaterThanOrEqual(1);
    spy.mockRestore();
  });

  it('sidebar nav links advertise their keyboard shortcut via aria-keyshortcuts', () => {
    const root = freshRoot();
    mountApp(root);
    const dashLink = root.querySelector<HTMLAnchorElement>(
      '[data-route="dashboard"]',
    );
    expect(dashLink?.getAttribute('aria-keyshortcuts')).toBe('g d');
    const masterLink = root.querySelector<HTMLAnchorElement>(
      '[data-route="binders"]',
    );
    expect(masterLink?.getAttribute('aria-keyshortcuts')).toBe('g p');
  });

  // -- PR 28 — runtime desktop badge ---------------------------------

  it('does NOT render runtime-badge in browser mode', () => {
    const root = freshRoot();
    mountApp(root);
    expect(root.querySelector('[data-region="runtime-badge"]')).toBeNull();
  });

  it('renders runtime-badge with text "Desktop" when Tauri internals are present', () => {
    const w = window as unknown as Record<string, unknown>;
    const hadKey = '__TAURI_INTERNALS__' in w;
    const previous = w['__TAURI_INTERNALS__'];
    Object.defineProperty(w, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
      writable: true,
    });
    try {
      const root = freshRoot();
      mountApp(root);
      const badge = root.querySelector('[data-region="runtime-badge"]');
      expect(badge).not.toBeNull();
      expect(badge?.textContent).toBe('Desktop');
    } finally {
      if (hadKey) {
        w['__TAURI_INTERNALS__'] = previous;
      } else {
        delete w['__TAURI_INTERNALS__'];
      }
    }
  });

  it('runtime-badge does not break brand or default-route behavior', () => {
    const w = window as unknown as Record<string, unknown>;
    const hadKey = '__TAURI_INTERNALS__' in w;
    const previous = w['__TAURI_INTERNALS__'];
    Object.defineProperty(w, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
      writable: true,
    });
    try {
      const root = freshRoot();
      mountApp(root);
      // Brand still renders as an anchor with a href, regardless of
      // the badge's presence.
      const brand = root.querySelector<HTMLAnchorElement>(
        '[data-region="topbar-brand"]',
      );
      expect(brand?.getAttribute('href')).toBe('#dashboard');
      // Search slot still mounts so global search keeps working.
      expect(root.querySelector('[data-region="topbar-search"]')).not.toBeNull();
    } finally {
      if (hadKey) {
        w['__TAURI_INTERNALS__'] = previous;
      } else {
        delete w['__TAURI_INTERNALS__'];
      }
    }
  });
});
