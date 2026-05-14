// Dialog: build + preview + apply a multi-binder master-set plan.
//
// Two-stage flow:
//   1. "plan" stage — read all live sets + cards from cache, run the
//      pure planner, render a per-binder + per-section preview.
//   2. "apply" stage — write each binder via
//      `applyMasterSetPlan`, fire progress updates, then dispatch
//      USER_DATA_CHANGED + close.
//
// The dialog never writes data on its own — all writes go through
// `binderService.createMultiSetMasterBinder` via the apply helper,
// which preserves audit + validation.

import { DIALOG_SUBMITTED_EVENT } from './dialog';
import { USER_DATA_CHANGED_EVENT } from './events';
import { getDb } from '../db/database';
import { createBindersRepo } from '../repositories/binders-repo';
import { createCardsRepo } from '../repositories/cards-repo';
import { createSetsRepo } from '../repositories/sets-repo';
import { createBinderService } from '../services/binder-service';
import {
  applyMasterSetPlan,
  buildBinderName,
} from '../services/master-set-binder-apply';
import {
  buildMasterSetPlan,
  type MasterSetBinderPlan,
  type MasterSetPlanResult,
  type MasterSetSectionPlan,
} from '../services/master-set-binder-planner';
import type { CardRecord, SetRecord } from '../domain/types';
import type { DialogContent } from './dialog';

export function buildMasterSetBinderPlanDialog(): DialogContent {
  return {
    mount(host, close) {
      void mount(host, close);
    },
  };
}

async function mount(host: HTMLElement, close: () => void): Promise<void> {
  host.appendChild(buildSkeleton());
  const form = host.querySelector<HTMLFormElement>('form.master-plan-form');
  if (form === null) return;

  const status = form.querySelector<HTMLElement>('[data-region="status"]');
  const summary = form.querySelector<HTMLElement>('[data-region="summary"]');
  const list = form.querySelector<HTMLElement>('[data-region="binder-list"]');
  const cancelBtn = form.querySelector<HTMLButtonElement>('[data-action="cancel"]');
  const applyBtn = form.querySelector<HTMLButtonElement>('[data-region="apply-btn"]');
  const errorRegion = form.querySelector<HTMLElement>('[data-region="error"]');
  if (
    status === null ||
    summary === null ||
    list === null ||
    cancelBtn === null ||
    applyBtn === null ||
    errorRegion === null
  ) {
    return;
  }

  cancelBtn.addEventListener('click', () => close());

  status.textContent = 'Laster sett + kort …';
  applyBtn.disabled = true;

  let planResult: MasterSetPlanResult;
  try {
    planResult = await buildPlanFromDb();
  } catch (caught) {
    status.textContent = '';
    errorRegion.textContent = `Feil under planlegging: ${caught instanceof Error ? caught.message : 'ukjent feil'}`;
    return;
  }

  renderSummary(summary, planResult);
  renderBinderList(list, planResult);
  status.textContent = '';

  if (planResult.binders.length === 0) {
    applyBtn.textContent = 'Ingenting å lage';
    applyBtn.disabled = true;
    return;
  }

  applyBtn.textContent = `Opprett ${planResult.binders.length} ${planResult.binders.length === 1 ? 'perm' : 'permer'}`;
  applyBtn.disabled = false;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void runApply(form, planResult, host, close);
  });
}

async function buildPlanFromDb(): Promise<MasterSetPlanResult> {
  const db = getDb();
  const setsRepo = createSetsRepo(db);
  const cardsRepo = createCardsRepo(db);
  const sets: readonly SetRecord[] = await setsRepo.list();
  const allCards: readonly CardRecord[] = await cardsRepo.list();
  const cardsBySetId = new Map<string, CardRecord[]>();
  for (const c of allCards) {
    let bucket = cardsBySetId.get(c.setId);
    if (bucket === undefined) {
      bucket = [];
      cardsBySetId.set(c.setId, bucket);
    }
    bucket.push(c);
  }
  return buildMasterSetPlan({ sets, cardsBySetId });
}

async function runApply(
  form: HTMLFormElement,
  plan: MasterSetPlanResult,
  host: HTMLElement,
  close: () => void,
): Promise<void> {
  const status = form.querySelector<HTMLElement>('[data-region="status"]');
  const applyBtn = form.querySelector<HTMLButtonElement>('[data-region="apply-btn"]');
  const cancelBtn = form.querySelector<HTMLButtonElement>('[data-action="cancel"]');
  const errorRegion = form.querySelector<HTMLElement>('[data-region="error"]');
  if (
    status === null ||
    applyBtn === null ||
    cancelBtn === null ||
    errorRegion === null
  ) {
    return;
  }
  applyBtn.disabled = true;
  cancelBtn.disabled = true;
  errorRegion.textContent = '';

  const restoreControls = (): void => {
    applyBtn.disabled = false;
    cancelBtn.disabled = false;
  };

  // CodeRabbit feedback: an unhandled rejection here used to leave both
  // buttons disabled forever. Wrap setup + apply in one catch so any
  // failure (repo list, service init, the apply loop) restores controls
  // and surfaces the message.
  let result: Awaited<ReturnType<typeof applyMasterSetPlan>>;
  try {
    const service = createBinderService(getDb());
    const bindersRepo = createBindersRepo(getDb());
    const existing = await bindersRepo.listLive();
    const existingNames = new Set(existing.map((b) => b.name));

    // Generate unique names containing each binder's set IDs.
    const total = plan.binders.length;
    const names: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const binderPlan = plan.binders[i];
      if (binderPlan === undefined) continue;
      const base = buildBinderName(binderPlan, i + 1, total);
      let candidate = base;
      let suffix = 0;
      while (existingNames.has(candidate)) {
        suffix += 1;
        candidate = `${base} (#${suffix})`;
      }
      existingNames.add(candidate);
      names.push(candidate);
    }

    result = await applyMasterSetPlan(service, plan, {
      binderNames: names,
      onProgress: (e) => {
        status.textContent = `Oppretter perm ${e.index} av ${e.total}: ${e.binderName}`;
      },
    });
  } catch (caught) {
    errorRegion.textContent =
      `Oppretting feilet før noen permer ble skrevet: ${caught instanceof Error ? caught.message : 'ukjent feil'}`;
    restoreControls();
    return;
  }

  if (result.failedAt !== null) {
    errorRegion.textContent =
      `Stoppet ved perm ${result.failedAt.index} ("${result.failedAt.attemptedName}"): ${result.failedAt.error}. ` +
      `${result.created.length} permer ble opprettet før feilen.`;
    restoreControls();
    window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
    return;
  }

  status.textContent = `Ferdig — opprettet ${result.created.length} permer.`;
  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  host.dispatchEvent(new CustomEvent(DIALOG_SUBMITTED_EVENT));
  setTimeout(close, 600);
}

function renderSummary(
  region: HTMLElement,
  plan: MasterSetPlanResult,
): void {
  const totalSections = plan.binders.reduce(
    (sum, b) => sum + b.sections.length,
    0,
  );
  region.innerHTML = `
    <dl class="master-plan-summary">
      <div><dt>Permer</dt><dd>${plan.binders.length}</dd></div>
      <div><dt>Sett</dt><dd>${plan.totalSetCount}</dd></div>
      <div><dt>Sections totalt</dt><dd>${totalSections}</dd></div>
      <div><dt>Slots totalt</dt><dd>${plan.totalSlotCount.toLocaleString('nb-NO')}</dd></div>
      <div><dt>Kort i grunnlag</dt><dd>${plan.totalCardCount.toLocaleString('nb-NO')}</dd></div>
      <div><dt>Skippet</dt><dd>${plan.skippedSets.length}</dd></div>
    </dl>
  `;
}

function renderBinderList(
  region: HTMLElement,
  plan: MasterSetPlanResult,
): void {
  region.innerHTML = '';
  if (plan.binders.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'Ingen sett funnet — gjør en sync først.';
    region.appendChild(p);
    return;
  }
  for (const binder of plan.binders) {
    region.appendChild(buildBinderBlock(binder));
  }
}

function buildBinderBlock(binder: MasterSetBinderPlan): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'master-plan-binder';
  const header = document.createElement('header');
  header.innerHTML = `
    <h3>Perm ${binder.binderIndex}</h3>
    <p class="master-plan-binder__meta">
      ${binder.sections.length} ${binder.sections.length === 1 ? 'sett' : 'sett'} ·
      ${binder.usedSlotCount} brukte slots ·
      ${binder.unusedSlotCount} tomme ·
      kapasitet ${binder.capacity}
    </p>
  `;
  wrap.appendChild(header);

  const table = document.createElement('table');
  table.className = 'master-plan-binder__sections';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Sett</th>
        <th>Serie</th>
        <th>Utgitt</th>
        <th>Start</th>
        <th>Slutt</th>
        <th>Base</th>
        <th>Reverse</th>
        <th>Total</th>
        <th>Notat</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');
  if (tbody !== null) {
    for (const section of binder.sections) {
      tbody.appendChild(buildSectionRow(section));
    }
  }
  wrap.appendChild(table);
  return wrap;
}

function buildSectionRow(section: MasterSetSectionPlan): HTMLTableRowElement {
  const tr = document.createElement('tr');
  const noteText: string[] = [];
  if (section.continuedFromPreviousBinder) noteText.push('fortsetter');
  if (section.continuesIntoNextBinder) noteText.push('går videre');
  const noteCell = noteText.length > 0 ? noteText.join(' + ') : '—';
  tr.innerHTML = `
    <td><strong>${escapeHtml(section.setName)}</strong><br><code>${escapeHtml(section.setId)}</code></td>
    <td>${escapeHtml(section.series)}</td>
    <td>${escapeHtml(section.releaseDate)}</td>
    <td>${section.startPage}.${section.startSlot}</td>
    <td>${section.endPage}.${section.endSlot}</td>
    <td>${section.baseSlotCount}</td>
    <td>${section.reverseHoloSlotCount}</td>
    <td><strong>${section.totalSlotCount}</strong></td>
    <td>${noteCell}</td>
  `;
  return tr;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildSkeleton(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'master-plan-wrap';
  wrap.innerHTML = `
    <form class="master-plan-form" novalidate>
      <header class="master-plan-form__header">
        <h2>Planlegg standard master-permer</h2>
        <p class="master-plan-form__hint">
          Pakker alle synkede sett i fysiske Vault X XXL 1088-permer.
          Hvert sett blir en sammenhengende seksjon. Forhåndsvisning under
          — klikk "Opprett" når du er fornøyd.
        </p>
      </header>

      <p class="master-plan-form__status" data-region="status" aria-live="polite"></p>

      <section class="master-plan-form__summary" data-region="summary"></section>
      <section class="master-plan-form__binders" data-region="binder-list"></section>

      <p class="master-plan-form__error" data-region="error" role="alert" aria-live="polite"></p>

      <footer class="master-plan-form__footer">
        <button type="button" data-action="cancel">Lukk</button>
        <button type="submit" class="master-plan-form__apply" data-region="apply-btn" disabled>Forbereder …</button>
      </footer>
    </form>
  `;
  return wrap;
}
