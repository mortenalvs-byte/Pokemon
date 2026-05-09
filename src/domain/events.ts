// PR 32 — central registry of every custom event name dispatched
// or listened-for in the app.
//
// Every dispatcher and every listener imports from here so the
// strings have one source of truth. The actual values are
// **byte-identical to PR 31** (no `pokemon:*` rename, no
// `dialog:*` rename) — backwards-compatible with any external
// tooling (browser DevTools, Tauri-side listeners, future
// integration tests) that listens for these names on `window`
// or a host element.
//
// Existing import paths (`src/components/events.ts`,
// `src/components/dialog.ts`, `src/views/settings.ts`) re-export
// from this file so consumers do not need to change their import
// path. New code SHOULD import from `src/domain/events.ts`
// directly.
//
// This module is safe to ship in the production bundle — every
// event name here is dispatched by production-runtime code paths
// (lazy-image, dialog, settings save, etc.). Dev-only keys live
// in `src/domain/storage-keys.ts` instead, which is only reached
// through dev-only import chains.

/**
 * Cross-cutting "user-owned data changed" notification. Dispatched
 * on `window` after any view writes to holdings/binders/lots/
 * wishlist. Listeners refresh their cached snapshot.
 */
export const USER_DATA_CHANGED_EVENT = 'pokemon:user-data-changed';

/**
 * Settings view fires this on `window` after a successful sync
 * attempt (success or failure). The topbar status chip listens.
 */
export const SYNC_STATUS_CHANGED_EVENT = 'pokemon:sync-status-changed';

/**
 * Settings view fires this on `window` after a successful personal
 * preferences save. The shell re-applies brand text + shortcut-help
 * button visibility without remounting the app.
 */
export const SETTINGS_CHANGED_EVENT = 'pokemon:settings-changed';

/**
 * `createLazyImage` dispatches this on `window` from its
 * `<img onerror>` handler. The dev-only image audit module
 * listens to summarise broken images across a route walk.
 *
 * The event is dispatched from production code by design —
 * `createLazyImage` runs in production, the audit listener does
 * not. Tested by `tests/qa-route-prod-gating.test.ts` (the
 * audit listener identifier is banned; the event name is not).
 */
export const IMAGE_LOAD_ERROR_EVENT = 'pokemon:image-load-error';

/**
 * Dispatched by inner forms inside `<dialog>` when the form
 * submits successfully. `openDialog()` listens and resolves with
 * the form's payload. Used by holding-form, wishlist-form,
 * binder-form, lot-form, lot-item-form, slot-direct-add-form,
 * slot-action-menu, assign-holding-modal, binder-from-set-wizard,
 * wishlist-receive-prompt, and the master-gap recommended-placement
 * dialog.
 */
export const DIALOG_SUBMITTED_EVENT = 'dialog:submitted';
