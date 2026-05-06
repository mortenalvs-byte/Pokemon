// Re-export every repo factory so the broad repository test suite has a
// single import line. Production code imports directly from each
// repository module.

export { createSetsRepo } from '../../src/repositories/sets-repo';
export { createCardsRepo } from '../../src/repositories/cards-repo';
export { createHoldingsRepo } from '../../src/repositories/holdings-repo';
export { createLotsRepo } from '../../src/repositories/lots-repo';
export { createLotItemsRepo } from '../../src/repositories/lot-items-repo';
export { createBindersRepo } from '../../src/repositories/binders-repo';
export { createBinderSlotsRepo } from '../../src/repositories/binder-slots-repo';
export { createWishlistRepo } from '../../src/repositories/wishlist-repo';
export { createSettingsRepo } from '../../src/repositories/settings-repo';
export { createAppMetaRepo } from '../../src/repositories/app-meta-repo';
