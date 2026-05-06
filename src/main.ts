import { mountApp } from './app';
import { initializeDataLayer } from './db/init';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Root element #app not found');
}

// Render the app shell first. Data layer initialization is async and may
// fail (corrupted DB, denied storage, browser quota); the shell stays
// usable either way. PR 4+ wires the result into a UI status chip.
mountApp(root);

initializeDataLayer().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- intentional: surface init
  // failures during development. UI escalation comes in a later PR.
  console.error('[data-layer] initialization failed', error);
});
