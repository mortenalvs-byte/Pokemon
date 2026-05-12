// Sync orchestrator. Owns the fetch-all-first-then-write-once contract
// the user asked for in PR 5:
//
//   1. Fetch every set and every card into memory.
//   2. Only after every fetch succeeded, open ONE Dexie rw transaction
//      over [sets, cards, appMeta, auditLog]. Inside the transaction:
//      clear sets, bulkPut new sets, clear cards, bulkPut new cards,
//      update appMeta (lastSyncAt + lastSyncStatus = "ok"), clear
//      lastSyncError, append exactly one `sync_run` audit row.
//   3. On any failure during fetch, open a small rw transaction over
//      [appMeta, auditLog] only. Write lastSyncStatus = "failed",
//      sanitized lastSyncError, and exactly one `sync_failed` audit
//      row. Cache and user-owned stores are untouched.
//
// The orchestrator never reads or writes `settings`, `holdings`,
// `binders`, `binderSlots`, `lots`, `lotItems`, or `wishlist`. It also
// never logs the API key — the API client already sanitizes errors
// from the network layer; we sanitize again here on every error path
// for defence in depth.

import {
  createApiClient,
  type FetchProgress,
  type PokemonTcgApi,
} from '../api/pokemon-tcg-api';
import { sanitizeErrorMessage } from '../api/sanitize';
import { type FetchLike, type SleepFn } from '../api/retry';
import { invalidateCardCache, invalidateSetCache } from './cards-cache';
import { nowIso } from '../utils/dates';
import { newId } from '../utils/ids';
import {
  APP_META_KEYS,
  type AppMetaRecord,
  type CardRecord,
  type SetRecord,
  type SyncOrphansSnapshot,
} from '../domain/types';
import type { PokemonTrackerDB } from './database';

export interface SyncOptions {
  readonly db: PokemonTrackerDB;
  readonly apiKey?: string | null;
  readonly fetchImpl?: FetchLike;
  readonly sleep?: SleepFn;
  /**
   * Optional pre-built API client. Useful for tests that want to drive
   * a fully stubbed client without exercising the retry/fetch chain.
   * When absent, an internal client is built from {apiKey, fetchImpl,
   * sleep}.
   */
  readonly apiClient?: PokemonTcgApi;
  readonly onProgress?: (progress: FetchProgress) => void;
}

export interface SyncSuccess {
  readonly ok: true;
  readonly setsCount: number;
  readonly cardsCount: number;
  readonly durationMs: number;
}

export interface SyncFailure {
  readonly ok: false;
  readonly error: string;
}

export type SyncResult = SyncSuccess | SyncFailure;

export async function syncCardDatabase(
  options: SyncOptions,
): Promise<SyncResult> {
  const { db } = options;
  const apiKey = options.apiKey ?? null;
  const startedAt = Date.now();

  const apiClient =
    options.apiClient ??
    createApiClient({
      apiKey,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    });

  let allSets: SetRecord[];
  const allCards: CardRecord[] = [];

  try {
    allSets = await apiClient.fetchAllSets((progress) => {
      options.onProgress?.(progress);
    });

    for (const set of allSets) {
      const cards = await apiClient.fetchAllCardsForSet(set.id, (progress) => {
        options.onProgress?.(progress);
      });
      allCards.push(...cards);
    }
  } catch (caught) {
    // Fetch path failed. Cache and user data are untouched (we have
    // not opened any rw transaction over them). Record the failure
    // metadata, append one sync_failed audit, return.
    const sanitized = sanitizeErrorMessage(caught, apiKey);
    await recordSyncFailure(db, sanitized);
    return { ok: false, error: sanitized };
  }

  // All fetches succeeded. Commit cache + status atomically.
  const committedAt = nowIso();
  try {
    await db.transaction(
      'rw',
      [db.sets, db.cards, db.appMeta, db.auditLog],
      async () => {
        await db.sets.clear();
        if (allSets.length > 0) {
          await db.sets.bulkPut(allSets);
        }
        await db.cards.clear();
        if (allCards.length > 0) {
          await db.cards.bulkPut(allCards);
        }

        await putAppMeta(db, APP_META_KEYS.lastSyncAt, committedAt, committedAt);
        await putAppMeta(
          db,
          APP_META_KEYS.lastSyncStatus,
          'ok',
          committedAt,
        );
        await putAppMeta(db, APP_META_KEYS.lastSyncError, null, committedAt);
        // PR 28 review patch (Phase 4) — record that this run came
        // from the real pokemontcg.io endpoint, not a local fixture
        // import. The local-fixture importer writes the same key
        // with `'local_fixture'`.
        await putAppMeta(
          db,
          APP_META_KEYS.lastSyncSource,
          'pokemon_tcg_api',
          committedAt,
        );

        // PR 28 review patch — record the API mode in the audit
        // message so QA can confirm a public-tier sync without
        // having to read app state. Authenticated runs say
        // "(authenticated)"; unauthenticated say "(public API,
        // no key)".
        const modeNote =
          apiKey !== null && apiKey.length > 0
            ? '(authenticated)'
            : '(public API, no key)';
        await db.auditLog.add({
          id: newId(),
          action: 'sync_run',
          entityType: 'system',
          entityId: null,
          message: `synced ${allSets.length} sets, ${allCards.length} cards ${modeNote}`,
          createdAt: committedAt,
        });
      },
    );
  } catch (caught) {
    // The commit itself failed (rare: storage quota, etc.). Treat as
    // a failed sync — but the rw-transaction over sets/cards/appMeta/
    // auditLog has rolled back, so cache is untouched. We still need
    // to record the failure on its own.
    const sanitized = sanitizeErrorMessage(caught, apiKey);
    await recordSyncFailure(db, sanitized);
    return { ok: false, error: sanitized };
  }

  // PR 21 — the in-memory `cards` and `sets` caches must be evicted
  // after a successful sync rewrite. Repos read through these caches
  // for the 20 k-card list calls; without invalidation, every view
  // mounted before the next page reload would still see the previous
  // generation of cards.
  invalidateCardCache(db);
  invalidateSetCache(db);

  // Phase-2 Plan B — orphan-card safety net. After the cache rewrite
  // commits, scan user-data stores for cardId references that point to
  // cards that no longer exist upstream (rare but real: cards retired
  // from the Pokemon TCG API between syncs). The scan is BEST-EFFORT:
  // failures here never fail the sync as a whole, because the cache
  // rewrite already committed and the user-data stores were not
  // touched. Result is summarised in `appMeta.lastSyncOrphans` for the
  // dashboard to surface; the orphan rows themselves remain untouched
  // (sync NEVER writes user-owned data per the existing contract).
  try {
    await runOrphanDetection(db, allCards, committedAt);
  } catch { /* best-effort */ }

  return {
    ok: true,
    setsCount: allSets.length,
    cardsCount: allCards.length,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Phase-2 Plan B — Scan every user-data store with a direct `cardId`
 * column for references missing from the freshly-synced `cards` set.
 * Writes `appMeta.lastSyncOrphans` + (when count > 0) one audit row.
 *
 * READ-ONLY on user-data. The orphan rows stay in their respective
 * stores so the operator can decide what to do (keep, move to a lot,
 * soft-delete).
 *
 * Stores covered:
 *   - holdings.cardId
 *   - wishlist.cardId
 *   - lotItems.cardId
 *   - binderSlots.targetCardId (non-null only)
 *
 * The `binderSlots.holdingId` chain is covered indirectly via the
 * holdings scan: a slot's holding has its own `cardId` and that's the
 * one that becomes orphan.
 */
async function runOrphanDetection(
  db: PokemonTrackerDB,
  freshCards: readonly CardRecord[],
  detectedAt: string,
): Promise<void> {
  const freshIds = new Set<string>();
  for (const c of freshCards) freshIds.add(c.id);

  const orphanIds = new Set<string>();
  const consider = (id: string | null | undefined): void => {
    if (typeof id === 'string' && id.length > 0 && !freshIds.has(id)) {
      orphanIds.add(id);
    }
  };

  // Live rows only — soft-deleted user data shouldn't drive the
  // dashboard signal, and the operator already chose to discard them.
  const [holdings, wishlist, lotItems, binderSlots] = await Promise.all([
    db.holdings.toArray(),
    db.wishlist.toArray(),
    db.lotItems.toArray(),
    db.binderSlots.toArray(),
  ]);
  for (const h of holdings) if (h.deletedAt === null) consider(h.cardId);
  for (const w of wishlist) if (w.deletedAt === null) consider(w.cardId);
  for (const li of lotItems) if (li.deletedAt === null) consider(li.cardId);
  for (const s of binderSlots) if (s.deletedAt === null) consider(s.targetCardId);

  const sorted = Array.from(orphanIds).sort();
  const snapshot: SyncOrphansSnapshot = {
    detectedAt,
    count: sorted.length,
    sampleIds: sorted.slice(0, 10),
  };

  await db.transaction('rw', [db.appMeta, db.auditLog], async () => {
    await putAppMeta(
      db,
      APP_META_KEYS.lastSyncOrphans,
      snapshot,
      detectedAt,
    );
    if (sorted.length > 0) {
      const head = sorted.slice(0, 10).join(', ');
      await db.auditLog.add({
        id: newId(),
        action: 'sync_orphans_detected',
        entityType: 'system',
        entityId: null,
        message:
          `${sorted.length} orphan cardId(s) after sync — first 10: ${head}` +
          (sorted.length > 10 ? ' …' : ''),
        createdAt: detectedAt,
      });
    }
  });
}

async function recordSyncFailure(
  db: PokemonTrackerDB,
  sanitizedMessage: string,
): Promise<void> {
  const at = nowIso();
  await db.transaction('rw', [db.appMeta, db.auditLog], async () => {
    await putAppMeta(db, APP_META_KEYS.lastSyncStatus, 'failed', at);
    await putAppMeta(db, APP_META_KEYS.lastSyncError, sanitizedMessage, at);
    await db.auditLog.add({
      id: newId(),
      action: 'sync_failed',
      entityType: 'system',
      entityId: null,
      message: sanitizedMessage,
      createdAt: at,
    });
  });
}

async function putAppMeta(
  db: PokemonTrackerDB,
  key: string,
  value: unknown,
  updatedAt: string,
): Promise<void> {
  const record: AppMetaRecord = { key, value, updatedAt };
  await db.appMeta.put(record);
}
