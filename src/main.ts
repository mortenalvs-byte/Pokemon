import { mountApp } from './app';
import { initializeDataLayer } from './db/init';

// PR 31 — dev-only runtime separation.
//
// The console-audit hook, the auto route walk, and the four
// `pokemon.devAuto*` boot triggers all live in `src/qa/dev-runtime.ts`.
// We dynamic-import them inside `if (import.meta.env.DEV)` branches
// so production tree-shaking drops the entire chunk (plus its
// transitive imports — `qa-max-stress`, `qa-runner`, `image-audit`,
// `local-sync-fixture`, `desktop-persistence-diagnostic`) from the
// bundle. Production gating is re-pinned by
// `tests/qa-route-prod-gating.test.ts` (banned-string list extended
// with the new entry-point identifier).

if (import.meta.env.DEV) {
  void import('./qa/dev-runtime').then((mod) => {
    mod.installConsoleAudit();
  });
}

const root = document.getElementById('app');
if (!root) {
  throw new Error('Root element #app not found');
}

// Render the app shell first. Data layer initialization is async and may
// fail (corrupted DB, denied storage, browser quota); the shell stays
// usable either way. PR 4+ wires the result into a UI status chip.
mountApp(root);

initializeDataLayer()
  .then(async () => {
    if (import.meta.env.DEV) {
      const mod = await import('./qa/dev-runtime');
      await mod.runDevAutoTriggersAfterInit();
    }
  })
  .catch((error: unknown) => {
    // Intentional: surface init failures during development. UI
    // escalation comes in a later PR.
    console.error('[data-layer] initialization failed', error);
  });
