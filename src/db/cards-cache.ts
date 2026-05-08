// PR 21 — per-DB cache for the two replaceable API caches: `cards` and
// `sets`. The QA stress run measured ~1 s for `cardsRepo.list()` on a
// 20 237-card cache, and that single read dominated every cold view
// mount (binder detail, browse, collection, lot-detail, card-detail).
// Caching it here turns subsequent mounts into ~10 ms operations.
//
// Keying:
//   The cache is a `WeakMap<PokemonTrackerDB, Promise<list>>`. The
//   key is the live Dexie instance, so `freshDb()` in tests gets its
//   own cache automatically — no cross-test pollution.
//   `_resetDbSingletonForTests()` discards its singleton; the next
//   `getDb()` returns a new instance with no cache, also automatic.
//
// In-flight memoisation:
//   We cache the Promise itself, not the resolved array. Two parallel
//   first-time callers therefore share ONE `db.cards.toArray()` —
//   Dexie's busy-table cost is paid once.
//
// Failure handling:
//   If the read rejects, the rejection still flows back to the
//   awaiter, but we evict the cache entry so a retry on the next call
//   gets a fresh attempt instead of a permanently-bad Promise.
//
// Mutation contract:
//   The cached arrays are read-only by convention. Browse / collection
//   / wishlist / binder-slot services either never mutate or copy via
//   `.slice()` / `.map()` / `[...arr]` before sorting. The repos
//   historically returned a fresh array per call (`db.cards.toArray()`
//   makes a new one), so existing callers were never relying on
//   exclusive ownership. Treat the cached array as `readonly` from
//   this point forward.
//
// Invalidation contract:
//   - `cardsRepo.upsert / upsertMany / clear` invalidate the cards
//     cache after the write completes. Same for `setsRepo.*`.
//     Repo callers therefore see their own writes on the very next
//     `list()` — the read/write consistency you'd expect from any
//     repo.
//   - `db/sync.ts` writes to `db.cards` / `db.sets` directly inside
//     a single atomic rw-transaction (clear + bulkPut), bypassing
//     the repo. It calls `invalidateCardCache(db)` /
//     `invalidateSetCache(db)` after the transaction commits.
//   - `db/restore.ts` does the same for the replace-restore
//     transaction.
//   - Any future module that writes directly to `db.cards` /
//     `db.sets` (not via the repo) MUST call the corresponding
//     invalidator after the write commits. Going through the repo
//     does this for you.

import type { CardRecord, SetRecord } from '../domain/types';
import type { PokemonTrackerDB } from './database';

const cardListCache = new WeakMap<
  PokemonTrackerDB,
  Promise<CardRecord[]>
>();
const setListCache = new WeakMap<
  PokemonTrackerDB,
  Promise<SetRecord[]>
>();

export function getCachedCardList(
  db: PokemonTrackerDB,
): Promise<CardRecord[]> {
  let cached = cardListCache.get(db);
  if (cached === undefined) {
    cached = db.cards.toArray().catch((error: unknown) => {
      // Evict so the next call retries a fresh fetch instead of
      // reusing a permanently-rejected Promise.
      cardListCache.delete(db);
      throw error;
    });
    cardListCache.set(db, cached);
  }
  return cached;
}

export function getCachedSetList(
  db: PokemonTrackerDB,
): Promise<SetRecord[]> {
  let cached = setListCache.get(db);
  if (cached === undefined) {
    cached = db.sets.toArray().catch((error: unknown) => {
      setListCache.delete(db);
      throw error;
    });
    setListCache.set(db, cached);
  }
  return cached;
}

export function invalidateCardCache(db: PokemonTrackerDB): void {
  cardListCache.delete(db);
}

export function invalidateSetCache(db: PokemonTrackerDB): void {
  setListCache.delete(db);
}
