// PR 28 review patch (Phase 5) — dev-only image audit.
//
// Two complementary measurements:
//
// 1. Static coverage. Walk the `cards` store and count which records
//    expose `imageSmall` and/or `imageLarge`. Records that lack both
//    are the ones the dashboard / Browse cannot render.
//
// 2. Runtime load failures. `createLazyImage` dispatches a
//    `pokemon:image-load-error` window event when a thumbnail's
//    `<img>` fires `onerror`. This module attaches a single listener
//    on first call (idempotent) and accumulates failures per
//    {src, route} pair so the audit can report the first N broken
//    URLs across a real route walk.
//
// Tree-shaken from production via the dev-only QA view.

import type { PokemonTrackerDB } from '../db/database';

export interface ImageAuditMissing {
  readonly id: string;
  readonly setId: string;
  readonly name: string;
  readonly imageSmall: string | null;
  readonly imageLarge: string | null;
}

export interface ImageAuditLoadFailure {
  readonly src: string;
  readonly alt: string;
  readonly route: string;
  readonly ts: string;
}

export interface ImageAuditCoverage {
  readonly totalCards: number;
  readonly cardsWithImageSmall: number;
  readonly cardsWithImageLarge: number;
  readonly cardsWithBoth: number;
  readonly cardsMissingBoth: number;
  readonly missingSample: ReadonlyArray<ImageAuditMissing>;
  readonly loadFailuresSample: ReadonlyArray<ImageAuditLoadFailure>;
  readonly loadFailuresTotal: number;
  readonly capturedAt: string;
}

const SAMPLE_LIMIT = 20;
const FAILURE_LIMIT = 200;
const failures: ImageAuditLoadFailure[] = [];
let listener: ((event: Event) => void) | null = null;

interface ImageLoadErrorDetail {
  readonly src?: unknown;
  readonly alt?: unknown;
  readonly route?: unknown;
  readonly ts?: unknown;
}

/**
 * Idempotently install the runtime image-load-error listener. The
 * QA view calls this on mount; subsequent re-mounts during a Vite
 * HMR cycle won't double-register. Internally tracks the listener
 * so `_resetImageAuditForTests` can fully detach it between cases.
 */
export function installImageAudit(): void {
  if (listener !== null) return;
  if (typeof window === 'undefined') return;
  listener = (event: Event): void => {
    const ce = event as CustomEvent<ImageLoadErrorDetail>;
    const detail = ce.detail ?? {};
    if (failures.length >= FAILURE_LIMIT) return;
    failures.push({
      src: typeof detail.src === 'string' ? detail.src : '<unknown>',
      alt: typeof detail.alt === 'string' ? detail.alt : '',
      route: typeof detail.route === 'string' ? detail.route : '<unknown>',
      ts: typeof detail.ts === 'string' ? detail.ts : new Date().toISOString(),
    });
  };
  window.addEventListener('pokemon:image-load-error', listener);
}

/**
 * Read coverage straight from the cards table. Iterates ALL cards —
 * for ~20 000-card caches this takes a few hundred milliseconds on
 * the dev WebView2.
 */
export async function auditCardImageCoverage(
  db: PokemonTrackerDB,
): Promise<ImageAuditCoverage> {
  installImageAudit();
  const capturedAt = new Date().toISOString();
  let totalCards = 0;
  let cardsWithImageSmall = 0;
  let cardsWithImageLarge = 0;
  let cardsWithBoth = 0;
  let cardsMissingBoth = 0;
  const missingSample: ImageAuditMissing[] = [];

  await db.cards.each((card) => {
    totalCards += 1;
    const small =
      typeof card.imageSmall === 'string' && card.imageSmall.length > 0;
    const large =
      typeof card.imageLarge === 'string' && card.imageLarge.length > 0;
    if (small) cardsWithImageSmall += 1;
    if (large) cardsWithImageLarge += 1;
    if (small && large) cardsWithBoth += 1;
    if (!small && !large) {
      cardsMissingBoth += 1;
      if (missingSample.length < SAMPLE_LIMIT) {
        missingSample.push({
          id: card.id,
          setId: card.setId,
          name: card.name,
          imageSmall: card.imageSmall,
          imageLarge: card.imageLarge,
        });
      }
    }
  });

  return {
    totalCards,
    cardsWithImageSmall,
    cardsWithImageLarge,
    cardsWithBoth,
    cardsMissingBoth,
    missingSample,
    loadFailuresSample: failures.slice(0, SAMPLE_LIMIT),
    loadFailuresTotal: failures.length,
    capturedAt,
  };
}

/**
 * Test-only — drop the captured failures and detach the global
 * listener so the next test starts from zero.
 */
export function _resetImageAuditForTests(): void {
  failures.length = 0;
  if (listener !== null && typeof window !== 'undefined') {
    window.removeEventListener('pokemon:image-load-error', listener);
  }
  listener = null;
}
