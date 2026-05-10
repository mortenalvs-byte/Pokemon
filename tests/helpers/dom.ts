// PR 36 — shared DOM utilities for tests.
//
// `settle(ms?)` is the await-this-tick helper that 45+ test
// files inline as `await new Promise(r => setTimeout(r, N))`.
// Default 80 ms matches the historic per-file default in the
// action-audit-style tests — long enough to let debounced
// `setTimeout(fn, DEBOUNCE_MS=15)` chains drain in jsdom, short
// enough that the full suite stays fast. Tests with heavier
// renders (e.g. PR 20's 1088-slot binder) keep their own local
// settle with a bigger default; passing an explicit ms here
// works the same way.
//
// `clickByText(root, text)` finds the first descendant button
// whose visible text matches and clicks it. Throws if not
// found, with a helpful message that includes the buttons that
// WERE present — the most common debugging case.
//
// Both are pure JSDOM helpers — they do not touch the DB or
// any module from `src/`.

export async function settle(ms = 80): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Click the first `<button>` descendant of `root` whose trimmed
 * `textContent` exactly matches `text`. Throws when no button
 * matches; the error lists every button text under `root` so the
 * caller can see what the DOM actually looked like.
 */
export function clickByText(root: ParentNode, text: string): HTMLButtonElement {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button'));
  const target = buttons.find((b) => b.textContent?.trim() === text);
  if (target === undefined) {
    const labels = buttons
      .map((b) => `"${b.textContent?.trim() ?? ''}"`)
      .join(', ');
    throw new Error(
      `clickByText("${text}") found no matching button. Buttons present: [${labels}]`,
    );
  }
  target.click();
  return target;
}
