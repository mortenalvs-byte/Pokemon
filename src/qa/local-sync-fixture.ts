// PR 28 review patch (Phase 4) — local-sync-fixture importer.
//
// What it does
// ------------
// Reads a JSON blob shaped like one of:
//   1. App-normalized: { sets: SetRecord[], cards: CardRecord[] }
//   2. Backup file:    { schemaVersion, sets, cards, ... } (extra
//                      keys ignored — only sets/cards consumed)
//   3. pokemontcg.io DTO dump: { data: PokemonTcgCardDto[] } (single
//                      endpoint paste — sets unknown, derived from
//                      the union of cards' setIds when possible)
// …and rewrites the cards/sets cache exactly the way `syncCardDatabase`
// does: one atomic `rw` transaction over [sets, cards, appMeta,
// auditLog], with the same lastSyncAt / lastSyncStatus / lastSyncError
// metadata plus a fresh `lastSyncSource = 'local_fixture'` key and an
// audit row tagged `local_fixture_import`. After commit it invalidates
// the in-memory card/set caches so the next view paint reads through.
//
// What it does NOT do
// -------------------
//   - touch holdings, binders, binderSlots, lots, lotItems, wishlist
//   - touch settings (so PR 27 prefs survive)
//   - run the API client / hit the network
//   - introduce a new IndexedDB store
//   - introduce a schema migration
//
// The importer is dev-only. It is imported only by `src/views/qa.ts`
// and the boot-time auto-trigger in `src/main.ts`, both of which are
// tree-shaken from production via `import.meta.env.DEV`.

import { mapApiCard, type PokemonTcgCardDto } from '../api/types';
import { invalidateCardCache, invalidateSetCache } from '../db/cards-cache';
import type { PokemonTrackerDB } from '../db/database';
import {
  APP_META_KEYS,
  type AppMetaRecord,
  type CardRecord,
  type SetRecord,
} from '../domain/types';
import { nowIso } from '../utils/dates';
import { newId } from '../utils/ids';

export const LOCAL_FIXTURE_AUDIT_ACTION = 'local_fixture_import';
export const LOCAL_FIXTURE_SOURCE_VALUE = 'local_fixture';

export interface LocalSyncFixtureSource {
  readonly description: string;
  readonly sets: ReadonlyArray<SetRecord>;
  readonly cards: ReadonlyArray<CardRecord>;
}

export interface LocalSyncFixtureImportResult {
  readonly ok: true;
  readonly setsCount: number;
  readonly cardsCount: number;
  readonly cardsWithImageSmall: number;
  readonly cardsWithImageLarge: number;
  readonly cardsMissingBoth: number;
  readonly elapsedMs: number;
  readonly description: string;
}

export interface LocalSyncFixtureImportFailure {
  readonly ok: false;
  readonly error: string;
}

export type LocalSyncFixtureImportOutcome =
  | LocalSyncFixtureImportResult
  | LocalSyncFixtureImportFailure;

// ---------------------------------------------------------------------
// Parsers — accept the three documented input shapes.

interface AppNormalized {
  readonly sets?: ReadonlyArray<SetRecord>;
  readonly cards?: ReadonlyArray<CardRecord>;
}

interface DtoDump {
  readonly data?: ReadonlyArray<PokemonTcgCardDto>;
}

/**
 * Coerce one of the three documented JSON shapes into the
 * app-normalized `{ sets, cards }` pair the importer writes. Throws
 * a descriptive error if the input is none of the three.
 */
export function parseLocalSyncFixture(
  raw: unknown,
  description = 'fixture',
): LocalSyncFixtureSource {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(
      'fixture must be a JSON object with `sets`/`cards` or a `data` DTO array',
    );
  }
  const obj = raw as AppNormalized & DtoDump;

  // App-normalized or backup shape (we ignore the extra fields that a
  // backup carries — holdings, binders, etc. are intentionally not
  // imported here).
  if (Array.isArray(obj.cards) && Array.isArray(obj.sets)) {
    return {
      description,
      sets: obj.sets as ReadonlyArray<SetRecord>,
      cards: obj.cards as ReadonlyArray<CardRecord>,
    };
  }

  // Raw pokemontcg.io DTO dump (the `/cards` endpoint shape).
  if (Array.isArray(obj.data)) {
    const cards = obj.data
      .map((dto) => {
        try {
          return mapApiCard(dto);
        } catch {
          return null;
        }
      })
      .filter((c): c is CardRecord => c !== null);
    // Derive a minimal set list from the cards' setIds. Fields we
    // can't infer are filled with safe placeholders so the
    // existing `Browse` view doesn't crash on missing names.
    const setIds = new Set<string>();
    for (const card of cards) setIds.add(card.setId);
    const sets: SetRecord[] = Array.from(setIds).map((id) => ({
      id,
      name: id,
      series: 'fixture',
      printedTotal: cards.filter((c) => c.setId === id).length,
      total: cards.filter((c) => c.setId === id).length,
      releaseDate: '1970-01-01',
      symbolUrl: null,
      logoUrl: null,
      updatedAt: nowIso(),
    }));
    return { description, sets, cards };
  }

  throw new Error(
    'fixture must contain either `sets`+`cards` arrays or a `data` array of DTOs',
  );
}

// ---------------------------------------------------------------------
// Importer — atomic cache rewrite, mirrors `syncCardDatabase`.

/**
 * Rewrite the cards/sets cache from an in-memory fixture and record
 * the import in `appMeta` + `auditLog`. The transaction shape mirrors
 * the real sync's so the dashboard / browse views can't tell which
 * source ran.
 */
export async function importLocalSyncFixture(
  db: PokemonTrackerDB,
  source: LocalSyncFixtureSource,
): Promise<LocalSyncFixtureImportOutcome> {
  const startedAt = Date.now();
  try {
    const committedAt = nowIso();
    const cards = source.cards;
    const sets = source.sets;

    let cardsWithImageSmall = 0;
    let cardsWithImageLarge = 0;
    let cardsMissingBoth = 0;
    for (const card of cards) {
      const small = typeof card.imageSmall === 'string' && card.imageSmall.length > 0;
      const large = typeof card.imageLarge === 'string' && card.imageLarge.length > 0;
      if (small) cardsWithImageSmall += 1;
      if (large) cardsWithImageLarge += 1;
      if (!small && !large) cardsMissingBoth += 1;
    }

    await db.transaction(
      'rw',
      [db.sets, db.cards, db.appMeta, db.auditLog],
      async () => {
        await db.sets.clear();
        if (sets.length > 0) await db.sets.bulkPut(sets as SetRecord[]);
        await db.cards.clear();
        if (cards.length > 0) await db.cards.bulkPut(cards as CardRecord[]);

        await putAppMeta(db, APP_META_KEYS.lastSyncAt, committedAt, committedAt);
        await putAppMeta(
          db,
          APP_META_KEYS.lastSyncStatus,
          'ok',
          committedAt,
        );
        await putAppMeta(db, APP_META_KEYS.lastSyncError, null, committedAt);
        await putAppMeta(
          db,
          APP_META_KEYS.lastSyncSource,
          LOCAL_FIXTURE_SOURCE_VALUE,
          committedAt,
        );

        await db.auditLog.add({
          id: newId(),
          action: LOCAL_FIXTURE_AUDIT_ACTION,
          entityType: 'system',
          entityId: null,
          message: `imported ${sets.length} sets, ${cards.length} cards from ${source.description}`,
          createdAt: committedAt,
        });
      },
    );

    invalidateCardCache(db);
    invalidateSetCache(db);

    return {
      ok: true,
      setsCount: sets.length,
      cardsCount: cards.length,
      cardsWithImageSmall,
      cardsWithImageLarge,
      cardsMissingBoth,
      elapsedMs: Date.now() - startedAt,
      description: source.description,
    };
  } catch (caught) {
    return {
      ok: false,
      error: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

// ---------------------------------------------------------------------
// Helpers

async function putAppMeta(
  db: PokemonTrackerDB,
  key: string,
  value: unknown,
  updatedAt: string,
): Promise<void> {
  const record: AppMetaRecord = { key, value, updatedAt };
  await db.appMeta.put(record);
}
