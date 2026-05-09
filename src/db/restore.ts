// Backup parse + validate + replace-restore.
//
// Parse and validate are pure functions. They do not touch the database
// and they cannot throw past the boundary that matters: the caller sees
// either a successful parse + validation result or a typed error. The
// database is only read or written from within `replaceRestore()`, and
// every replaceRestore write happens inside one Dexie transaction so a
// mid-transaction failure leaves the original database intact.

import { isIsoTimestamp, nowIso } from '../utils/dates';
import { presetForLegacyRow } from '../domain/binder-presets';
import {
  APP_META_KEYS,
  SETTINGS_KEYS,
  type AppMetaRecord,
  type AuditLogRecord,
  type BackupFile,
  type BinderRecord,
  type BinderSlotRecord,
  type CardRecord,
  type HoldingRecord,
  type LotItemRecord,
  type LotRecord,
  type SetRecord,
  type SettingsRecord,
  type WishlistRecord,
} from '../domain/types';
import { newId } from '../utils/ids';
import { BACKUP_APP_LITERAL } from './backup';
import { tryPreRestoreAutoBackup } from './auto-backup';
import type { AutoBackupResult } from './auto-backup';
import { invalidateCardCache, invalidateSetCache } from './cards-cache';
import type { PokemonTrackerDB } from './database';
import { SCHEMA_VERSION } from './schema';

/**
 * Restore-time normalisation for binder rows. Pre-PR-14 backups and
 * any tampered JSON may carry rows where `binderPreset` is missing or
 * `null`; the rest of the app (binders list view, binder form, etc.)
 * branches on `binderPreset !== null`, which is true for `undefined`
 * — so feeding `undefined` straight in would crash
 * `getBinderPresetDefinition()` later.
 *
 * Same rule as the v1→v2 schema upgrade hook in `db/schema.ts`:
 *   slotsPerPage === 18 → legacy_18, else custom.
 */
function normaliseBackupBinder(binder: BinderRecord): BinderRecord {
  if (binder.binderPreset !== undefined && binder.binderPreset !== null) {
    return binder;
  }
  return {
    ...binder,
    binderPreset: presetForLegacyRow(binder.slotsPerPage),
  };
}

// ---------------------------------------------------------------------
// Errors

export class PreRestoreBackupFailedError extends Error {
  public readonly originalError: Error;

  constructor(originalError: Error) {
    super(
      `Pre-restore auto-backup failed: ${originalError.message}. The replace-restore was aborted because no safety-net backup could be written. Re-run with confirmedWithoutPreBackup=true to proceed anyway.`,
    );
    this.name = 'PreRestoreBackupFailedError';
    this.originalError = originalError;
  }
}

// ---------------------------------------------------------------------
// Parse

export function parseBackupJson(text: string): unknown {
  return JSON.parse(text);
}

// ---------------------------------------------------------------------
// Validate

export interface ValidationOk {
  readonly ok: true;
  readonly backup: BackupFile;
  readonly warnings: readonly string[];
}

export interface ValidationFail {
  readonly ok: false;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export type ValidationResult = ValidationOk | ValidationFail;

const TOP_LEVEL_ARRAY_KEYS = [
  'settings',
  'sets',
  'cards',
  'holdings',
  'lots',
  'lotItems',
  'binders',
  'binderSlots',
  'wishlist',
  'auditLog',
  'appMeta',
] as const;

const ID_REQUIRED_STORES = [
  'holdings',
  'lots',
  'lotItems',
  'binders',
  'binderSlots',
  'wishlist',
] as const;

export function validateBackup(parsed: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      errors: ['root: backup must be a JSON object'],
      warnings,
    };
  }

  const root = parsed as Record<string, unknown>;

  if (root['app'] !== BACKUP_APP_LITERAL) {
    errors.push(
      `app: expected "${BACKUP_APP_LITERAL}", got ${JSON.stringify(root['app'])}`,
    );
  }

  const schemaVersion = root['schemaVersion'];
  if (
    typeof schemaVersion !== 'number' ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1
  ) {
    errors.push('schemaVersion: must be a positive integer');
  } else if (schemaVersion > SCHEMA_VERSION) {
    errors.push(
      `schemaVersion: backup is version ${schemaVersion} but this build supports up to ${SCHEMA_VERSION}. Update the app first.`,
    );
  }

  if (typeof root['exportedAt'] !== 'string' || !isIsoTimestamp(root['exportedAt'])) {
    errors.push('exportedAt: must be a valid ISO 8601 timestamp');
  }

  for (const key of TOP_LEVEL_ARRAY_KEYS) {
    const value = root[key];
    if (value === undefined) {
      errors.push(`${key}: required top-level array is missing`);
    } else if (!Array.isArray(value)) {
      errors.push(`${key}: must be an array`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  // Past this point we can safely cast; every required key exists and is
  // an array of the expected outer shape. Per-record id check is a
  // separate pass because it only applies to user-data stores.

  for (const store of ID_REQUIRED_STORES) {
    const records = root[store] as unknown[];
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      if (
        record === null ||
        typeof record !== 'object' ||
        Array.isArray(record) ||
        typeof (record as Record<string, unknown>)['id'] !== 'string'
      ) {
        errors.push(`${store}[${i}]: record is missing a string id`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  // PR 33 — per-record deep validation.
  //
  // Up to and including PR 30, validateBackup only checked top-level
  // shape and the presence of a string `id` on user-data records.
  // A poisoned backup with `quantity: "garbage"` or
  // `finish: 12345` therefore landed in Dexie via `bulkPut` and
  // corrupted downstream readers. F-BACKUP-VALID-1 in
  // docs/PR30_FULL_TECHNICAL_AUDIT.md captured the gap; this pass
  // closes it.
  //
  // Field-type / enum errors hard-fail. Cross-references stay
  // warnings-only (kept downstream as before).
  for (const r of root['holdings'] as Record<string, unknown>[]) {
    const i = (root['holdings'] as unknown[]).indexOf(r);
    errors.push(...validateHoldingRecord(r, `holdings[${i}]`));
  }
  for (const r of root['lots'] as Record<string, unknown>[]) {
    const i = (root['lots'] as unknown[]).indexOf(r);
    errors.push(...validateLotRecord(r, `lots[${i}]`));
  }
  for (const r of root['lotItems'] as Record<string, unknown>[]) {
    const i = (root['lotItems'] as unknown[]).indexOf(r);
    errors.push(...validateLotItemRecord(r, `lotItems[${i}]`));
  }
  for (const r of root['binders'] as Record<string, unknown>[]) {
    const i = (root['binders'] as unknown[]).indexOf(r);
    errors.push(...validateBinderRecord(r, `binders[${i}]`));
  }
  for (const r of root['binderSlots'] as Record<string, unknown>[]) {
    const i = (root['binderSlots'] as unknown[]).indexOf(r);
    errors.push(...validateBinderSlotRecord(r, `binderSlots[${i}]`));
  }
  for (const r of root['wishlist'] as Record<string, unknown>[]) {
    const i = (root['wishlist'] as unknown[]).indexOf(r);
    errors.push(...validateWishlistRecord(r, `wishlist[${i}]`));
  }
  // Light validation for KV-shaped + audit stores.
  for (let i = 0; i < (root['settings'] as unknown[]).length; i += 1) {
    const r = (root['settings'] as unknown[])[i];
    errors.push(...validateKeyValueRecord(r, `settings[${i}]`));
  }
  for (let i = 0; i < (root['appMeta'] as unknown[]).length; i += 1) {
    const r = (root['appMeta'] as unknown[])[i];
    errors.push(...validateKeyValueRecord(r, `appMeta[${i}]`));
  }
  for (let i = 0; i < (root['auditLog'] as unknown[]).length; i += 1) {
    const r = (root['auditLog'] as unknown[])[i];
    errors.push(...validateAuditLogRecord(r, `auditLog[${i}]`));
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  // Cross-reference checks produce warnings only — bad references do
  // not abort the restore, but the user sees them in the preview.
  collectCrossReferenceWarnings(root, warnings);

  // The shape passes; we can claim the typed BackupFile.
  const backup: BackupFile = {
    app: BACKUP_APP_LITERAL,
    schemaVersion: schemaVersion as number,
    exportedAt: root['exportedAt'] as string,
    settings: root['settings'] as SettingsRecord[],
    sets: root['sets'] as SetRecord[],
    cards: root['cards'] as CardRecord[],
    holdings: root['holdings'] as HoldingRecord[],
    lots: root['lots'] as LotRecord[],
    lotItems: root['lotItems'] as LotItemRecord[],
    binders: root['binders'] as BinderRecord[],
    binderSlots: root['binderSlots'] as BinderSlotRecord[],
    wishlist: root['wishlist'] as WishlistRecord[],
    auditLog: root['auditLog'] as AuditLogRecord[],
    appMeta: root['appMeta'] as AppMetaRecord[],
  };

  return { ok: true, backup, warnings };
}

function collectCrossReferenceWarnings(
  root: Record<string, unknown>,
  warnings: string[],
): void {
  const binders = root['binders'] as Array<{ id: string }>;
  const holdings = root['holdings'] as Array<{ id: string; lotId: string | null }>;
  const lots = root['lots'] as Array<{ id: string }>;
  const binderSlots = root['binderSlots'] as Array<{
    binderId: string;
    holdingId: string | null;
  }>;
  const lotItems = root['lotItems'] as Array<{
    lotId: string;
    holdingId: string | null;
  }>;

  const binderIds = new Set(binders.map((b) => b.id));
  const lotIds = new Set(lots.map((l) => l.id));
  const holdingIds = new Set(holdings.map((h) => h.id));

  binderSlots.forEach((slot, i) => {
    if (!binderIds.has(slot.binderId)) {
      warnings.push(
        `binderSlots[${i}]: references missing binderId ${JSON.stringify(slot.binderId)}`,
      );
    }
    if (slot.holdingId !== null && !holdingIds.has(slot.holdingId)) {
      warnings.push(
        `binderSlots[${i}]: references missing holdingId ${JSON.stringify(slot.holdingId)}`,
      );
    }
  });

  holdings.forEach((holding, i) => {
    if (holding.lotId !== null && !lotIds.has(holding.lotId)) {
      warnings.push(
        `holdings[${i}]: references missing lotId ${JSON.stringify(holding.lotId)}`,
      );
    }
  });

  lotItems.forEach((item, i) => {
    if (!lotIds.has(item.lotId)) {
      warnings.push(
        `lotItems[${i}]: references missing lotId ${JSON.stringify(item.lotId)}`,
      );
    }
    if (item.holdingId !== null && !holdingIds.has(item.holdingId)) {
      warnings.push(
        `lotItems[${i}]: references missing holdingId ${JSON.stringify(item.holdingId)}`,
      );
    }
  });
}

// ---------------------------------------------------------------------
// PR 33 — per-record deep validators.
//
// Each validator mirrors the corresponding `XRecord` shape in
// `src/domain/types.ts`. Required fields must be present with the
// correct primitive type or be a member of the documented enum.
// Nullable fields must be `null` when no value is supplied (JSON has
// no `undefined`, so a missing key behaves as `undefined` and is
// treated as a hard error for required-non-null fields).
//
// Validators return an array of human-readable error messages,
// scoped to the record's path label (e.g. `holdings[3]`). The
// caller in `validateBackup` flattens those into the existing
// `errors` array; if anything is reported, `ok: false` is returned
// before the cross-reference walk runs.
//
// Stop-condition compliance: validators reject malformed data, but
// they do NOT extend the on-disk JSON shape, change schemaVersion,
// alter the warnings-vs-errors policy for cross-references, or
// touch the API key preservation rule. (See PR_30 audit doc §
// F-BACKUP-VALID-1 → Successor PR: PR 33.)

// -- Type guards for enum values --------------------------------------

function isOneOf<T extends string>(values: readonly T[]): (v: unknown) => boolean {
  return (v: unknown) => typeof v === 'string' && (values as readonly string[]).includes(v);
}

const isRawCondition = isOneOf(['NM', 'LP', 'MP', 'HP', 'DMG', 'UNKNOWN']);
const isConditionType = isOneOf(['raw', 'graded']);
const isGradingCompany = isOneOf([
  'PSA',
  'BGS',
  'CGC',
  'TAG',
  'ACE',
  'OTHER',
]);
const isCardFinish = isOneOf([
  'normal',
  'holo',
  'reverse_holo',
  'non_holo',
  'stamped',
  'unknown',
]);
const isEdition = isOneOf([
  'unlimited',
  'first_edition',
  'shadowless',
  'unknown',
]);
const isBinderSlotStatus = isOneOf([
  'empty',
  'wanted',
  'owned',
  'missing',
  'ordered',
  'duplicate',
  'upgrade_needed',
]);
const isValueSource = isOneOf([
  'manual',
  'tcgplayer',
  'cardmarket',
  'estimated',
  'unknown',
]);
const isCurrencyCode = isOneOf(['NOK', 'USD', 'EUR', 'PHP']);
const isAllocationMethod = isOneOf([
  'equal',
  'weighted_by_market_price',
  'manual',
]);
const isCompletionMode = isOneOf(['standard', 'master', 'grand_master']);
const isHoldingStatus = isOneOf([
  'owned',
  'duplicate',
  'for_sale',
  'for_trade',
  'upgrade_needed',
  'ordered',
  'wanted',
]);
const isWishlistStatus = isOneOf([
  'wanted',
  'ordered',
  'received',
  'cancelled',
]);
const isWishlistPriority = isOneOf(['low', 'medium', 'high', 'grail']);
const isHoldingSource = isOneOf(['manual', 'lot', 'imported']);
const isAuditEntityType = isOneOf([
  'holding',
  'binder',
  'binderSlot',
  'lot',
  'lotItem',
  'wishlist',
  'settings',
  'system',
]);
const isBinderPreset = isOneOf([
  'vaultx_9_360',
  'vaultx_12_480',
  'vaultx_12xl_624',
  'vaultx_16xxl_1088',
  'custom',
  'legacy_18',
]);

function isSlotsPerPage(v: unknown): boolean {
  return v === 4 || v === 9 || v === 12 || v === 16 || v === 18;
}

// -- Field-level helpers ----------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonNegativeInteger(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isNonNegativeFiniteNumber(v: unknown): boolean {
  return isFiniteNumber(v) && (v as number) >= 0;
}

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

function isNullableIsoTimestamp(v: unknown): boolean {
  return v === null || (typeof v === 'string' && isIsoTimestamp(v));
}

// -- Per-record validators --------------------------------------------

function validateHoldingRecord(
  r: unknown,
  label: string,
): string[] {
  if (!isPlainObject(r)) return [`${label}: must be an object`];
  const e: string[] = [];
  if (typeof r['cardId'] !== 'string' || (r['cardId'] as string).length === 0)
    e.push(`${label}.cardId: must be a non-empty string`);
  if (!isNonNegativeInteger(r['quantity']))
    e.push(`${label}.quantity: must be a non-negative integer`);
  if (!isConditionType(r['conditionType']))
    e.push(`${label}.conditionType: must be 'raw' | 'graded'`);
  if (r['rawCondition'] !== null && !isRawCondition(r['rawCondition']))
    e.push(`${label}.rawCondition: must be RawCondition or null`);
  if (r['gradingCompany'] !== null && !isGradingCompany(r['gradingCompany']))
    e.push(`${label}.gradingCompany: must be GradingCompany or null`);
  if (r['grade'] !== null && !isFiniteNumber(r['grade']))
    e.push(`${label}.grade: must be a finite number or null`);
  if (r['certNumber'] !== null && typeof r['certNumber'] !== 'string')
    e.push(`${label}.certNumber: must be string or null`);
  if (r['certUrl'] !== null && typeof r['certUrl'] !== 'string')
    e.push(`${label}.certUrl: must be string or null`);
  if (!isNullableIsoTimestamp(r['gradedDate']))
    e.push(`${label}.gradedDate: must be ISO timestamp or null`);
  if (!isCardFinish(r['finish']))
    e.push(`${label}.finish: must be a CardFinish`);
  if (!isEdition(r['edition']))
    e.push(`${label}.edition: must be an Edition`);
  if (typeof r['language'] !== 'string')
    e.push(`${label}.language: must be a string`);
  if (r['purchasePrice'] !== null && !isNonNegativeFiniteNumber(r['purchasePrice']))
    e.push(`${label}.purchasePrice: must be non-negative number or null`);
  if (r['purchaseCurrency'] !== null && !isCurrencyCode(r['purchaseCurrency']))
    e.push(`${label}.purchaseCurrency: must be CurrencyCode or null`);
  if (r['estimatedValue'] !== null && !isNonNegativeFiniteNumber(r['estimatedValue']))
    e.push(`${label}.estimatedValue: must be non-negative number or null`);
  if (r['valueCurrency'] !== null && !isCurrencyCode(r['valueCurrency']))
    e.push(`${label}.valueCurrency: must be CurrencyCode or null`);
  if (!isValueSource(r['valueSource']))
    e.push(`${label}.valueSource: must be a ValueSource`);
  if (r['valueNote'] !== null && typeof r['valueNote'] !== 'string')
    e.push(`${label}.valueNote: must be string or null`);
  if (!isNullableIsoTimestamp(r['valueUpdatedAt']))
    e.push(`${label}.valueUpdatedAt: must be ISO timestamp or null`);
  if (!isHoldingSource(r['source']))
    e.push(`${label}.source: must be 'manual' | 'lot' | 'imported'`);
  if (r['note'] !== null && typeof r['note'] !== 'string')
    e.push(`${label}.note: must be string or null`);
  if (typeof r['specialVariant'] !== 'boolean')
    e.push(`${label}.specialVariant: must be boolean`);
  if (!isStringArray(r['tags']))
    e.push(`${label}.tags: must be an array of strings`);
  if (r['lotId'] !== null && typeof r['lotId'] !== 'string')
    e.push(`${label}.lotId: must be string or null`);
  if (!isHoldingStatus(r['status']))
    e.push(`${label}.status: must be a HoldingStatus`);
  if (typeof r['createdAt'] !== 'string' || !isIsoTimestamp(r['createdAt']))
    e.push(`${label}.createdAt: must be an ISO timestamp`);
  if (typeof r['updatedAt'] !== 'string' || !isIsoTimestamp(r['updatedAt']))
    e.push(`${label}.updatedAt: must be an ISO timestamp`);
  if (!isNullableIsoTimestamp(r['deletedAt']))
    e.push(`${label}.deletedAt: must be ISO timestamp or null`);
  return e;
}

function validateBinderRecord(
  r: unknown,
  label: string,
): string[] {
  if (!isPlainObject(r)) return [`${label}: must be an object`];
  const e: string[] = [];
  if (typeof r['name'] !== 'string' || (r['name'] as string).length === 0)
    e.push(`${label}.name: must be a non-empty string`);
  if (r['description'] !== null && typeof r['description'] !== 'string')
    e.push(`${label}.description: must be string or null`);
  if (r['binderType'] !== null && typeof r['binderType'] !== 'string')
    e.push(`${label}.binderType: must be string or null`);
  if (!isNonNegativeInteger(r['totalPages']))
    e.push(`${label}.totalPages: must be a non-negative integer`);
  if (!isSlotsPerPage(r['slotsPerPage']))
    e.push(`${label}.slotsPerPage: must be 4|9|12|16|18`);
  // binderPreset is normalised post-validate (legacy back-fill in
  // `normaliseBackupBinder`). Accept null/undefined OR a documented
  // BinderPreset; reject any other value.
  if (
    r['binderPreset'] !== null &&
    r['binderPreset'] !== undefined &&
    !isBinderPreset(r['binderPreset'])
  ) {
    e.push(`${label}.binderPreset: must be BinderPreset, null, or absent`);
  }
  if (!isCompletionMode(r['completionMode']))
    e.push(`${label}.completionMode: must be a CompletionMode`);
  if (r['sourceSetId'] !== null && typeof r['sourceSetId'] !== 'string')
    e.push(`${label}.sourceSetId: must be string or null`);
  if (typeof r['createdAt'] !== 'string' || !isIsoTimestamp(r['createdAt']))
    e.push(`${label}.createdAt: must be an ISO timestamp`);
  if (typeof r['updatedAt'] !== 'string' || !isIsoTimestamp(r['updatedAt']))
    e.push(`${label}.updatedAt: must be an ISO timestamp`);
  if (!isNullableIsoTimestamp(r['deletedAt']))
    e.push(`${label}.deletedAt: must be ISO timestamp or null`);
  return e;
}

function validateBinderSlotRecord(
  r: unknown,
  label: string,
): string[] {
  if (!isPlainObject(r)) return [`${label}: must be an object`];
  const e: string[] = [];
  if (typeof r['binderId'] !== 'string' || (r['binderId'] as string).length === 0)
    e.push(`${label}.binderId: must be a non-empty string`);
  if (!isNonNegativeInteger(r['pageNumber']))
    e.push(`${label}.pageNumber: must be a non-negative integer`);
  if (!isNonNegativeInteger(r['slotNumber']))
    e.push(`${label}.slotNumber: must be a non-negative integer`);
  if (r['targetCardId'] !== null && typeof r['targetCardId'] !== 'string')
    e.push(`${label}.targetCardId: must be string or null`);
  if (r['holdingId'] !== null && typeof r['holdingId'] !== 'string')
    e.push(`${label}.holdingId: must be string or null`);
  if (!isBinderSlotStatus(r['status']))
    e.push(`${label}.status: must be a BinderSlotStatus`);
  if (r['note'] !== null && typeof r['note'] !== 'string')
    e.push(`${label}.note: must be string or null`);
  if (typeof r['createdAt'] !== 'string' || !isIsoTimestamp(r['createdAt']))
    e.push(`${label}.createdAt: must be an ISO timestamp`);
  if (typeof r['updatedAt'] !== 'string' || !isIsoTimestamp(r['updatedAt']))
    e.push(`${label}.updatedAt: must be an ISO timestamp`);
  if (!isNullableIsoTimestamp(r['deletedAt']))
    e.push(`${label}.deletedAt: must be ISO timestamp or null`);
  return e;
}

function validateLotRecord(
  r: unknown,
  label: string,
): string[] {
  if (!isPlainObject(r)) return [`${label}: must be an object`];
  const e: string[] = [];
  if (typeof r['name'] !== 'string' || (r['name'] as string).length === 0)
    e.push(`${label}.name: must be a non-empty string`);
  if (typeof r['purchaseDate'] !== 'string' || !isIsoTimestamp(r['purchaseDate']))
    e.push(`${label}.purchaseDate: must be an ISO timestamp`);
  if (!isNonNegativeFiniteNumber(r['totalCost']))
    e.push(`${label}.totalCost: must be a non-negative number`);
  if (!isCurrencyCode(r['currency']))
    e.push(`${label}.currency: must be a CurrencyCode`);
  if (!isAllocationMethod(r['allocationMethod']))
    e.push(`${label}.allocationMethod: must be an AllocationMethod`);
  if (r['notes'] !== null && typeof r['notes'] !== 'string')
    e.push(`${label}.notes: must be string or null`);
  if (typeof r['createdAt'] !== 'string' || !isIsoTimestamp(r['createdAt']))
    e.push(`${label}.createdAt: must be an ISO timestamp`);
  if (typeof r['updatedAt'] !== 'string' || !isIsoTimestamp(r['updatedAt']))
    e.push(`${label}.updatedAt: must be an ISO timestamp`);
  if (!isNullableIsoTimestamp(r['deletedAt']))
    e.push(`${label}.deletedAt: must be ISO timestamp or null`);
  return e;
}

function validateLotItemRecord(
  r: unknown,
  label: string,
): string[] {
  if (!isPlainObject(r)) return [`${label}: must be an object`];
  const e: string[] = [];
  if (typeof r['lotId'] !== 'string' || (r['lotId'] as string).length === 0)
    e.push(`${label}.lotId: must be a non-empty string`);
  if (typeof r['cardId'] !== 'string' || (r['cardId'] as string).length === 0)
    e.push(`${label}.cardId: must be a non-empty string`);
  if (!isCardFinish(r['finish']))
    e.push(`${label}.finish: must be a CardFinish`);
  if (!isEdition(r['edition']))
    e.push(`${label}.edition: must be an Edition`);
  if (!isConditionType(r['conditionType']))
    e.push(`${label}.conditionType: must be 'raw' | 'graded'`);
  if (r['rawCondition'] !== null && !isRawCondition(r['rawCondition']))
    e.push(`${label}.rawCondition: must be RawCondition or null`);
  if (r['gradingCompany'] !== null && !isGradingCompany(r['gradingCompany']))
    e.push(`${label}.gradingCompany: must be GradingCompany or null`);
  if (r['grade'] !== null && !isFiniteNumber(r['grade']))
    e.push(`${label}.grade: must be a finite number or null`);
  if (!isNonNegativeInteger(r['quantity']))
    e.push(`${label}.quantity: must be a non-negative integer`);
  if (r['manualPriceOverride'] !== null && !isNonNegativeFiniteNumber(r['manualPriceOverride']))
    e.push(`${label}.manualPriceOverride: must be non-negative number or null`);
  if (r['marketEstimate'] !== null && !isNonNegativeFiniteNumber(r['marketEstimate']))
    e.push(`${label}.marketEstimate: must be non-negative number or null`);
  if (r['allocatedCost'] !== null && !isNonNegativeFiniteNumber(r['allocatedCost']))
    e.push(`${label}.allocatedCost: must be non-negative number or null`);
  if (r['holdingId'] !== null && typeof r['holdingId'] !== 'string')
    e.push(`${label}.holdingId: must be string or null`);
  if (r['note'] !== null && typeof r['note'] !== 'string')
    e.push(`${label}.note: must be string or null`);
  if (typeof r['createdAt'] !== 'string' || !isIsoTimestamp(r['createdAt']))
    e.push(`${label}.createdAt: must be an ISO timestamp`);
  if (typeof r['updatedAt'] !== 'string' || !isIsoTimestamp(r['updatedAt']))
    e.push(`${label}.updatedAt: must be an ISO timestamp`);
  if (!isNullableIsoTimestamp(r['deletedAt']))
    e.push(`${label}.deletedAt: must be ISO timestamp or null`);
  return e;
}

function validateWishlistRecord(
  r: unknown,
  label: string,
): string[] {
  if (!isPlainObject(r)) return [`${label}: must be an object`];
  const e: string[] = [];
  if (typeof r['cardId'] !== 'string' || (r['cardId'] as string).length === 0)
    e.push(`${label}.cardId: must be a non-empty string`);
  if (!isCardFinish(r['finish']))
    e.push(`${label}.finish: must be a CardFinish`);
  if (!isWishlistPriority(r['priority']))
    e.push(`${label}.priority: must be a WishlistPriority`);
  if (r['targetCondition'] !== null && !isRawCondition(r['targetCondition']))
    e.push(`${label}.targetCondition: must be RawCondition or null`);
  if (r['targetPrice'] !== null && !isNonNegativeFiniteNumber(r['targetPrice']))
    e.push(`${label}.targetPrice: must be non-negative number or null`);
  if (r['targetCurrency'] !== null && !isCurrencyCode(r['targetCurrency']))
    e.push(`${label}.targetCurrency: must be CurrencyCode or null`);
  if (!isWishlistStatus(r['status']))
    e.push(`${label}.status: must be a WishlistStatus`);
  if (r['note'] !== null && typeof r['note'] !== 'string')
    e.push(`${label}.note: must be string or null`);
  if (typeof r['createdAt'] !== 'string' || !isIsoTimestamp(r['createdAt']))
    e.push(`${label}.createdAt: must be an ISO timestamp`);
  if (typeof r['updatedAt'] !== 'string' || !isIsoTimestamp(r['updatedAt']))
    e.push(`${label}.updatedAt: must be an ISO timestamp`);
  if (!isNullableIsoTimestamp(r['deletedAt']))
    e.push(`${label}.deletedAt: must be ISO timestamp or null`);
  return e;
}

function validateAuditLogRecord(
  r: unknown,
  label: string,
): string[] {
  if (!isPlainObject(r)) return [`${label}: must be an object`];
  const e: string[] = [];
  if (typeof r['id'] !== 'string')
    e.push(`${label}.id: must be a string`);
  if (typeof r['action'] !== 'string')
    e.push(`${label}.action: must be a string`);
  if (!isAuditEntityType(r['entityType']))
    e.push(`${label}.entityType: must be an AuditEntityType`);
  if (r['entityId'] !== null && typeof r['entityId'] !== 'string')
    e.push(`${label}.entityId: must be string or null`);
  if (typeof r['message'] !== 'string')
    e.push(`${label}.message: must be a string`);
  if (typeof r['createdAt'] !== 'string' || !isIsoTimestamp(r['createdAt']))
    e.push(`${label}.createdAt: must be an ISO timestamp`);
  return e;
}

function validateKeyValueRecord(
  r: unknown,
  label: string,
): string[] {
  // Both `settings` and `appMeta` rows have the same shape:
  //   { key: string, value: unknown, updatedAt: IsoTimestamp }.
  // `value` is intentionally open — settings store free-form JSON
  // payloads (preferences, sentinels, sync metadata).
  if (!isPlainObject(r)) return [`${label}: must be an object`];
  const e: string[] = [];
  if (typeof r['key'] !== 'string' || (r['key'] as string).length === 0)
    e.push(`${label}.key: must be a non-empty string`);
  if (!('value' in r))
    e.push(`${label}.value: must be present (any JSON value, including null)`);
  if (typeof r['updatedAt'] !== 'string' || !isIsoTimestamp(r['updatedAt']))
    e.push(`${label}.updatedAt: must be an ISO timestamp`);
  return e;
}

// ---------------------------------------------------------------------
// Replace restore

export interface ReplaceRestoreOptions {
  /**
   * The result of `tryPreRestoreAutoBackup(db)`. If supplied and ok,
   * the restore proceeds. If supplied and fail (ok === false), the
   * caller must also set `confirmedWithoutPreBackup: true` or the
   * restore aborts with `PreRestoreBackupFailedError`.
   *
   * If not supplied at all, the restore runs `tryPreRestoreAutoBackup`
   * itself.
   */
  readonly preRestoreBackup?: AutoBackupResult;
  readonly confirmedWithoutPreBackup?: boolean;
}

export interface ReplaceRestoreResult {
  readonly preRestoreBackup: AutoBackupResult;
  readonly restoredAt: string;
}

export async function replaceRestore(
  db: PokemonTrackerDB,
  validatedBackup: BackupFile,
  options: ReplaceRestoreOptions = {},
): Promise<ReplaceRestoreResult> {
  // 1. Pre-restore safety net.
  const preRestoreBackup =
    options.preRestoreBackup ?? (await tryPreRestoreAutoBackup(db));

  if (!preRestoreBackup.ok && options.confirmedWithoutPreBackup !== true) {
    throw new PreRestoreBackupFailedError(preRestoreBackup.error);
  }

  // 2. Read the current API key so we can preserve it if the backup
  //    omits one.
  const existingApiKeyRow = await db.settings.get(
    SETTINGS_KEYS.pokemonTcgApiKey,
  );

  // 3. Apply the restore inside a single transaction. Any throw rolls
  //    back; on commit, the database is exactly the backup (plus the
  //    audit row appended below).
  const restoredAt = nowIso();

  await db.transaction(
    'rw',
    [
      db.sets,
      db.cards,
      db.holdings,
      db.lots,
      db.lotItems,
      db.binders,
      db.binderSlots,
      db.wishlist,
      db.auditLog,
      db.settings,
      db.appMeta,
    ],
    async () => {
      // Cache stores
      await db.sets.clear();
      await db.cards.clear();
      if (validatedBackup.sets.length > 0) {
        await db.sets.bulkPut(validatedBackup.sets);
      }
      if (validatedBackup.cards.length > 0) {
        await db.cards.bulkPut(validatedBackup.cards);
      }

      // User-owned stores
      await db.holdings.clear();
      await db.lots.clear();
      await db.lotItems.clear();
      await db.binders.clear();
      await db.binderSlots.clear();
      await db.wishlist.clear();
      await db.auditLog.clear();
      if (validatedBackup.holdings.length > 0) {
        await db.holdings.bulkPut(validatedBackup.holdings);
      }
      if (validatedBackup.lots.length > 0) {
        await db.lots.bulkPut(validatedBackup.lots);
      }
      if (validatedBackup.lotItems.length > 0) {
        await db.lotItems.bulkPut(validatedBackup.lotItems);
      }
      if (validatedBackup.binders.length > 0) {
        // Normalise `binderPreset` on every binder row before
        // persisting. Pre-PR-14 backups omit the field; without this
        // pass the resulting rows would carry `undefined`, which
        // breaks the binders list view's `binderPreset !== null`
        // guard the moment the user opens Permer.
        const normalised = validatedBackup.binders.map(normaliseBackupBinder);
        await db.binders.bulkPut(normalised);
      }
      if (validatedBackup.binderSlots.length > 0) {
        await db.binderSlots.bulkPut(validatedBackup.binderSlots);
      }
      if (validatedBackup.wishlist.length > 0) {
        await db.wishlist.bulkPut(validatedBackup.wishlist);
      }
      if (validatedBackup.auditLog.length > 0) {
        await db.auditLog.bulkPut(validatedBackup.auditLog);
      }

      // Settings — preserve current API key if backup lacks one.
      const backupHasApiKey = validatedBackup.settings.some(
        (record) => record.key === SETTINGS_KEYS.pokemonTcgApiKey,
      );
      const settingsToWrite: SettingsRecord[] =
        backupHasApiKey || existingApiKeyRow === undefined
          ? [...validatedBackup.settings]
          : [...validatedBackup.settings, existingApiKeyRow];
      await db.settings.clear();
      if (settingsToWrite.length > 0) {
        await db.settings.bulkPut(settingsToWrite);
      }

      // appMeta — write the backup's metadata, then override the three
      // keys that must reflect the post-restore reality.
      await db.appMeta.clear();
      if (validatedBackup.appMeta.length > 0) {
        await db.appMeta.bulkPut(validatedBackup.appMeta);
      }
      await db.appMeta.put({
        key: APP_META_KEYS.schemaVersion,
        value: SCHEMA_VERSION,
        updatedAt: restoredAt,
      });
      await db.appMeta.put({
        key: APP_META_KEYS.lastBackupAt,
        value: validatedBackup.exportedAt,
        updatedAt: restoredAt,
      });
      await db.appMeta.put({
        key: APP_META_KEYS.lastMigrationAt,
        value: restoredAt,
        updatedAt: restoredAt,
      });

      // 4. Audit entry inside the same transaction so it commits
      //    atomically with the new state.
      await db.auditLog.add({
        id: newId(),
        action: 'backup_restored',
        entityType: 'system',
        entityId: null,
        message: `restored from backup exported ${validatedBackup.exportedAt}`,
        createdAt: restoredAt,
      });
    },
  );

  // PR 21 — invalidate the in-memory `cards` and `sets` caches now
  // that the transaction has committed a fresh generation. Without
  // this every view mounted before the next page reload would still
  // see the old card list (cardsRepo.list reads through the cache).
  invalidateCardCache(db);
  invalidateSetCache(db);

  return { preRestoreBackup, restoredAt };
}
