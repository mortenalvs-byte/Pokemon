// PR B1 — Lot bulk-import dialog.
//
// Renders inside an <dialog> provided by openDialog(). The user pastes
// a list of `cardId,quantity[,finish[,edition[,condition]]]` lines OR
// loads a .csv/.txt file. We parse + resolve via
// parseAndResolveBulkImport(), surface a per-line summary, then on
// confirmation write each resolved item via the existing
// lot-items-repo so the audit + soft-delete + allocation paths from
// PR 22 / PR 18 / PR 33 stay intact.
//
// Two-step flow:
//   step 'input'   — textarea + file picker + "Forhåndsvis" button
//   step 'summary' — N resolved / M errors; "Importer N kort" + "Tilbake"
//
// On import: appends each resolved item via lotItemsRepo.create, then
// appends ONE 'lot_bulk_import' audit row summarizing the operation.

import { DIALOG_SUBMITTED_EVENT } from './dialog';
import { USER_DATA_CHANGED_EVENT } from './events';
import { appendAudit } from '../db/audit';
import { getDb } from '../db/database';
import { createCardsRepo } from '../repositories/cards-repo';
import { createLotItemsRepo } from '../repositories/lot-items-repo';
import {
  parseAndResolveBulkImport,
  type ParseSummary,
} from '../services/lot-bulk-import-service';
import type { DialogContent } from './dialog';

export interface LotBulkImportOptions {
  readonly lotId: string;
}

export function buildLotBulkImportDialog(
  options: LotBulkImportOptions,
): DialogContent {
  return {
    mount(host, close) {
      mount(options, host, close);
    },
  };
}

function mount(
  options: LotBulkImportOptions,
  host: HTMLElement,
  close: () => void,
): void {
  // State lives in closures; the dialog is short-lived.
  let summary: ParseSummary | null = null;
  // In-flight guard for the parse stage. Without it, rapid repeat-
  // submits used to launch overlapping doParse runs (the submit
  // button isn't disabled during parse — only during the second-
  // stage doImport, which manages its own disable). Class fix
  // mirrored from bulk-add-holdings-dialog.
  let parsing = false;

  host.appendChild(buildSkeleton());
  const form = host.querySelector<HTMLFormElement>('form.lot-bulk-import-form');
  if (form === null) return;

  renderInputStep(form);

  form
    .querySelector<HTMLButtonElement>('[data-action="cancel"]')
    ?.addEventListener('click', () => close());

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    // Two-stage submit: first stage = parse + preview; second = import.
    if (summary === null) {
      if (parsing) return;
      parsing = true;
      void doParse(form, options.lotId, (s) => {
        summary = s;
        renderSummaryStep(form, s);
      }).finally(() => {
        parsing = false;
      });
    } else {
      void doImport(form, host, summary);
    }
  });

  form
    .querySelector<HTMLButtonElement>('[data-action="back"]')
    ?.addEventListener('click', () => {
      summary = null;
      renderInputStep(form);
    });

  form
    .querySelector<HTMLInputElement>('input[type="file"]')
    ?.addEventListener('change', (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file === undefined) return;
      void file.text().then((content) => {
        const textarea = form.querySelector<HTMLTextAreaElement>(
          'textarea[name="csv"]',
        );
        if (textarea !== null) textarea.value = content;
      });
    });
}

function buildSkeleton(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'lot-bulk-import-wrap';
  wrap.innerHTML = `
    <form class="lot-bulk-import-form" novalidate>
      <header class="lot-bulk-import-form__header">
        <h2>Importer mange kort til lot</h2>
        <p class="lot-bulk-import-form__hint">
          Lim inn én linje per kort, eller velg en CSV-fil.
          Format: <code>cardId,quantity[,finish[,edition[,condition]]]</code>.
          Tomme linjer og linjer som starter med <code>#</code> ignoreres.
          Default: quantity=1, finish=normal, edition=unlimited, condition=NM.
        </p>
      </header>

      <fieldset class="lot-bulk-import-form__section" data-region="input-step">
        <legend>Lim inn eller last opp</legend>
        <label class="lot-bulk-import-form__field">
          <span>CSV / pastet liste</span>
          <textarea name="csv" rows="12" placeholder="base1-4,4,normal,unlimited,NM&#10;base1-58,1,reverse_holo&#10;# kommentar — ignoreres&#10;jungle-15"></textarea>
        </label>
        <label class="lot-bulk-import-form__field">
          <span>…eller velg fil (.csv / .txt)</span>
          <input type="file" accept=".csv,.txt,text/csv,text/plain" />
        </label>
      </fieldset>

      <fieldset class="lot-bulk-import-form__section" data-region="summary-step" hidden>
        <legend>Sammendrag</legend>
        <p data-region="summary-text"></p>
        <ul data-region="summary-errors" class="lot-bulk-import-form__errors"></ul>
      </fieldset>

      <p class="lot-bulk-import-form__error" data-region="form-error" role="alert" aria-live="polite"></p>

      <footer class="lot-bulk-import-form__footer">
        <button type="button" data-action="cancel">Avbryt</button>
        <button type="button" data-action="back" hidden>Tilbake</button>
        <button type="submit" class="lot-bulk-import-form__submit" data-region="submit-btn">Forhåndsvis</button>
      </footer>
    </form>
  `;
  return wrap;
}

function renderInputStep(form: HTMLFormElement): void {
  setHidden(form, '[data-region="input-step"]', false);
  setHidden(form, '[data-region="summary-step"]', true);
  setHidden(form, '[data-action="back"]', true);
  const submit = form.querySelector<HTMLButtonElement>('[data-region="submit-btn"]');
  if (submit !== null) {
    submit.textContent = 'Forhåndsvis';
    // Re-enable: a previous summary step with 0 resolved items would have
    // set submit.disabled = true; coming back to input must always allow
    // the user to re-trigger preview after editing the textarea.
    submit.disabled = false;
  }
}

function renderSummaryStep(form: HTMLFormElement, summary: ParseSummary): void {
  setHidden(form, '[data-region="input-step"]', true);
  setHidden(form, '[data-region="summary-step"]', false);
  setHidden(form, '[data-action="back"]', false);

  const text = form.querySelector<HTMLElement>('[data-region="summary-text"]');
  if (text !== null) {
    const n = summary.resolved.length;
    const e = summary.errors.length;
    const skipped = summary.skippedBlank + summary.skippedComment;
    text.textContent =
      `${n} kort klare for import. ${e} feil. ${skipped} tomme/kommentar-linjer hoppet over.`;
  }

  const errorList = form.querySelector<HTMLElement>('[data-region="summary-errors"]');
  if (errorList !== null) {
    errorList.replaceChildren();
    for (const err of summary.errors) {
      const li = document.createElement('li');
      li.textContent = `Linje ${err.line}: ${err.reason} — “${err.raw.slice(0, 80)}”`;
      errorList.appendChild(li);
    }
  }

  const submit = form.querySelector<HTMLButtonElement>('[data-region="submit-btn"]');
  if (submit !== null) {
    submit.textContent = `Importer ${summary.resolved.length} kort`;
    submit.disabled = summary.resolved.length === 0;
  }
}

async function doParse(
  form: HTMLFormElement,
  lotId: string,
  onDone: (s: ParseSummary) => void,
): Promise<void> {
  const textarea = form.querySelector<HTMLTextAreaElement>('textarea[name="csv"]');
  const errorRegion = form.querySelector<HTMLElement>('[data-region="form-error"]');
  if (errorRegion !== null) errorRegion.textContent = '';
  const text = textarea?.value ?? '';
  if (text.trim().length === 0) {
    if (errorRegion !== null) {
      errorRegion.textContent = 'Tom input — lim inn minst én linje eller velg en fil.';
    }
    return;
  }
  const db = getDb();
  const cardsRepo = createCardsRepo(db);
  const summary = await parseAndResolveBulkImport(lotId, text, cardsRepo);
  onDone(summary);
}

async function doImport(
  form: HTMLFormElement,
  host: HTMLElement,
  summary: ParseSummary,
): Promise<void> {
  const errorRegion = form.querySelector<HTMLElement>('[data-region="form-error"]');
  if (errorRegion !== null) errorRegion.textContent = '';
  const submit = form.querySelector<HTMLButtonElement>('[data-region="submit-btn"]');
  if (submit !== null) submit.disabled = true;

  const db = getDb();
  const lotItemsRepo = createLotItemsRepo(db);
  let written = 0;
  for (const r of summary.resolved) {
    try {
      await lotItemsRepo.create(r.input);
      written++;
    } catch (caught) {
      if (errorRegion !== null) {
        // CodeRabbit-class finding: replay via the same `summary` would
        // call lotItemsRepo.create on rows we already wrote, creating
        // duplicate lot items (create adds new IDs, it doesn't merge).
        // When at least one row was written, lock submit so the user
        // must close + reopen with adjusted input.
        errorRegion.textContent =
          `Stoppet ved linje ${r.line}: ${(caught as Error).message}. ` +
          `${written} kort ble skrevet før feilen.` +
          (written > 0
            ? ` Lukk dialogen og åpne på nytt — replay vil duplisere de ${written} kortene som allerede er skrevet.`
            : '');
      }
      // When nothing was written yet, re-enable submit so the user can
      // adjust input and retry safely. Otherwise leave submit disabled.
      if (written === 0 && submit !== null) submit.disabled = false;
      return;
    }
  }

  // One summary audit row per import operation (append-only contract).
  try {
    await appendAudit(db, {
      action: 'lot_bulk_import',
      entityType: 'lot',
      entityId: summary.resolved[0]?.input.lotId ?? null,
      message:
        `bulk-import: ${written} kort lagt til, ` +
        `${summary.errors.length} feil, ` +
        `${summary.skippedBlank + summary.skippedComment} tomme/kommentar-linjer`,
    });
  } catch { /* best-effort */ }

  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  host.dispatchEvent(new CustomEvent(DIALOG_SUBMITTED_EVENT));
}

function setHidden(form: HTMLFormElement, selector: string, hidden: boolean): void {
  const el = form.querySelector<HTMLElement>(selector);
  if (el === null) return;
  el.hidden = hidden;
}
