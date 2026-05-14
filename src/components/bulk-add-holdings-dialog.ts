// Bulk-add holdings dialog: paste a list of cards, preview the parse,
// confirm, watch progress. Direct-to-collection — no lot, no extra
// materialise step.

import { DIALOG_SUBMITTED_EVENT } from './dialog';
import { USER_DATA_CHANGED_EVENT } from './events';
import { getDb } from '../db/database';
import { createCardsRepo } from '../repositories/cards-repo';
import {
  applyBulkAddHoldings,
  parseBulkAddHoldings,
  type BulkAddHoldingsParseSummary,
} from '../services/bulk-add-holdings-service';
import type { DialogContent } from './dialog';

export function buildBulkAddHoldingsDialog(): DialogContent {
  return {
    mount(host, close) {
      mount(host, close);
    },
  };
}

function mount(host: HTMLElement, close: () => void): void {
  let summary: BulkAddHoldingsParseSummary | null = null;
  // In-flight guard for the parse stage. Apply doesn't need its own
  // flag because doApply disables submit/cancel/back as its first step.
  let parsing = false;

  host.appendChild(buildSkeleton());
  const form = host.querySelector<HTMLFormElement>('form.bulk-add-form');
  if (form === null) return;

  renderInputStep(form);

  form
    .querySelector<HTMLButtonElement>('[data-action="cancel"]')
    ?.addEventListener('click', () => close());

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
      void file.text().then(
        (content) => {
          const ta = form.querySelector<HTMLTextAreaElement>('textarea[name="csv"]');
          if (ta !== null) ta.value = content;
        },
        (err) => {
          const errorRegion = form.querySelector<HTMLElement>('[data-region="form-error"]');
          if (errorRegion !== null) {
            errorRegion.textContent =
              `Kunne ikke lese fil: ${err instanceof Error ? err.message : 'ukjent feil'}`;
          }
        },
      );
    });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (summary === null) {
      // Rapid repeat-submits used to launch overlapping doParse runs
      // because doParse is async and the submit button isn't disabled
      // during the parse stage. The flag is reset in .finally() so
      // both the success path and any rejection clear it.
      if (parsing) return;
      parsing = true;
      void doParse(form, (s) => {
        summary = s;
        renderSummaryStep(form, s);
      }).finally(() => {
        parsing = false;
      });
    } else {
      void doApply(form, summary, host, close);
    }
  });
}

async function doParse(
  form: HTMLFormElement,
  onDone: (s: BulkAddHoldingsParseSummary) => void,
): Promise<void> {
  const textarea = form.querySelector<HTMLTextAreaElement>('textarea[name="csv"]');
  const errorRegion = form.querySelector<HTMLElement>('[data-region="form-error"]');
  if (errorRegion !== null) errorRegion.textContent = '';
  const text = textarea?.value ?? '';
  if (text.trim().length === 0) {
    if (errorRegion !== null) errorRegion.textContent = 'Tom input — lim inn minst én linje.';
    return;
  }
  try {
    const cardsRepo = createCardsRepo(getDb());
    const summary = await parseBulkAddHoldings(text, cardsRepo);
    onDone(summary);
  } catch (caught) {
    if (errorRegion !== null) {
      errorRegion.textContent =
        `Kunne ikke parse input: ${caught instanceof Error ? caught.message : 'ukjent feil'}`;
    }
  }
}

async function doApply(
  form: HTMLFormElement,
  summary: BulkAddHoldingsParseSummary,
  host: HTMLElement,
  close: () => void,
): Promise<void> {
  const errorRegion = form.querySelector<HTMLElement>('[data-region="form-error"]');
  const status = form.querySelector<HTMLElement>('[data-region="progress"]');
  const submit = form.querySelector<HTMLButtonElement>('[data-region="submit-btn"]');
  const cancel = form.querySelector<HTMLButtonElement>('[data-action="cancel"]');
  const back = form.querySelector<HTMLButtonElement>('[data-action="back"]');
  if (errorRegion === null || status === null || submit === null || cancel === null || back === null) return;
  errorRegion.textContent = '';
  submit.disabled = true; cancel.disabled = true; back.disabled = true;

  const restoreControls = (): void => {
    submit.disabled = false;
    cancel.disabled = false;
    back.disabled = false;
  };

  let result: Awaited<ReturnType<typeof applyBulkAddHoldings>>;
  try {
    const db = getDb();
    result = await applyBulkAddHoldings(db, summary, {
      onProgress: (e) => {
        status.textContent = `Skriver kort ${e.index} av ${e.total} (${e.action === 'merged' ? 'merger' : 'oppretter'}) …`;
      },
    });
  } catch (caught) {
    // CodeRabbit feedback: an unhandled rejection here used to leave
    // the dialog disabled with no visible error. Restore controls + show
    // the message so the user can adjust input and retry.
    errorRegion.textContent =
      `Bulk-import feilet før noen kort ble skrevet: ${caught instanceof Error ? caught.message : 'ukjent feil'}`;
    restoreControls();
    return;
  }

  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));

  if (result.failed.length > 0) {
    const partialWrite = result.created.length > 0 || result.merged.length > 0;
    errorRegion.textContent =
      `${result.created.length} opprettet, ${result.merged.length} merget, ` +
      `${result.failed.length} feilet. Første feil: linje ${result.failed[0]?.line} ` +
      `(${result.failed[0]?.cardId}): ${result.failed[0]?.error}.` +
      (partialWrite
        ? ` Lukk dialogen og åpne på nytt for å fortsette — replay vil duplisere kvantitet på de ${result.created.length + result.merged.length} kortene som allerede er skrevet.`
        : '');
    if (partialWrite) {
      // CodeRabbit finding: replay via the same `summary` would re-run
      // upsertByVariant on rows we already wrote, doubling their
      // quantity (the parser produces additive imports, not idempotent
      // sets). Lock submit + back; cancel remains so the user can
      // dismiss the dialog. They must reopen with adjusted input.
      cancel.disabled = false;
    } else {
      restoreControls();
    }
    return;
  }

  status.textContent =
    `Ferdig — ${result.created.length} opprettet, ${result.merged.length} merget.`;
  host.dispatchEvent(new CustomEvent(DIALOG_SUBMITTED_EVENT));
  setTimeout(close, 800);
}

function renderInputStep(form: HTMLFormElement): void {
  setHidden(form, '[data-region="input-step"]', false);
  setHidden(form, '[data-region="summary-step"]', true);
  setHidden(form, '[data-action="back"]', true);
  const submit = form.querySelector<HTMLButtonElement>('[data-region="submit-btn"]');
  if (submit !== null) {
    submit.textContent = 'Forhåndsvis';
    submit.disabled = false;
  }
  const errorRegion = form.querySelector<HTMLElement>('[data-region="form-error"]');
  if (errorRegion !== null) errorRegion.textContent = '';
  const progress = form.querySelector<HTMLElement>('[data-region="progress"]');
  if (progress !== null) progress.textContent = '';
}

function renderSummaryStep(
  form: HTMLFormElement,
  summary: BulkAddHoldingsParseSummary,
): void {
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
    // Cap to first 20 to avoid massive scroll for huge bad imports.
    const shown = summary.errors.slice(0, 20);
    for (const err of shown) {
      const li = document.createElement('li');
      li.textContent = `Linje ${err.line}: ${err.reason} — “${err.raw.slice(0, 80)}”`;
      errorList.appendChild(li);
    }
    if (summary.errors.length > shown.length) {
      const li = document.createElement('li');
      li.textContent = `… og ${summary.errors.length - shown.length} flere feil`;
      errorList.appendChild(li);
    }
  }

  const submit = form.querySelector<HTMLButtonElement>('[data-region="submit-btn"]');
  if (submit !== null) {
    submit.textContent = `Importer ${summary.resolved.length} kort`;
    submit.disabled = summary.resolved.length === 0;
  }
}

function setHidden(form: HTMLFormElement, selector: string, hidden: boolean): void {
  const el = form.querySelector<HTMLElement>(selector);
  if (el === null) return;
  el.hidden = hidden;
}

function buildSkeleton(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'bulk-add-wrap';
  wrap.innerHTML = `
    <form class="bulk-add-form" novalidate>
      <header class="bulk-add-form__header">
        <h2>Bulk-importer kort til samling</h2>
        <p class="bulk-add-form__hint">
          Lim inn én linje per kort, eller velg en CSV-fil.
          Format: <code>cardId,quantity[,finish[,edition[,condition]]]</code>.
          Tomme linjer og linjer som starter med <code>#</code> ignoreres.
          Default: quantity=1, finish=normal, edition=unlimited, condition=NM.
          Eksisterende holding med samme variant blir merget (kvantitet økt).
        </p>
      </header>

      <fieldset class="bulk-add-form__section" data-region="input-step">
        <legend>Lim inn eller last opp</legend>
        <label class="bulk-add-form__field">
          <span>CSV / pastet liste</span>
          <textarea name="csv" rows="14" placeholder="base1-4,1,holo,unlimited,NM&#10;base1-58,1,reverse_holo&#10;# kommentar — ignoreres&#10;jungle-15"></textarea>
        </label>
        <label class="bulk-add-form__field">
          <span>…eller velg fil (.csv / .txt)</span>
          <input type="file" accept=".csv,.txt,text/csv,text/plain" />
        </label>
      </fieldset>

      <fieldset class="bulk-add-form__section" data-region="summary-step" hidden>
        <legend>Sammendrag</legend>
        <p data-region="summary-text"></p>
        <ul data-region="summary-errors" class="bulk-add-form__errors"></ul>
      </fieldset>

      <p class="bulk-add-form__progress" data-region="progress" aria-live="polite"></p>
      <p class="bulk-add-form__error" data-region="form-error" role="alert" aria-live="polite"></p>

      <footer class="bulk-add-form__footer">
        <button type="button" data-action="cancel">Avbryt</button>
        <button type="button" data-action="back" hidden>Tilbake</button>
        <button type="submit" class="bulk-add-form__submit" data-region="submit-btn">Forhåndsvis</button>
      </footer>
    </form>
  `;
  return wrap;
}
