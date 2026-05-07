import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BACKUP_APP_LITERAL } from '../src/db/backup';
import {
  PreRestoreBackupFailedError,
  replaceRestore,
} from '../src/db/restore';
import { initializeDataLayer } from '../src/db/init';
import { APP_META_KEYS, SETTINGS_KEYS, type BackupFile } from '../src/domain/types';
import { SCHEMA_VERSION } from '../src/db/schema';
import { createSettingsRepo } from '../src/repositories/settings-repo';
import { createHoldingsRepo } from '../src/repositories/holdings-repo';
import type { AutoBackupResult } from '../src/db/auto-backup';
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

function emptyBackup(overrides: Partial<BackupFile> = {}): BackupFile {
  return {
    app: BACKUP_APP_LITERAL,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: '2026-05-06T00:00:00.000Z',
    settings: [],
    sets: [],
    cards: [],
    holdings: [],
    lots: [],
    lotItems: [],
    binders: [],
    binderSlots: [],
    wishlist: [],
    auditLog: [],
    appMeta: [],
    ...overrides,
  };
}

const okPreRestoreBackup: AutoBackupResult = {
  ok: true,
  filename: 'pre-restore-backup-test.json',
  json: '{}',
};

describe('replaceRestore', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    db = await freshDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    // PR 11 strict variant validation: seed the card before any
    // pre-restore holding write goes through the repo.
    await db.cards.put({
      id: 'base1-4',
      setId: 'base1',
      name: 'Charizard',
      number: '4',
      rarity: 'Rare Holo',
      supertype: 'Pokémon',
      subtypes: [],
      types: [],
      imageSmall: null,
      imageLarge: null,
      tcgplayer: {
        prices: {
          normal: { market: 1 },
          holofoil: { market: 1 },
          reverseHolofoil: { market: 1 },
        },
      },
      cardmarket: null,
      updatedAt: '2026-05-06T00:00:00.000Z',
    });
  });

  afterEach(async () => {
    await closeAndDelete(db);
  });

  it('atomically replaces every store with the backup contents', async () => {
    const holdingsRepo = createHoldingsRepo(db);
    await holdingsRepo.create(sampleHolding);
    expect(await db.holdings.count()).toBe(1);

    const backup = emptyBackup({
      cards: [
        {
          id: 'base1-4',
          setId: 'base1',
          name: 'Charizard',
          number: '4',
          rarity: null,
          supertype: null,
          subtypes: [],
          types: [],
          imageSmall: null,
          imageLarge: null,
          tcgplayer: { prices: { normal: { market: 1 }, holofoil: { market: 1 }, reverseHolofoil: { market: 1 }, "1stEditionNormal": { market: 1 }, "1stEditionHolofoil": { market: 1 } } },
          cardmarket: null,
          updatedAt: '2026-05-06T00:00:00.000Z',
        },
      ],
    });

    await replaceRestore(db, backup, { preRestoreBackup: okPreRestoreBackup });

    expect(await db.holdings.count()).toBe(0);
    expect(await db.cards.count()).toBe(1);
  });

  it('appends a backup_restored audit entry inside the transaction', async () => {
    await replaceRestore(db, emptyBackup(), {
      preRestoreBackup: okPreRestoreBackup,
    });
    const audits = await db.auditLog
      .where('action')
      .equals('backup_restored')
      .toArray();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.message).toContain('2026-05-06T00:00:00.000Z');
  });

  it('updates appMeta.schemaVersion / lastBackupAt / lastMigrationAt', async () => {
    await replaceRestore(db, emptyBackup(), {
      preRestoreBackup: okPreRestoreBackup,
    });
    const schemaRow = await db.appMeta.get(APP_META_KEYS.schemaVersion);
    const lastBackupRow = await db.appMeta.get(APP_META_KEYS.lastBackupAt);
    const lastMigRow = await db.appMeta.get(APP_META_KEYS.lastMigrationAt);
    expect(schemaRow?.value).toBe(SCHEMA_VERSION);
    expect(lastBackupRow?.value).toBe('2026-05-06T00:00:00.000Z');
    expect(typeof lastMigRow?.value).toBe('string');
  });

  it('preserves the existing API key when the backup does not contain one', async () => {
    const settingsRepo = createSettingsRepo(db);
    await settingsRepo.set(SETTINGS_KEYS.pokemonTcgApiKey, 'preserve-me');

    await replaceRestore(db, emptyBackup(), {
      preRestoreBackup: okPreRestoreBackup,
    });

    const apiKey = await db.settings.get(SETTINGS_KEYS.pokemonTcgApiKey);
    expect(apiKey?.value).toBe('preserve-me');
  });

  it('overwrites the API key when the backup contains one', async () => {
    const settingsRepo = createSettingsRepo(db);
    await settingsRepo.set(SETTINGS_KEYS.pokemonTcgApiKey, 'old-key');

    const backup = emptyBackup({
      settings: [
        {
          key: SETTINGS_KEYS.pokemonTcgApiKey,
          value: 'new-key',
          updatedAt: '2026-05-06T00:00:00.000Z',
        },
      ],
    });

    await replaceRestore(db, backup, { preRestoreBackup: okPreRestoreBackup });

    const apiKey = await db.settings.get(SETTINGS_KEYS.pokemonTcgApiKey);
    expect(apiKey?.value).toBe('new-key');
  });

  it('throws PreRestoreBackupFailedError when pre-restore backup failed and not confirmed', async () => {
    const failedPreBackup: AutoBackupResult = {
      ok: false,
      error: new Error('disk full'),
    };

    await expect(
      replaceRestore(db, emptyBackup(), { preRestoreBackup: failedPreBackup }),
    ).rejects.toBeInstanceOf(PreRestoreBackupFailedError);

    // DB unchanged: only the schema_migration entry from beforeEach.
    const audits = await db.auditLog.toArray();
    expect(audits.some((a) => a.action === 'backup_restored')).toBe(false);
  });

  it('proceeds when pre-restore failed but caller passes confirmedWithoutPreBackup:true', async () => {
    const failedPreBackup: AutoBackupResult = {
      ok: false,
      error: new Error('disk full'),
    };
    await replaceRestore(db, emptyBackup(), {
      preRestoreBackup: failedPreBackup,
      confirmedWithoutPreBackup: true,
    });
    const audits = await db.auditLog
      .where('action')
      .equals('backup_restored')
      .toArray();
    expect(audits).toHaveLength(1);
  });

  it('keeps the database unchanged when the transaction throws', async () => {
    const holdingsRepo = createHoldingsRepo(db);
    const created = await holdingsRepo.create(sampleHolding);

    // Build a backup whose holdings array contains a duplicate id.
    // bulkPut tolerates duplicates by overwriting, so to force a real
    // failure we feed the DB.holdings store an object missing its
    // primary key. Dexie raises and the transaction rolls back.
    const corruptHolding = { ...created, id: undefined } as unknown as typeof created;
    const backup = emptyBackup({
      holdings: [corruptHolding],
    });

    await expect(
      replaceRestore(db, backup, { preRestoreBackup: okPreRestoreBackup }),
    ).rejects.toBeDefined();

    // Pre-existing holding is still there because the transaction
    // rolled back.
    const stillThere = await db.holdings.get(created.id);
    expect(stillThere).toBeDefined();
  });
});
