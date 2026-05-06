// Fresh-DB helper for tests. Each call returns a Dexie instance bound to a
// new randomly-named IndexedDB so concurrent tests never share state, and
// so a leaked write in one test cannot affect another.

import { createDatabase } from '../../src/db/database';
import type { PokemonTrackerDB } from '../../src/db/database';

export async function freshDb(): Promise<PokemonTrackerDB> {
  const name = `test-${crypto.randomUUID()}`;
  const db = createDatabase(name);
  await db.open();
  return db;
}

export async function closeAndDelete(db: PokemonTrackerDB): Promise<void> {
  const name = db.name;
  db.close();
  // Dexie's static `delete` removes the underlying IndexedDB.
  const Dexie = (await import('dexie')).Dexie;
  await Dexie.delete(name);
}
