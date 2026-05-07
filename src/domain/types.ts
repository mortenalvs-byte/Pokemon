// Single source of truth for domain enums and record shapes. Any module
// that touches a row in IndexedDB imports its types from here. See
// DATA_MODEL.md for the authoritative description.

import type { IsoTimestamp } from '../utils/dates';
import type { Uuid } from '../utils/ids';

export type { IsoTimestamp, Uuid };

// -- Enums --------------------------------------------------------------

export type RawCondition = 'NM' | 'LP' | 'MP' | 'HP' | 'DMG' | 'UNKNOWN';

export type ConditionType = 'raw' | 'graded';

export type GradingCompany = 'PSA' | 'BGS' | 'CGC' | 'TAG' | 'ACE' | 'OTHER';

export type CardFinish =
  | 'normal'
  | 'holo'
  | 'reverse_holo'
  | 'non_holo'
  | 'stamped'
  | 'unknown';

export type Edition = 'unlimited' | 'first_edition' | 'shadowless' | 'unknown';

export type BinderSlotStatus =
  | 'empty'
  | 'wanted'
  | 'owned'
  | 'missing'
  | 'ordered'
  | 'duplicate'
  | 'upgrade_needed';

export type ValueSource =
  | 'manual'
  | 'tcgplayer'
  | 'cardmarket'
  | 'estimated'
  | 'unknown';

export type CurrencyCode = 'NOK' | 'USD' | 'EUR' | 'PHP';

export type AllocationMethod = 'equal' | 'weighted_by_market_price' | 'manual';

// MVP supports 'standard' and 'master'. 'grand_master' is reserved.
export type CompletionMode = 'standard' | 'master' | 'grand_master';

/**
 * Slots per visible binder page. PR 14 introduced 4/12/16 to match
 * physical Vault X products; `18` is kept as a legacy value for
 * binders created before the Vault X presets shipped (it modelled a
 * "double-page" layout, never a real Vault X size).
 */
export type SlotsPerPage = 4 | 9 | 12 | 16 | 18;

/**
 * Binder layout preset. Drives default `slotsPerPage` + `totalPages`
 * + the "physical capacity" the from-set wizard fills. Definitions
 * live in `domain/binder-presets.ts`. `legacy_18` is only assigned
 * by the v1→v2 migration and the binder form never offers it as a
 * choice for new binders.
 */
export type BinderPreset =
  | 'vaultx_9_360'
  | 'vaultx_12_480'
  | 'vaultx_12xl_624'
  | 'vaultx_16xxl_1088'
  | 'custom'
  | 'legacy_18';

export type WishlistStatus = 'wanted' | 'ordered' | 'received' | 'cancelled';

export type WishlistPriority = 'low' | 'medium' | 'high' | 'grail';

export type HoldingStatus =
  | 'owned'
  | 'duplicate'
  | 'for_sale'
  | 'for_trade'
  | 'upgrade_needed'
  | 'ordered'
  | 'wanted';

export type AuditEntityType =
  | 'holding'
  | 'binder'
  | 'binderSlot'
  | 'lot'
  | 'lotItem'
  | 'wishlist'
  | 'settings'
  | 'system';

// -- Record shapes ------------------------------------------------------

export interface SetRecord {
  id: string;
  name: string;
  series: string;
  printedTotal: number;
  total: number;
  releaseDate: string;
  symbolUrl: string | null;
  logoUrl: string | null;
  updatedAt: IsoTimestamp;
}

export interface CardRecord {
  id: string;
  setId: string;
  name: string;
  number: string;
  rarity: string | null;
  supertype: string | null;
  subtypes: string[];
  types: string[];
  imageSmall: string | null;
  imageLarge: string | null;
  tcgplayer: unknown | null;
  cardmarket: unknown | null;
  updatedAt: IsoTimestamp;
}

export interface HoldingRecord {
  id: Uuid;
  cardId: string;
  quantity: number;

  conditionType: ConditionType;
  rawCondition: RawCondition | null;
  gradingCompany: GradingCompany | null;
  grade: number | null;
  certNumber: string | null;
  certUrl: string | null;
  gradedDate: IsoTimestamp | null;

  finish: CardFinish;
  edition: Edition;
  language: string;

  purchasePrice: number | null;
  purchaseCurrency: CurrencyCode | null;

  estimatedValue: number | null;
  valueCurrency: CurrencyCode | null;
  valueSource: ValueSource;
  valueNote: string | null;
  valueUpdatedAt: IsoTimestamp | null;

  source: 'manual' | 'lot' | 'imported';
  note: string | null;
  specialVariant: boolean;

  tags: string[];
  lotId: Uuid | null;
  status: HoldingStatus;

  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  deletedAt: IsoTimestamp | null;
}

export interface BinderRecord {
  id: Uuid;
  name: string;
  description: string | null;
  binderType: string | null;
  totalPages: number;
  slotsPerPage: SlotsPerPage;
  /**
   * Layout preset. Required after PR 14 v1→v2 migration:
   *   - existing 18-slot binders get `'legacy_18'`
   *   - other existing binders get `'custom'`
   *   - new binders pick a Vault X preset or `'custom'`
   * Backups produced before PR 14 may carry rows with the field
   * absent / null; the restore path normalises them via the same
   * migration rules.
   */
  binderPreset: BinderPreset | null;
  completionMode: CompletionMode;
  sourceSetId: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  deletedAt: IsoTimestamp | null;
}

export interface BinderSlotRecord {
  id: Uuid;
  binderId: Uuid;
  pageNumber: number;
  slotNumber: number;
  targetCardId: string | null;
  holdingId: Uuid | null;
  status: BinderSlotStatus;
  note: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  deletedAt: IsoTimestamp | null;
}

export interface LotRecord {
  id: Uuid;
  name: string;
  purchaseDate: IsoTimestamp;
  totalCost: number;
  currency: CurrencyCode;
  allocationMethod: AllocationMethod;
  notes: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  deletedAt: IsoTimestamp | null;
}

export interface LotItemRecord {
  id: Uuid;
  lotId: Uuid;
  cardId: string;
  finish: CardFinish;
  edition: Edition;
  conditionType: ConditionType;
  rawCondition: RawCondition | null;
  gradingCompany: GradingCompany | null;
  grade: number | null;
  quantity: number;
  manualPriceOverride: number | null;
  marketEstimate: number | null;
  allocatedCost: number | null;
  holdingId: Uuid | null;
  note: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  deletedAt: IsoTimestamp | null;
}

export interface WishlistRecord {
  id: Uuid;
  cardId: string;
  finish: CardFinish;
  priority: WishlistPriority;
  targetCondition: RawCondition | null;
  targetPrice: number | null;
  targetCurrency: CurrencyCode | null;
  status: WishlistStatus;
  note: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  deletedAt: IsoTimestamp | null;
}

export interface AuditLogRecord {
  id: Uuid;
  action: string;
  entityType: AuditEntityType;
  entityId: string | null;
  message: string;
  createdAt: IsoTimestamp;
}

export interface SettingsRecord {
  key: string;
  value: unknown;
  updatedAt: IsoTimestamp;
}

export interface AppMetaRecord {
  key: string;
  value: unknown;
  updatedAt: IsoTimestamp;
}

// -- Backup file shape (used by PR 4) -----------------------------------

export interface BackupFile {
  app: 'Pokemon TCG Tracker';
  schemaVersion: number;
  exportedAt: IsoTimestamp;
  settings: SettingsRecord[];
  sets: SetRecord[];
  cards: CardRecord[];
  holdings: HoldingRecord[];
  lots: LotRecord[];
  lotItems: LotItemRecord[];
  binders: BinderRecord[];
  binderSlots: BinderSlotRecord[];
  wishlist: WishlistRecord[];
  auditLog: AuditLogRecord[];
  appMeta: AppMetaRecord[];
}

// -- Reserved appMeta keys ----------------------------------------------

export const APP_META_KEYS = {
  schemaVersion: 'schemaVersion',
  appVersion: 'appVersion',
  lastSyncAt: 'lastSyncAt',
  lastSyncStatus: 'lastSyncStatus',
  lastSyncError: 'lastSyncError',
  lastBackupAt: 'lastBackupAt',
  lastBackupHoldingCount: 'lastBackupHoldingCount',
  persistentStorageGranted: 'persistentStorageGranted',
  lastMigrationAt: 'lastMigrationAt',
} as const;

export type AppMetaKey = (typeof APP_META_KEYS)[keyof typeof APP_META_KEYS];

export type SyncStatus = 'ok' | 'failed';

// -- Reserved settings keys ---------------------------------------------

export const SETTINGS_KEYS = {
  pokemonTcgApiKey: 'pokemonTcgApiKey',
  preferredCurrency: 'preferredCurrency',
  defaultCondition: 'defaultCondition',
  defaultBinderSlotsPerPage: 'defaultBinderSlotsPerPage',
} as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];
