// PR 15A — F-3 regression test.
//
// Before this PR, every view's `mountX(container)` registered a
// `window.addEventListener(USER_DATA_CHANGED_EVENT, …)` and never
// removed it. Because all views share the same `<main>` container,
// dispatching USER_DATA_CHANGED_EVENT after a route change caused the
// PREVIOUS view's handler to re-render its content into the container
// the NEW view had just taken over. Visible to the user as `#lots`
// suddenly showing the card-detail "Ingen kort valgt" placeholder
// after saving a lot.
//
// The fix: the router (`src/app.ts` `renderActiveView`) creates a
// fresh `AbortController` per mount and aborts the previous one before
// the next mount. Each view accepts the signal and passes it to
// `onUserDataChanged(handler, signal)`. When the signal is aborted the
// listener is removed — the previous view can no longer touch the DOM.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mountBindersView } from '../src/views/binders';
import { mountLotsView } from '../src/views/lots';
import { mountCardDetailView } from '../src/views/card-detail';
import { _resetDbSingletonForTests, getDb } from '../src/db/database';
import { initializeDataLayer } from '../src/db/init';
import { USER_DATA_CHANGED_EVENT } from '../src/components/events';
import { closeAndDelete } from './helpers/fresh-db';
import type { PokemonTrackerDB } from '../src/db/database';

async function settle(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('view mount teardown (PR 15A — F-3)', () => {
  let db: PokemonTrackerDB;

  beforeEach(async () => {
    document.body.innerHTML = '<div id="content"></div>';
    _resetDbSingletonForTests();
    db = getDb();
    await initializeDataLayer({ db, skipPersistentStorage: true });
    window.location.hash = '';
  });

  afterEach(async () => {
    document.body.innerHTML = '';
    await closeAndDelete(db);
    _resetDbSingletonForTests();
    window.location.hash = '';
  });

  it('aborted-signal mount: previous view does not re-render after USER_DATA_CHANGED_EVENT', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');

    // Mount 1: binders list with a signal we will abort.
    const firstController = new AbortController();
    mountBindersView(root, firstController.signal);
    await settle();
    // Sanity: binders' empty state ("Ingen permer ennå…") is rendered.
    expect(root.querySelector('.binders-view__empty')).not.toBeNull();

    // Simulate the router's behaviour on route change: abort the
    // previous controller, clear the container, mount the next view.
    firstController.abort();
    root.innerHTML = '';
    const secondController = new AbortController();
    mountLotsView(root, secondController.signal);
    await settle();
    // Sanity: lots view rendered.
    expect(root.querySelector('.lots-view')).not.toBeNull();
    const lotsViewMarker = root.querySelector('.lots-view');

    // Now fire USER_DATA_CHANGED_EVENT. Before the F-3 fix, the binders
    // view's leaked listener would call its `rerender(container)` and
    // wipe the lots view out of the container. After the fix, the
    // aborted signal has already removed that listener.
    window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
    await settle();

    // The lots view should still be in place. The binders view's
    // `.binders-view__empty` should NOT have been re-injected.
    expect(root.querySelector('.lots-view')).toBe(lotsViewMarker);
    expect(root.querySelector('.binders-view__empty')).toBeNull();
    // The container's primary section is the lots view, not binders.
    expect(root.querySelector('section.binders-view')).toBeNull();
  });

  it('card-detail mount with aborted signal does not flip a different route', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');

    // Pretend the user was on card-detail for some card id.
    window.location.hash = '#card/test-card-id';
    const firstController = new AbortController();
    mountCardDetailView(root, firstController.signal);
    await settle();

    // Now navigate away — abort the controller, mount lots.
    firstController.abort();
    window.location.hash = '#lots';
    root.innerHTML = '';
    const secondController = new AbortController();
    mountLotsView(root, secondController.signal);
    await settle();

    expect(root.querySelector('.lots-view')).not.toBeNull();

    // Fire USER_DATA_CHANGED_EVENT. The pre-fix bug was that
    // card-detail's listener fired and rendered card-detail's empty
    // state ("Ingen kort valgt. Velg et kort fra Browse…") into the
    // container even though hash is now `#lots`.
    window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
    await settle();

    expect(root.querySelector('.lots-view')).not.toBeNull();
    expect(root.querySelector('.card-detail-view')).toBeNull();
    expect(root.textContent).not.toMatch(/Ingen kort valgt/);
  });

  it('non-aborted signal: handler still fires (positive control)', async () => {
    const root = document.getElementById('content');
    if (!root) throw new Error('test bootstrap failed');

    const liveController = new AbortController();
    mountBindersView(root, liveController.signal);
    await settle();

    // No abort. The handler should still re-render when the event
    // fires — proves the handler is wired, not just that the test is
    // accidentally always passing.
    expect(root.querySelector('.binders-view__empty')).not.toBeNull();
    const empty1 = root.querySelector('.binders-view__empty');

    window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
    await settle();

    // After the event, the view re-renders. The empty-state element is
    // a fresh node (not the same identity as before).
    const empty2 = root.querySelector('.binders-view__empty');
    expect(empty2).not.toBeNull();
    expect(empty2).not.toBe(empty1);
  });
});
