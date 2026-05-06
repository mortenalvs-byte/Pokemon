// Key/value store for user preferences and the local API key. Settings
// are sacred user data, so the public surface only allows reads, writes,
// and listing — no generic `delete(key)` is exposed in MVP. If a future
// PR needs to clear a specific setting (e.g. "forget API key"), it must
// add a narrow, explicitly-named method or rely on PR 4's restore logic.
//
// The API key must never be logged (KRAVSPEC §11), so this module avoids
// any console output even on error paths. Audit entries record that a
// key changed, but never the value.

import { nowIso } from '../utils/dates';
import type { SettingsKey, SettingsRecord } from '../domain/types';
import { SETTINGS_KEYS } from '../domain/types';
import { appendAudit } from '../db/audit';
import type { PokemonTrackerDB } from '../db/database';

export interface SettingsRepo {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  all(): Promise<SettingsRecord[]>;
}

export function createSettingsRepo(db: PokemonTrackerDB): SettingsRepo {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const row = await db.settings.get(key);
      return row?.value as T | undefined;
    },

    async set(key, value) {
      const record: SettingsRecord = {
        key,
        value,
        updatedAt: nowIso(),
      };
      await db.settings.put(record);
      await appendAudit(db, {
        action: keyToAction(key),
        entityType: 'settings',
        entityId: key,
        message: redactedAuditMessage(key),
      });
    },

    async all() {
      return db.settings.toArray();
    },
  };
}

function keyToAction(key: string): string {
  if (key === SETTINGS_KEYS.pokemonTcgApiKey) {
    return 'api_key_changed';
  }
  return 'setting_changed';
}

function redactedAuditMessage(key: string): string {
  // Never include the value: especially for `pokemonTcgApiKey`. Keys
  // themselves are safe to log (they appear in the source code).
  if (key === SETTINGS_KEYS.pokemonTcgApiKey) {
    return 'pokemontcg.io API key updated (value redacted)';
  }
  return `setting "${key}" changed`;
}

export type { SettingsKey };
