// PR C1 — Unit tests for the hand-rolled windowed list helper.
// Exercises the windowing math, the renderAllThreshold fast path,
// empty-state rendering, scroll-driven re-rendering, and DOM
// cleanup. No table wrapping — we use `div`-tagged spacers so the
// component's contract is decoupled from <tbody> specifics.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createVirtualScroll,
  type VirtualScrollScrollContext,
} from '../src/components/virtual-scroll';

interface Row {
  readonly id: string;
  readonly label: string;
}

function makeRows(count: number): readonly Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({ id: `row-${i}`, label: `Row ${i}` });
  }
  return rows;
}

function buildRowEl(row: Row): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'vs-test-row';
  el.dataset['rowId'] = row.id;
  el.textContent = row.label;
  return el;
}

describe('createVirtualScroll', () => {
  let container: HTMLElement;
  let scrollCtx: VirtualScrollScrollContext;

  beforeEach(() => {
    document.body.innerHTML = '<div id="vs-host"></div>';
    container = document.getElementById('vs-host') as HTMLElement;
    scrollCtx = { scrollTop: 0, viewportHeight: 600, rowsTopOffset: 0 };
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders all items when total ≤ renderAllThreshold', () => {
    const handle = createVirtualScroll<Row>({
      contentRoot: container,
      spacerTag: 'div',
      items: makeRows(20),
      rowHeight: 50,
      renderAllThreshold: 100,
      getScrollContext: () => scrollCtx,
      renderItem: buildRowEl,
    });

    const rows = container.querySelectorAll<HTMLDivElement>('.vs-test-row');
    expect(rows.length).toBe(20);
    const range = handle.visibleRange();
    expect(range.startIndex).toBe(0);
    expect(range.endIndex).toBe(20);
  });

  it('renders only the windowed slice when total > renderAllThreshold', () => {
    const handle = createVirtualScroll<Row>({
      contentRoot: container,
      spacerTag: 'div',
      items: makeRows(1000),
      rowHeight: 50,
      overscan: 5,
      renderAllThreshold: 100,
      // Viewport 600px / 50px = 12 rows visible. Plus 5 overscan each
      // side ⇒ start at 0 (clamped), end at 12+5 = 17.
      getScrollContext: () => ({
        scrollTop: 0,
        viewportHeight: 600,
        rowsTopOffset: 0,
      }),
      renderItem: buildRowEl,
    });

    const rows = container.querySelectorAll<HTMLDivElement>('.vs-test-row');
    expect(rows.length).toBeLessThan(50);
    expect(rows.length).toBeGreaterThan(10);
    const range = handle.visibleRange();
    expect(range.startIndex).toBe(0);
    expect(range.endIndex).toBe(17);
  });

  it('spacer heights track total dataset size and windowed offset', () => {
    createVirtualScroll<Row>({
      contentRoot: container,
      spacerTag: 'div',
      items: makeRows(1000),
      rowHeight: 50,
      overscan: 0,
      renderAllThreshold: 100,
      // Scrolled 500px past the rows region top: visible window
      // starts at row 10, ends at row 22 (600/50 = 12 rows visible).
      getScrollContext: () => ({
        scrollTop: 500,
        viewportHeight: 600,
        rowsTopOffset: 0,
      }),
      renderItem: buildRowEl,
    });

    const topSpacer = container.querySelector<HTMLElement>(
      '[data-region="vs-top-spacer"]',
    );
    const bottomSpacer = container.querySelector<HTMLElement>(
      '[data-region="vs-bottom-spacer"]',
    );
    expect(topSpacer?.style.height).toBe('500px'); // 10 rows × 50px
    // 1000 total − 22 endIndex = 978 rows below × 50px = 48900px
    expect(bottomSpacer?.style.height).toBe('48900px');
  });

  it('empty list: renderEmpty is inserted between spacers; spacers stay at 0px', () => {
    createVirtualScroll<Row>({
      contentRoot: container,
      spacerTag: 'div',
      items: [],
      rowHeight: 50,
      renderAllThreshold: 100,
      getScrollContext: () => scrollCtx,
      renderItem: buildRowEl,
      renderEmpty: () => {
        const el = document.createElement('div');
        el.className = 'vs-empty';
        el.textContent = 'no rows';
        return el;
      },
    });

    const empty = container.querySelector<HTMLElement>('.vs-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toBe('no rows');
    const topSpacer = container.querySelector<HTMLElement>(
      '[data-region="vs-top-spacer"]',
    );
    const bottomSpacer = container.querySelector<HTMLElement>(
      '[data-region="vs-bottom-spacer"]',
    );
    expect(topSpacer?.style.height).toBe('0px');
    expect(bottomSpacer?.style.height).toBe('0px');
  });

  it('empty list without renderEmpty leaves the rows area between spacers blank', () => {
    createVirtualScroll<Row>({
      contentRoot: container,
      spacerTag: 'div',
      items: [],
      rowHeight: 50,
      renderAllThreshold: 100,
      getScrollContext: () => scrollCtx,
      renderItem: buildRowEl,
    });

    expect(container.querySelectorAll('.vs-test-row').length).toBe(0);
    // Only the two spacers should remain.
    expect(container.children.length).toBe(2);
  });

  it('setItems replaces the dataset and re-renders the window', () => {
    const handle = createVirtualScroll<Row>({
      contentRoot: container,
      spacerTag: 'div',
      items: makeRows(5),
      rowHeight: 50,
      renderAllThreshold: 100,
      getScrollContext: () => scrollCtx,
      renderItem: buildRowEl,
    });
    expect(container.querySelectorAll('.vs-test-row').length).toBe(5);

    handle.setItems(makeRows(12));
    const rows = container.querySelectorAll<HTMLDivElement>('.vs-test-row');
    expect(rows.length).toBe(12);
    expect(rows[0]?.dataset['rowId']).toBe('row-0');
    expect(rows[11]?.dataset['rowId']).toBe('row-11');
  });

  it('setItems on virtualized dataset shifts the visible slice', () => {
    let ctx: VirtualScrollScrollContext = {
      scrollTop: 0,
      viewportHeight: 500,
      rowsTopOffset: 0,
    };
    const handle = createVirtualScroll<Row>({
      contentRoot: container,
      spacerTag: 'div',
      items: makeRows(500),
      rowHeight: 50,
      overscan: 2,
      renderAllThreshold: 100,
      getScrollContext: () => ctx,
      renderItem: buildRowEl,
    });

    const initial = handle.visibleRange();
    expect(initial.startIndex).toBe(0);

    // Scroll 2500px down ⇒ row 50 ≤ start ≤ row 50.
    ctx = { scrollTop: 2500, viewportHeight: 500, rowsTopOffset: 0 };
    handle.refresh();
    const after = handle.visibleRange();
    expect(after.startIndex).toBe(2500 / 50 - 2); // 48
    expect(after.endIndex).toBe(Math.ceil(3000 / 50) + 2); // 62
    const rows = container.querySelectorAll<HTMLDivElement>('.vs-test-row');
    expect(rows[0]?.dataset['rowId']).toBe('row-48');
    expect(rows[rows.length - 1]?.dataset['rowId']).toBe('row-61');
  });

  it('refresh() with same scroll context is a no-op for the DOM', () => {
    let renderCalls = 0;
    const handle = createVirtualScroll<Row>({
      contentRoot: container,
      spacerTag: 'div',
      items: makeRows(500),
      rowHeight: 50,
      overscan: 2,
      renderAllThreshold: 100,
      getScrollContext: () => scrollCtx,
      renderItem: (row) => {
        renderCalls += 1;
        return buildRowEl(row);
      },
    });
    const initialCalls = renderCalls;
    handle.refresh();
    handle.refresh();
    handle.refresh();
    expect(renderCalls).toBe(initialCalls);
  });

  it('destroy() clears the DOM children', () => {
    const handle = createVirtualScroll<Row>({
      contentRoot: container,
      spacerTag: 'div',
      items: makeRows(8),
      rowHeight: 50,
      renderAllThreshold: 100,
      getScrollContext: () => scrollCtx,
      renderItem: buildRowEl,
    });
    expect(container.children.length).toBeGreaterThan(0);
    handle.destroy();
    expect(container.children.length).toBe(0);
  });

  it('spacers use the <tr>+<td>+colSpan shape when spacerTag is "tr"', () => {
    const tbody = document.createElement('tbody');
    container.appendChild(tbody);
    createVirtualScroll<Row>({
      contentRoot: tbody,
      spacerTag: 'tr',
      spacerColSpan: 7,
      items: makeRows(3),
      rowHeight: 52,
      renderAllThreshold: 100,
      getScrollContext: () => scrollCtx,
      renderItem: buildRowEl,
    });

    const topSpacer = tbody.querySelector<HTMLTableRowElement>(
      'tr[data-region="vs-top-spacer"]',
    );
    expect(topSpacer).not.toBeNull();
    const td = topSpacer?.querySelector<HTMLTableCellElement>('td');
    expect(td?.colSpan).toBe(7);
    expect(topSpacer?.getAttribute('aria-hidden')).toBe('true');
  });

  it('clamps endIndex to items.length even when scrolled past the end', () => {
    const handle = createVirtualScroll<Row>({
      contentRoot: container,
      spacerTag: 'div',
      items: makeRows(200),
      rowHeight: 50,
      overscan: 5,
      renderAllThreshold: 100,
      // Scroll far past the dataset's total (200 × 50 = 10000px).
      getScrollContext: () => ({
        scrollTop: 50000,
        viewportHeight: 600,
        rowsTopOffset: 0,
      }),
      renderItem: buildRowEl,
    });
    const range = handle.visibleRange();
    expect(range.endIndex).toBe(200);
    expect(range.startIndex).toBeLessThanOrEqual(200);
  });

  it('handles dataset shrinking below renderAllThreshold across setItems', () => {
    const handle = createVirtualScroll<Row>({
      contentRoot: container,
      spacerTag: 'div',
      items: makeRows(500),
      rowHeight: 50,
      renderAllThreshold: 100,
      getScrollContext: () => scrollCtx,
      renderItem: buildRowEl,
    });
    // Large dataset: virtualized.
    expect(container.querySelectorAll('.vs-test-row').length).toBeLessThan(50);

    handle.setItems(makeRows(8));
    // Now below threshold: every row in DOM.
    expect(container.querySelectorAll('.vs-test-row').length).toBe(8);
    const topSpacer = container.querySelector<HTMLElement>(
      '[data-region="vs-top-spacer"]',
    );
    expect(topSpacer?.style.height).toBe('0px');
  });
});
