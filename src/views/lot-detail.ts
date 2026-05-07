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
import { USER_DATA_CHANGED_EVENT } from '../components/events';
import { buildLotItemForm } from '../components/lot-item-form';
import { getDb } from '../db/database';
import { getCurrentLotId, navigate, navigateToCard } from '../router';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import { createLotItemsRepo } from '../repositories/lot-items-repo';
import { createLotsRepo } from '../repositories/lots-repo';
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

export function mountLotDetailView(container: HTMLElement): void {
  void renderInto(container);
  const refresh = (): void => {
    if (!container.isConnected) return;
    void renderInto(container);
  };
  window.addEventListener(USER_DATA_CHANGED_EVENT, refresh);
}

async function renderInto(container: HTMLElement): Promise<void> {
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

  root.appendChild(buildSummary(detail));
  root.appendChild(buildToolbar(detail));
  root.appendChild(buildItemsTable(detail));
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

function buildToolbar(detail: LotDetail): HTMLElement {
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

  const materialiseBtn = document.createElement('button');
  materialiseBtn.type = 'button';
  materialiseBtn.className = 'lot-detail-view__materialize';
  materialiseBtn.dataset['action'] = 'materialize';
  materialiseBtn.textContent = `Materialiser ${countMaterializeReady(detail)} holdings`;
  materialiseBtn.disabled = countMaterializeReady(detail) === 0;
  materialiseBtn.addEventListener('click', () => {
    void handleMaterialize(detail);
  });
  wrap.appendChild(materialiseBtn);

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

// ---------------------------------------------------------------------
// Items

function buildItemsTable(detail: LotDetail): HTMLElement {
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

  const table = document.createElement('table');
  table.className = 'lot-items-table';
  table.innerHTML = `
    <thead>
      <tr>
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
  const body = table.querySelector<HTMLElement>('[data-region="items-body"]');
  if (body !== null) {
    for (const item of detail.items) {
      const card = detail.cardsById.get(item.cardId) ?? null;
      const holding =
        item.holdingId !== null
          ? (detail.holdingsById.get(item.holdingId) ?? null)
          : null;
      body.appendChild(buildItemRow(detail.lot, item, card, holding));
    }
  }
  wrap.appendChild(table);
  return wrap;
}

function buildItemRow(
  lot: LotRecord,
  item: LotItemRecord,
  card: CardRecord | null,
  holding: HoldingRecord | null,
): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'lot-items-table__row';
  tr.dataset['itemId'] = item.id;
  if (item.holdingId !== null) {
    tr.dataset['materialized'] = 'true';
  }

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
    note.textContent = 'Materialisert (låst)';
    actions.appendChild(note);
  }
  tr.appendChild(actions);

  void lot;
  return tr;
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

async function handleMaterialize(detail: LotDetail): Promise<void> {
  const ready = countMaterializeReady(detail);
  const confirmed = window.confirm(
    `Opprett ${ready} holdings fra lotten "${detail.lot.name}"?\n\n` +
      'Hver holding får source=lot, lotId=<denne lotten> og purchasePrice=allokert kostnad. ' +
      'Allerede materialiserte items hoppes over.',
  );
  if (!confirmed) return;
  try {
    const result = await createLotService(getDb()).materializeHoldings(
      detail.lot.id,
    );
    if (result.noop) {
      window.alert('Ingen items å materialisere.');
      return;
    }
    window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  } catch (caught) {
    if (caught instanceof Error) {
      window.alert(`Materialisering feilet: ${caught.message}`);
    } else {
      window.alert('Materialisering feilet av en ukjent grunn.');
    }
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
