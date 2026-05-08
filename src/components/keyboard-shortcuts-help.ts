// PR 27 — Snarveier-knapp i topplinjen + dialog som viser alle
// keyboard shortcuts. Visibility er gated på personal-preferences
// `showShortcutHints`. Knappen lever ved siden av global search slot
// i topbar; den fjernes hvis brukeren skrur av hint-flagget.
//
// Bruker eksisterende dialog-komponent. Ingen ny modal.
// Shortcut-handler i `keyboard-shortcuts.ts` ignorerer events innenfor
// `[role="dialog"]`, så Esc og taster trygt klippes.

import { openDialog, type DialogContent } from './dialog';
import { getDb } from '../db/database';
import { createSettingsRepo } from '../repositories/settings-repo';
import { createPersonalPreferencesService } from '../services/personal-preferences-service';

const HELP_BUTTON_REGION = 'topbar-shortcut-help';

export async function mountKeyboardShortcutsHelp(): Promise<void> {
  let visible = true;
  try {
    const svc = createPersonalPreferencesService(
      createSettingsRepo(getDb()),
    );
    const prefs = await svc.getPreferences();
    visible = prefs.showShortcutHints;
  } catch {
    // Fall back to visible — it's a hint button, not a privilege.
  }
  // Topbar status region is the natural anchor; the brand keeps its
  // own slot, the search component owns `topbar-search`. We tuck the
  // shortcut button into `topbar-status`'s sibling space by appending
  // a button into a dedicated slot. If the slot doesn't exist yet
  // (test harness skipped it), create it once next to the status
  // chip so future remounts can find and replace.
  const topbar = document.querySelector<HTMLElement>(
    '[data-region="topbar"]',
  );
  if (topbar === null) return;

  // Drop any existing shortcut-help button so we never end up with
  // duplicates after a SETTINGS_CHANGED_EVENT remount.
  const existing = topbar.querySelector<HTMLElement>(
    `[data-region="${HELP_BUTTON_REGION}"]`,
  );
  if (existing !== null) existing.remove();

  if (!visible) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'topbar__shortcut-help';
  button.dataset['region'] = HELP_BUTTON_REGION;
  button.dataset['action'] = 'open-shortcuts-help';
  button.textContent = 'Snarveier';
  button.addEventListener('click', () => {
    void openDialog(buildShortcutsHelpDialog());
  });
  // Insert before the status region if present, else append.
  const status = topbar.querySelector<HTMLElement>(
    '[data-region="topbar-status"]',
  );
  if (status !== null && status.parentNode !== null) {
    status.parentNode.insertBefore(button, status);
  } else {
    topbar.appendChild(button);
  }
}

function buildShortcutsHelpDialog(): DialogContent {
  return {
    mount(host) {
      const wrap = document.createElement('section');
      wrap.className = 'shortcuts-help';
      wrap.setAttribute('aria-labelledby', 'shortcuts-help-heading');
      const heading = document.createElement('h2');
      heading.id = 'shortcuts-help-heading';
      heading.textContent = 'Snarveier';
      wrap.appendChild(heading);
      const list = document.createElement('dl');
      list.className = 'shortcuts-help__list';
      for (const row of SHORTCUT_ROWS) {
        const dt = document.createElement('dt');
        dt.textContent = row.keys;
        list.appendChild(dt);
        const dd = document.createElement('dd');
        dd.textContent = row.label;
        list.appendChild(dd);
      }
      wrap.appendChild(list);
      host.appendChild(wrap);
    },
  };
}

const SHORTCUT_ROWS: ReadonlyArray<{
  readonly keys: string;
  readonly label: string;
}> = [
  { keys: 'g d', label: 'Dashboard' },
  { keys: 'g m', label: 'Master gap' },
  { keys: 'g b', label: 'Browse' },
  { keys: 'g c', label: 'Min samling' },
  { keys: 'g p', label: 'Permer' },
  { keys: 'g l', label: 'Lotter' },
  { keys: 'g w', label: 'Ønskeliste' },
  { keys: 'Ctrl/Cmd + K', label: 'Global search' },
  { keys: 'Esc', label: 'Lukk / avbryt' },
];
