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
//   - Persistence diagnostic + sentinel (PR 28 review patch — desktop
//     persistence regression debug, Launch A/B/C recipe in
//     docs/QA_DESKTOP.md)
//
// All actions go through repos / services already covered by the
// rest of the test suite. No DB writes outside reset/seed and the
// explicit "Write persistence sentinel" button.

import { getDb } from '../db/database';
import {
  buildPersistenceDiagnostic,
  evaluatePersistenceDiagnostic,
  renderPersistenceDiagnosticJson,
  writePersistenceSentinel,
  type PersistenceDiagnostic,
} from '../qa/desktop-persistence-diagnostic';
import {
  auditCardImageCoverage,
  installImageAudit,
  type ImageAuditCoverage,
} from '../qa/image-audit';
import {
  importLocalSyncFixture,
  parseLocalSyncFixture,
  type LocalSyncFixtureImportOutcome,
} from '../qa/local-sync-fixture';
import {
  seedMaxStressData,
  type QaMaxStressSummary,
} from '../qa/qa-max-stress';
import {
  renderQaReportJson,
  renderQaReportMarkdown,
  type QaReport,
} from '../qa/qa-report';
import { buildQaDeps, runQa, type QaRunOptions } from '../qa/qa-runner';
import { downloadTextFile } from '../utils/download';

const REPORT_BASENAME = 'desktop-qa-report';
const PERSISTENCE_BASENAME = 'desktop-persistence-diagnostic';

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
        <h2>Image audit</h2>
        <p class="qa-view__hint">
          Teller bilde-dekning i kort-cachen og logger
          <code>pokemon:image-load-error</code>-events fra route-walken.
          Fallback rendereres som synlig "No image"-placeholder.
        </p>
        <div class="qa-view__actions">
          <button type="button" class="qa-view__button" data-action="qa-image-audit">Run image audit</button>
          <button type="button" class="qa-view__button" data-action="qa-image-download">Last ned image audit JSON</button>
        </div>
        <p class="qa-view__feedback" data-region="qa-image-feedback" aria-live="polite"></p>
      </section>

      <section class="qa-view__panel">
        <h2>Local sync fixture</h2>
        <p class="qa-view__hint">
          Importerer en lokal JSON-fixture (samme atomiske
          cache-rewrite-løypa som ekte sync) slik at dashboard +
          Browse + bilde-test kan kjøres uten å treffe
          pokemontcg.io. Aksepterer app-shape
          (<code>{ sets, cards }</code>) eller backup-shape
          (<code>{ schemaVersion, sets, cards, … }</code>).
        </p>
        <div class="qa-view__actions">
          <input type="file" accept="application/json" data-region="qa-fixture-input" hidden />
          <button type="button" class="qa-view__button qa-view__button--primary" data-action="qa-fixture-pick">Velg fixture-fil …</button>
          <button type="button" class="qa-view__button" data-action="qa-fixture-download">Last ned import-resultat JSON</button>
        </div>
        <p class="qa-view__feedback" data-region="qa-fixture-feedback" aria-live="polite"></p>
      </section>

      <section class="qa-view__panel">
        <h2>Max stress (full state matrix)</h2>
        <p class="qa-view__hint">
          Eksercerer alle holdings-tilstander (raw × condition ×
          finish × edition × status + graded × company × grade),
          alle binder-presets og completion-modi, alle wishlist
          (status × priority), og lots i ulike allokerings-tilstander.
          Kjør først Innstillinger → Synk for å fylle kort-cachen
          (~20 000 kort), så blir matrisen ekte.
        </p>
        <div class="qa-view__actions">
          <button type="button" class="qa-view__button qa-view__button--primary" data-action="qa-max-stress">Max stress (all-states populate)</button>
          <button type="button" class="qa-view__button" data-action="qa-max-stress-download">Last ned stress-summary JSON</button>
        </div>
        <p class="qa-view__feedback" data-region="qa-stress-feedback" aria-live="polite"></p>
      </section>

      <section class="qa-view__panel">
        <h2>Desktop persistence diagnostic</h2>
        <p class="qa-view__hint">
          Launch A → seed + <em>Write persistence sentinel</em>.
          Launch B/C → <em>Run persistence diagnostic</em> og
          bekreft holdings = 1000 og samme bootCounter. PASS bare
          hvis IndexedDB-tellingene følger sentinelen.
        </p>
        <div class="qa-view__actions">
          <button type="button" class="qa-view__button" data-action="qa-persist-run">Run persistence diagnostic</button>
          <button type="button" class="qa-view__button" data-action="qa-persist-run-expect">Run + expect seeded data</button>
          <button type="button" class="qa-view__button qa-view__button--primary" data-action="qa-persist-sentinel">Write persistence sentinel</button>
          <button type="button" class="qa-view__button" data-action="qa-persist-download">Last ned diagnostic JSON</button>
        </div>
        <p class="qa-view__feedback" data-region="qa-persist-feedback" aria-live="polite"></p>
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
  let lastDiagnostic: PersistenceDiagnostic | null = null;
  let lastStressSummary: QaMaxStressSummary | null = null;
  let lastFixtureResult: LocalSyncFixtureImportOutcome | null = null;
  let lastImageAudit: ImageAuditCoverage | null = null;
  // Install the image-load-error capture once. Cheap, idempotent.
  installImageAudit();

  const feedback = container.querySelector<HTMLElement>(
    '[data-region="qa-feedback"]',
  );
  const reportRegion = container.querySelector<HTMLElement>(
    '[data-region="qa-report"]',
  );
  const persistFeedback = container.querySelector<HTMLElement>(
    '[data-region="qa-persist-feedback"]',
  );
  const stressFeedback = container.querySelector<HTMLElement>(
    '[data-region="qa-stress-feedback"]',
  );
  const fixtureFeedback = container.querySelector<HTMLElement>(
    '[data-region="qa-fixture-feedback"]',
  );
  const fixtureInput = container.querySelector<HTMLInputElement>(
    '[data-region="qa-fixture-input"]',
  );
  const imageFeedback = container.querySelector<HTMLElement>(
    '[data-region="qa-image-feedback"]',
  );
  if (
    feedback === null ||
    reportRegion === null ||
    persistFeedback === null ||
    stressFeedback === null ||
    fixtureFeedback === null ||
    fixtureInput === null ||
    imageFeedback === null
  ) {
    return;
  }

  function setFeedback(text: string, isError = false): void {
    feedback!.textContent = text;
    feedback!.classList.toggle('qa-view__feedback--error', isError);
  }

  function setPersistFeedback(text: string, isError = false): void {
    persistFeedback!.textContent = text;
    persistFeedback!.classList.toggle('qa-view__feedback--error', isError);
  }

  function setStressFeedback(text: string, isError = false): void {
    stressFeedback!.textContent = text;
    stressFeedback!.classList.toggle('qa-view__feedback--error', isError);
  }

  function setFixtureFeedback(text: string, isError = false): void {
    fixtureFeedback!.textContent = text;
    fixtureFeedback!.classList.toggle('qa-view__feedback--error', isError);
  }

  function setImageFeedback(text: string, isError = false): void {
    imageFeedback!.textContent = text;
    imageFeedback!.classList.toggle('qa-view__feedback--error', isError);
  }

  async function runImageAudit(): Promise<void> {
    setImageFeedback('Teller bilde-dekning fra `cards`-store …');
    try {
      const audit = await auditCardImageCoverage(getDb());
      lastImageAudit = audit;
      const pct = (n: number): string =>
        audit.totalCards === 0
          ? '0%'
          : `${Math.round((n / audit.totalCards) * 100)}%`;
      setImageFeedback(
        `${audit.totalCards} kort · imageSmall ${audit.cardsWithImageSmall} (${pct(audit.cardsWithImageSmall)}) · imageLarge ${audit.cardsWithImageLarge} (${pct(audit.cardsWithImageLarge)}) · missing both ${audit.cardsMissingBoth} · runtime load failures ${audit.loadFailuresTotal}`,
        audit.cardsMissingBoth > 0 || audit.loadFailuresTotal > 0,
      );
    } catch (caught) {
      setImageFeedback(
        `Feil: ${caught instanceof Error ? caught.message : 'ukjent feil'}`,
        true,
      );
    }
  }

  async function handleFixtureFile(file: File): Promise<void> {
    setFixtureFeedback(`Leser ${file.name} (${(file.size / 1024).toFixed(0)} KB) …`);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const source = parseLocalSyncFixture(json, file.name);
      setFixtureFeedback(
        `Importerer ${source.sets.length} sett · ${source.cards.length} kort fra ${file.name} …`,
      );
      const result = await importLocalSyncFixture(getDb(), source);
      lastFixtureResult = result;
      if (result.ok) {
        setFixtureFeedback(
          `OK · ${result.setsCount} sett · ${result.cardsCount} kort · imageSmall=${result.cardsWithImageSmall}/${result.cardsCount} · imageLarge=${result.cardsWithImageLarge}/${result.cardsCount} · missing both=${result.cardsMissingBoth} · ${result.elapsedMs} ms`,
        );
      } else {
        setFixtureFeedback(`Feil: ${result.error}`, true);
      }
    } catch (caught) {
      setFixtureFeedback(
        `Feil: ${caught instanceof Error ? caught.message : 'ukjent feil'}`,
        true,
      );
    }
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

  async function runPersistenceDiagnostic(
    expectSeededDesktopData: boolean,
  ): Promise<void> {
    setPersistFeedback('Henter persistence-diagnostikk …');
    try {
      const db = getDb();
      const diagnostic = await buildPersistenceDiagnostic(db);
      lastDiagnostic = diagnostic;
      const verdict = evaluatePersistenceDiagnostic(diagnostic, {
        expectSeededDesktopData,
      });
      const holdings = diagnostic.storeCounts['holdings'] ?? -1;
      const sentinelLine =
        diagnostic.localStorageSentinel === null
          ? 'sentinel: missing'
          : `sentinel#${diagnostic.localStorageSentinel.bootCounter} (${diagnostic.localStorageSentinel.timestamp})`;
      setPersistFeedback(
        `Verdict: ${verdict} · holdings=${holdings} · ${sentinelLine}`,
        verdict.startsWith('fail_'),
      );
    } catch (caught) {
      setPersistFeedback(
        `Feil: ${
          caught instanceof Error ? caught.message : 'ukjent feil'
        }`,
        true,
      );
    }
  }

  async function runMaxStress(): Promise<void> {
    setStressFeedback('Kjører max-stress (kan ta noen minutter på 20 000 kort) …');
    try {
      const db = getDb();
      const summary = await seedMaxStressData(buildQaDeps(db));
      lastStressSummary = summary;
      setStressFeedback(
        `Ferdig — ${summary.holdings.total} holdings (${summary.holdings.raw} raw + ${summary.holdings.graded} graded), ${summary.binders.total} binders / ${summary.binders.slots} slots / ${summary.binders.assignedSlots} assigned, ${summary.wishlist.total} wishlist, ${summary.lots.items} lot items (${summary.lots.materialised} materialised). Brukte ${summary.cardsUsedForHoldings}/${summary.cards} kort. ${summary.elapsedMs} ms.${summary.notes.length > 0 ? ` Notes: ${summary.notes.length}` : ''}`,
      );
    } catch (caught) {
      setStressFeedback(
        `Feil: ${
          caught instanceof Error ? caught.message : 'ukjent feil'
        }`,
        true,
      );
    }
  }

  async function writeSentinel(): Promise<void> {
    setPersistFeedback('Skriver sentinel …');
    try {
      const db = getDb();
      const payload = await writePersistenceSentinel(db, {
        note: 'Manual L3 launch from QA view',
      });
      setPersistFeedback(
        `Sentinel skrevet: bootCounter=${payload.bootCounter} timestamp=${payload.timestamp} origin=${payload.origin} runtime=${payload.runtime}`,
      );
    } catch (caught) {
      setPersistFeedback(
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
      void handle({
        reset: true,
        seed: true,
        runtime: 'unknown',
        includePersistenceDiagnostic: true,
      });
    });
  container
    .querySelector<HTMLButtonElement>('[data-action="qa-measure"]')
    ?.addEventListener('click', () => {
      void handle({
        reset: false,
        seed: false,
        runtime: 'unknown',
        includePersistenceDiagnostic: true,
      });
    });

  container
    .querySelector<HTMLButtonElement>('[data-action="qa-image-audit"]')
    ?.addEventListener('click', () => {
      void runImageAudit();
    });
  container
    .querySelector<HTMLButtonElement>('[data-action="qa-image-download"]')
    ?.addEventListener('click', () => {
      if (lastImageAudit === null) {
        setImageFeedback(
          'Ingen audit ennå — kjør Run image audit først.',
          true,
        );
        return;
      }
      downloadTextFile(
        'desktop-qa-image-audit.json',
        JSON.stringify(lastImageAudit, null, 2),
        { mimeType: 'application/json' },
      );
    });

  container
    .querySelector<HTMLButtonElement>('[data-action="qa-fixture-pick"]')
    ?.addEventListener('click', () => {
      fixtureInput.click();
    });
  fixtureInput.addEventListener('change', () => {
    const file = fixtureInput.files?.[0];
    if (file !== undefined && file !== null) {
      void handleFixtureFile(file);
    }
  });
  container
    .querySelector<HTMLButtonElement>('[data-action="qa-fixture-download"]')
    ?.addEventListener('click', () => {
      if (lastFixtureResult === null) {
        setFixtureFeedback(
          'Ingen import-resultat ennå — velg fixture først.',
          true,
        );
        return;
      }
      downloadTextFile(
        'desktop-qa-fixture-import.json',
        JSON.stringify(lastFixtureResult, null, 2),
        { mimeType: 'application/json' },
      );
    });

  container
    .querySelector<HTMLButtonElement>('[data-action="qa-max-stress"]')
    ?.addEventListener('click', () => {
      void runMaxStress();
    });
  container
    .querySelector<HTMLButtonElement>('[data-action="qa-max-stress-download"]')
    ?.addEventListener('click', () => {
      if (lastStressSummary === null) {
        setStressFeedback(
          'Ingen stress-summary ennå — kjør Max stress først.',
          true,
        );
        return;
      }
      downloadTextFile(
        'desktop-qa-max-stress.json',
        JSON.stringify(lastStressSummary, null, 2),
        { mimeType: 'application/json' },
      );
    });

  container
    .querySelector<HTMLButtonElement>('[data-action="qa-persist-run"]')
    ?.addEventListener('click', () => {
      void runPersistenceDiagnostic(false);
    });
  container
    .querySelector<HTMLButtonElement>('[data-action="qa-persist-run-expect"]')
    ?.addEventListener('click', () => {
      void runPersistenceDiagnostic(true);
    });
  container
    .querySelector<HTMLButtonElement>('[data-action="qa-persist-sentinel"]')
    ?.addEventListener('click', () => {
      void writeSentinel();
    });
  container
    .querySelector<HTMLButtonElement>('[data-action="qa-persist-download"]')
    ?.addEventListener('click', () => {
      if (lastDiagnostic === null) {
        setPersistFeedback(
          'Ingen diagnostic ennå — kjør Run først.',
          true,
        );
        return;
      }
      downloadTextFile(
        `${PERSISTENCE_BASENAME}.json`,
        renderPersistenceDiagnosticJson(lastDiagnostic),
        { mimeType: 'application/json' },
      );
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
