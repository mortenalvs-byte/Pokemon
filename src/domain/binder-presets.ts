// Binder layout presets. Pure data + small helpers, no I/O. PR 14
// introduced these to match physical Vault X products: the user's
// real binders have fixed page counts, fixed slots-per-page, and a
// known total capacity. The from-set wizard fills targets into the
// first slots of the chosen physical binder and leaves the rest
// empty so the in-app binder mirrors the physical one slot-by-slot.
//
// All capacities are expressed in *visible pages*, not physical
// sheets — the user navigates the in-app binder one page at a time,
// not by flipping a sheet which would show two pages at once.
//
// `legacy_18` exists only for binders created before this PR (the
// `slotsPerPage = 9 | 18` model that PR 8a/8b shipped). It is
// assigned by the v1→v2 migration and is never offered to users
// when creating a new binder.

import type { BinderPreset, SlotsPerPage } from './types';

export interface BinderPresetDefinition {
  readonly id: BinderPreset;
  readonly label: string;
  /**
   * Slots a single visible page can hold. For Vault X 9-pocket this
   * is 9; for the 12 and 12 XL it is 12; for the 16 XXL it is 16.
   */
  readonly slotsPerPage: SlotsPerPage;
  /**
   * Number of *visible* pages. A Vault X 9-pocket has 20 sheets but
   * 40 visible pages (front + back of each sheet).
   */
  readonly totalPages: number;
  /** `slotsPerPage * totalPages`. Cached so callers don't recompute. */
  readonly capacity: number;
  /** Physical sheet count when known; null for `custom` / `legacy_18`. */
  readonly physicalSheets: number | null;
  readonly isVaultX: boolean;
  readonly isLegacy: boolean;
}

const DEFINITIONS: Record<BinderPreset, BinderPresetDefinition> = {
  vaultx_9_360: {
    id: 'vaultx_9_360',
    label: 'Vault X 9-pocket — 360 kort',
    slotsPerPage: 9,
    totalPages: 40,
    capacity: 360,
    physicalSheets: 20,
    isVaultX: true,
    isLegacy: false,
  },
  vaultx_12_480: {
    id: 'vaultx_12_480',
    label: 'Vault X 12-pocket — 480 kort',
    slotsPerPage: 12,
    totalPages: 40,
    capacity: 480,
    physicalSheets: 20,
    isVaultX: true,
    isLegacy: false,
  },
  vaultx_12xl_624: {
    id: 'vaultx_12xl_624',
    label: 'Vault X 12-pocket XL — 624 kort',
    slotsPerPage: 12,
    totalPages: 52,
    capacity: 624,
    physicalSheets: 26,
    isVaultX: true,
    isLegacy: false,
  },
  vaultx_16xxl_1088: {
    id: 'vaultx_16xxl_1088',
    label: 'Vault X 16-pocket XXL — 1088 kort',
    slotsPerPage: 16,
    totalPages: 68,
    capacity: 1088,
    physicalSheets: 34,
    isVaultX: true,
    isLegacy: false,
  },
  custom: {
    id: 'custom',
    label: 'Tilpasset',
    // `custom` does not impose a fixed layout; the form uses these as
    // initial values when the user picks the preset.
    slotsPerPage: 9,
    totalPages: 1,
    capacity: 9,
    physicalSheets: null,
    isVaultX: false,
    isLegacy: false,
  },
  legacy_18: {
    id: 'legacy_18',
    label: 'Eldre 18-slot dobbeltside',
    slotsPerPage: 18,
    totalPages: 1,
    capacity: 18,
    physicalSheets: null,
    isVaultX: false,
    isLegacy: true,
  },
};

const VAULT_X_ORDER: readonly BinderPreset[] = [
  'vaultx_9_360',
  'vaultx_12_480',
  'vaultx_12xl_624',
  'vaultx_16xxl_1088',
];

/** Slots-per-page values a user can pick when creating a new binder. */
export const CREATABLE_SLOTS_PER_PAGE: readonly SlotsPerPage[] = [4, 9, 12, 16];

export function getBinderPresetDefinition(
  id: BinderPreset,
): BinderPresetDefinition {
  return DEFINITIONS[id];
}

export function isVaultXPreset(id: BinderPreset): boolean {
  return DEFINITIONS[id].isVaultX;
}

export function isLegacyPreset(id: BinderPreset): boolean {
  return DEFINITIONS[id].isLegacy;
}

/**
 * Presets the binder form is allowed to offer when creating a new
 * binder. `legacy_18` is excluded — old 18-slot binders keep working
 * but no new binder should adopt that layout.
 */
export function getCreatableBinderPresets(): readonly BinderPresetDefinition[] {
  return [
    ...VAULT_X_ORDER.map((id) => DEFINITIONS[id]),
    DEFINITIONS.custom,
  ];
}

export function getCreatableSlotsPerPageOptions(): readonly SlotsPerPage[] {
  return CREATABLE_SLOTS_PER_PAGE;
}

export function deriveCapacity(
  slotsPerPage: SlotsPerPage,
  totalPages: number,
): number {
  return slotsPerPage * totalPages;
}

/**
 * v1 → v2 migration helper. Existing rows had `slotsPerPage = 9 | 18`
 * and no `binderPreset`. We flag 18-slot rows as `legacy_18` and
 * everything else as `custom` so they keep rendering and the user
 * can still edit name/description without having to re-pick a layout.
 */
export function presetForLegacyRow(
  slotsPerPage: number,
): BinderPreset {
  return slotsPerPage === 18 ? 'legacy_18' : 'custom';
}
