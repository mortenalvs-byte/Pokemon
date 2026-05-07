// "Ny perm fra sett"-wizard. Single dialog, progressive disclosure:
//
//   1. Pick set (sorted by releaseDate desc).
//   2. Pick name + slotsPerPage + completionMode + (master only)
//      includeReverseHolos.
//   3. Live preview of base / reverse-holo / total slots + total pages.
//   4. Submit → `binderService.createBinderFromSet()`.
//
// All persistence goes through the service so the binder, every slot,
// and the audit row land in one Dexie transaction. The wizard never
// touches stores directly. Cards for the chosen set are loaded via
// `cardsRepo.listBySet()` and cached for the wizard's lifetime so
// switching modes does not re-fetch.

import { DIALOG_SUBMITTED_EVENT } from './dialog';
import { USER_DATA_CHANGED_EVENT } from './events';
import { getDb } from '../db/database';
import {
  generateFromSetSlots,
  type TemplateResult,
} from '../domain/binder-template';
import { ValidationError } from '../domain/validators';
import { createCardsRepo } from '../repositories/cards-repo';
import { createSetsRepo } from '../repositories/sets-repo';
import { createBinderService } from '../services/binder-service';
import type { CardRecord, CompletionMode, SetRecord } from '../domain/types';
import type { DialogContent } from './dialog';

const SLOTS_PER_PAGE_OPTIONS: ReadonlyArray<{
  readonly value: '9' | '18';
  readonly label: string;
}> = [
  { value: '9', label: '9 (3×3)' },
  { value: '18', label: '18 (3×3 dobbel)' },
];

const COMPLETION_MODES: ReadonlyArray<{
  readonly value: Exclude<CompletionMode, 'grand_master'>;
  readonly label: string;
}> = [
  { value: 'standard', label: 'Standard' },
  { value: 'master', label: 'Master' },
];

interface WizardState {
  sets: readonly SetRecord[];
  cardsBySet: Map<string, CardRecord[]>;
  // Whether the user has manually edited the name. While `false`, any
  // change to set or completionMode will refresh the auto-generated
  // name suggestion. Once the user types in the name field, we stop
  // overwriting their input.
  nameWasManuallyEdited: boolean;
}

export function buildBinderFromSetWizard(): DialogContent {
  return {
    mount(host, close) {
      void mount(host, close);
    },
  };
}

async function mount(host: HTMLElement, close: () => void): Promise<void> {
  host.appendChild(buildSkeleton());
  const form = host.querySelector<HTMLFormElement>('form.binder-from-set-wizard');
  if (form === null) return;

  const db = getDb();
  const allSets = await createSetsRepo(db).list();
  const sortedSets = [...allSets].sort((a, b) =>
    a.releaseDate < b.releaseDate ? 1 : -1,
  );

  const state: WizardState = {
    sets: sortedSets,
    cardsBySet: new Map(),
    nameWasManuallyEdited: false,
  };

  if (sortedSets.length === 0) {
    showError(
      form,
      'Ingen sett i lokal cache. Synk databasen i Innstillinger først.',
    );
    disableSubmit(form, true);
    form
      .querySelector<HTMLButtonElement>('[data-action="cancel"]')
      ?.addEventListener('click', () => close());
    return;
  }

  populateSetSelect(form, sortedSets);
  populateLayoutSelects(form);
  setDefaults(form, sortedSets);

  // Initial preview after defaults land.
  await refreshPreview(form, state);

  attachEventListeners(form, state, close);
}

function buildSkeleton(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'binder-from-set-wizard-wrap';
  wrap.innerHTML = `
    <form class="binder-from-set-wizard" novalidate>
      <header class="binder-from-set-wizard__header">
        <h2>Ny perm fra sett</h2>
        <p class="binder-from-set-wizard__hint">
          Velg et sett og en completion-modus. Permen opprettes med ferdig-utfylte
          mål-kort på hver slot.
        </p>
      </header>

      <fieldset class="binder-from-set-wizard__section">
        <legend>Sett</legend>
        <label class="binder-from-set-wizard__field">
          <span>Velg sett</span>
          <select name="setId" data-region="set-select"></select>
        </label>
      </fieldset>

      <fieldset class="binder-from-set-wizard__section">
        <legend>Permdetaljer</legend>
        <label class="binder-from-set-wizard__field">
          <span>Navn</span>
          <input type="text" name="name" data-region="name-input" required maxlength="120" />
        </label>
        <label class="binder-from-set-wizard__field">
          <span>Slots per side</span>
          <select name="slotsPerPage" data-region="slots-per-page"></select>
        </label>
        <label class="binder-from-set-wizard__field">
          <span>Completion-modus</span>
          <select name="completionMode" data-region="completion-mode"></select>
        </label>
        <label class="binder-from-set-wizard__field binder-from-set-wizard__field--checkbox" data-region="reverse-holo-row">
          <input type="checkbox" name="includeReverseHolos" data-region="include-reverse-holo" checked />
          <span>Inkluder reverse holo (kun master-mode)</span>
        </label>
      </fieldset>

      <section class="binder-from-set-wizard__preview" data-region="preview">
        <h3>Forhåndsvis</h3>
        <dl data-region="preview-list"></dl>
      </section>

      <p class="binder-from-set-wizard__error" data-region="form-error" role="alert" aria-live="polite"></p>

      <footer class="binder-from-set-wizard__footer">
        <button type="button" data-action="cancel">Avbryt</button>
        <button type="submit" class="binder-from-set-wizard__submit">Opprett</button>
      </footer>
    </form>
  `;
  return wrap;
}

function populateSetSelect(
  form: HTMLFormElement,
  sets: readonly SetRecord[],
): void {
  const select = form.querySelector<HTMLSelectElement>(
    '[data-region="set-select"]',
  );
  if (select === null) return;
  select.replaceChildren();
  for (const set of sets) {
    const opt = document.createElement('option');
    opt.value = set.id;
    opt.textContent = `${set.name} (${set.releaseDate.slice(0, 4)})`;
    select.appendChild(opt);
  }
}

function populateLayoutSelects(form: HTMLFormElement): void {
  const slots = form.querySelector<HTMLSelectElement>(
    '[data-region="slots-per-page"]',
  );
  const mode = form.querySelector<HTMLSelectElement>(
    '[data-region="completion-mode"]',
  );
  if (slots !== null) {
    slots.replaceChildren();
    for (const opt of SLOTS_PER_PAGE_OPTIONS) {
      const el = document.createElement('option');
      el.value = opt.value;
      el.textContent = opt.label;
      slots.appendChild(el);
    }
  }
  if (mode !== null) {
    mode.replaceChildren();
    for (const opt of COMPLETION_MODES) {
      const el = document.createElement('option');
      el.value = opt.value;
      el.textContent = opt.label;
      mode.appendChild(el);
    }
  }
}

function setDefaults(
  form: HTMLFormElement,
  sets: readonly SetRecord[],
): void {
  const firstSet = sets[0];
  if (firstSet === undefined) return;
  setSelectValue(form, 'set-select', firstSet.id);
  setSelectValue(form, 'slots-per-page', '18');
  setSelectValue(form, 'completion-mode', 'standard');
  const nameInput = form.querySelector<HTMLInputElement>(
    '[data-region="name-input"]',
  );
  if (nameInput !== null) {
    nameInput.value = computeAutoName(firstSet, 'standard');
  }
  toggleReverseHoloRow(form, 'standard');
}

function attachEventListeners(
  form: HTMLFormElement,
  state: WizardState,
  close: () => void,
): void {
  form
    .querySelector<HTMLButtonElement>('[data-action="cancel"]')
    ?.addEventListener('click', () => close());

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void handleSubmit(form, state);
  });

  const setSelect = form.querySelector<HTMLSelectElement>(
    '[data-region="set-select"]',
  );
  setSelect?.addEventListener('change', () => {
    refreshAutoName(form, state);
    void refreshPreview(form, state);
  });

  const modeSelect = form.querySelector<HTMLSelectElement>(
    '[data-region="completion-mode"]',
  );
  modeSelect?.addEventListener('change', () => {
    const mode = modeSelect.value as 'standard' | 'master';
    toggleReverseHoloRow(form, mode);
    refreshAutoName(form, state);
    void refreshPreview(form, state);
  });

  const slotsSelect = form.querySelector<HTMLSelectElement>(
    '[data-region="slots-per-page"]',
  );
  slotsSelect?.addEventListener('change', () => {
    void refreshPreview(form, state);
  });

  const includeReverse = form.querySelector<HTMLInputElement>(
    '[data-region="include-reverse-holo"]',
  );
  includeReverse?.addEventListener('change', () => {
    void refreshPreview(form, state);
  });

  const nameInput = form.querySelector<HTMLInputElement>(
    '[data-region="name-input"]',
  );
  nameInput?.addEventListener('input', () => {
    state.nameWasManuallyEdited = true;
  });
}

function refreshAutoName(form: HTMLFormElement, state: WizardState): void {
  if (state.nameWasManuallyEdited) return;
  const setId = readValue(form, 'set-select');
  const mode = readValue(form, 'completion-mode') as 'standard' | 'master';
  const set = state.sets.find((s) => s.id === setId);
  if (set === undefined) return;
  const nameInput = form.querySelector<HTMLInputElement>(
    '[data-region="name-input"]',
  );
  if (nameInput === null) return;
  nameInput.value = computeAutoName(set, mode);
}

function computeAutoName(
  set: SetRecord,
  mode: 'standard' | 'master',
): string {
  return mode === 'master' ? `${set.name} (master)` : set.name;
}

async function refreshPreview(
  form: HTMLFormElement,
  state: WizardState,
): Promise<void> {
  const previewList = form.querySelector<HTMLElement>(
    '[data-region="preview-list"]',
  );
  if (previewList === null) return;

  const setId = readValue(form, 'set-select');
  const slotsPerPageStr = readValue(form, 'slots-per-page');
  const slotsPerPage: 9 | 18 = slotsPerPageStr === '18' ? 18 : 9;
  const mode = readValue(form, 'completion-mode') as 'standard' | 'master';
  const includeReverseHolos = readChecked(form, 'include-reverse-holo');

  if (setId.length === 0) {
    renderPreview(previewList, null);
    return;
  }

  const cards = await loadCardsForSet(state, setId);
  if (cards.length === 0) {
    renderPreview(previewList, {
      slots: [],
      summary: {
        baseSlotCount: 0,
        reverseHoloSlotCount: 0,
        totalSlotCount: 0,
        totalPages: 0,
      },
    });
    return;
  }

  const result = generateFromSetSlots(cards, {
    slotsPerPage,
    completionMode: mode,
    includeReverseHolos,
  });
  renderPreview(previewList, result);
}

async function loadCardsForSet(
  state: WizardState,
  setId: string,
): Promise<CardRecord[]> {
  const cached = state.cardsBySet.get(setId);
  if (cached !== undefined) return cached;
  const cards = await createCardsRepo(getDb()).listBySet(setId);
  state.cardsBySet.set(setId, cards);
  return cards;
}

function renderPreview(
  list: HTMLElement,
  result: TemplateResult | null,
): void {
  list.replaceChildren();
  if (result === null) {
    appendDt(list, 'Sett', 'Ingen valgt');
    return;
  }
  if (result.summary.totalSlotCount === 0) {
    appendDt(list, 'Sett', 'Ingen kort i lokal cache for valgt sett');
    return;
  }
  appendDt(list, 'Mål-slots (base)', String(result.summary.baseSlotCount));
  if (result.summary.reverseHoloSlotCount > 0) {
    appendDt(
      list,
      '+ Reverse holo',
      String(result.summary.reverseHoloSlotCount),
    );
  }
  appendDt(list, 'Totalt slots', String(result.summary.totalSlotCount));
  appendDt(list, 'Sider', String(result.summary.totalPages));
}

function appendDt(list: HTMLElement, label: string, value: string): void {
  const dt = document.createElement('dt');
  dt.textContent = label;
  list.appendChild(dt);
  const dd = document.createElement('dd');
  dd.textContent = value;
  list.appendChild(dd);
}

async function handleSubmit(
  form: HTMLFormElement,
  state: WizardState,
): Promise<void> {
  const errorRegion = form.querySelector<HTMLElement>('[data-region="form-error"]');
  if (errorRegion !== null) {
    errorRegion.textContent = '';
    errorRegion.classList.remove('binder-from-set-wizard__error--visible');
  }

  const submitButton = form.querySelector<HTMLButtonElement>(
    '.binder-from-set-wizard__submit',
  );

  const setId = readValue(form, 'set-select');
  const set = state.sets.find((s) => s.id === setId);
  if (set === undefined) {
    showError(form, 'Velg et sett først.');
    return;
  }

  const nameInput = form.querySelector<HTMLInputElement>(
    '[data-region="name-input"]',
  );
  const name = (nameInput?.value ?? '').trim();
  if (name.length === 0) {
    showError(form, 'Navn er påkrevd.');
    return;
  }

  const slotsPerPage: 9 | 18 = readValue(form, 'slots-per-page') === '18' ? 18 : 9;
  const mode = readValue(form, 'completion-mode') as 'standard' | 'master';
  const includeReverseHolos = readChecked(form, 'include-reverse-holo');

  const cards = await loadCardsForSet(state, setId);
  if (cards.length === 0) {
    showError(
      form,
      `Ingen kort i lokal cache for "${set.name}". Synk databasen først.`,
    );
    return;
  }

  let template: TemplateResult;
  try {
    template = generateFromSetSlots(cards, {
      slotsPerPage,
      completionMode: mode,
      includeReverseHolos,
    });
  } catch (caught) {
    showError(form, describeError(caught));
    return;
  }

  if (submitButton !== null) submitButton.disabled = true;
  try {
    await createBinderService(getDb()).createBinderFromSet({
      binder: {
        name,
        description: null,
        binderType: null,
        slotsPerPage,
        completionMode: mode,
        sourceSetId: set.id,
      },
      slots: template.slots,
    });
  } catch (caught) {
    if (submitButton !== null) submitButton.disabled = false;
    showError(form, describeError(caught));
    return;
  }

  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  form.dispatchEvent(
    new CustomEvent(DIALOG_SUBMITTED_EVENT, { bubbles: true }),
  );
}

function toggleReverseHoloRow(
  form: HTMLFormElement,
  mode: 'standard' | 'master',
): void {
  const row = form.querySelector<HTMLElement>(
    '[data-region="reverse-holo-row"]',
  );
  if (row === null) return;
  if (mode === 'master') {
    row.hidden = false;
  } else {
    row.hidden = true;
  }
}

function readValue(form: HTMLFormElement, region: string): string {
  const el = form.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[data-region="${region}"]`,
  );
  return el?.value ?? '';
}

function readChecked(form: HTMLFormElement, region: string): boolean {
  const el = form.querySelector<HTMLInputElement>(`[data-region="${region}"]`);
  return el?.checked === true;
}

function setSelectValue(
  form: HTMLFormElement,
  region: string,
  value: string,
): void {
  const el = form.querySelector<HTMLSelectElement>(`[data-region="${region}"]`);
  if (el !== null) el.value = value;
}

function showError(formOrRegion: HTMLElement, message: string): void {
  const region =
    formOrRegion instanceof HTMLFormElement
      ? formOrRegion.querySelector<HTMLElement>('[data-region="form-error"]')
      : formOrRegion;
  if (region === null) return;
  region.textContent = message;
  region.classList.add('binder-from-set-wizard__error--visible');
}

function disableSubmit(form: HTMLFormElement, disabled: boolean): void {
  const submitButton = form.querySelector<HTMLButtonElement>(
    '.binder-from-set-wizard__submit',
  );
  if (submitButton !== null) submitButton.disabled = disabled;
}

function describeError(caught: unknown): string {
  if (caught instanceof ValidationError) {
    return `Feil: ${caught.message}`;
  }
  if (caught instanceof Error) {
    return `Opprettelse feilet: ${caught.message}`;
  }
  return 'Opprettelse feilet av en ukjent grunn.';
}
