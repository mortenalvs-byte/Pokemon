// PR 27 — pure domain tests for personal-preferences normalisers.
// No DB, no DOM. Each normaliser must be safe for any unknown input.

import { describe, expect, it } from 'vitest';

import {
  APP_DISPLAY_NAME_MAX_LENGTH,
  COMMAND_CENTER_MAX_ITEMS,
  COMMAND_CENTER_MIN_ITEMS,
  DEFAULT_PERSONAL_PREFERENCES,
  isDashboardFocusMode,
  isMasterGapDefaultFilter,
  isPersonalStartRoute,
  normaliseAppDisplayName,
  normaliseBoolean,
  normaliseCommandCenterMaxItems,
  normaliseDashboardFocusMode,
  normaliseMasterGapDefaultFilter,
  normalisePersonalPreferences,
  normalisePersonalStartRoute,
  normaliseViewDensity,
} from '../src/domain/personal-preferences';

describe('personal-preferences (PR 27 — domain)', () => {
  // -- normaliseAppDisplayName ---------------------------------------
  describe('normaliseAppDisplayName', () => {
    it('returns the trimmed string when valid', () => {
      expect(normaliseAppDisplayName('  Morten')).toBe('Morten');
    });

    it('falls back to the default for empty / whitespace-only', () => {
      expect(normaliseAppDisplayName('')).toBe(
        DEFAULT_PERSONAL_PREFERENCES.appDisplayName,
      );
      expect(normaliseAppDisplayName('   ')).toBe(
        DEFAULT_PERSONAL_PREFERENCES.appDisplayName,
      );
    });

    it('falls back to the default for non-string input', () => {
      expect(normaliseAppDisplayName(undefined)).toBe(
        DEFAULT_PERSONAL_PREFERENCES.appDisplayName,
      );
      expect(normaliseAppDisplayName(null)).toBe(
        DEFAULT_PERSONAL_PREFERENCES.appDisplayName,
      );
      expect(normaliseAppDisplayName(42)).toBe(
        DEFAULT_PERSONAL_PREFERENCES.appDisplayName,
      );
    });

    it('truncates to APP_DISPLAY_NAME_MAX_LENGTH', () => {
      const long = 'X'.repeat(APP_DISPLAY_NAME_MAX_LENGTH + 5);
      const result = normaliseAppDisplayName(long);
      expect(result.length).toBe(APP_DISPLAY_NAME_MAX_LENGTH);
    });
  });

  // -- isPersonalStartRoute / normalisePersonalStartRoute ------------
  describe('isPersonalStartRoute', () => {
    it('accepts every documented start route', () => {
      const routes = [
        'dashboard',
        'master-gap',
        'browse',
        'collection',
        'binders',
        'lots',
        'wishlist',
        'backup',
        'settings',
      ];
      for (const r of routes) expect(isPersonalStartRoute(r)).toBe(true);
    });

    it('rejects unknown / non-string inputs', () => {
      expect(isPersonalStartRoute('home')).toBe(false);
      expect(isPersonalStartRoute('')).toBe(false);
      expect(isPersonalStartRoute(undefined)).toBe(false);
      expect(isPersonalStartRoute(null)).toBe(false);
      expect(isPersonalStartRoute(42)).toBe(false);
    });

    it('normalisePersonalStartRoute falls back to dashboard for invalid values', () => {
      expect(normalisePersonalStartRoute('home')).toBe('dashboard');
      expect(normalisePersonalStartRoute(null)).toBe('dashboard');
    });
  });

  // -- isDashboardFocusMode / normaliseDashboardFocusMode ------------
  describe('isDashboardFocusMode', () => {
    it('accepts every documented focus mode', () => {
      for (const mode of [
        'balanced',
        'master_set',
        'binder_work',
        'wishlist',
        'lots',
        'collection_health',
      ]) {
        expect(isDashboardFocusMode(mode)).toBe(true);
      }
    });

    it('rejects unknown inputs', () => {
      expect(isDashboardFocusMode('foo')).toBe(false);
      expect(isDashboardFocusMode(undefined)).toBe(false);
    });

    it('normaliseDashboardFocusMode falls back to master_set', () => {
      expect(normaliseDashboardFocusMode('foo')).toBe('master_set');
      expect(normaliseDashboardFocusMode(undefined)).toBe('master_set');
    });
  });

  // -- isMasterGapDefaultFilter / normaliseMasterGapDefaultFilter ----
  describe('isMasterGapDefaultFilter', () => {
    it('accepts every documented filter', () => {
      for (const f of [
        'all',
        'missing',
        'owned_unplaced',
        'wishlist',
        'in_lot',
        'invalid',
      ]) {
        expect(isMasterGapDefaultFilter(f)).toBe(true);
      }
    });

    it('rejects unknown filters', () => {
      expect(isMasterGapDefaultFilter('done')).toBe(false);
      expect(isMasterGapDefaultFilter(null)).toBe(false);
    });

    it('normaliseMasterGapDefaultFilter falls back to all', () => {
      expect(normaliseMasterGapDefaultFilter('done')).toBe('all');
    });
  });

  // -- normaliseCommandCenterMaxItems --------------------------------
  describe('normaliseCommandCenterMaxItems', () => {
    it('returns the rounded number when in range', () => {
      expect(normaliseCommandCenterMaxItems(6)).toBe(6);
      expect(normaliseCommandCenterMaxItems(8)).toBe(8);
    });

    it('clamps below the minimum', () => {
      expect(normaliseCommandCenterMaxItems(0)).toBe(COMMAND_CENTER_MIN_ITEMS);
      expect(normaliseCommandCenterMaxItems(2)).toBe(COMMAND_CENTER_MIN_ITEMS);
      expect(normaliseCommandCenterMaxItems(-5)).toBe(
        COMMAND_CENTER_MIN_ITEMS,
      );
    });

    it('clamps above the maximum', () => {
      expect(normaliseCommandCenterMaxItems(20)).toBe(
        COMMAND_CENTER_MAX_ITEMS,
      );
    });

    it('parses numeric strings', () => {
      expect(normaliseCommandCenterMaxItems('8')).toBe(8);
    });

    it('falls back to 6 for invalid input', () => {
      expect(normaliseCommandCenterMaxItems('asdf')).toBe(6);
      expect(normaliseCommandCenterMaxItems(undefined)).toBe(6);
      expect(normaliseCommandCenterMaxItems(null)).toBe(6);
      expect(normaliseCommandCenterMaxItems(Number.NaN)).toBe(6);
    });
  });

  // -- normaliseBoolean ----------------------------------------------
  describe('normaliseBoolean', () => {
    it('returns booleans verbatim', () => {
      expect(normaliseBoolean(true, false)).toBe(true);
      expect(normaliseBoolean(false, true)).toBe(false);
    });

    it('returns the fallback for non-boolean input', () => {
      expect(normaliseBoolean('true', false)).toBe(false);
      expect(normaliseBoolean(1, true)).toBe(true);
      expect(normaliseBoolean(undefined, true)).toBe(true);
      expect(normaliseBoolean(null, false)).toBe(false);
    });
  });

  // -- normaliseViewDensity ------------------------------------------
  describe('normaliseViewDensity', () => {
    it('accepts both densities', () => {
      expect(normaliseViewDensity('compact')).toBe('compact');
      expect(normaliseViewDensity('comfortable')).toBe('comfortable');
    });

    it('falls back to compact for invalid input', () => {
      expect(normaliseViewDensity('cosy')).toBe('compact');
      expect(normaliseViewDensity(null)).toBe('compact');
    });
  });

  // -- normalisePersonalPreferences ----------------------------------
  describe('normalisePersonalPreferences', () => {
    it('returns full defaults when given an empty record', () => {
      expect(normalisePersonalPreferences({})).toEqual(
        DEFAULT_PERSONAL_PREFERENCES,
      );
    });

    it('overrides only the fields present in the record', () => {
      const result = normalisePersonalPreferences({
        appDisplayName: 'Pokesamler',
        masterGapDensity: 'comfortable',
        commandCenterMaxItems: 10,
      });
      expect(result.appDisplayName).toBe('Pokesamler');
      expect(result.masterGapDensity).toBe('comfortable');
      expect(result.commandCenterMaxItems).toBe(10);
      // Unspecified fields fall back to defaults.
      expect(result.defaultStartRoute).toBe(
        DEFAULT_PERSONAL_PREFERENCES.defaultStartRoute,
      );
      expect(result.commandCenterShowAllClear).toBe(
        DEFAULT_PERSONAL_PREFERENCES.commandCenterShowAllClear,
      );
    });

    it('does NOT throw on garbage input — every field falls back independently', () => {
      const result = normalisePersonalPreferences({
        appDisplayName: 999 as unknown as string,
        defaultStartRoute: 'space-station' as unknown as never,
        dashboardFocusMode: 0 as unknown as never,
        masterGapDensity: { weird: true } as unknown as never,
        masterGapHideComplete: 'truthy' as unknown as boolean,
        masterGapOnlyActionable: null as unknown as boolean,
        masterGapDefaultFilter: 42 as unknown as never,
        commandCenterMaxItems: 'lots' as unknown as number,
        commandCenterShowAllClear: 'yes' as unknown as boolean,
        showShortcutHints: undefined as unknown as boolean,
        showPersonalWorkspaceSummary: [] as unknown as boolean,
      });
      expect(result).toEqual(DEFAULT_PERSONAL_PREFERENCES);
    });
  });
});
