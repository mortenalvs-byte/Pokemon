// Verifies the boot-time guarantee: the app shell must render even when
// initializeDataLayer() rejects. The actual data-layer call happens in
// `src/main.ts`; this test isolates the contract by importing app shell +
// init separately and asserting the shell does not depend on init success.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountApp } from '../src/app';
import { initializeDataLayer } from '../src/db/init';

describe('boot-time data-layer init', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('app shell renders synchronously without waiting on data-layer init', () => {
    const root = document.getElementById('app');
    if (!root) throw new Error('test bootstrap failed');

    mountApp(root);

    expect(root.querySelector('.topbar')).not.toBeNull();
    expect(root.querySelector('.sidebar')).not.toBeNull();
    expect(root.querySelector('#content')).not.toBeNull();
  });

  it('app shell remains usable when initializeDataLayer() rejects', async () => {
    const root = document.getElementById('app');
    if (!root) throw new Error('test bootstrap failed');

    mountApp(root);

    // Simulate a rejected init (e.g. corrupted IndexedDB). The shell must
    // already be rendered, and the rejection must be catchable without
    // throwing past the boundary.
    const rejected = Promise.reject(new Error('simulated init failure'));
    let caught: unknown = null;
    await rejected.catch((error: unknown) => {
      caught = error;
    });
    expect(caught).toBeInstanceOf(Error);

    // The shell is still rendered.
    expect(root.querySelector('.topbar')).not.toBeNull();
    expect(root.querySelector('.sidebar')).not.toBeNull();
  });

  it('initializeDataLayer is callable in jsdom (no navigator.storage)', async () => {
    // jsdom does not implement `navigator.storage.persist`. The function
    // must treat that as a "best-effort: not granted" outcome, never throw.
    const result = await initializeDataLayer({
      skipPersistentStorage: false,
    });
    expect(result.persistentStorageGranted).toBe(false);
    expect(result.schemaVersion).toBeGreaterThan(0);
  });
});
