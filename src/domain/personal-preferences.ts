// PR 27 — personal preferences for Morten's command-center workspace.
//
// All preferences live in the existing settings key/value store
// (`SettingsRecord`). No schema migration. No new IndexedDB store.
// The service in `services/personal-preferences-service.ts` reads /
// writes through `settingsRepo` and falls back to the defaults below
// when a key is missing OR holds an invalid value. That keeps a
// brand-new DB and a partial backup both safe.
//
// This module owns:
//   - the canonical `PersonalPreferences` shape
//   - safe defaults
//   - per-field normalisers (small, pure, no DB / no router imports)

import type { ViewDensity } from './view-density';

export type PersonalStartRoute =
  | 'dashboard'
  | 'master-gap'
  | 'browse'
  | 'collection'
  | 'binders'
  | 'lots'
  | 'wishlist'
  | 'backup'
  | 'settings';

export type DashboardFocusMode =
  | 'balanced'
  | 'master_set'
  | 'binder_work'
  | 'wishlist'
  | 'lots'
  | 'collection_health';

export type MasterGapDefaultFilter =
  | 'all'
  | 'missing'
  | 'owned_unplaced'
  | 'wishlist'
  | 'in_lot'
  | 'invalid';

export interface PersonalPreferences {
  readonly appDisplayName: string;
  readonly defaultStartRoute: PersonalStartRoute;
  readonly dashboardFocusMode: DashboardFocusMode;

  readonly masterGapDensity: ViewDensity;
  readonly masterGapHideComplete: boolean;
  readonly masterGapOnlyActionable: boolean;
  readonly masterGapDefaultFilter: MasterGapDefaultFilter;

  readonly commandCenterMaxItems: number;
  readonly commandCenterShowAllClear: boolean;

  readonly showShortcutHints: boolean;
  readonly showPersonalWorkspaceSummary: boolean;
}

export const DEFAULT_PERSONAL_PREFERENCES: PersonalPreferences = Object.freeze({
  appDisplayName: "Morten's Pokémon Tracker",
  defaultStartRoute: 'dashboard',
  dashboardFocusMode: 'master_set',
  masterGapDensity: 'compact',
  masterGapHideComplete: false,
  masterGapOnlyActionable: false,
  masterGapDefaultFilter: 'all',
  commandCenterMaxItems: 6,
  commandCenterShowAllClear: true,
  showShortcutHints: true,
  showPersonalWorkspaceSummary: true,
});

// ---------------------------------------------------------------------
// Normalisers / type guards. All pure. None throw.

export const APP_DISPLAY_NAME_MAX_LENGTH = 60;

export function normaliseAppDisplayName(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_PERSONAL_PREFERENCES.appDisplayName;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return DEFAULT_PERSONAL_PREFERENCES.appDisplayName;
  }
  if (trimmed.length > APP_DISPLAY_NAME_MAX_LENGTH) {
    return trimmed.slice(0, APP_DISPLAY_NAME_MAX_LENGTH);
  }
  return trimmed;
}

const PERSONAL_START_ROUTES: ReadonlySet<PersonalStartRoute> = new Set<PersonalStartRoute>([
  'dashboard',
  'master-gap',
  'browse',
  'collection',
  'binders',
  'lots',
  'wishlist',
  'backup',
  'settings',
]);

export function isPersonalStartRoute(
  value: unknown,
): value is PersonalStartRoute {
  return (
    typeof value === 'string' &&
    PERSONAL_START_ROUTES.has(value as PersonalStartRoute)
  );
}

export function normalisePersonalStartRoute(value: unknown): PersonalStartRoute {
  return isPersonalStartRoute(value)
    ? value
    : DEFAULT_PERSONAL_PREFERENCES.defaultStartRoute;
}

const DASHBOARD_FOCUS_MODES: ReadonlySet<DashboardFocusMode> = new Set<DashboardFocusMode>([
  'balanced',
  'master_set',
  'binder_work',
  'wishlist',
  'lots',
  'collection_health',
]);

export function isDashboardFocusMode(
  value: unknown,
): value is DashboardFocusMode {
  return (
    typeof value === 'string' &&
    DASHBOARD_FOCUS_MODES.has(value as DashboardFocusMode)
  );
}

export function normaliseDashboardFocusMode(
  value: unknown,
): DashboardFocusMode {
  return isDashboardFocusMode(value)
    ? value
    : DEFAULT_PERSONAL_PREFERENCES.dashboardFocusMode;
}

const MASTER_GAP_DEFAULT_FILTERS: ReadonlySet<MasterGapDefaultFilter> = new Set<MasterGapDefaultFilter>([
  'all',
  'missing',
  'owned_unplaced',
  'wishlist',
  'in_lot',
  'invalid',
]);

export function isMasterGapDefaultFilter(
  value: unknown,
): value is MasterGapDefaultFilter {
  return (
    typeof value === 'string' &&
    MASTER_GAP_DEFAULT_FILTERS.has(value as MasterGapDefaultFilter)
  );
}

export function normaliseMasterGapDefaultFilter(
  value: unknown,
): MasterGapDefaultFilter {
  return isMasterGapDefaultFilter(value)
    ? value
    : DEFAULT_PERSONAL_PREFERENCES.masterGapDefaultFilter;
}

export const COMMAND_CENTER_MIN_ITEMS = 3;
export const COMMAND_CENTER_MAX_ITEMS = 12;

export function normaliseCommandCenterMaxItems(value: unknown): number {
  const fallback = DEFAULT_PERSONAL_PREFERENCES.commandCenterMaxItems;
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    n = Number.isFinite(parsed) ? parsed : fallback;
  } else {
    return fallback;
  }
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded < COMMAND_CENTER_MIN_ITEMS) return COMMAND_CENTER_MIN_ITEMS;
  if (rounded > COMMAND_CENTER_MAX_ITEMS) return COMMAND_CENTER_MAX_ITEMS;
  return rounded;
}

export function normaliseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}

const VIEW_DENSITIES: ReadonlySet<ViewDensity> = new Set<ViewDensity>([
  'compact',
  'comfortable',
]);

export function normaliseViewDensity(value: unknown): ViewDensity {
  return typeof value === 'string' && VIEW_DENSITIES.has(value as ViewDensity)
    ? (value as ViewDensity)
    : DEFAULT_PERSONAL_PREFERENCES.masterGapDensity;
}

// ---------------------------------------------------------------------
// Compose stored fragment → fully-validated preferences.

/**
 * Merge a partial / untrusted record (e.g. the union of all rows
 * read from the settings store) into a fully-validated
 * `PersonalPreferences`. Each field is normalised independently — a
 * single bad row never poisons the rest.
 */
export function normalisePersonalPreferences(
  raw: Partial<Record<keyof PersonalPreferences, unknown>>,
): PersonalPreferences {
  return {
    appDisplayName: normaliseAppDisplayName(raw.appDisplayName),
    defaultStartRoute: normalisePersonalStartRoute(raw.defaultStartRoute),
    dashboardFocusMode: normaliseDashboardFocusMode(raw.dashboardFocusMode),
    masterGapDensity: normaliseViewDensity(raw.masterGapDensity),
    masterGapHideComplete: normaliseBoolean(
      raw.masterGapHideComplete,
      DEFAULT_PERSONAL_PREFERENCES.masterGapHideComplete,
    ),
    masterGapOnlyActionable: normaliseBoolean(
      raw.masterGapOnlyActionable,
      DEFAULT_PERSONAL_PREFERENCES.masterGapOnlyActionable,
    ),
    masterGapDefaultFilter: normaliseMasterGapDefaultFilter(
      raw.masterGapDefaultFilter,
    ),
    commandCenterMaxItems: normaliseCommandCenterMaxItems(
      raw.commandCenterMaxItems,
    ),
    commandCenterShowAllClear: normaliseBoolean(
      raw.commandCenterShowAllClear,
      DEFAULT_PERSONAL_PREFERENCES.commandCenterShowAllClear,
    ),
    showShortcutHints: normaliseBoolean(
      raw.showShortcutHints,
      DEFAULT_PERSONAL_PREFERENCES.showShortcutHints,
    ),
    showPersonalWorkspaceSummary: normaliseBoolean(
      raw.showPersonalWorkspaceSummary,
      DEFAULT_PERSONAL_PREFERENCES.showPersonalWorkspaceSummary,
    ),
  };
}
