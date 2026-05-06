// Vitest setup file. Runs once per test file.
//
// Polyfill IndexedDB so Dexie can be exercised in the Node test environment
// without spinning up a real browser. fake-indexeddb/auto installs both
// `indexedDB` and `IDBKeyRange` on the global object as side effects.
import 'fake-indexeddb/auto';
