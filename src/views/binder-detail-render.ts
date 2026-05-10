// PR 34 — pure render builders lifted from
// `src/views/binder-detail.ts`.
//
// Every function here is **pure**: it produces DOM from its
// arguments and never reads or mutates the orchestrator's
// `ViewState` closure. State-coupled builders (`buildToolbar`,
// `buildAutoAssignSummary`, `buildPagesGrid`, `buildPagesNav`,
// `buildChecklist`, `buildChecklistNav`) stay in the orchestrator
// because they wire callbacks back to `renderInto`.
//
// The state-coupled grid + checklist wrappers in the orchestrator
// import `buildPage` / `buildSlot` / `buildChecklistRow` from this
// module to render their inner rows.

import { isReverseHoloTemplateSlot } from '../domain/card-variants';
import { navigateToCard } from '../router';
import type { BinderDetail } from '../services/binder-slot-service';
import { createLazyImage } from '../utils/lazy-image';
import type { BinderSlotRecord } from '../domain/types';

import {
  handlePlaceEligible,
  openAssign,
  openDirectAdd,
  openMenu,
} from './binder-detail-actions';
import {
  appendCell,
  appendStat,
  describeCondition,
  displaySlotNote,
  isSlotComplete,
  resolveCardForSlot,
  FINISH_LABELS,
  STATUS_LABELS,
} from './binder-detail-helpers';
import type { AssignableSlotInfo } from './binder-detail-helpers';

// ---------------------------------------------------------------------
// Header / summary block.

export function buildSummary(detail: BinderDetail): HTMLElement {
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

// ---------------------------------------------------------------------
// Master-set-gap banner skeleton (the async fill is in
// `binder-detail-actions.ts:populateGapBanner`).

export function buildGapBannerSkeleton(binderId: string): HTMLElement {
  const banner = document.createElement('section');
  banner.className = 'binder-detail-view__gap-summary';
  banner.dataset['region'] = 'binder-gap-summary';
  banner.dataset['binderId'] = binderId;
  const loading = document.createElement('p');
  loading.className = 'binder-detail-view__gap-summary-loading';
  loading.dataset['region'] = 'gap-summary-loading';
  loading.textContent = 'Laster gap-analyse …';
  banner.appendChild(loading);
  return banner;
}

// ---------------------------------------------------------------------
// Pages-mode page + slot renderers.

export function buildPage(
  detail: BinderDetail,
  pageNumber: number,
  slots: readonly BinderSlotRecord[],
  matches: (slot: BinderSlotRecord) => boolean,
  assignableInfo: Map<string, AssignableSlotInfo>,
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
    grid.appendChild(
      buildSlot(detail, slot, matches(slot), assignableInfo.get(slot.id) ?? null),
    );
  }
  page.appendChild(grid);
  return page;
}

export function buildSlot(
  detail: BinderDetail,
  slot: BinderSlotRecord,
  matchesFilter: boolean,
  assignable: AssignableSlotInfo | null,
): HTMLElement {
  const tile = document.createElement('article');
  const isReverseTemplate = isReverseHoloTemplateSlot(slot.note);
  tile.className = `binder-slot binder-slot--${slot.status}${
    !matchesFilter ? ' binder-slot--filtered-out' : ''
  }${isReverseTemplate ? ' binder-slot--reverse-template' : ''}`;
  tile.dataset['slotId'] = slot.id;
  tile.dataset['status'] = slot.status;
  tile.dataset['pageNumber'] = String(slot.pageNumber);
  tile.dataset['slotNumber'] = String(slot.slotNumber);
  tile.dataset['matchesFilter'] = matchesFilter ? 'true' : 'false';
  if (isReverseTemplate) {
    tile.dataset['reverseHoloTemplate'] = 'true';
  }
  if (!matchesFilter) {
    tile.setAttribute('aria-hidden', 'true');
  }

  const indexLabel = document.createElement('span');
  indexLabel.className = 'binder-slot__index';
  indexLabel.textContent = `${slot.pageNumber}.${slot.slotNumber}`;
  tile.appendChild(indexLabel);

  const statusBadge = document.createElement('span');
  statusBadge.className = `status-chip status-chip--${slot.status}`;
  statusBadge.dataset['region'] = 'status-badge';
  statusBadge.textContent = STATUS_LABELS[slot.status];
  tile.appendChild(statusBadge);

  if (isReverseTemplate) {
    const finishBadge = document.createElement('span');
    finishBadge.className = 'binder-slot__finish-badge';
    finishBadge.textContent = 'Reverse holo';
    tile.appendChild(finishBadge);
  }

  // PR 24 — assignable badge. Visible on missing target slots that
  // have at least one matching unassigned holding.
  if (assignable !== null && matchesFilter) {
    const badge = document.createElement('span');
    badge.className = 'binder-slot__assignable-badge';
    badge.dataset['region'] = 'assignable-badge';
    badge.textContent =
      assignable.count === 1
        ? 'Kan plasseres'
        : `Kan plasseres (${assignable.count})`;
    tile.appendChild(badge);
  }

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

    // Filtered-out tiles must have no focusable children (the tile is
    // `aria-hidden`). Render the card name as plain text instead of a
    // button so screen readers + keyboard users skip it cleanly.
    if (matchesFilter) {
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
    } else {
      const nameText = document.createElement('p');
      nameText.className = 'binder-slot__card-link binder-slot__card-link--inert';
      nameText.textContent = card.name;
      tile.appendChild(nameText);
    }

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

  // Action buttons are the only mutation surface in the grid view. We
  // never render them for a filtered-out tile so:
  //   1) The filter contract holds (filtered slots cannot be mutated).
  //   2) `aria-hidden` content has no focusable descendants.
  //   3) There is no accidental scroll/tab landing on an opaque tile
  //      the user filtered away.
  if (matchesFilter) {
    const actions = document.createElement('div');
    actions.className = 'binder-slot__actions';

    // PR 24 — single-click "Plasser" only renders when there is exactly
    // one eligible holding for this slot. Multi-candidate / wrong-finish
    // / blank slots fall back to the existing assign modal.
    if (
      assignable !== null &&
      assignable.count === 1 &&
      assignable.eligibleHoldingId !== null
    ) {
      const placeBtn = document.createElement('button');
      placeBtn.type = 'button';
      placeBtn.className = 'binder-slot__action binder-slot__action--success';
      placeBtn.dataset['action'] = 'place-eligible';
      placeBtn.textContent = 'Plasser';
      const eligibleHoldingId = assignable.eligibleHoldingId;
      placeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void handlePlaceEligible(slot, detail.binder.slotsPerPage, eligibleHoldingId);
      });
      actions.appendChild(placeBtn);
    }

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

    // PR 24 — direct add for target slots only. Blank slots route
    // through "Tilordne holding" (the existing modal) where the user
    // can search/pick from existing holdings.
    if (slot.targetCardId !== null && slot.holdingId === null) {
      const directAddBtn = document.createElement('button');
      directAddBtn.type = 'button';
      directAddBtn.className = 'binder-slot__action';
      directAddBtn.dataset['action'] = 'direct-add';
      directAddBtn.textContent = 'Legg til her';
      directAddBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void openDirectAdd(slot, detail.binder.slotsPerPage);
      });
      actions.appendChild(directAddBtn);
    }

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
  }
  return tile;
}

// ---------------------------------------------------------------------
// Checklist-mode row renderer.

export function buildChecklistRow(
  detail: BinderDetail,
  slot: BinderSlotRecord,
  assignable: AssignableSlotInfo | null,
): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const isReverseTemplate = isReverseHoloTemplateSlot(slot.note);
  tr.className = 'checklist-table__row';
  tr.dataset['slotId'] = slot.id;
  tr.dataset['status'] = slot.status;
  if (isReverseTemplate) {
    tr.dataset['reverseHoloTemplate'] = 'true';
  }

  const card = resolveCardForSlot(detail, slot);
  const holding =
    slot.holdingId !== null
      ? (detail.holdingsById.get(slot.holdingId) ?? null)
      : null;

  appendCell(tr, card?.number ?? '');
  appendCell(tr, card?.name ?? slot.targetCardId ?? '–');
  appendCell(tr, card?.id ?? '');

  const finishLabel = isReverseTemplate
    ? 'Reverse holo'
    : (holding !== null ? FINISH_LABELS[holding.finish] : '–');
  appendCell(tr, finishLabel);

  // PR 24 — append a "Kan plasseres" indicator inline with the status
  // cell so the checklist surfaces the same affordance as the grid
  // tile. Empty cell when no candidate.
  const statusCell = document.createElement('td');
  const statusLabel = document.createElement('span');
  statusLabel.textContent = STATUS_LABELS[slot.status];
  statusCell.appendChild(statusLabel);
  if (assignable !== null) {
    const badge = document.createElement('span');
    badge.className = 'checklist-table__assignable-badge';
    badge.dataset['region'] = 'assignable-badge';
    badge.textContent =
      assignable.count === 1
        ? 'Kan plasseres'
        : `Kan plasseres (${assignable.count})`;
    statusCell.appendChild(badge);
  }
  tr.appendChild(statusCell);

  appendCell(tr, isSlotComplete(slot, detail) ? '✓' : '–');
  appendCell(tr, `${slot.pageNumber}.${slot.slotNumber}`);
  appendCell(tr, describeCondition(holding));
  appendCell(tr, displaySlotNote(slot));

  const actions = document.createElement('td');
  actions.className = 'checklist-table__actions';
  // PR 24 — single-click "Plasser" mirrors the grid action.
  if (
    assignable !== null &&
    assignable.count === 1 &&
    assignable.eligibleHoldingId !== null
  ) {
    const place = document.createElement('button');
    place.type = 'button';
    place.className = 'checklist-table__action checklist-table__action--success';
    place.dataset['action'] = 'place-eligible';
    place.textContent = 'Plasser';
    const eligibleHoldingId = assignable.eligibleHoldingId;
    place.addEventListener('click', (event) => {
      event.stopPropagation();
      void handlePlaceEligible(slot, detail.binder.slotsPerPage, eligibleHoldingId);
    });
    actions.appendChild(place);
  }
  const assign = document.createElement('button');
  assign.type = 'button';
  assign.className = 'checklist-table__action';
  assign.dataset['action'] = 'assign';
  assign.textContent = slot.holdingId === null ? 'Tilordne' : 'Bytt';
  assign.addEventListener('click', (event) => {
    event.stopPropagation();
    void openAssign(slot, detail.binder.slotsPerPage);
  });
  actions.appendChild(assign);
  if (slot.targetCardId !== null && slot.holdingId === null) {
    const directAdd = document.createElement('button');
    directAdd.type = 'button';
    directAdd.className = 'checklist-table__action';
    directAdd.dataset['action'] = 'direct-add';
    directAdd.textContent = 'Legg til her';
    directAdd.addEventListener('click', (event) => {
      event.stopPropagation();
      void openDirectAdd(slot, detail.binder.slotsPerPage);
    });
    actions.appendChild(directAdd);
  }
  const menu = document.createElement('button');
  menu.type = 'button';
  menu.className = 'checklist-table__action';
  menu.dataset['action'] = 'open-menu';
  menu.textContent = 'Status';
  menu.addEventListener('click', (event) => {
    event.stopPropagation();
    void openMenu(slot, detail.binder.slotsPerPage);
  });
  actions.appendChild(menu);
  tr.appendChild(actions);

  return tr;
}
