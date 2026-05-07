// Lots list view. Replaces the placeholder. Shows every live lot with
// its derived status chip and links to the lot-detail route via
// `#lot/<id>`. Reads via `lot-detail-service`. Mutations route through
// `lotsRepo` (form save / soft-delete / restore).

import { openDialog } from '../components/dialog';
import { USER_DATA_CHANGED_EVENT, onUserDataChanged } from '../components/events';
import { buildLotForm } from '../components/lot-form';
import { getDb } from '../db/database';
import { navigateToLot } from '../router';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import { createLotItemsRepo } from '../repositories/lot-items-repo';
import { createLotsRepo } from '../repositories/lots-repo';
import {
  createLotDetailService,
  type LotStatus,
  type LotSummary,
} from '../services/lot-detail-service';
import type { LotRecord } from '../domain/types';

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

export function mountLotsView(
  container: HTMLElement,
  signal?: AbortSignal,
): void {
  container.innerHTML = `
    <section class="lots-view" aria-labelledby="lots-heading">
      <header class="lots-view__header">
        <h1 id="lots-heading">Lotter</h1>
        <button type="button" class="lots-view__add" data-action="new-lot">
          Ny lot
        </button>
      </header>
      <p class="lots-view__counts" data-region="counts"></p>
      <div class="lots-view__list" data-region="list"></div>
    </section>
  `;

  const newButton = container.querySelector<HTMLButtonElement>(
    '[data-action="new-lot"]',
  );
  newButton?.addEventListener('click', () => {
    void handleNewLot(container);
  });

  void rerender(container);

  // PR 15A — F-3: router signal drops this listener on next route.
  onUserDataChanged(() => {
    if (!container.isConnected) return;
    void rerender(container);
  }, signal);
}

async function rerender(container: HTMLElement): Promise<void> {
  const listRegion = container.querySelector<HTMLElement>('[data-region="list"]');
  const countsRegion = container.querySelector<HTMLElement>('[data-region="counts"]');
  if (listRegion === null || countsRegion === null) return;

  const db = getDb();
  const service = createLotDetailService(
    createLotsRepo(db),
    createLotItemsRepo(db),
    createHoldingsRepo(db),
    createCardsRepo(db),
  );
  const summaries = await service.listSummaries();

  countsRegion.textContent = `${summaries.length} aktive lotter`;

  listRegion.replaceChildren();
  if (summaries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'lots-view__empty';
    empty.textContent =
      'Ingen lotter ennå. Opprett din første lot for å registrere et bulk-kjøp.';
    listRegion.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  table.className = 'lots-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Navn</th>
        <th>Dato</th>
        <th>Total</th>
        <th>Items</th>
        <th>Allokert</th>
        <th>Materialisert</th>
        <th>Status</th>
        <th class="lots-table__actions-col">Handlinger</th>
      </tr>
    </thead>
    <tbody data-region="rows"></tbody>
  `;
  const rows = table.querySelector<HTMLElement>('[data-region="rows"]');
  if (rows !== null) {
    for (const summary of summaries) {
      rows.appendChild(buildRow(summary));
    }
  }
  listRegion.appendChild(table);
}

function buildRow(summary: LotSummary): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = 'lots-table__row';
  tr.dataset['lotId'] = summary.lot.id;

  const nameCell = document.createElement('td');
  const nameButton = document.createElement('button');
  nameButton.type = 'button';
  nameButton.className = 'lots-table__name-link';
  nameButton.dataset['action'] = 'open';
  nameButton.textContent = summary.lot.name;
  nameButton.addEventListener('click', () => {
    navigateToLot(summary.lot.id);
  });
  nameCell.appendChild(nameButton);
  tr.appendChild(nameCell);

  appendCell(tr, summary.lot.purchaseDate.slice(0, 10));
  appendCell(tr, `${summary.lot.totalCost.toFixed(2)} ${summary.lot.currency}`);
  appendCell(tr, String(summary.itemCount));
  appendCell(
    tr,
    `${summary.allocatedTotal.toFixed(2)} / ${summary.lot.totalCost.toFixed(2)}`,
  );
  appendCell(tr, `${summary.materializedCount} / ${summary.itemCount}`);

  const statusCell = document.createElement('td');
  const chip = document.createElement('span');
  chip.className = STATUS_CHIP_CLASS[summary.status];
  chip.textContent = STATUS_LABELS[summary.status];
  statusCell.appendChild(chip);
  tr.appendChild(statusCell);

  const actionsCell = document.createElement('td');
  actionsCell.className = 'lots-table__actions';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'lots-table__action';
  editBtn.dataset['action'] = 'edit';
  editBtn.textContent = 'Rediger';
  editBtn.addEventListener('click', () => {
    void handleEdit(summary.lot);
  });
  actionsCell.appendChild(editBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'lots-table__action lots-table__action--danger';
  deleteBtn.dataset['action'] = 'soft-delete';
  deleteBtn.textContent = 'Slett';
  deleteBtn.addEventListener('click', () => {
    void handleSoftDelete(summary.lot);
  });
  actionsCell.appendChild(deleteBtn);

  tr.appendChild(actionsCell);
  return tr;
}

function appendCell(tr: HTMLTableRowElement, value: string): void {
  const td = document.createElement('td');
  td.textContent = value;
  tr.appendChild(td);
}

async function handleNewLot(container: HTMLElement): Promise<void> {
  const result = await openDialog(buildLotForm({ mode: 'add' }));
  if (result === 'submitted' && container.isConnected) {
    await rerender(container);
  }
}

async function handleEdit(lot: LotRecord): Promise<void> {
  await openDialog(buildLotForm({ mode: 'edit', lot }));
}

async function handleSoftDelete(lot: LotRecord): Promise<void> {
  const confirmed = window.confirm(
    `Slett lotten "${lot.name}"?\n\n` +
      'Lotten merkes som slettet. Items og evt. materialiserte holdings beholdes.',
  );
  if (!confirmed) return;
  await createLotsRepo(getDb()).softDelete(
    lot.id,
    'Soft-deleted from Lots view',
  );
  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
}
