// PR C1 — Hand-rolled windowed list helper.
//
// Renders only the rows currently inside (or near) the viewport plus
// a configurable overscan, anchored by top/bottom spacers that hold
// the total height. As the user scrolls, the slice is recomputed and
// the spacer heights adjust so the scroll bar position keeps tracking
// the user's location in the full dataset.
//
// Goals (operator requirement #11):
//   - ~30 rows in DOM regardless of dataset size, once the dataset
//     crosses the renderAllThreshold.
//   - No new dependencies. Hand-rolled DOM ops only.
//   - Cooperates with <table> rendering by accepting `tr`-tagged
//     spacers so a <tbody> can be the contentRoot.
//   - Stays inert on small datasets (≤ threshold): renders everything
//     in one pass, no scroll math, no spacers with visible height.
//     This keeps tests + bulk-mode UX stable for small page sizes.
//
// What it intentionally does NOT do:
//   - Variable-height rows. rowHeight is treated as a constant; the
//     spacer math is approximate when actual heights vary. Fine for
//     the browse table where every row renders the same controls.
//   - Sub-pixel scroll snapping. Browsers handle that natively.

export interface VirtualScrollScrollContext {
  /** Current scroll position. Browser = window.scrollY; container = el.scrollTop. */
  readonly scrollTop: number;
  /** Visible viewport height in CSS pixels. */
  readonly viewportHeight: number;
  /**
   * Document-absolute Y-coordinate of the contentRoot's top. For a
   * window-scrolled <tbody> this is `window.scrollY + rect.top`. The
   * caller recomputes per refresh so layout shifts above the table
   * don't desync the windowing math.
   */
  readonly rowsTopOffset: number;
}

export interface VirtualScrollOptions<T> {
  /** Element that holds the rendered rows (e.g. <tbody>). */
  readonly contentRoot: HTMLElement;
  /** Tag for the top/bottom spacers. Use `tr` inside a <tbody>, else `div`. */
  readonly spacerTag?: 'tr' | 'div';
  /** Colspan for the <td> inside a tr-spacer (tables need it for alignment). */
  readonly spacerColSpan?: number;
  /** Initial item list. Update later via setItems(). */
  readonly items: readonly T[];
  /** Estimated row height in px. Used for spacer math. */
  readonly rowHeight: number;
  /** Extra rows above/below the visible window (default 5). */
  readonly overscan?: number;
  /**
   * Below this threshold every item renders at once (no virtualization).
   * Keeps small datasets simple and avoids breaking tests/a11y tools
   * that count rows in the DOM. Default 100.
   */
  readonly renderAllThreshold?: number;
  /** Returns current scroll context. Called per refresh; cheap. */
  readonly getScrollContext: () => VirtualScrollScrollContext;
  /** Build the DOM element for a row. */
  readonly renderItem: (item: T, index: number) => HTMLElement;
  /**
   * Optional fallback when items.length === 0. The element is inserted
   * between the spacers so callers can render an empty-state row that
   * spans the table width via colspan.
   */
  readonly renderEmpty?: () => HTMLElement;
}

export interface VirtualScrollHandle<T> {
  /** Re-read scroll context and rerender if the visible range changed. */
  refresh(): void;
  /** Replace the full item list and rerender. Forces a fresh render. */
  setItems(items: readonly T[]): void;
  /** Currently rendered range. */
  visibleRange(): { readonly startIndex: number; readonly endIndex: number };
  /** Remove rendered rows + spacers and clear internal state. */
  destroy(): void;
}

export function createVirtualScroll<T>(opts: VirtualScrollOptions<T>): VirtualScrollHandle<T> {
  const spacerTag = opts.spacerTag ?? 'div';
  const overscan = Math.max(0, opts.overscan ?? 5);
  const renderAllThreshold = Math.max(0, opts.renderAllThreshold ?? 100);
  let items: readonly T[] = opts.items;
  let lastRange = { startIndex: -1, endIndex: -1 };

  const topSpacer = makeSpacer(spacerTag, opts.spacerColSpan, 'vs-top-spacer');
  const bottomSpacer = makeSpacer(spacerTag, opts.spacerColSpan, 'vs-bottom-spacer');

  function attachSpacers(): void {
    // Wipe contentRoot once on attach so we own its children.
    opts.contentRoot.replaceChildren(topSpacer, bottomSpacer);
  }

  function computeRange(): { startIndex: number; endIndex: number } {
    const total = items.length;
    if (total === 0) return { startIndex: 0, endIndex: 0 };
    if (total <= renderAllThreshold) {
      return { startIndex: 0, endIndex: total };
    }
    const ctx = opts.getScrollContext();
    const rowH = Math.max(1, opts.rowHeight);
    // Position of the visible viewport in the contentRoot's local
    // coordinate space (top of tbody = 0).
    const visibleTopLocal = Math.max(0, ctx.scrollTop - ctx.rowsTopOffset);
    const visibleBottomLocal =
      ctx.scrollTop - ctx.rowsTopOffset + Math.max(0, ctx.viewportHeight);
    let startIndex = Math.floor(visibleTopLocal / rowH) - overscan;
    let endIndex = Math.ceil(visibleBottomLocal / rowH) + overscan;
    if (startIndex < 0) startIndex = 0;
    // Clamp startIndex first so a scroll past the dataset's last row
    // doesn't leave us with start > total (which would otherwise
    // un-clamp endIndex below when endIndex < startIndex).
    if (startIndex > total) startIndex = total;
    if (endIndex > total) endIndex = total;
    if (endIndex < startIndex) endIndex = startIndex;
    return { startIndex, endIndex };
  }

  function renderSlice(startIndex: number, endIndex: number): void {
    const parent = topSpacer.parentNode;
    if (parent === null) {
      attachSpacers();
      return renderSlice(startIndex, endIndex);
    }
    // Remove every node strictly between the two spacers.
    let cursor: ChildNode | null = topSpacer.nextSibling;
    while (cursor !== null && cursor !== bottomSpacer) {
      const next: ChildNode | null = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
    const total = items.length;
    if (total === 0) {
      if (opts.renderEmpty !== undefined) {
        const el = opts.renderEmpty();
        parent.insertBefore(el, bottomSpacer);
      }
      topSpacer.style.height = '0px';
      bottomSpacer.style.height = '0px';
      return;
    }
    for (let i = startIndex; i < endIndex; i += 1) {
      const item = items[i];
      if (item === undefined) continue;
      const el = opts.renderItem(item, i);
      parent.insertBefore(el, bottomSpacer);
    }
    if (total <= renderAllThreshold) {
      topSpacer.style.height = '0px';
      bottomSpacer.style.height = '0px';
    } else {
      const rowH = Math.max(1, opts.rowHeight);
      const topPx = Math.max(0, startIndex) * rowH;
      const bottomPx = Math.max(0, total - endIndex) * rowH;
      topSpacer.style.height = `${topPx}px`;
      bottomSpacer.style.height = `${bottomPx}px`;
    }
  }

  function refresh(): void {
    if (topSpacer.parentNode !== opts.contentRoot) {
      attachSpacers();
    }
    const range = computeRange();
    if (
      range.startIndex === lastRange.startIndex &&
      range.endIndex === lastRange.endIndex
    ) {
      // Same window AND a previous render exists (lastRange != {-1,-1}).
      // Skip the rerender; scroll noise shouldn't churn the DOM.
      if (lastRange.startIndex !== -1) return;
    }
    lastRange = range;
    renderSlice(range.startIndex, range.endIndex);
  }

  function setItems(next: readonly T[]): void {
    items = next;
    // Force a fresh render even if the window indices happen to match.
    lastRange = { startIndex: -1, endIndex: -1 };
    refresh();
  }

  function visibleRange(): { readonly startIndex: number; readonly endIndex: number } {
    return lastRange;
  }

  function destroy(): void {
    opts.contentRoot.replaceChildren();
    lastRange = { startIndex: -1, endIndex: -1 };
  }

  attachSpacers();
  refresh();

  return { refresh, setItems, visibleRange, destroy };
}

function makeSpacer(
  tag: 'tr' | 'div',
  colSpan: number | undefined,
  region: string,
): HTMLElement {
  if (tag === 'tr') {
    const tr = document.createElement('tr');
    tr.className = 'browse-table__vs-spacer';
    tr.setAttribute('aria-hidden', 'true');
    tr.dataset['region'] = region;
    const td = document.createElement('td');
    if (colSpan !== undefined && colSpan > 0) td.colSpan = colSpan;
    td.className = 'browse-table__vs-spacer-cell';
    tr.appendChild(td);
    return tr;
  }
  const el = document.createElement(tag);
  el.className = 'browse-table__vs-spacer';
  el.setAttribute('aria-hidden', 'true');
  el.dataset['region'] = region;
  return el;
}
