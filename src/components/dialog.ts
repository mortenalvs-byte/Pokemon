// Tiny `<dialog>` wrapper. Native HTML5 element, no framework. The
// returned Promise resolves with the dialog's outcome — `submitted`
// when the inner form fired its `dialog:submitted` custom event,
// `cancelled` otherwise (Esc key, native backdrop close, or explicit
// cancel button).
//
// The inner content is responsible for:
//   - Putting whatever DOM it needs inside the dialog.
//   - Dispatching `new CustomEvent('dialog:submitted')` from anywhere
//     inside the dialog after a successful save. The wrapper closes
//     the dialog and resolves with `submitted`.
//   - Optionally calling the `close` callback passed to `mount`
//     (declared in `DialogContent.mount`) for explicit cancel.
//
// PR 7a uses one dialog at a time. The wrapper does not stack.

export type DialogResult = 'submitted' | 'cancelled';

export interface DialogContent {
  mount(host: HTMLElement, close: () => void): void;
}

export const DIALOG_SUBMITTED_EVENT = 'dialog:submitted';

export async function openDialog(content: DialogContent): Promise<DialogResult> {
  return new Promise<DialogResult>((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'app-dialog';

    let outcome: DialogResult = 'cancelled';
    const finish = (result: DialogResult): void => {
      if (!dialog.open) return;
      outcome = result;
      // Native browsers and modern jsdom expose `dialog.close()`. Older
      // jsdom versions only support the `open` attribute, so fall back
      // to emitting `close` ourselves.
      if (typeof dialog.close === 'function') {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
        dialog.dispatchEvent(new Event('close'));
      }
    };

    dialog.addEventListener(DIALOG_SUBMITTED_EVENT, () => {
      finish('submitted');
    });

    // `cancel` fires when the user presses Esc or otherwise dismisses
    // natively. `close` fires after either path; we read `outcome`
    // there to decide what to resolve with.
    dialog.addEventListener('cancel', () => {
      finish('cancelled');
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(outcome);
    });

    content.mount(dialog, () => finish('cancelled'));

    document.body.appendChild(dialog);
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      // jsdom does not implement showModal yet (as of this writing).
      // Fall back to `open=true` which still surfaces the element so
      // tests can interact with it.
      dialog.setAttribute('open', '');
    }
  });
}
