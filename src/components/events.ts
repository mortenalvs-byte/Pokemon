// Cross-cutting custom events. Dispatched on `window` so any view that
// renders user-data-derived state (Browse rows, Card Detail "Dine kort"
// section, the Collection view itself) can refresh without a global
// store. Same pattern as `pokemon:sync-status-changed` in the Settings
// view — small, native, no dependencies.

export const USER_DATA_CHANGED_EVENT = 'pokemon:user-data-changed';

/**
 * Register a handler for `USER_DATA_CHANGED_EVENT` that the router can
 * tear down by aborting `signal` (PR 15A — F-3 fix). When `signal` is
 * undefined the listener stays alive for the lifetime of the page —
 * acceptable in tests that recreate the DOM per test, but in the
 * running app `app.ts` always passes a signal that aborts on the next
 * route change.
 *
 * The dance with `signal !== undefined ? { signal } : undefined` is
 * required by TypeScript's `exactOptionalPropertyTypes`: passing
 * `{ signal: undefined }` is a different type than passing nothing.
 */
export function onUserDataChanged(
  handler: () => void,
  signal?: AbortSignal,
): void {
  if (signal !== undefined) {
    window.addEventListener(USER_DATA_CHANGED_EVENT, handler, { signal });
  } else {
    window.addEventListener(USER_DATA_CHANGED_EVENT, handler);
  }
}
