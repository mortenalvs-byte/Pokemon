// Binder detail view. Renders the page/slot grid for a single binder
// reached via the `#binder/<id>` sub-route. Each slot tile shows its
// page/slot index, a status badge, and (when applicable) the assigned
// card thumbnail + name. Slot tiles open the slot action menu; an
// explicit "Tilordne holding" button opens the assign modal.
//
// Reads via `binder-slot-service`. Mutations are dispatched by the
// dialogs (slot-action-menu, assign-holding-modal) which all go through
// `binder-slots-repo` so validation + audit run.

import { openDialog } from '../components/dialog';
import { USER_DATA_CHANGED_EVENT } from '../components/events';
import { buildAssignHoldingModal } from '../components/assign-holding-modal';
import { buildSlotActionMenu } from '../components/slot-action-menu';
import { getDb } from '../db/database';
import { getCurrentBinderId, navigate, navigateToCard } from '../router';
import { createBindersRepo } from '../repositories/binders-repo';
import { createBinderSlotsRepo } from '../repositories/binder-slots-repo';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import {
  createBinderSlotService,
  type BinderDetail,
} from '../services/binder-slot-service';
import { createLazyImage } from '../utils/lazy-image';
import type {
  BinderSlotRecord,
  BinderSlotStatus,
  CardRecord,
  HoldingRecord,
} from '../domain/types';

const STATUS_LABELS: Record<BinderSlotStatus, string> = {
  empty: 'Tom',
  wanted: 'Ønsket',
  owned: 'Eid',
  missing: 'Mangler',
  ordered: 'Bestilt',
  duplicate: 'Duplikat',
  upgrade_needed: 'Oppgrader',
};

export function mountBinderDetailView(container: HTMLElement): void {
  void renderInto(container);

  // Same pattern as Card Detail: refresh on user-data changes from any
  // dialog or other view. The `isConnected` guard skips updates after
  // the route has unmounted.
  const refresh = (): void => {
    if (!container.isConnected) return;
    void renderInto(container);
  };
  window.addEventListener(USER_DATA_CHANGED_EVENT, refresh);
}

async function renderInto(container: HTMLElement): Promise<void> {
  container.innerHTML = '';
  const binderId = getCurrentBinderId();

  const root = document.createElement('section');
  root.className = 'binder-detail-view';
  container.appendChild(root);

  const header = document.createElement('div');
  header.className = 'binder-detail-view__header';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'binder-detail-view__back';
  back.dataset['action'] = 'back';
  back.textContent = '← Tilbake til Permer';
  back.addEventListener('click', () => {
    navigate('binders');
  });
  header.appendChild(back);
  root.appendChild(header);

  if (binderId === null) {
    appendMessage(root, 'Ingen perm valgt. Gå tilbake til Permer-listen.');
    return;
  }

  const db = getDb();
  const service = createBinderSlotService(
    createBindersRepo(db),
    createBinderSlotsRepo(db),
    createHoldingsRepo(db),
    createCardsRepo(db),
  );
  const detail = await service.getDetail(binderId);
  if (detail === null) {
    appendMessage(root, 'Permen finnes ikke (eller er slettet). Gå tilbake til Permer-listen.');
    return;
  }

  root.appendChild(buildSummary(detail));
  root.appendChild(buildPagesGrid(detail));
}

function appendMessage(root: HTMLElement, text: string): void {
  const p = document.createElement('p');
  p.className = 'binder-detail-view__message';
  p.textContent = text;
  root.appendChild(p);
}

function buildSummary(detail: BinderDetail): HTMLElement {
  const summary = document.createElement('header');
  summary.className = 'binder-detail-view__summary';

  const title = document.createElement('h1');
  title.className = 'binder-detail-view__title';
  title.textContent = detail.binder.name;
  summary.appendChild(title);

  if (detail.binder.binderType !== null) {
    const t = document.createElement('p');
    t.className = 'binder-detail-view__type';
    t.textContent = detail.binder.binderType;
    summary.appendChild(t);
  }
  if (detail.binder.description !== null) {
    const d = document.createElement('p');
    d.className = 'binder-detail-view__description';
    d.textContent = detail.binder.description;
    summary.appendChild(d);
  }

  const stats = document.createElement('dl');
  stats.className = 'binder-detail-view__stats';
  appendStat(stats, 'Sider', String(detail.binder.totalPages));
  appendStat(stats, 'Slots/side', String(detail.binder.slotsPerPage));
  appendStat(
    stats,
    'Mål-slots',
    String(detail.completion.totalTargetSlots),
  );
  appendStat(
    stats,
    'Fullført',
    `${detail.completion.completedSlots} (${detail.completion.percentage}%)`,
  );
  appendStat(stats, 'Mangler', String(detail.completion.missingSlots));
  summary.appendChild(stats);

  const progress = document.createElement('div');
  progress.className = 'binder-detail-view__progress';
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  progress.setAttribute('aria-valuenow', String(detail.completion.percentage));
  const fill = document.createElement('span');
  fill.className = 'binder-detail-view__progress-fill';
  fill.style.width = `${detail.completion.percentage}%`;
  progress.appendChild(fill);
  summary.appendChild(progress);

  return summary;
}

function appendStat(dl: HTMLDListElement, label: string, value: string): void {
  const dt = document.createElement('dt');
  dt.textContent = label;
  dl.appendChild(dt);
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dd);
}

function buildPagesGrid(detail: BinderDetail): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'binder-detail-view__pages';

  if (detail.slots.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'binder-detail-view__empty';
    empty.textContent =
      'Permen har ingen slots ennå. Hvis dette er en ny perm, prøv å rendre på nytt eller opprett en ny perm.';
    wrap.appendChild(empty);
    return wrap;
  }

  const slotsByPage = new Map<number, BinderSlotRecord[]>();
  for (const slot of detail.slots) {
    let page = slotsByPage.get(slot.pageNumber);
    if (page === undefined) {
      page = [];
      slotsByPage.set(slot.pageNumber, page);
    }
    page.push(slot);
  }

  const sortedPageNumbers = [...slotsByPage.keys()].sort((a, b) => a - b);
  for (const pageNumber of sortedPageNumbers) {
    const slotsForPage = slotsByPage.get(pageNumber);
    if (slotsForPage === undefined) continue;
    wrap.appendChild(
      buildPage(detail, pageNumber, slotsForPage),
    );
  }

  return wrap;
}

function buildPage(
  detail: BinderDetail,
  pageNumber: number,
  slots: readonly BinderSlotRecord[],
): HTMLElement {
  const page = document.createElement('section');
  page.className = 'binder-page';
  page.dataset['pageNumber'] = String(pageNumber);

  const heading = document.createElement('h2');
  heading.className = 'binder-page__heading';
  heading.textContent = `Side ${pageNumber}`;
  page.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = `binder-page__grid binder-page__grid--${detail.binder.slotsPerPage}`;
  for (const slot of slots) {
    grid.appendChild(buildSlot(detail, slot));
  }
  page.appendChild(grid);
  return page;
}

function buildSlot(
  detail: BinderDetail,
  slot: BinderSlotRecord,
): HTMLElement {
  const tile = document.createElement('article');
  tile.className = `binder-slot binder-slot--${slot.status}`;
  tile.dataset['slotId'] = slot.id;
  tile.dataset['status'] = slot.status;
  tile.dataset['pageNumber'] = String(slot.pageNumber);
  tile.dataset['slotNumber'] = String(slot.slotNumber);

  const indexLabel = document.createElement('span');
  indexLabel.className = 'binder-slot__index';
  indexLabel.textContent = `${slot.pageNumber}.${slot.slotNumber}`;
  tile.appendChild(indexLabel);

  const statusBadge = document.createElement('span');
  statusBadge.className = `status-chip status-chip--${slot.status}`;
  statusBadge.dataset['region'] = 'status-badge';
  statusBadge.textContent = STATUS_LABELS[slot.status];
  tile.appendChild(statusBadge);

  const card = resolveCardForSlot(detail, slot);
  if (card !== null) {
    const thumb = createLazyImage({
      src: card.imageSmall,
      alt: card.name,
      width: 80,
      height: 112,
      className: 'binder-slot__thumb',
    });
    tile.appendChild(thumb);

    const nameButton = document.createElement('button');
    nameButton.type = 'button';
    nameButton.className = 'binder-slot__card-link';
    nameButton.dataset['action'] = 'open-card';
    nameButton.textContent = card.name;
    nameButton.addEventListener('click', (event) => {
      event.stopPropagation();
      navigateToCard(card.id);
    });
    tile.appendChild(nameButton);

    const meta = document.createElement('p');
    meta.className = 'binder-slot__meta';
    meta.textContent = `${card.id}`;
    tile.appendChild(meta);
  } else {
    const placeholder = document.createElement('p');
    placeholder.className = 'binder-slot__empty';
    placeholder.textContent =
      slot.targetCardId !== null
        ? `Mål: ${slot.targetCardId}`
        : 'Tom slot';
    tile.appendChild(placeholder);
  }

  const actions = document.createElement('div');
  actions.className = 'binder-slot__actions';

  const assignBtn = document.createElement('button');
  assignBtn.type = 'button';
  assignBtn.className = 'binder-slot__action';
  assignBtn.dataset['action'] = 'assign';
  assignBtn.textContent =
    slot.holdingId === null ? 'Tilordne holding' : 'Bytt holding';
  assignBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    void openAssign(slot, detail.binder.slotsPerPage);
  });
  actions.appendChild(assignBtn);

  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'binder-slot__action';
  menuBtn.dataset['action'] = 'open-menu';
  menuBtn.textContent = 'Endre status';
  menuBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    void openMenu(slot, detail.binder.slotsPerPage);
  });
  actions.appendChild(menuBtn);

  tile.appendChild(actions);
  return tile;
}

function resolveCardForSlot(
  detail: BinderDetail,
  slot: BinderSlotRecord,
): CardRecord | null {
  if (slot.holdingId !== null) {
    const holding = detail.holdingsById.get(slot.holdingId);
    if (holding !== undefined) {
      return resolveCardFromHolding(detail, holding);
    }
  }
  if (slot.targetCardId !== null) {
    return detail.cardsById.get(slot.targetCardId) ?? null;
  }
  return null;
}

function resolveCardFromHolding(
  detail: BinderDetail,
  holding: HoldingRecord,
): CardRecord | null {
  return detail.cardsById.get(holding.cardId) ?? null;
}

async function openAssign(
  slot: BinderSlotRecord,
  slotsPerPage: 9 | 18,
): Promise<void> {
  await openDialog(buildAssignHoldingModal({ slot, slotsPerPage }));
}

async function openMenu(
  slot: BinderSlotRecord,
  slotsPerPage: 9 | 18,
): Promise<void> {
  await openDialog(buildSlotActionMenu({ slot, slotsPerPage }));
}
