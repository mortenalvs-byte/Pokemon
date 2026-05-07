// Pure tests for binder-presets. No DB.

import { describe, expect, it } from 'vitest';

import {
  CREATABLE_SLOTS_PER_PAGE,
  deriveCapacity,
  getBinderPresetDefinition,
  getCreatableBinderPresets,
  getCreatableSlotsPerPageOptions,
  isLegacyPreset,
  isVaultXPreset,
  presetForLegacyRow,
} from '../src/domain/binder-presets';

describe('binder-presets', () => {
  it('Vault X 9-pocket has 9×40 = 360', () => {
    const def = getBinderPresetDefinition('vaultx_9_360');
    expect(def.slotsPerPage).toBe(9);
    expect(def.totalPages).toBe(40);
    expect(def.capacity).toBe(360);
    expect(def.physicalSheets).toBe(20);
    expect(def.isVaultX).toBe(true);
    expect(def.isLegacy).toBe(false);
  });

  it('Vault X 12-pocket has 12×40 = 480', () => {
    const def = getBinderPresetDefinition('vaultx_12_480');
    expect(def.slotsPerPage).toBe(12);
    expect(def.totalPages).toBe(40);
    expect(def.capacity).toBe(480);
  });

  it('Vault X 12-pocket XL has 12×52 = 624', () => {
    const def = getBinderPresetDefinition('vaultx_12xl_624');
    expect(def.slotsPerPage).toBe(12);
    expect(def.totalPages).toBe(52);
    expect(def.capacity).toBe(624);
  });

  it('Vault X 16-pocket XXL has 16×68 = 1088', () => {
    const def = getBinderPresetDefinition('vaultx_16xxl_1088');
    expect(def.slotsPerPage).toBe(16);
    expect(def.totalPages).toBe(68);
    expect(def.capacity).toBe(1088);
  });

  it('every Vault X capacity equals slotsPerPage * totalPages', () => {
    const presets = ['vaultx_9_360', 'vaultx_12_480', 'vaultx_12xl_624', 'vaultx_16xxl_1088'] as const;
    for (const id of presets) {
      const def = getBinderPresetDefinition(id);
      expect(def.capacity).toBe(def.slotsPerPage * def.totalPages);
    }
  });

  it('legacy_18 is recognised by isLegacyPreset and not isVaultX', () => {
    expect(isLegacyPreset('legacy_18')).toBe(true);
    expect(isVaultXPreset('legacy_18')).toBe(false);
  });

  it('custom is neither Vault X nor legacy', () => {
    expect(isVaultXPreset('custom')).toBe(false);
    expect(isLegacyPreset('custom')).toBe(false);
  });

  it('getCreatableBinderPresets does not include legacy_18', () => {
    const ids = getCreatableBinderPresets().map((p) => p.id);
    expect(ids).not.toContain('legacy_18');
    expect(ids).toContain('vaultx_9_360');
    expect(ids).toContain('vaultx_12_480');
    expect(ids).toContain('vaultx_12xl_624');
    expect(ids).toContain('vaultx_16xxl_1088');
    expect(ids).toContain('custom');
  });

  it('CREATABLE_SLOTS_PER_PAGE = 4 / 9 / 12 / 16', () => {
    expect([...CREATABLE_SLOTS_PER_PAGE].sort((a, b) => a - b)).toEqual([4, 9, 12, 16]);
    expect(getCreatableSlotsPerPageOptions()).toBe(CREATABLE_SLOTS_PER_PAGE);
  });

  it('deriveCapacity multiplies', () => {
    expect(deriveCapacity(12, 52)).toBe(624);
    expect(deriveCapacity(16, 68)).toBe(1088);
    expect(deriveCapacity(4, 1)).toBe(4);
  });

  it('presetForLegacyRow maps 18 to legacy_18 and others to custom', () => {
    expect(presetForLegacyRow(18)).toBe('legacy_18');
    expect(presetForLegacyRow(9)).toBe('custom');
    expect(presetForLegacyRow(12)).toBe('custom');
  });
});
