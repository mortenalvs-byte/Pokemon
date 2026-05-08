// PR 27 — personal-preferences service. DB-driven (real Dexie via
// fake-indexeddb) so we exercise the actual settingsRepo audit path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPersonalPreferencesService } from '../src/services/personal-preferences-service';
import { createSettingsRepo } from '../src/repositories/settings-repo';
import { DEFAULT_PERSONAL_PREFERENCES } from '../src/domain/personal-preferences';
import { SETTINGS_KEYS } from '../src/domain/types';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';

describe('personal-preferences-service (PR 27)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('returns defaults when no settings exist', async () => {
    const svc = createPersonalPreferencesService(createSettingsRepo(db));
    const prefs = await svc.getPreferences();
    expect(prefs).toEqual(DEFAULT_PERSONAL_PREFERENCES);
  });

  it('reads stored values and exposes them as preferences', async () => {
    const repo = createSettingsRepo(db);
    await repo.set(SETTINGS_KEYS.appDisplayName, 'Pokesamler');
    await repo.set(SETTINGS_KEYS.defaultStartRoute, 'master-gap');
    await repo.set(SETTINGS_KEYS.masterGapDensity, 'comfortable');
    await repo.set(SETTINGS_KEYS.commandCenterMaxItems, 8);
    await repo.set(SETTINGS_KEYS.showShortcutHints, false);

    const svc = createPersonalPreferencesService(repo);
    const prefs = await svc.getPreferences();

    expect(prefs.appDisplayName).toBe('Pokesamler');
    expect(prefs.defaultStartRoute).toBe('master-gap');
    expect(prefs.masterGapDensity).toBe('comfortable');
    expect(prefs.commandCenterMaxItems).toBe(8);
    expect(prefs.showShortcutHints).toBe(false);
    // Untouched fields fall back to defaults.
    expect(prefs.dashboardFocusMode).toBe(
      DEFAULT_PERSONAL_PREFERENCES.dashboardFocusMode,
    );
  });

  it('falls back to defaults when stored values are invalid', async () => {
    const repo = createSettingsRepo(db);
    await repo.set(SETTINGS_KEYS.defaultStartRoute, 'space-station');
    await repo.set(SETTINGS_KEYS.masterGapDensity, 999);
    await repo.set(SETTINGS_KEYS.commandCenterMaxItems, 'lots');

    const svc = createPersonalPreferencesService(repo);
    const prefs = await svc.getPreferences();

    expect(prefs.defaultStartRoute).toBe(
      DEFAULT_PERSONAL_PREFERENCES.defaultStartRoute,
    );
    expect(prefs.masterGapDensity).toBe('compact');
    expect(prefs.commandCenterMaxItems).toBe(6);
  });

  it('updatePreferences writes only patched keys', async () => {
    const repo = createSettingsRepo(db);
    const setSpy = vi.spyOn(repo, 'set');
    const svc = createPersonalPreferencesService(repo);

    const merged = await svc.updatePreferences({
      appDisplayName: 'Morten',
      masterGapHideComplete: true,
    });

    expect(merged.appDisplayName).toBe('Morten');
    expect(merged.masterGapHideComplete).toBe(true);

    const writtenKeys = setSpy.mock.calls.map((c) => c[0]);
    expect(writtenKeys).toContain(SETTINGS_KEYS.appDisplayName);
    expect(writtenKeys).toContain(SETTINGS_KEYS.masterGapHideComplete);
    expect(writtenKeys).not.toContain(SETTINGS_KEYS.dashboardFocusMode);
    setSpy.mockRestore();
  });

  it('normalises before write — patched garbage stays out of the store', async () => {
    const repo = createSettingsRepo(db);
    const svc = createPersonalPreferencesService(repo);
    await svc.updatePreferences({
      defaultStartRoute: 'home' as never,
      commandCenterMaxItems: 999 as never,
      masterGapDensity: 'cosy' as never,
      appDisplayName: '   ',
    });
    const prefs = await svc.getPreferences();
    expect(prefs.defaultStartRoute).toBe(
      DEFAULT_PERSONAL_PREFERENCES.defaultStartRoute,
    );
    expect(prefs.commandCenterMaxItems).toBe(12); // clamped to max
    expect(prefs.masterGapDensity).toBe('compact');
    expect(prefs.appDisplayName).toBe(
      DEFAULT_PERSONAL_PREFERENCES.appDisplayName,
    );
  });

  it('roundtrip: write → read returns the written values', async () => {
    const repo = createSettingsRepo(db);
    const svc = createPersonalPreferencesService(repo);
    const patch = {
      appDisplayName: 'Mortens samling',
      defaultStartRoute: 'master-gap' as const,
      dashboardFocusMode: 'binder_work' as const,
      masterGapDensity: 'comfortable' as const,
      masterGapHideComplete: true,
      masterGapOnlyActionable: true,
      masterGapDefaultFilter: 'owned_unplaced' as const,
      commandCenterMaxItems: 10,
      commandCenterShowAllClear: false,
      showShortcutHints: false,
      showPersonalWorkspaceSummary: false,
    };
    await svc.updatePreferences(patch);
    const prefs = await svc.getPreferences();
    expect(prefs).toEqual(patch);
  });

  it('survives a settingsRepo.get rejection on one key', async () => {
    const repo = createSettingsRepo(db);
    // Store one good value first.
    await repo.set(SETTINGS_KEYS.appDisplayName, 'Morten');
    // Make ONE specific get throw — Promise.allSettled keeps the
    // other reads alive.
    const original = repo.get.bind(repo);
    vi.spyOn(repo, 'get').mockImplementation(async (key: string) => {
      if (key === SETTINGS_KEYS.commandCenterMaxItems) {
        throw new Error('simulated dexie hiccup');
      }
      return original(key);
    });
    const svc = createPersonalPreferencesService(repo);
    const prefs = await svc.getPreferences();
    expect(prefs.appDisplayName).toBe('Morten');
    // The throwing key falls back to its default.
    expect(prefs.commandCenterMaxItems).toBe(
      DEFAULT_PERSONAL_PREFERENCES.commandCenterMaxItems,
    );
  });

  it('audit row records the key change without leaking the value', async () => {
    const repo = createSettingsRepo(db);
    const svc = createPersonalPreferencesService(repo);
    await svc.updatePreferences({ appDisplayName: 'super-secret-name-1234' });
    const audit = await db.auditLog.toArray();
    const settingChange = audit.find(
      (a) =>
        a.entityType === 'settings' &&
        a.entityId === SETTINGS_KEYS.appDisplayName,
    );
    expect(settingChange).toBeDefined();
    expect(settingChange?.message).not.toContain('super-secret-name-1234');
  });
});
