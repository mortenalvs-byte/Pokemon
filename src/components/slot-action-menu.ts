// Slot action menu. Renders inside an `<dialog>` for the binder detail
// view and exposes the status changes the user can apply to a single
// slot. There is intentionally NO "Mark owned" option — `owned` is only
// reachable by assigning a holding to the slot, because owned without a
// holding is meaningless under KRAVSPEC §6 completion rules.
//
// The "Tøm slot" (clear) action resets `holdingId` and `status` to
// `empty`/`wanted` while preserving `targetCardId`. This is the rule the
// user explicitly called out for PR 8a: clearing must never destroy the
// slot's identity in a from-set template.

import { DIALOG_SUBMITTED_EVENT } from './dialog';
import { USER_DATA_CHANGED_EVENT } from './events';
import { getDb } from '../db/database';
import { ValidationError } from '../domain/validators';
import { createBinderSlotsRepo } from '../repositories/binder-slots-repo';
import type {
  BinderSlotRecord,
  BinderSlotStatus,
} from '../domain/types';
import type { DialogContent } from './dialog';

export interface SlotActionMenuOptions {
  readonly slot: BinderSlotRecord;
  readonly slotsPerPage: 9 | 18;
}

interface MenuAction {
  readonly label: string;
  readonly status: BinderSlotStatus;
  readonly action: 'set-status' | 'clear';
}

const ACTIONS: readonly MenuAction[] = [
  { label: 'Marker som ønsket', status: 'wanted', action: 'set-status' },
  { label: 'Marker som bestilt', status: 'ordered', action: 'set-status' },
  { label: 'Marker som mangler', status: 'missing', action: 'set-status' },
  { label: 'Marker som duplikat', status: 'duplicate', action: 'set-status' },
  {
    label: 'Marker for oppgradering',
    status: 'upgrade_needed',
    action: 'set-status',
  },
  { label: 'Tøm slot', status: 'empty', action: 'clear' },
];

export function buildSlotActionMenu(
  options: SlotActionMenuOptions,
): DialogContent {
  return {
    mount(host, close) {
      mount(options, host, close);
    },
  };
}

function mount(
  options: SlotActionMenuOptions,
  host: HTMLElement,
  close: () => void,
): void {
  host.appendChild(buildSkeleton(options.slot));
  const root = host.querySelector<HTMLElement>('.slot-action-menu');
  if (root === null) return;

  for (const action of ACTIONS) {
    if (action.action === 'set-status' && options.slot.status === action.status) {
      // Don't offer the status the slot is already in.
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'slot-action-menu__option';
    button.dataset['action'] = action.action;
    button.dataset['status'] = action.status;
    button.textContent = action.label;
    button.addEventListener('click', () => {
      void handleAction(options, action, host);
    });
    root.appendChild(button);
  }

  const errorRegion = document.createElement('p');
  errorRegion.className = 'slot-action-menu__error';
  errorRegion.dataset['region'] = 'form-error';
  errorRegion.setAttribute('role', 'alert');
  errorRegion.setAttribute('aria-live', 'polite');
  root.appendChild(errorRegion);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'slot-action-menu__cancel';
  cancel.dataset['action'] = 'cancel';
  cancel.textContent = 'Lukk';
  cancel.addEventListener('click', () => close());
  root.appendChild(cancel);
}

function buildSkeleton(slot: BinderSlotRecord): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'slot-action-menu-wrap';

  const header = document.createElement('header');
  header.className = 'slot-action-menu__header';
  const title = document.createElement('h2');
  title.textContent = `Side ${slot.pageNumber} · slot ${slot.slotNumber}`;
  header.appendChild(title);
  wrap.appendChild(header);

  const root = document.createElement('div');
  root.className = 'slot-action-menu';
  wrap.appendChild(root);

  return wrap;
}

async function handleAction(
  options: SlotActionMenuOptions,
  action: MenuAction,
  host: HTMLElement,
): Promise<void> {
  const errorRegion = host.querySelector<HTMLElement>('[data-region="form-error"]');
  if (errorRegion !== null) errorRegion.textContent = '';

  try {
    const repo = createBinderSlotsRepo(getDb());
    if (action.action === 'clear') {
      // Preserve targetCardId so the slot keeps its identity in a
      // from-set template; only reset what the user has changed.
      await repo.update(
        options.slot.id,
        {
          holdingId: null,
          status: options.slot.targetCardId !== null ? 'wanted' : 'empty',
          note: null,
        },
        options.slotsPerPage,
      );
    } else {
      await repo.update(
        options.slot.id,
        { status: action.status },
        options.slotsPerPage,
      );
    }
  } catch (caught) {
    if (errorRegion !== null) {
      errorRegion.textContent = describeError(caught);
    }
    return;
  }

  window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  host.dispatchEvent(new CustomEvent(DIALOG_SUBMITTED_EVENT));
}

function describeError(caught: unknown): string {
  if (caught instanceof ValidationError) {
    return `Feil: ${caught.message}`;
  }
  if (caught instanceof Error) {
    return `Handling feilet: ${caught.message}`;
  }
  return 'Handling feilet av en ukjent grunn.';
}
