// PR 22 — single source of truth for "active vs closed" wishlist
// semantics. Before this module the same boolean check (`status ===
// 'wanted' || status === 'ordered'`) was being copy-pasted across
// receive-flow code paths and view counts. Drift across copies would
// silently change which wishlist rows count as actionable, so the
// rule is locked here.
//
// Definitions:
//   - Active   = `wanted | ordered` → user is still trying to acquire
//                the card. The receive flow targets these.
//   - Closed   = `received | cancelled` → user is done with it. These
//                rows still exist (history) but should not count as
//                "open wishlist" anywhere in the UI.

import type { WishlistStatus } from './types';

export const ACTIVE_WISHLIST_STATUSES: readonly WishlistStatus[] = [
  'wanted',
  'ordered',
];

export const CLOSED_WISHLIST_STATUSES: readonly WishlistStatus[] = [
  'received',
  'cancelled',
];

export function isActiveWishlistStatus(status: WishlistStatus): boolean {
  return status === 'wanted' || status === 'ordered';
}

export function isClosedWishlistStatus(status: WishlistStatus): boolean {
  return status === 'received' || status === 'cancelled';
}

const STATUS_LABELS: Record<WishlistStatus, string> = {
  wanted: 'Ønsket',
  ordered: 'Bestilt',
  received: 'Mottatt',
  cancelled: 'Avbrutt',
};

export function wishlistStatusLabel(status: WishlistStatus): string {
  return STATUS_LABELS[status];
}
