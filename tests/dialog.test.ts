import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DIALOG_SUBMITTED_EVENT,
  openDialog,
  type DialogContent,
} from '../src/components/dialog';

async function tick(ms = 10): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('openDialog', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('mounts the supplied content into a <dialog>', async () => {
    const content: DialogContent = {
      mount(host) {
        const p = document.createElement('p');
        p.textContent = 'hello dialog';
        p.dataset['testProbe'] = 'present';
        host.appendChild(p);
      },
    };
    const _result = openDialog(content);
    await tick();

    const dialog = document.querySelector('dialog.app-dialog');
    expect(dialog).not.toBeNull();
    expect(
      dialog?.querySelector('[data-test-probe="present"]')?.textContent,
    ).toBe('hello dialog');

    // Resolve by submitting so the test does not leak.
    dialog?.dispatchEvent(new CustomEvent(DIALOG_SUBMITTED_EVENT));
    await _result;
  });

  it('resolves with "submitted" when the inner content fires dialog:submitted', async () => {
    const content: DialogContent = {
      mount() {
        // No-op; the test fires the submitted event externally.
      },
    };
    const promise = openDialog(content);
    await tick();
    const dialog = document.querySelector<HTMLDialogElement>('dialog.app-dialog');
    expect(dialog).not.toBeNull();
    dialog!.dispatchEvent(new CustomEvent(DIALOG_SUBMITTED_EVENT));
    expect(await promise).toBe('submitted');
    expect(document.querySelector('dialog.app-dialog')).toBeNull();
  });

  it('resolves with "cancelled" when the close callback is invoked', async () => {
    const cancelHolder: { fn: (() => void) | null } = { fn: null };
    const content: DialogContent = {
      mount(_host, close) {
        cancelHolder.fn = close;
      },
    };
    const promise = openDialog(content);
    await tick();
    expect(cancelHolder.fn).not.toBeNull();
    cancelHolder.fn!();
    expect(await promise).toBe('cancelled');
    expect(document.querySelector('dialog.app-dialog')).toBeNull();
  });
});
