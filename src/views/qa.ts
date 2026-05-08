// PR 28 review patch — dev-only QA harness view.
//
// Mounted ONLY when `import.meta.env.DEV` is true (Vite injects this
// at build time). In a production browser/Tauri build the view
// module is still part of the bundle but the route is never wired
// up by `app.ts`, so the buttons cannot be reached by a normal
// user. The seed never runs against production data unless the
// user explicitly opens `#qa` in dev.
//
// What the view offers:
//   - Reset QA data       (drops every store except settings)
//   - Seed stress data    (deterministic — `morten-pokemon-qa-v1`)
//   - Run + download QA report (JSON + Markdown)
//   - Live counts panel
//
// All actions go through repos / services already covered by the
// rest of the test suite. No DB writes outside reset/seed.

import { getDb } from '../db/database';
import {
  renderQaReportJson,
  renderQaReportMarkdown,
  type QaReport,
} from '../qa/qa-report';
import { runQa, type QaRunOptions } from '../qa/qa-runner';
import { downloadTextFile } from '../utils/download';

const REPORT_BASENAME = 'desktop-qa-report';

export function mountQaView(
  container: HTMLElement,
  _signal?: AbortSignal,
): void {
  container.innerHTML = `
    <section class="qa-view" aria-labelledby="qa-heading">
      <header class="qa-view__header">
        <h1 id="qa-heading">QA harness (dev only)</h1>
        <p class="qa-view__hint">
          Deterministisk seed + rapport for PR 28 desktop-verifisering.
          Bruker den nåværende databasen — kjør Backup → Eksporter
          før du kjører <em>Reset</em> hvis du har data du vil
          beholde.
        </p>
      </header>

      <section class="qa-view__panel">
        <h2>Handlinger</h2>
        <div class="qa-view__actions">
          <button type="button" class="qa-view__button qa-view__button--danger" data-action="qa-reset">Reset QA data</button>
          <button type="button" class="qa-view__button qa-view__button--primary" data-action="qa-seed">Seed stress data</button>
          <button type="button" class="qa-view__button qa-view__button--primary" data-action="qa-run">Reset + Seed + Run report</button>
          <button type="button" class="qa-view__button" data-action="qa-measure">Measure only (read-only)</button>
        </div>
        <p class="qa-view__feedback" data-region="qa-feedback" aria-live="polite"></p>
      </section>

      <section class="qa-view__panel">
        <h2>Last ned rapport</h2>
        <div class="qa-view__actions">
          <button type="button" class="qa-view__button" data-action="qa-download-json">Last ned JSON</button>
          <button type="button" class="qa-view__button" data-action="qa-download-md">Last ned Markdown</button>
        </div>
        <p class="qa-view__hint">
          Filene heter <code>${REPORT_BASENAME}.json</code> og
          <code>${REPORT_BASENAME}.md</code>. Flytt dem til
          <code>.local/qa/</code> hvis du vil holde historikk lokalt
          (mappa er gitignored).
        </p>
      </section>

      <section class="qa-view__panel">
        <h2>Forrige rapport</h2>
        <pre class="qa-view__report" data-region="qa-report"></pre>
      </section>
    </section>
  `;

  let lastReport: QaReport | null = null;

  const feedback = container.querySelector<HTMLElement>(
    '[data-region="qa-feedback"]',
  );
  const reportRegion = container.querySelector<HTMLElement>(
    '[data-region="qa-report"]',
  );
  if (feedback === null || reportRegion === null) return;

  function setFeedback(text: string, isError = false): void {
    feedback!.textContent = text;
    feedback!.classList.toggle('qa-view__feedback--error', isError);
  }

  function renderReport(report: QaReport): void {
    lastReport = report;
    reportRegion!.textContent = renderQaReportMarkdown(report);
  }

  async function handle(options: QaRunOptions): Promise<void> {
    setFeedback('Kjører …');
    try {
      const db = getDb();
      const report = await runQa(db, options);
      renderReport(report);
      const summary = report.seed;
      const detail =
        summary !== null
          ? ` — ${summary.holdings} holdings, ${summary.binders} binders, ${summary.slots} slots, ${summary.elapsedMs} ms`
          : '';
      setFeedback(`Ferdig. Overall: ${report.overall.toUpperCase()}${detail}`);
    } catch (caught) {
      setFeedback(
        `Feil: ${
          caught instanceof Error ? caught.message : 'ukjent feil'
        }`,
        true,
      );
    }
  }

  container
    .querySelector<HTMLButtonElement>('[data-action="qa-reset"]')
    ?.addEventListener('click', () => {
      void handle({ reset: true, seed: false, runtime: 'unknown' });
    });
  container
    .querySelector<HTMLButtonElement>('[data-action="qa-seed"]')
    ?.addEventListener('click', () => {
      void handle({ reset: false, seed: true, runtime: 'unknown' });
    });
  container
    .querySelector<HTMLButtonElement>('[data-action="qa-run"]')
    ?.addEventListener('click', () => {
      void handle({ reset: true, seed: true, runtime: 'unknown' });
    });
  container
    .querySelector<HTMLButtonElement>('[data-action="qa-measure"]')
    ?.addEventListener('click', () => {
      void handle({ reset: false, seed: false, runtime: 'unknown' });
    });

  container
    .querySelector<HTMLButtonElement>('[data-action="qa-download-json"]')
    ?.addEventListener('click', () => {
      if (lastReport === null) {
        setFeedback('Ingen rapport ennå — kjør Run først.', true);
        return;
      }
      downloadTextFile(
        `${REPORT_BASENAME}.json`,
        renderQaReportJson(lastReport),
        { mimeType: 'application/json' },
      );
    });
  container
    .querySelector<HTMLButtonElement>('[data-action="qa-download-md"]')
    ?.addEventListener('click', () => {
      if (lastReport === null) {
        setFeedback('Ingen rapport ennå — kjør Run først.', true);
        return;
      }
      downloadTextFile(
        `${REPORT_BASENAME}.md`,
        renderQaReportMarkdown(lastReport),
        { mimeType: 'text/markdown' },
      );
    });
}
