// PR 27 — personal preferences service. Thin wrapper over the
// existing settings key/value store.
//
// Contract:
//   - getPreferences() reads every PR 27 settings key in parallel,
//     pipes the raw values through `normalisePersonalPreferences`,
//     and never throws. A bad row falls back to defaults; the rest
//     of the preferences keep working.
//   - updatePreferences(patch) writes only the keys present in the
//     patch (using `settingsRepo.set`), then returns the merged
//     `PersonalPreferences`. Each value is normalised before write
//     so the store never ends up with garbage.
//   - The service NEVER logs values. The audit row written by
//     `settingsRepo.set` already records the key change with no
//     value content.
//   - The service NEVER touches localStorage.
//
// All preferences live in the existing `settings` store via
// `settingsRepo.set(key, value)`. No schema change.

import {
  DEFAULT_PERSONAL_PREFERENCES,
  normaliseAppDisplayName,
  normaliseBoolean,
  normaliseCommandCenterMaxItems,
  normaliseDashboardFocusMode,
  normaliseMasterGapDefaultFilter,
  normalisePersonalPreferences,
  normalisePersonalStartRoute,
  normaliseViewDensity,
  type PersonalPreferences,
} from '../domain/personal-preferences';
import { SETTINGS_KEYS } from '../domain/types';
import type { SettingsRepo } from '../repositories/settings-repo';

export interface PersonalPreferencesService {
  getPreferences(): Promise<PersonalPreferences>;
  updatePreferences(
    patch: Partial<PersonalPreferences>,
  ): Promise<PersonalPreferences>;
}

export function createPersonalPreferencesService(
  settingsRepo: SettingsRepo,
): PersonalPreferencesService {
  return {
    async getPreferences(): Promise<PersonalPreferences> {
      // Read every key once. We use Promise.allSettled rather than
      // Promise.all so a single transient read failure (e.g. one
      // value with a Dexie type-coercion edge case) cannot break the
      // whole load — the missing rows simply fall back to defaults.
      const readKeys = [
        SETTINGS_KEYS.appDisplayName,
        SETTINGS_KEYS.defaultStartRoute,
        SETTINGS_KEYS.dashboardFocusMode,
        SETTINGS_KEYS.masterGapDensity,
        SETTINGS_KEYS.masterGapHideComplete,
        SETTINGS_KEYS.masterGapOnlyActionable,
        SETTINGS_KEYS.masterGapDefaultFilter,
        SETTINGS_KEYS.commandCenterMaxItems,
        SETTINGS_KEYS.commandCenterShowAllClear,
        SETTINGS_KEYS.showShortcutHints,
        SETTINGS_KEYS.showPersonalWorkspaceSummary,
      ] as const;
      const results = await Promise.allSettled(
        readKeys.map((k) => settingsRepo.get<unknown>(k)),
      );
      const raw: Partial<Record<keyof PersonalPreferences, unknown>> = {};
      const setIfFulfilled = (
        idx: number,
        field: keyof PersonalPreferences,
      ): void => {
        const r = results[idx];
        if (r !== undefined && r.status === 'fulfilled') {
          raw[field] = r.value;
        }
      };
      setIfFulfilled(0, 'appDisplayName');
      setIfFulfilled(1, 'defaultStartRoute');
      setIfFulfilled(2, 'dashboardFocusMode');
      setIfFulfilled(3, 'masterGapDensity');
      setIfFulfilled(4, 'masterGapHideComplete');
      setIfFulfilled(5, 'masterGapOnlyActionable');
      setIfFulfilled(6, 'masterGapDefaultFilter');
      setIfFulfilled(7, 'commandCenterMaxItems');
      setIfFulfilled(8, 'commandCenterShowAllClear');
      setIfFulfilled(9, 'showShortcutHints');
      setIfFulfilled(10, 'showPersonalWorkspaceSummary');
      return normalisePersonalPreferences(raw);
    },

    async updatePreferences(patch): Promise<PersonalPreferences> {
      const current = await this.getPreferences();
      // Normalise + persist each patch key independently. We deliberately
      // do NOT short-circuit when a key already matches its current
      // value — the user may want their setting saved even if the
      // current store value happens to agree (e.g. after a restore).
      // Writes happen sequentially so the audit log stays in a
      // predictable order; the data volume is small (≤ 11 rows) so
      // this is fine.
      if (patch.appDisplayName !== undefined) {
        await settingsRepo.set(
          SETTINGS_KEYS.appDisplayName,
          normaliseAppDisplayName(patch.appDisplayName),
        );
      }
      if (patch.defaultStartRoute !== undefined) {
        await settingsRepo.set(
          SETTINGS_KEYS.defaultStartRoute,
          normalisePersonalStartRoute(patch.defaultStartRoute),
        );
      }
      if (patch.dashboardFocusMode !== undefined) {
        await settingsRepo.set(
          SETTINGS_KEYS.dashboardFocusMode,
          normaliseDashboardFocusMode(patch.dashboardFocusMode),
        );
      }
      if (patch.masterGapDensity !== undefined) {
        await settingsRepo.set(
          SETTINGS_KEYS.masterGapDensity,
          normaliseViewDensity(patch.masterGapDensity),
        );
      }
      if (patch.masterGapHideComplete !== undefined) {
        await settingsRepo.set(
          SETTINGS_KEYS.masterGapHideComplete,
          normaliseBoolean(
            patch.masterGapHideComplete,
            DEFAULT_PERSONAL_PREFERENCES.masterGapHideComplete,
          ),
        );
      }
      if (patch.masterGapOnlyActionable !== undefined) {
        await settingsRepo.set(
          SETTINGS_KEYS.masterGapOnlyActionable,
          normaliseBoolean(
            patch.masterGapOnlyActionable,
            DEFAULT_PERSONAL_PREFERENCES.masterGapOnlyActionable,
          ),
        );
      }
      if (patch.masterGapDefaultFilter !== undefined) {
        await settingsRepo.set(
          SETTINGS_KEYS.masterGapDefaultFilter,
          normaliseMasterGapDefaultFilter(patch.masterGapDefaultFilter),
        );
      }
      if (patch.commandCenterMaxItems !== undefined) {
        await settingsRepo.set(
          SETTINGS_KEYS.commandCenterMaxItems,
          normaliseCommandCenterMaxItems(patch.commandCenterMaxItems),
        );
      }
      if (patch.commandCenterShowAllClear !== undefined) {
        await settingsRepo.set(
          SETTINGS_KEYS.commandCenterShowAllClear,
          normaliseBoolean(
            patch.commandCenterShowAllClear,
            DEFAULT_PERSONAL_PREFERENCES.commandCenterShowAllClear,
          ),
        );
      }
      if (patch.showShortcutHints !== undefined) {
        await settingsRepo.set(
          SETTINGS_KEYS.showShortcutHints,
          normaliseBoolean(
            patch.showShortcutHints,
            DEFAULT_PERSONAL_PREFERENCES.showShortcutHints,
          ),
        );
      }
      if (patch.showPersonalWorkspaceSummary !== undefined) {
        await settingsRepo.set(
          SETTINGS_KEYS.showPersonalWorkspaceSummary,
          normaliseBoolean(
            patch.showPersonalWorkspaceSummary,
            DEFAULT_PERSONAL_PREFERENCES.showPersonalWorkspaceSummary,
          ),
        );
      }
      // Re-read so the merged result reflects whatever the store
      // actually contains (which is the normalised value, not the
      // raw patch).
      return { ...current, ...(await this.getPreferences()) };
    },
  };
}
