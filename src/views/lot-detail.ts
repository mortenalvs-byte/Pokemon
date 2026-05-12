// Lot detail view. Reached via `#lot/<id>`. Renders the lot summary,
// the items table, the allocation toolbar (mode select + apply
// button), the materialise button, and the CSV export button.
//
// Reads via `lot-detail-service`. All mutations route through:
//   - lotsRepo (lot.allocationMethod change)
//   - lotItemsRepo (item soft-delete / restore)
//   - lotItemForm (item add / edit)
//   - lotService (applyAllocation, materializeHoldings)
//   - createLotCsvExporter (CSV generate + audit)

import { openDialog } from '../components/dialog';
import { USER_DATA_CHANGED_EVENT, onUserDataChanged } from '../components/events';
import { buildLotItemForm } from '../components/lot-item-form';
import { buildLotBulkImportDialog } from '../components/lot-bulk-import-dialog';
import { openWishlistReceivePrompt } from '../components/wishlist-receive-prompt';
import { getDb } from '../db/database';
import { getCurrentLotId, navigate, navigateToCard } from '../router';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import { createLotItemsRepo } from '../repositories/lot-items-repo';
import { createLotsRepo } from '../repositories/lots-repo';
import { createWishlistRepo } from '../repositories/wishlist-repo';
import { findReceiveCandidatesForHoldings } from '../services/wishlist-receive-service';
import {
  createLotDetailService,
  type LotDetail,
  type LotStatus,
} from '../services/lot-detail-service';
import { createLotCsvExporter } from '../services/lot-csv-export';
import { createLotService } from '../services/lot-service';
import { downloadTextFile } from '../utils/download';
import type {
  AllocationMethod,
  CardRecord,
  HoldingRecord,
  LotItemRecord,
  LotRecord,
} from '../domain/types';

const STATUS_LABELS: Record<LotStatus, string> = {
  unallocated: 'Ufordelt',
  partial: 'Delvis fordelt',
  allocated: 'Fordelt',
  materialized: 'Materialisert',
};

const STATUS_CHIP_CLASS: Record<LotStatus, string> = {
  unallocated: 'status-chip status-chip--info',
  partial: 'status-chip status-chip--warning',
  allocated: 'status-chip status-chip--info',
  materialized: 'status-chip status-chip--success',
};

const ALLOCATION_METHOD_LABELS: Record<AllocationMethod, string> = {
  equal: 'Lik fordeling',
  weighted_by_market_price: 'Vektet etter markedspris',
  manual: 'Manuell',
};

/**
 * PR 18 — view state held across `USER_DATA_CHANGED_EVENT` rerenders.
 *
 * `selectedItemIds` is a Set<string> of lot-item ids the user ticked
 * the per-row checkbox on. When the user materialises selected items,
 * those ids leave the unmaterialised pool, so the next render
 * automatically removes them from the selection (we filter out any
 * id that's no longer a candidate).
 *
 * `page` is 0-indexed for pagination. Resets to 0 when the user
 * navigates away and back (the per-mount state is created fresh in
 * `mountLotDetailView`).
 */
const LOT_ITEMS_PAGE_SIZE = 50;

interface LotDetailState {
  readonly selectedItemIds: Set<string>;
  page: number;
}

export function mountLotDetailView(
  container: HTMLElement,
  signal?: AbortSignal,
): void {
  const state: LotDetailState = {
    selectedItemIds: new Set(),
    page: 0,
  };
  void renderInto(container, state);
  const refresh = (): void => {
    if (!container.isConnected) return;
    void renderInto(container, state);
  };
  // PR 15A — F-3: router signal drops this listener on next route.
  onUserDataChanged(refresh, signal);
}

async function renderInto(
  container: HTMLElement,
  state: LotDetailState,
): Promise<void> {
  container.innerHTML = '';
  const lotId = getCurrentLotId();

  const root = document.createElement('section');
  root.className = 'lot-detail-view';
  container.appendChild(root);

  const header = document.createElement('div');
  header.className = 'lot-detail-view__header';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'lot-detail-view__back';
  back.dataset['action'] = 'back';
  back.textContent = '← Tilbake til Lotter';
  back.addEventListener('click', () => navigate('lots'));
  header.appendChild(back);
  root.appendChild(header);

  if (lotId === null) {
    appendMessage(root, 'Ingen lot valgt. Gå tilbake til Lotter-listen.');
    return;
  }

  const db = getDb();
  const detailService = createLotDetailService(
    createLotsRepo(db),
    createLotItemsRepo(db),
    createHoldingsRepo(db),
    createCardsRepo(db),
  );
  const detail = await detailService.getDetail(lotId);
  if (detail === null) {
    appendMessage(
      root,
      'Lotten finnes ikke (eller er slettet). Gå tilbake til Lotter-listen.',
    );
    return;
  }

  // PR 18 — drop selection ids that are no longer candidates (item
  // soft-deleted, lot reloaded, or just-materialised in the previous
  // action).
  const candidateIds = new Set(
    detail.items
      .filter((i) => i.holdingId === null && i.deletedAt === null)
      .map((i) => i.id),
  );
  for (const id of [...state.selectedItemIds]) {
    if (!candidateIds.has(id)) state.selectedItemIds.delete(id);
  }

  // Clamp the page index so a soft-delete that shrinks the list
  // doesn't leave the view stranded on a non-existent page.
  const totalPages = Math.max(
    1,
    Math.ceil(detail.items.length / LOT_ITEMS_PAGE_SIZE),
  );
  if (state.page >= totalPages) state.page = totalPages - 1;
  if (state.page < 0) state.page = 0;

  root.appendChild(buildSummary(detail));
  root.appendChild(buildToolbar(detail, state, container));
  root.appendChild(buildItemsTable(detail, state, container));
  root.appendChild(buildPagination(detail, state, container));
  root.appendChild(buildBottomActions(detail));
}

function appendMessage(root: HTMLElement, text: string): void {
  const p = document.createElement('p');
  p.className = 'lot-detail-view__message';
  p.textContent = text;
  root.appendChild(p);
}

// ---------------------------------------------------------------------
// Summary

function buildSummary(detail: LotDetail): HTMLElement {
  const wrap = document.createElement('header');
  wrap.className = 'lot-detail-view__summary';

  const title = document.createElement('h1');
  title.className = 'lot-detail-view__title';
  title.textContent = detail.lot.name;
  wrap.appendChild(title);

  const chip = document.createElement('span');
  chip.className = STATUS_CHIP_CLASS[detail.summary.status];
  chip.textContent = STATUS_LABELS[detail.summary.status];
  wrap.appendChild(chip);

  if (detail.lot.notes !== null) {
    const notes = document.createElement('p');
    notes.className = 'lot-detail-view__notes';
    notes.textContent = detail.lot.notes;
    wrap.appendChild(notes);
  }

  const stats = document.createElement('dl');
  stats.className = 'lot-detail-view__stats';
  appendStat(stats, 'Kjøpsdato', detail.lot.purchaseDate.slice(0, 10));
  appendStat(
    stats,
    'Total',
    `${detail.lot.totalCost.toFixed(2)} ${detail.lot.currency}`,
  );
  appendStat(stats, 'Items', String(detail.summary.itemCount));
  appendStat(
    stats,
    'Allokert',
    `${detail.summary.allocatedTotal.toFixed(2)} ${detail.lot.currency}`,
  );
  appendStat(
    stats,
    'Materialisert',
    `${detail.summary.materializedCount} / ${detail.summary.itemCount}`,
  );
  wrap.appendChild(stats);

  if (Math.abs(detail.summary.allocationDifference) > 0.01) {
    const warning = document.createElement('p');
    warning.className = 'lot-detail-view__warning';
    warning.dataset['region'] = 'allocation-warning';
    warning.textContent =
      `Allokeringen matcher ikke lot-totalen (differanse: ${detail.summary.allocationDifference.toFixed(2)} ${detail.lot.currency}). ` +
      'Trykk "Beregn allokering på nytt".';
    wrap.appendChild(warning);
  }

  return wrap;
}

function appendStat(dl: HTMLDListElement, label: string, value: string): void {
  const dt = document.createElement('dt');
  dt.textContent = label;
  dl.appendChild(dt);
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dd);
}

// ---------------------------------------------------------------------
// Toolbar

function buildToolbar(
  detail: LotDetail,
  state: LotDetailState,
  container: HTMLElement,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'lot-detail-view__toolbar';

  // Allocation method picker — changing it persists immediately via
  // lotsRepo.update so the choice survives a route round-trip; the
  // actual allocation is not re-run until the user clicks Apply.
  const methodLabel = document.createElement('label');
  methodLabel.className = 'lot-detail-view__method';
  const methodText = document.createElement('span');
  methodText.textContent = 'Modus';
  methodLabel.appendChild(methodText);
  const methodSelect = document.createElement('select');
  methodSelect.dataset['region'] = 'method-select';
  for (const value of [
    'equal',
    'weighted_by_market_price',
    'manual',
  ] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = ALLOCATION_METHOD_LABELS[value];
    methodSelect.appendChild(opt);
  }
  methodSelect.value = detail.lot.allocationMethod;
  methodSelect.addEventListener('change', () => {
    void handleMethodChange(detail.lot, methodSelect.value as AllocationMethod);
  });
  methodLabel.appendChild(methodSelect);
  wrap.appendChild(methodLabel);

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'lot-detail-view__apply';
  applyBtn.dataset['action'] = 'apply-allocation';
  applyBtn.textContent = 'Beregn allokering på nytt';
  applyBtn.disabled = detail.summary.unmaterializedCount === 0;
  applyBtn.addEventListener('click', () => {
    void handleApplyAllocation(detail.lot.id);
  });
  wrap.appendChild(applyBtn);

  // PR 18 — split the old "Materialiser N holdings" into two
  // explicit, plain-language actions:
  //   - "Legg hele loten i samling" → unchanged behaviour from PR 9
  //   - "Legg valgte i samling (X)" → new partial-materialise path
  const totalReady = countMaterializeReady(detail);
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'lot-detail-view__materialize';
  allBtn.dataset['action'] = 'materialize-all';
  allBtn.textContent = `Legg hele loten i samling (${totalReady})`;
  allBtn.disabled = totalReady === 0;
  allBtn.addEventListener('click', () => {
    void handleMaterializeAll(detail, state);
  });
  wrap.appendChild(allBtn);

  const selectedReady = countSelectedReady(detail, state);
  const selectedBtn = document.createElement('button');
  selectedBtn.type = 'button';
  selectedBtn.className = 'lot-detail-view__materialize-selected';
  selectedBtn.dataset['action'] = 'materialize-selected';
  selectedBtn.textContent = `Legg valgte i samling (${selectedReady})`;
  selectedBtn.disabled = selectedReady === 0;
  selectedBtn.addEventListener('click', () => {
    void handleMaterializeSelected(detail, state);
  });
  wrap.appendChild(selectedBtn);

  void container;

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'lot-detail-view__export';
  exportBtn.dataset['action'] = 'export-csv';
  exportBtn.textContent = 'Eksporter CSV';
  exportBtn.addEventListener('click', () => {
    void handleExportCsv(detail.lot.id);
  });
  wrap.appendChild(exportBtn);

  return wrap;
}

function countMaterializeReady(detail: LotDetail): number {
  return detail.items.filter(
    (i) => i.holdingId === null && i.allocatedCost !== null,
  ).length;
}

function countSelectedReady(
  detail: LotDetail,
  state: LotDetailState,
): number {
  let n = 0;
  for (const item of detail.items) {
    if (
      item.holdingId === null &&
      item.allocatedCost !== null &&
      state.selectedItemIds.has(item.id)
    ) {
      n += 1;
    }
  }
  return n;
}

// ---------------------------------------------------------------------
// Items

function buildItemsTable(
  detail: LotDetail,
  state: LotDetailState,
  container: HTMLElement,
): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'lot-detail-view__items';

  if (detail.items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'lot-detail-view__empty';
    empty.textContent =
      'Ingen items i lotten ennå. Bruk "Legg til item" for å registrere et kort.';
    wrap.appendChild(empty);
    return wrap;
  }

  // PR 18 — paginate. 50 per page is the same default as Browse and
  // Collection, so users develop one mental model. Pagination
  // operates over the full item list (materialised + ready), which
  // keeps the row order stable across allocate / materialise cycles.
  const start = state.page * LOT_ITEMS_PAGE_SIZE;
  const visible = detail.items.slice(start, start + LOT_ITEMS_PAGE_SIZE);

  // Visible-range select-all checkbox: ticks/un-ticks every
  // unmaterialised, allocation-ready item ON THE CURRENT PAGE.
  // Materialised rows are deliberately excluded so the checkbox
  // never undoes a materialised state (it can't anyway, since
  // those rows have no checkbox).
  const visibleReadyIds = visible
    .filter((i) => i.holdingId === null && i.allocatedCost !== null)
    .map((i) => i.id);
  const allVisibleSelected =
    visibleReadyIds.length > 0 &&
    visibleReadyIds.every((id) => state.selectedItemIds.has(id));

  const table = document.createElement('table');
  table.className = 'lot-items-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th class="lot-items-table__check-col">
          <label class="visually-hidden" for="lot-items-select-all">Velg alle synlige</label>
          <input type="checkbox" id="lot-items-select-all" data-region="select-all" />
        </th>
        <th>Kort</th>
        <th>Finish</th>
        <th>Edition</th>
        <th>Tilstand</th>
        <th>Antall</th>
        <th>Marked</th>
        <th>Manuell</th>
        <th>Allokert</th>
        <th>Holding</th>
        <th class="lot-items-table__actions-col">Handlinger</th>
      </tr>
    </thead>
    <tbody data-region="items-body"></tbody>
  `;
  const selectAll = table.querySelector<HTMLInputElement>(
    '[data-region="select-all"]',
  );
  if (selectAll !== null) {
    selectAll.checked = allVisibleSelected;
    selectAll.disabled = visibleReadyIds.length === 0;
    selectAll.addEventListener('change', () => {
      if (selectAll.checked) {
        for (const id of visibleReadyIds) state.selectedItemIds.add(id);
      } else {
        for (const id of visibleReadyIds) state.selectedItemIds.delete(id);
      }
      void renderInto(container, state);
    });
  }
  const body = table.querySelector<HTMLElement>('[data-region="items-body"]');
  if (body !== null) {
    for (const item of visible) {
      const card = detail.cardsById.get(item.cardId) ?? null;
      const holding =
        item.holdingId !== null
          ? (detail.holdingsById.get(item.holdingId) ?? null)
          : null;
      body.appendChild(
        buildItemRow(detail, item, card, holding, state, container),
      );
    }
  }
  wrap.appendChild(table);
  return wrap;
}

function buildItemRow(
  detail: LotDetail,
  item: LotItemRecord,
  card: CardRecord | null,
  holding: HoldingRecord | null,
  state: LotDetailState,
  container: HTMLElement,
): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'lot-items-table__row';
  tr.dataset['itemId'] = item.id;
  const isMaterialised = item.holdingId !== null;
  if (isMaterialised) {
    tr.dataset['materialized'] = 'true';
    tr.classList.add('lot-items-table__row--materialized');
  }

  // PR 18 — per-row checkbox. Only rendered for unmaterialised
  // allocation-ready rows; materialised + un-allocated rows show an
  // empty cell so the column still aligns.
  const checkCell = document.createElement('td');
  checkCell.className = 'lot-items-table__check';
  if (!isMaterialised && item.allocatedCost !== null) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset['action'] = 'select-item';
    cb.dataset['itemId'] = item.id;
    cb.checked = state.selectedItemIds.has(item.id);
    cb.setAttribute('aria-label', 'Velg dette itemet');
    cb.addEventListener('change', () => {
      if (cb.checked) {
        state.selectedItemIds.add(item.id);
      } else {
        state.selectedItemIds.delete(item.id);
      }
      void renderInto(container, state);
    });
    checkCell.appendChild(cb);
  }
  tr.appendChild(checkCell);

  // Card name (linkable when in cache)
  const cardCell = document.createElement('td');
  if (card !== null) {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'lot-items-table__card-link';
    link.dataset['action'] = 'open-card';
    link.textContent = `${card.name} (${card.id})`;
    link.addEventListener('click', () => navigateToCard(card.id));
    cardCell.appendChild(link);
  } else {
    cardCell.textContent = item.cardId;
  }
  tr.appendChild(cardCell);

  appendCell(tr, item.finish);
  appendCell(tr, item.edition);
  appendCell(tr, describeCondition(item));
  appendCell(tr, String(item.quantity));
  appendCell(tr, item.marketEstimate !== null ? `${item.marketEstimate.toFixed(2)}` : '–');
  appendCell(
    tr,
    item.manualPriceOverride !== null
      ? `${item.manualPriceOverride.toFixed(2)}`
      : '–',
  );
  appendCell(
    tr,
    item.allocatedCost !== null ? `${item.allocatedCost.toFixed(2)}` : '–',
  );

  const holdingCell = document.createElement('td');
  if (holding !== null) {
    holdingCell.textContent = holding.deletedAt !== null ? '✓ (slettet)' : '✓';
  } else {
    holdingCell.textContent = '–';
  }
  tr.appendChild(holdingCell);

  const actions = document.createElement('td');
  actions.className = 'lot-items-table__actions';
  if (item.holdingId === null) {
    // PR 18 — per-row "Legg i samling". Only useful when the row
    // already has an allocatedCost (materialise needs that). Disabled
    // with a tooltip otherwise so the user knows what to do next.
    const addOne = document.createElement('button');
    addOne.type = 'button';
    addOne.className = 'lot-items-table__action lot-items-table__action--primary';
    addOne.dataset['action'] = 'materialize-one';
    addOne.textContent = 'Legg i samling';
    if (item.allocatedCost === null) {
      addOne.disabled = true;
      addOne.title =
        'Mangler allokert kostnad. Trykk "Beregn allokering på nytt" først.';
    }
    addOne.addEventListener('click', () => {
      void handleMaterializeOne(detail, item, state, container);
    });
    actions.appendChild(addOne);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'lot-items-table__action';
    edit.dataset['action'] = 'edit-item';
    edit.textContent = 'Rediger';
    edit.addEventListener('click', () => {
      void openDialog(buildLotItemForm({ mode: 'edit', item }));
    });
    actions.appendChild(edit);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'lot-items-table__action lot-items-table__action--danger';
    del.dataset['action'] = 'soft-delete-item';
    del.textContent = 'Slett';
    del.addEventListener('click', () => {
      void handleSoftDeleteItem(item);
    });
    actions.appendChild(del);
  } else {
    const note = document.createElement('span');
    note.className = 'lot-items-table__locked';
    note.textContent = '✓ I samlingen';
    actions.appendChild(note);
  }
  tr.appendChild(actions);

  return tr;
}

function buildPagination(
  detail: LotDetail,
  state: LotDetailState,
  container: HTMLElement,
): HTMLElement {
  const wrap = document.createElement('nav');
  wrap.className = 'lot-detail-view__pagination';
  wrap.setAttribute('aria-label', 'Sidenavigasjon for lot-items');
  if (detail.items.length <= LOT_ITEMS_PAGE_SIZE) {
    wrap.hidden = true;
    return wrap;
  }
  const totalPages = Math.max(
    1,
    Math.ceil(detail.items.length / LOT_ITEMS_PAGE_SIZE),
  );
  const prev = document.createElement('button');
  prev.type = 'button';
  prev.dataset['action'] = 'prev-page';
  prev.textContent = 'Forrige';
  prev.disabled = state.page === 0;
  prev.addEventListener('click', () => {
    if (state.page > 0) {
      state.page -= 1;
      void renderInto(container, state);
    }
  });
  wrap.appendChild(prev);

  const summary = document.createElement('span');
  summary.dataset['region'] = 'page-summary';
  const start = state.page * LOT_ITEMS_PAGE_SIZE + 1;
  const end = Math.min(
    detail.items.length,
    (state.page + 1) * LOT_ITEMS_PAGE_SIZE,
  );
  summary.textContent = `Side ${state.page + 1} av ${totalPages} — viser ${start}–${end} av ${detail.items.length}`;
  wrap.appendChild(summary);

  const next = document.createElement('button');
  next.type = 'button';
  next.dataset['action'] = 'next-page';
  next.textContent = 'Neste';
  next.disabled = state.page + 1 >= totalPages;
  next.addEventListener('click', () => {
    if (state.page + 1 < totalPages) {
      state.page += 1;
      void renderInto(container, state);
    }
  });
  wrap.appendChild(next);
  return wrap;
}

function describeCondition(item: LotItemRecord): string {
  if (item.conditionType === 'graded') {
    const company = item.gradingCompany ?? '?';
    const grade = item.grade !== null ? item.grade.toFixed(1) : '?';
    return `${company} ${grade}`;
  }
  return item.rawCondition ?? '–';
}

function appendCell(tr: HTMLTableRowElement, value: string): void {
  const td = document.createElement('td');
  td.textContent = value;
  tr.appendChild(td);
}

// ---------------------------------------------------------------------
// Bottom actions

function buildBottomActions(detail: LotDetail): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'lot-detail-view__bottom';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'lot-detail-view__add-item';
  addBtn.dataset['action'] = 'add-item';
  addBtn.textContent = 'Legg til item';
  addBtn.addEventListener('click', () => {
    void openDialog(buildLotItemForm({ mode: 'add', lotId: detail.lot.id }));
  });
  wrap.appendChild(addBtn);
  // PR B1: bulk-import button (operator requirement #7 — lot-kjøp i bulk).
  // Pastes/loads N cards from CSV in one shot instead of N×single-form clicks.
  const bulkBtn = document.createElement('button');
  bulkBtn.type = 'button';
  bulkBtn.className = 'lot-detail-view__add-item';
  bulkBtn.dataset['action'] = 'bulk-import';
  bulkBtn.textContent = 'Importer mange';
  bulkBtn.addEventListener('click', () => {
    void openDialog(buildLotBulkImportDialog({ lotId: detail.lot.id }));
  });
  wrap.appendChild(bulkBtn);
  return wrap;
}

// ---------------------------------------------------------------------
// Action handlers

async function handleMethodChange(
  lot: LotRecord,
  newMethod: AllocationMethod,
): Promise<void> {
  if (lot.allocationMethod === newMethod) return;
  await createLotsRepo(getDb()).update(lot.id, {
    allocationMethod: newMethod,
  });
  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
}

async function handleApplyAllocation(lotId: string): Promise<void> {
  const result = await createLotService(getDb()).applyAllocation(lotId);
  if (!result.applied) {
    const message =
      result.allocation.errors.length > 0
        ? result.allocation.errors.join('\n')
        : 'Allokering kunne ikke kjøres.';
    window.alert(message);
    return;
  }
  if (result.allocation.warnings.length > 0) {
    window.alert(result.allocation.warnings.join('\n'));
  }
  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
}

async function handleMaterializeAll(
  detail: LotDetail,
  state: LotDetailState,
): Promise<void> {
  const ready = countMaterializeReady(detail);
  const confirmed = window.confirm(
    `Legg ${ready} kort fra lotten "${detail.lot.name}" i samlingen?\n\n` +
      'Hver holding får source=lot, lotId=<denne lotten> og purchasePrice=allokert kostnad. ' +
      'Allerede materialiserte items hoppes over.',
  );
  if (!confirmed) return;
  await runMaterialize(detail, state, undefined);
}

async function handleMaterializeSelected(
  detail: LotDetail,
  state: LotDetailState,
): Promise<void> {
  // PR 18 hardening — only send ids that are actually ready. The
  // checkbox UI prunes ids on every render so this is normally a
  // no-op filter, but a stale selection state could otherwise reach
  // the service with an unallocated id and trigger
  // "Cannot materialise: N item(s) have no allocatedCost" — which
  // would contradict the button's "Legg valgte i samling (X)" label.
  const readyIds: string[] = [];
  for (const item of detail.items) {
    if (
      state.selectedItemIds.has(item.id) &&
      item.holdingId === null &&
      item.allocatedCost !== null &&
      item.deletedAt === null
    ) {
      readyIds.push(item.id);
    }
  }
  if (readyIds.length === 0) return;
  const confirmed = window.confirm(
    `Legg ${readyIds.length} valgte kort fra lotten "${detail.lot.name}" i samlingen?\n\n` +
      'Bare de valgte ready-itemene blir materialisert. Allerede materialiserte items hoppes over hvis de er med i utvalget.',
  );
  if (!confirmed) return;
  await runMaterialize(detail, state, readyIds);
}

async function handleMaterializeOne(
  detail: LotDetail,
  item: LotItemRecord,
  state: LotDetailState,
  container: HTMLElement,
): Promise<void> {
  if (item.allocatedCost === null) return;
  await runMaterialize(detail, state, [item.id]);
  void container;
}

async function runMaterialize(
  detail: LotDetail,
  state: LotDetailState,
  itemIds: readonly string[] | undefined,
): Promise<void> {
  try {
    const options =
      itemIds !== undefined ? { itemIds } : undefined;
    const result = await createLotService(getDb()).materializeHoldings(
      detail.lot.id,
      options,
    );
    if (result.noop) {
      const msg =
        result.skippedAlreadyMaterialised > 0
          ? `Alle ${result.skippedAlreadyMaterialised} valgte items var allerede i samlingen.`
          : 'Ingen items å legge til i samlingen.';
      window.alert(msg);
      return;
    }
    // Drop the materialised ids from the selection so the next render
    // doesn't keep them ticked.
    for (const updated of result.updatedItems) {
      state.selectedItemIds.delete(updated.id);
    }
    if (result.skippedAlreadyMaterialised > 0) {
      window.alert(
        `La til ${result.created.length} kort i samlingen. ` +
          `${result.skippedAlreadyMaterialised} var allerede der og ble hoppet over.`,
      );
    }
    window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
    // PR 22 — surface wishlist receive candidates for the freshly
    // materialised holdings. One grouped prompt, never one per card.
    void runReceivePromptForLotMaterialize(result.created);
  } catch (caught) {
    if (caught instanceof Error) {
      window.alert(`Kunne ikke legge i samling: ${caught.message}`);
    } else {
      window.alert('Kunne ikke legge i samling av en ukjent grunn.');
    }
  }
}

async function runReceivePromptForLotMaterialize(
  created: readonly HoldingRecord[],
): Promise<void> {
  if (created.length === 0) return;
  try {
    const candidates = await findReceiveCandidatesForHoldings(
      createWishlistRepo(getDb()),
      created,
    );
    if (candidates.length === 0) return;
    await openWishlistReceivePrompt({
      candidates,
      heading:
        candidates.length === 1
          ? `Lot-materialisering: 1 match på aktiv ønskeliste.`
          : `Lot-materialisering: ${candidates.length} matcher på aktiv ønskeliste.`,
    });
  } catch {
    // Non-fatal: holdings are already in the collection.
  }
}

async function handleSoftDeleteItem(item: LotItemRecord): Promise<void> {
  const confirmed = window.confirm(
    'Slett dette lot-itemet?\n\n' +
      'Itemet merkes som slettet og kan gjenopprettes senere.',
  );
  if (!confirmed) return;
  await createLotItemsRepo(getDb()).softDelete(
    item.id,
    'Soft-deleted from Lot Detail',
  );
  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
}

async function handleExportCsv(lotId: string): Promise<void> {
  const db = getDb();
  const exporter = createLotCsvExporter(
    db,
    createLotsRepo(db),
    createLotItemsRepo(db),
    createHoldingsRepo(db),
    createCardsRepo(db),
  );
  const result = await exporter.build(lotId);
  if (result === null) return;
  downloadTextFile(result.filename, result.content, { mimeType: 'text/csv' });
  const lot = await createLotsRepo(db).get(lotId);
  if (lot === undefined) return;
  await exporter.recordExport(lot, result.rowCount);
}
