// Binders list view. Shows every live binder with its completion stats
// and lets the user create new ones (manual binders only — the from-set
// wizard ships in PR 8b). Each row links to the binder detail view via
// the `#binder/<id>` sub-route.
//
// Reads via `binder-slot-service`. Mutations always go through
// `binders-repo` or `binder-service` so validation + audit run.

import { openDialog } from '../components/dialog';
import { USER_DATA_CHANGED_EVENT } from '../components/events';
import { buildBinderForm } from '../components/binder-form';
import { buildBinderFromSetWizard } from '../components/binder-from-set-wizard';
import { getDb } from '../db/database';
import { getBinderPresetDefinition } from '../domain/binder-presets';
import { navigateToBinder } from '../router';
import { createBindersRepo } from '../repositories/binders-repo';
import { createBinderSlotsRepo } from '../repositories/binder-slots-repo';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import {
  createBinderSlotService,
  type BinderSummary,
} from '../services/binder-slot-service';
import type { BinderRecord, CompletionMode } from '../domain/types';

const COMPLETION_MODE_LABELS: Record<CompletionMode, string> = {
  standard: 'Standard',
  master: 'Master',
  grand_master: 'Grand master',
};

export function mountBindersView(container: HTMLElement): void {
  container.innerHTML = `
    <section class="binders-view" aria-labelledby="binders-heading">
      <header class="binders-view__header">
        <h1 id="binders-heading">Permer</h1>
        <div class="binders-view__actions">
          <button type="button" class="binders-view__add" data-action="new-binder">
            Ny perm
          </button>
          <button type="button" class="binders-view__add" data-action="new-from-set">
            Ny perm fra sett
          </button>
        </div>
      </header>
      <p class="binders-view__counts" data-region="counts"></p>
      <div class="binders-view__list" data-region="list"></div>
    </section>
  `;

  const listRegion = container.querySelector<HTMLElement>('[data-region="list"]');
  const countsRegion = container.querySelector<HTMLElement>('[data-region="counts"]');
  const newButton = container.querySelector<HTMLButtonElement>(
    '[data-action="new-binder"]',
  );
  const fromSetButton = container.querySelector<HTMLButtonElement>(
    '[data-action="new-from-set"]',
  );
  if (
    listRegion === null ||
    countsRegion === null ||
    newButton === null ||
    fromSetButton === null
  ) {
    return;
  }

  newButton.addEventListener('click', () => {
    void handleNewBinder(container);
  });

  fromSetButton.addEventListener('click', () => {
    void handleNewFromSet(container);
  });

  void rerender(container);

  // Refresh on user-data changes from any other view (form save, slot
  // assign, soft-delete from card detail, etc.). The `isConnected`
  // guard skips updates after the route has unmounted.
  window.addEventListener(USER_DATA_CHANGED_EVENT, () => {
    if (!container.isConnected) return;
    void rerender(container);
  });
}

async function rerender(container: HTMLElement): Promise<void> {
  const listRegion = container.querySelector<HTMLElement>('[data-region="list"]');
  const countsRegion = container.querySelector<HTMLElement>('[data-region="counts"]');
  if (listRegion === null || countsRegion === null) return;

  const db = getDb();
  const service = createBinderSlotService(
    createBindersRepo(db),
    createBinderSlotsRepo(db),
    createHoldingsRepo(db),
    createCardsRepo(db),
  );
  const summaries = await service.listSummaries();

  countsRegion.textContent = `${summaries.length} aktive permer`;

  listRegion.replaceChildren();
  if (summaries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'binders-view__empty';
    empty.textContent =
      'Ingen permer ennå. Opprett din første perm for å begynne å organisere samlingen.';
    listRegion.appendChild(empty);
    return;
  }

  for (const summary of summaries) {
    listRegion.appendChild(buildBinderCard(summary));
  }
}

function buildBinderCard(summary: BinderSummary): HTMLElement {
  const card = document.createElement('article');
  card.className = 'binder-card';
  card.dataset['binderId'] = summary.binder.id;

  const heading = document.createElement('header');
  heading.className = 'binder-card__header';

  const titleButton = document.createElement('button');
  titleButton.type = 'button';
  titleButton.className = 'binder-card__title';
  titleButton.dataset['action'] = 'open';
  titleButton.textContent = summary.binder.name;
  titleButton.addEventListener('click', () => {
    navigateToBinder(summary.binder.id);
  });
  heading.appendChild(titleButton);

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'binder-card__edit';
  editBtn.dataset['action'] = 'edit';
  editBtn.textContent = 'Rediger';
  editBtn.addEventListener('click', () => {
    void handleEdit(summary.binder);
  });
  heading.appendChild(editBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'binder-card__delete';
  deleteBtn.dataset['action'] = 'soft-delete';
  deleteBtn.textContent = 'Slett';
  deleteBtn.addEventListener('click', () => {
    void handleSoftDelete(summary.binder);
  });
  heading.appendChild(deleteBtn);

  card.appendChild(heading);

  if (summary.binder.binderType !== null) {
    const typeP = document.createElement('p');
    typeP.className = 'binder-card__type';
    typeP.textContent = summary.binder.binderType;
    card.appendChild(typeP);
  }
  if (summary.binder.description !== null) {
    const descP = document.createElement('p');
    descP.className = 'binder-card__description';
    descP.textContent = summary.binder.description;
    card.appendChild(descP);
  }

  const stats = document.createElement('dl');
  stats.className = 'binder-card__stats';
  if (summary.binder.binderPreset !== null) {
    const def = getBinderPresetDefinition(summary.binder.binderPreset);
    appendStat(stats, 'Permtype', def.label);
  }
  appendStat(stats, 'Sider', String(summary.binder.totalPages));
  appendStat(stats, 'Slots/side', String(summary.binder.slotsPerPage));
  appendStat(
    stats,
    'Kapasitet',
    String(summary.binder.totalPages * summary.binder.slotsPerPage),
  );
  appendStat(stats, 'Modus', COMPLETION_MODE_LABELS[summary.binder.completionMode]);
  appendStat(
    stats,
    'Mål-slots',
    String(summary.completion.totalTargetSlots),
  );
  appendStat(
    stats,
    'Fullført',
    `${summary.completion.completedSlots} (${summary.completion.percentage}%)`,
  );
  appendStat(stats, 'Mangler', String(summary.completion.missingSlots));
  card.appendChild(stats);

  const progress = document.createElement('div');
  progress.className = 'binder-card__progress';
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  progress.setAttribute('aria-valuenow', String(summary.completion.percentage));
  const fill = document.createElement('span');
  fill.className = 'binder-card__progress-fill';
  fill.style.width = `${summary.completion.percentage}%`;
  progress.appendChild(fill);
  card.appendChild(progress);

  return card;
}

function appendStat(dl: HTMLDListElement, label: string, value: string): void {
  const dt = document.createElement('dt');
  dt.textContent = label;
  dl.appendChild(dt);
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.appendChild(dd);
}

async function handleNewBinder(container: HTMLElement): Promise<void> {
  const result = await openDialog(buildBinderForm({ mode: 'add' }));
  if (result === 'submitted' && container.isConnected) {
    await rerender(container);
  }
}

async function handleNewFromSet(container: HTMLElement): Promise<void> {
  const result = await openDialog(buildBinderFromSetWizard());
  if (result === 'submitted' && container.isConnected) {
    await rerender(container);
  }
}

async function handleEdit(binder: BinderRecord): Promise<void> {
  await openDialog(buildBinderForm({ mode: 'edit', binder }));
}

async function handleSoftDelete(binder: BinderRecord): Promise<void> {
  const confirmed = window.confirm(
    `Slett permen "${binder.name}"?\n\n` +
      'Permen merkes som slettet. Slottene blir liggende i databasen og kan gjenopprettes ved å gjenopprette permen.',
  );
  if (!confirmed) return;
  await createBindersRepo(getDb()).softDelete(
    binder.id,
    'Soft-deleted from Binders view',
  );
  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
}
