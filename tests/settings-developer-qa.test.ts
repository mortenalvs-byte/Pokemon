// PR 28 review patch (Phase 2 cleanup) — Developer QA section in
// Settings. The QA harness used to live as a dev-only sidebar entry;
// it has been moved into a dedicated "Developer QA" panel inside
// `#settings` so the sidebar shape is identical in dev and production.
// This test pins:
//   - the dev-only panel renders when `import.meta.env.DEV === true`
//     (vitest's runtime default)
//   - the panel exposes a single "Open QA harness" link to `#qa`
//   - the panel carries the dev-only marker class so styling can fade
//     it out without anyone mistaking it for production UX

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { mountSettingsView } from '../src/views/settings';
import { closeAndDelete } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 40): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Settings — Developer QA section (PR 28 review patch, Phase 2)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    window.location.hash = '';
  });

  afterEach(async () => {
    await settle(10);
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  it('renders the Developer QA panel in DEV mode', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountSettingsView(root);
    await settle();
    const panel = root.querySelector('[data-region="developer-qa"]');
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('h2')?.textContent?.trim()).toBe(
      'Developer QA',
    );
  });

  it('exposes exactly one #qa link with the documented label', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountSettingsView(root);
    await settle();
    const link = root.querySelector<HTMLAnchorElement>(
      '[data-region="developer-qa-link"]',
    );
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('#qa');
    expect(link?.textContent?.trim()).toBe('Open QA harness');
  });

  it('marks the panel as dev-only via a CSS class so styling can de-emphasise it', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountSettingsView(root);
    await settle();
    const panel = root.querySelector<HTMLElement>(
      '[data-region="developer-qa"]',
    );
    expect(panel?.classList.contains('settings-view__panel--dev')).toBe(true);
  });

  it('mentions that the panel is not part of production builds', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');
    mountSettingsView(root);
    await settle();
    const panel = root.querySelector<HTMLElement>(
      '[data-region="developer-qa"]',
    );
    const text = (panel?.textContent ?? '').toLowerCase();
    expect(text).toContain('dev-only');
    expect(text).toContain('not included in production builds');
  });
});
