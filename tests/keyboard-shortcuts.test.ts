// PR 26 — keyboard shortcuts. Vim-style two-key sequences with safe
// gating: ignore inputs/dialogs, ignore modifier chords, expire after
// 1200 ms.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  mountKeyboardShortcuts,
  resetKeyboardShortcutsForTests,
} from '../src/components/keyboard-shortcuts';

function press(
  key: string,
  init: KeyboardEventInit & { target?: EventTarget } = {},
): void {
  const { target, ...eventInit } = init;
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    key,
    ...eventInit,
  });
  if (target !== undefined) {
    target.dispatchEvent(event);
  } else {
    window.dispatchEvent(event);
  }
}

describe('keyboard shortcuts (PR 26)', () => {
  beforeEach(() => {
    window.location.hash = '';
    resetKeyboardShortcutsForTests();
  });

  afterEach(() => {
    resetKeyboardShortcutsForTests();
    vi.useRealTimers();
  });

  it('mountKeyboardShortcuts is idempotent', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    mountKeyboardShortcuts();
    mountKeyboardShortcuts();
    mountKeyboardShortcuts();
    const keydownRegistrations = addSpy.mock.calls.filter(
      (call) => call[0] === 'keydown',
    );
    expect(keydownRegistrations).toHaveLength(1);
    addSpy.mockRestore();
  });

  it('g then d navigates to #dashboard', () => {
    mountKeyboardShortcuts();
    press('g');
    press('d');
    expect(window.location.hash).toBe('#dashboard');
  });

  it('g then m navigates to #master-gap', () => {
    mountKeyboardShortcuts();
    press('g');
    press('m');
    expect(window.location.hash).toBe('#master-gap');
  });

  it('g then b navigates to #browse', () => {
    mountKeyboardShortcuts();
    press('g');
    press('b');
    expect(window.location.hash).toBe('#browse');
  });

  it('g then c navigates to #collection', () => {
    mountKeyboardShortcuts();
    press('g');
    press('c');
    expect(window.location.hash).toBe('#collection');
  });

  it('g then p navigates to #binders', () => {
    mountKeyboardShortcuts();
    press('g');
    press('p');
    expect(window.location.hash).toBe('#binders');
  });

  it('g then l navigates to #lots', () => {
    mountKeyboardShortcuts();
    press('g');
    press('l');
    expect(window.location.hash).toBe('#lots');
  });

  it('g then w navigates to #wishlist', () => {
    mountKeyboardShortcuts();
    press('g');
    press('w');
    expect(window.location.hash).toBe('#wishlist');
  });

  it('shortcut is ignored when target is an input element', () => {
    mountKeyboardShortcuts();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    press('g', { target: input });
    press('m', { target: input });
    expect(window.location.hash).toBe('');
    input.remove();
  });

  it('shortcut is ignored when target is a textarea', () => {
    mountKeyboardShortcuts();
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    press('g', { target: ta });
    press('m', { target: ta });
    expect(window.location.hash).toBe('');
    ta.remove();
  });

  it('shortcut is ignored when target is a select', () => {
    mountKeyboardShortcuts();
    const select = document.createElement('select');
    document.body.appendChild(select);
    select.focus();
    press('g', { target: select });
    press('d', { target: select });
    expect(window.location.hash).toBe('');
    select.remove();
  });

  it('shortcut is ignored when target is contenteditable', () => {
    mountKeyboardShortcuts();
    const ed = document.createElement('div');
    ed.setAttribute('contenteditable', 'true');
    document.body.appendChild(ed);
    press('g', { target: ed });
    press('d', { target: ed });
    expect(window.location.hash).toBe('');
    ed.remove();
  });

  it('shortcut is ignored when target is inside a role="dialog"', () => {
    mountKeyboardShortcuts();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const inner = document.createElement('button');
    dialog.appendChild(inner);
    document.body.appendChild(dialog);
    press('g', { target: inner });
    press('d', { target: inner });
    expect(window.location.hash).toBe('');
    dialog.remove();
  });

  it('unknown second key cancels the pending shortcut and does nothing', () => {
    mountKeyboardShortcuts();
    press('g');
    press('z'); // not a known second key
    expect(window.location.hash).toBe('');
    // After the unknown key the pending state is dropped — pressing
    // `d` alone should not navigate.
    press('d');
    expect(window.location.hash).toBe('');
  });

  it('Escape cancels the pending shortcut', () => {
    mountKeyboardShortcuts();
    press('g');
    press('Escape');
    press('d');
    expect(window.location.hash).toBe('');
  });

  it('pending shortcut expires after 1200 ms', () => {
    vi.useFakeTimers();
    mountKeyboardShortcuts();
    press('g');
    vi.advanceTimersByTime(1200);
    press('d');
    expect(window.location.hash).toBe('');
  });

  it('Ctrl+K is not handled here (global search owns it)', () => {
    mountKeyboardShortcuts();
    press('k', { ctrlKey: true });
    expect(window.location.hash).toBe('');
  });

  it('Cmd+K is not handled here', () => {
    mountKeyboardShortcuts();
    press('k', { metaKey: true });
    expect(window.location.hash).toBe('');
  });

  it('Ctrl+G does not start the pending sequence', () => {
    mountKeyboardShortcuts();
    press('g', { ctrlKey: true });
    press('d');
    expect(window.location.hash).toBe('');
  });
});
