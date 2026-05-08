// PR 26 — desktop keyboard navigation. Single global keydown listener,
// Vim-style two-key sequences (`g d`, `g m`, etc.). Idempotent mount so
// a second `mountKeyboardShortcuts()` call (test harness re-mount,
// stale HMR) doesn't double-register the listener.
//
// Scope rules:
//   - We do NOT handle `Cmd/Ctrl+K` here. PR 23's global search owns
//     that. Adding it here would race the search component for the
//     same chord.
//   - We never dispatch synthetic events. We just read `keydown` and
//     call existing router helpers.
//   - We bail when the event target is an editable element or sits
//     inside a `[role="dialog"]` so typing in a wishlist form or the
//     assign-holding modal can't accidentally navigate.
//   - We bail when modifier keys (Ctrl / Meta / Alt) are held — those
//     keys belong to the browser / OS, not to our two-key sequences.
//
// Sequences:
//   g d → Dashboard
//   g b → Browse
//   g c → Collection
//   g p → Permer (binders)
//   g l → Lots
//   g w → Wishlist
//   g m → Master gap

import {
  navigate,
  navigateToMasterGap,
  type SidebarRoute,
} from '../router';

const PENDING_TIMEOUT_MS = 1200;

type SecondKey = 'd' | 'b' | 'c' | 'p' | 'l' | 'w' | 'm';

type SecondKeyHandler = () => void;

const SECOND_KEY_HANDLERS: Record<SecondKey, SecondKeyHandler> = {
  d: () => navigate('dashboard' satisfies SidebarRoute),
  b: () => navigate('browse' satisfies SidebarRoute),
  c: () => navigate('collection' satisfies SidebarRoute),
  p: () => navigate('binders' satisfies SidebarRoute),
  l: () => navigate('lots' satisfies SidebarRoute),
  w: () => navigate('wishlist' satisfies SidebarRoute),
  m: () => navigateToMasterGap(),
};

let listener: ((event: KeyboardEvent) => void) | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPrefix = false;

export function mountKeyboardShortcuts(): void {
  if (listener !== null) return;
  listener = handleKeyDown;
  window.addEventListener('keydown', listener);
}

/**
 * Test-only: drop the registered listener and clear pending state so
 * the next `mountKeyboardShortcuts()` starts from zero. Production
 * code never calls this — `mountKeyboardShortcuts()` runs once per
 * page load.
 */
export function resetKeyboardShortcutsForTests(): void {
  if (listener !== null) {
    window.removeEventListener('keydown', listener);
    listener = null;
  }
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  pendingPrefix = false;
}

function handleKeyDown(event: KeyboardEvent): void {
  if (shouldIgnoreEvent(event)) return;
  if (hasModifier(event)) return;

  if (event.key === 'Escape') {
    cancelPending();
    return;
  }

  if (!pendingPrefix) {
    if (event.key === 'g') {
      pendingPrefix = true;
      pendingTimer = setTimeout(cancelPending, PENDING_TIMEOUT_MS);
    }
    return;
  }

  // We have a pending `g`. Try to resolve a two-key sequence.
  const handler = SECOND_KEY_HANDLERS[event.key as SecondKey];
  cancelPending();
  if (handler !== undefined) {
    event.preventDefault();
    handler();
  }
  // Unknown second key → swallow the pending state silently. We do
  // not navigate, do not error.
}

function cancelPending(): void {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  pendingPrefix = false;
}

function hasModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey || event.altKey;
}

function shouldIgnoreEvent(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  // `isContentEditable` would be ideal but jsdom doesn't always
  // populate it; fall back to the attribute and the closest()
  // walk so a `<div contenteditable="true">` and any child of it
  // both get caught.
  if (target.closest('[contenteditable=""], [contenteditable="true"]') !== null)
    return true;
  if (target.closest('[role="dialog"]') !== null) return true;
  return false;
}
