// PR 34 — async dialog/handler routines lifted from
// `src/views/binder-detail.ts`.
//
// Every handler in this module is **stateless**: it takes its slot
// + slotsPerPage (or banner element + binderId) and runs against
// the live DB and global services. Nothing here reads or mutates
// the orchestrator's `ViewState` closure.
//
// `handleAutoAssign` stays in the orchestrator because it owns the
// summary cache + triggers a re-render through the per-mount
// `renderInto` closure; lifting it would require passing both
// state and a re-render callback.
//
// `buildAutoAssignSummary` and `buildGapBannerSkeleton` are render
// helpers — they live in the orchestrator alongside the other
// `build*` builders for now and may move in a follow-up PR.

import { openDialog } from '../components/dialog';
import { USER_DATA_CHANGED_EVENT } from '../components/events';
import { buildAssignHoldingModal } from '../components/assign-holding-modal';
import { buildSlotActionMenu } from '../components/slot-action-menu';
import { buildSlotDirectAddForm } from '../components/slot-direct-add-form';
import { openWishlistReceivePrompt } from '../components/wishlist-receive-prompt';
import { getDb } from '../db/database';
import type { MasterGapBinderSummary } from '../domain/master-set-gap';
import { navigateToMasterGapBinder } from '../router';
import { createBindersRepo } from '../repositories/binders-repo';
import { createBinderSlotsRepo } from '../repositories/binder-slots-repo';
import { createCardsRepo } from '../repositories/cards-repo';
import { createHoldingsRepo } from '../repositories/holdings-repo';
import { createLotItemsRepo } from '../repositories/lot-items-repo';
import { createSetsRepo } from '../repositories/sets-repo';
import { createWishlistRepo } from '../repositories/wishlist-repo';
import { createBinderCsvExporter } from '../services/binder-csv-export';
import { assignHoldingToSlot } from '../services/binder-assignment-service';
import { createMasterSetGapService } from '../services/master-set-gap-service';
import { findWishlistReceiveCandidates } from '../services/wishlist-receive-service';
import { downloadTextFile } from '../utils/download';
import type { BinderSlotRecord, SlotsPerPage } from '../domain/types';

// ---------------------------------------------------------------------
// Master-set-gap banner.
//
// `buildGapBannerSkeleton` is the synchronous DOM placeholder; it
// stays in the orchestrator alongside the other `build*` helpers.
// `populateGapBanner` is the async fetch + render that fills the
// skeleton in. It is stateless — only takes the banner element and
// the binder id.

export async function populateGapBanner(
  banner: HTMLElement,
  binderId: string,
): Promise<void> {
  let summary: MasterGapBinderSummary | null;
  try {
    const db = getDb();
    const report = await createMasterSetGapService({
      bindersRepo: createBindersRepo(db),
      binderSlotsRepo: createBinderSlotsRepo(db),
      cardsRepo: createCardsRepo(db),
      setsRepo: createSetsRepo(db),
      holdingsRepo: createHoldingsRepo(db),
      wishlistRepo: createWishlistRepo(db),
      lotItemsRepo: createLotItemsRepo(db),
    }).buildBinderReport(binderId);
    summary = report?.binder ?? null;
  } catch {
    if (!banner.isConnected) return;
    banner.replaceChildren();
    const err = document.createElement('p');
    err.className = 'binder-detail-view__gap-summary-error';
    err.textContent = 'Kunne ikke laste gap-analyse.';
    banner.appendChild(err);
    return;
  }
  if (!banner.isConnected) return;
  if (summary === null) {
    banner.replaceChildren();
    return;
  }

  banner.replaceChildren();
  const fragment = `Master gap: ${summary.complete} / ${summary.totalTargetSlots} fullført · ${summary.missing} mangler · ${summary.ownedUnplaced} eies men ikke plassert · ${summary.wishlistWanted} ønsket · ${summary.wishlistOrdered} bestilt · ${summary.invalidAssignment + summary.invalidVariant} feil`;
  const main = document.createElement('p');
  main.className = 'binder-detail-view__gap-summary-line';
  main.textContent = fragment;
  banner.appendChild(main);

  if (summary.canPlaceDirectlyCount > 0) {
    const directly = document.createElement('p');
    directly.className =
      'binder-detail-view__gap-summary-line binder-detail-view__gap-summary-line--quickwin';
    directly.textContent = `${summary.canPlaceDirectlyCount} kan plasseres direkte`;
    banner.appendChild(directly);
  }

  const showBtn = document.createElement('button');
  showBtn.type = 'button';
  showBtn.className = 'binder-detail-view__gap-summary-action';
  showBtn.dataset['action'] = 'show-gap';
  showBtn.textContent = 'Vis gap';
  showBtn.addEventListener('click', () => {
    navigateToMasterGapBinder(binderId);
  });
  banner.appendChild(showBtn);
}

// ---------------------------------------------------------------------
// CSV export.
//
// Builds the CSV via the canonical exporter, hands the content to
// the download helper FIRST, then writes the audit row. Same
// "audit ↔ download started" semantics as PR 8b.

export async function handleExportCsv(binderId: string): Promise<void> {
  const db = getDb();
  const exporter = createBinderCsvExporter(
    db,
    createBindersRepo(db),
    createBinderSlotsRepo(db),
    createHoldingsRepo(db),
    createCardsRepo(db),
    createSetsRepo(db),
  );
  const result = await exporter.build(binderId);
  if (result === null) return;
  // Hand the content to the download helper FIRST. The audit row says
  // "the CSV was generated and a download was started" — write it
  // after the call so a thrown error in download still leaves an
  // audit-correct trail (or no trail at all on failure).
  downloadTextFile(result.filename, result.content, { mimeType: 'text/csv' });
  const binder = await createBindersRepo(db).get(binderId);
  if (binder === undefined) return;
  await exporter.recordExport(binder, result.rowCount);
}

// ---------------------------------------------------------------------
// Per-slot dialog openers + single-click "Plasser" handler.

export async function openAssign(
  slot: BinderSlotRecord,
  slotsPerPage: SlotsPerPage,
): Promise<void> {
  await openDialog(buildAssignHoldingModal({ slot, slotsPerPage }));
}

export async function openMenu(
  slot: BinderSlotRecord,
  slotsPerPage: SlotsPerPage,
): Promise<void> {
  await openDialog(buildSlotActionMenu({ slot, slotsPerPage }));
}

// PR 24 — single-click "Plasser" handler. Looks up the eligible
// holding by id and calls assignHoldingToSlot. We do NOT re-open the
// assign modal because the candidate is unambiguous (count === 1 was
// the badge condition).
export async function handlePlaceEligible(
  slot: BinderSlotRecord,
  slotsPerPage: SlotsPerPage,
  holdingId: string,
): Promise<void> {
  const db = getDb();
  const holdingsRepo = createHoldingsRepo(db);
  const holding = await holdingsRepo.get(holdingId);
  if (holding === undefined || holding.deletedAt !== null) {
    window.alert('Holding finnes ikke lenger. Last inn permen på nytt.');
    return;
  }
  try {
    await assignHoldingToSlot(
      {
        bindersRepo: createBindersRepo(db),
        binderSlotsRepo: createBinderSlotsRepo(db),
        holdingsRepo,
        cardsRepo: createCardsRepo(db),
      },
      slot,
      holding,
      slotsPerPage,
    );
    window.dispatchEvent(new CustomEvent(USER_DATA_CHANGED_EVENT));
  } catch (caught) {
    window.alert(
      caught instanceof Error
        ? `Plassering feilet: ${caught.message}`
        : 'Plassering feilet av en ukjent grunn.',
    );
  }
}

// PR 24 — direct-add for target slots. Opens the smaller slot form
// from `slot-direct-add-form.ts`; on success we run the wishlist
// receive prompt for the freshly-created holding so the receive flow
// stays consistent across all write-paths.
export async function openDirectAdd(
  slot: BinderSlotRecord,
  slotsPerPage: SlotsPerPage,
): Promise<void> {
  let createdHoldingId: string | null = null;
  await openDialog(
    buildSlotDirectAddForm({
      slot,
      slotsPerPage,
      onCreated: (holding) => {
        createdHoldingId = holding.id;
      },
    }),
  );
  if (createdHoldingId === null) return;
  try {
    const db = getDb();
    const holding = await createHoldingsRepo(db).get(createdHoldingId);
    if (holding === undefined) return;
    const candidates = await findWishlistReceiveCandidates(
      createWishlistRepo(db),
      holding,
    );
    if (candidates.length === 0) return;
    await openWishlistReceivePrompt({
      candidates,
      heading:
        candidates.length === 1
          ? 'Legg til i slot: 1 match på aktiv ønskeliste.'
          : `Legg til i slot: ${candidates.length} matcher på aktiv ønskeliste.`,
    });
  } catch {
    // Receive flow is non-blocking. Holding + slot are already saved.
  }
}
