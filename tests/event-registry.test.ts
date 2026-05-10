// PR 32 — pin every event-name string in the registry. Renaming
// any of these is a public-API change (browser DevTools, Tauri-side
// listeners, future integration tests listen for these names) and
// requires an explicit operator decision.

import { describe, expect, it } from 'vitest';

import {
  DIALOG_SUBMITTED_EVENT,
  IMAGE_LOAD_ERROR_EVENT,
  SETTINGS_CHANGED_EVENT,
  SYNC_STATUS_CHANGED_EVENT,
  USER_DATA_CHANGED_EVENT,
} from '../src/domain/events';

describe('event registry — exact literal pins', () => {
  it('USER_DATA_CHANGED_EVENT is pokemon:user-data-changed', () => {
    expect(USER_DATA_CHANGED_EVENT).toBe('pokemon:user-data-changed');
  });

  it('SYNC_STATUS_CHANGED_EVENT is pokemon:sync-status-changed', () => {
    expect(SYNC_STATUS_CHANGED_EVENT).toBe('pokemon:sync-status-changed');
  });

  it('SETTINGS_CHANGED_EVENT is pokemon:settings-changed', () => {
    expect(SETTINGS_CHANGED_EVENT).toBe('pokemon:settings-changed');
  });

  it('IMAGE_LOAD_ERROR_EVENT is pokemon:image-load-error', () => {
    expect(IMAGE_LOAD_ERROR_EVENT).toBe('pokemon:image-load-error');
  });

  it('DIALOG_SUBMITTED_EVENT is dialog:submitted', () => {
    expect(DIALOG_SUBMITTED_EVENT).toBe('dialog:submitted');
  });
});

describe('event registry — re-export shims', () => {
  it('components/events re-exports USER_DATA_CHANGED_EVENT identically', async () => {
    const fromShim = await import('../src/components/events');
    expect(fromShim.USER_DATA_CHANGED_EVENT).toBe(USER_DATA_CHANGED_EVENT);
  });

  it('components/dialog re-exports DIALOG_SUBMITTED_EVENT identically', async () => {
    const fromShim = await import('../src/components/dialog');
    expect(fromShim.DIALOG_SUBMITTED_EVENT).toBe(DIALOG_SUBMITTED_EVENT);
  });

  it('views/settings re-exports SYNC_STATUS_CHANGED_EVENT and SETTINGS_CHANGED_EVENT identically', async () => {
    const fromShim = await import('../src/views/settings');
    expect(fromShim.SYNC_STATUS_CHANGED_EVENT).toBe(SYNC_STATUS_CHANGED_EVENT);
    expect(fromShim.SETTINGS_CHANGED_EVENT).toBe(SETTINGS_CHANGED_EVENT);
  });
});
