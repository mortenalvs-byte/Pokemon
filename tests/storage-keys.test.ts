// PR 32 — pin every localStorage key string in the registry.
// Renaming any of these is a backwards-compat break for tooling
// outside the app (Tauri-side reader, the Node-side
// `.local/read-webview-localstorage.mjs` helper, manual operator
// inspection in DevTools) and requires an explicit operator
// decision plus a coordinated update of those external readers.
//
// `ALL_DEV_ONLY_STORAGE_KEYS` is the single list the production
// gating test (`tests/qa-route-prod-gating.test.ts`) imports to
// build its banned-string list. So adding a key to the registry
// automatically extends the gating contract — there is no second
// place to update.

import { describe, expect, it } from 'vitest';

import {
  ALL_DEV_ONLY_STORAGE_KEYS,
  CONSOLE_AUDIT_HISTORY_KEY,
  DESKTOP_PERSISTENCE_BOOT_COUNTER_KEY,
  DESKTOP_PERSISTENCE_SENTINEL_KEY,
  DEV_AUTO_FIXTURE_IMPORT_KEY,
  DEV_AUTO_FIXTURE_IMPORT_RESULT_KEY,
  DEV_AUTO_IMAGE_AUDIT_KEY,
  DEV_AUTO_IMAGE_AUDIT_RESULT_KEY,
  DEV_AUTO_MAX_STRESS_KEY,
  DEV_AUTO_MAX_STRESS_RESULT_KEY,
  DEV_AUTO_PUBLIC_SYNC_KEY,
  DEV_AUTO_PUBLIC_SYNC_RESULT_KEY,
  PERSISTENCE_DIAG_BOOT_HISTORY_KEY,
  ROUTE_WALK_HISTORY_KEY,
} from '../src/domain/storage-keys';

describe('storage keys registry — exact literal pins', () => {
  it('PERSISTENCE_DIAG_BOOT_HISTORY_KEY', () => {
    expect(PERSISTENCE_DIAG_BOOT_HISTORY_KEY).toBe(
      'pokemon.persistenceDiagBootHistory',
    );
  });

  it('CONSOLE_AUDIT_HISTORY_KEY', () => {
    expect(CONSOLE_AUDIT_HISTORY_KEY).toBe('pokemon.consoleAuditHistory');
  });

  it('ROUTE_WALK_HISTORY_KEY', () => {
    expect(ROUTE_WALK_HISTORY_KEY).toBe('pokemon.routeWalkHistory');
  });

  it('DEV_AUTO_FIXTURE_IMPORT_KEY (+ result)', () => {
    expect(DEV_AUTO_FIXTURE_IMPORT_KEY).toBe('pokemon.devAutoFixtureImport');
    expect(DEV_AUTO_FIXTURE_IMPORT_RESULT_KEY).toBe(
      'pokemon.devAutoFixtureImportResult',
    );
  });

  it('DEV_AUTO_IMAGE_AUDIT_KEY (+ result)', () => {
    expect(DEV_AUTO_IMAGE_AUDIT_KEY).toBe('pokemon.devAutoImageAudit');
    expect(DEV_AUTO_IMAGE_AUDIT_RESULT_KEY).toBe(
      'pokemon.devAutoImageAuditResult',
    );
  });

  it('DEV_AUTO_PUBLIC_SYNC_KEY (+ result)', () => {
    expect(DEV_AUTO_PUBLIC_SYNC_KEY).toBe('pokemon.devAutoPublicSync');
    expect(DEV_AUTO_PUBLIC_SYNC_RESULT_KEY).toBe(
      'pokemon.devAutoPublicSyncResult',
    );
  });

  it('DEV_AUTO_MAX_STRESS_KEY (+ result)', () => {
    expect(DEV_AUTO_MAX_STRESS_KEY).toBe('pokemon.devAutoMaxStress');
    expect(DEV_AUTO_MAX_STRESS_RESULT_KEY).toBe(
      'pokemon.devAutoMaxStressResult',
    );
  });

  it('DESKTOP_PERSISTENCE_SENTINEL_KEY', () => {
    expect(DESKTOP_PERSISTENCE_SENTINEL_KEY).toBe(
      'pokemon.desktopPersistenceSentinel',
    );
  });

  it('DESKTOP_PERSISTENCE_BOOT_COUNTER_KEY', () => {
    expect(DESKTOP_PERSISTENCE_BOOT_COUNTER_KEY).toBe(
      'pokemon.desktopPersistenceBootCounter',
    );
  });
});

describe('storage keys registry — ALL_DEV_ONLY_STORAGE_KEYS roll-up', () => {
  it('contains exactly 13 keys', () => {
    expect(ALL_DEV_ONLY_STORAGE_KEYS.length).toBe(13);
  });

  it('every key is `pokemon.*`-prefixed (the desktop appMeta key is intentionally NOT in this list)', () => {
    for (const key of ALL_DEV_ONLY_STORAGE_KEYS) {
      expect(key.startsWith('pokemon.')).toBe(true);
    }
  });

  it('contains every individually-exported key', () => {
    const set = new Set<string>(ALL_DEV_ONLY_STORAGE_KEYS);
    expect(set.has(PERSISTENCE_DIAG_BOOT_HISTORY_KEY)).toBe(true);
    expect(set.has(CONSOLE_AUDIT_HISTORY_KEY)).toBe(true);
    expect(set.has(ROUTE_WALK_HISTORY_KEY)).toBe(true);
    expect(set.has(DEV_AUTO_FIXTURE_IMPORT_KEY)).toBe(true);
    expect(set.has(DEV_AUTO_FIXTURE_IMPORT_RESULT_KEY)).toBe(true);
    expect(set.has(DEV_AUTO_IMAGE_AUDIT_KEY)).toBe(true);
    expect(set.has(DEV_AUTO_IMAGE_AUDIT_RESULT_KEY)).toBe(true);
    expect(set.has(DEV_AUTO_PUBLIC_SYNC_KEY)).toBe(true);
    expect(set.has(DEV_AUTO_PUBLIC_SYNC_RESULT_KEY)).toBe(true);
    expect(set.has(DEV_AUTO_MAX_STRESS_KEY)).toBe(true);
    expect(set.has(DEV_AUTO_MAX_STRESS_RESULT_KEY)).toBe(true);
    expect(set.has(DESKTOP_PERSISTENCE_SENTINEL_KEY)).toBe(true);
    expect(set.has(DESKTOP_PERSISTENCE_BOOT_COUNTER_KEY)).toBe(true);
  });

  it('has no duplicates', () => {
    expect(new Set(ALL_DEV_ONLY_STORAGE_KEYS).size).toBe(
      ALL_DEV_ONLY_STORAGE_KEYS.length,
    );
  });
});
