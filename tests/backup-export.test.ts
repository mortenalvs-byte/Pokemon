import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BACKUP_APP_LITERAL,
  buildBackupFileName,
  exportToBackupFile,
  readBackupSnapshot,
  serializeBackupToJson,
} from '../src/db/backup';
import { initializeDataLayer } from '../src/db/init';
import { APP_META_KEYS, SETTINGS_KEYS } from '../src/domain/types';
import { SCHEMA_VERSION } from '../src/db/schema';
import { createSettingsRepo } from '../src/repositories/settings-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import { closeAndDelete, freshDb } from './helpers/fresh-db';
import type { HoldingInput } from '../src/domain/validators';
import type { PokemonTrackerDB } from '../src/db/database';

const sampleHolding: HoldingInput = {
  cardId: 'base1-4',
  quantity: 1,
  conditionType: 'raw',
  rawCondition: 'NM',
  gradingCompany: null,
  grade: null,
  certNumber: null,
  certUrl: null,
  gradedDate: null,
  finish: 'holo',
  edition: 'unlimited',
  language: 'en',
  purchasePrice: null,
  purchaseCurrency: null,
  estimatedValue: null,
  valueCurrency: null,
  valueSource: 'unknown',
  valueNote: null,
  valueUpdatedAt: null,
  source: 'manual',
  note: null,
  specialVariant: false,
  tags: [],
  lotId: null,
  status: 'owned',
};

describe('backup export', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('readBackupSnapshot returns all 12 top-level keys', async () => {
    const backup = await readBackupSnapshot(db);
    expect(Object.keys(backup).sort()).toEqual(
      [
        'app',
        'appMeta',
        'auditLog',
        'binderSlots',
        'binders',
        'cards',
        'exportedAt',
        'holdings',
        'lotItems',
        'lots',
        'schemaVersion',
        'sets',
        'settings',
        'wishlist',
      ].sort(),
    );
    expect(backup.app).toBe(BACKUP_APP_LITERAL);
    expect(backup.schemaVersion).toBe(SCHEMA_VERSION);
    expect(typeof backup.exportedAt).toBe('string');
  });

  it('default export excludes the API key from settings', async () => {
    const settingsRepo = createSettingsRepo(db);
    await settingsRepo.set(SETTINGS_KEYS.pokemonTcgApiKey, 'super-secret');
    await settingsRepo.set(SETTINGS_KEYS.preferredCurrency, 'NOK');

    const backup = await readBackupSnapshot(db);
    const keys = backup.settings.map((s) => s.key);
    expect(keys).toContain(SETTINGS_KEYS.preferredCurrency);
    expect(keys).not.toContain(SETTINGS_KEYS.pokemonTcgApiKey);
  });

  it('includeApiKey:true keeps the API key in the snapshot', async () => {
    const settingsRepo = createSettingsRepo(db);
    await settingsRepo.set(SETTINGS_KEYS.pokemonTcgApiKey, 'super-secret');

    const backup = await readBackupSnapshot(db, { includeApiKey: true });
    const apiKeyRow = backup.settings.find(
      (s) => s.key === SETTINGS_KEYS.pokemonTcgApiKey,
    );
    expect(apiKeyRow?.value).toBe('super-secret');
  });

  it('exportToBackupFile records appMeta and audit side effects', async () => {
    const holdingsRepo = createHoldingsRepo(db);
    await holdingsRepo.create(sampleHolding);
    await holdingsRepo.create({ ...sampleHolding, cardId: 'base1-5' });

    const result = await exportToBackupFile(db);

    expect(result.json.startsWith('{')).toBe(true);
    expect(result.filename).toMatch(
      /^pokemon-tracker-backup-v1-\d{8}-\d{6}\.json$/,
    );

    const lastBackup = await db.appMeta.get(APP_META_KEYS.lastBackupAt);
    const lastCount = await db.appMeta.get(
      APP_META_KEYS.lastBackupHoldingCount,
    );
    expect(typeof lastBackup?.value).toBe('string');
    expect(lastCount?.value).toBe(2);

    const audits = await db.auditLog
      .where('action')
      .equals('backup_exported')
      .toArray();
    expect(audits).toHaveLength(1);
  });

  it('serializeBackupToJson emits two-space indented UTF-8 JSON', async () => {
    const backup = await readBackupSnapshot(db);
    const json = serializeBackupToJson(backup);
    expect(json.startsWith('{\n  "app":')).toBe(true);
    expect(json.endsWith('}')).toBe(true);
  });

  it('buildBackupFileName follows the documented pattern', () => {
    const fixedDate = new Date(Date.UTC(2026, 4, 6, 14, 30, 5));
    expect(buildBackupFileName(fixedDate)).toBe(
      'pokemon-tracker-backup-v1-20260506-143005.json',
    );
  });

  it('snapshot is captured before side effects', async () => {
    // Establish a baseline so the audit count we record below is
    // measured against a real starting point (initializeDataLayer adds
    // a schema_migration entry).
    const baselineAuditCount = await db.auditLog.count();

    const result = await exportToBackupFile(db);

    // The exported JSON should NOT contain the new `backup_exported`
    // audit entry itself, because the snapshot was captured before
    // that entry was written.
    const parsed = JSON.parse(result.json) as {
      auditLog: Array<{ action: string }>;
    };
    expect(parsed.auditLog).toHaveLength(baselineAuditCount);
    expect(
      parsed.auditLog.some((entry) => entry.action === 'backup_exported'),
    ).toBe(false);

    // But the live DB does have the new audit entry now.
    expect(await db.auditLog.count()).toBe(baselineAuditCount + 1);
  });
});
