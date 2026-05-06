// `navigator.storage.persist()` reduces the chance the browser evicts the
// database under storage pressure. The request is best-effort: it must
// never throw out of `requestPersistentStorage()` and must never block app
// startup. Persistent storage is *additional* to backup/restore, never a
// substitute (see KRAVSPEC §11).

export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const storage = navigator.storage;
  if (!storage || typeof storage.persist !== 'function') {
    return false;
  }
  try {
    return await storage.persist();
  } catch {
    return false;
  }
}

export async function isStoragePersistent(): Promise<boolean> {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const storage = navigator.storage;
  if (!storage || typeof storage.persisted !== 'function') {
    return false;
  }
  try {
    return await storage.persisted();
  } catch {
    return false;
  }
}
