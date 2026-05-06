// Cross-cutting custom events. Dispatched on `window` so any view that
// renders user-data-derived state (Browse rows, Card Detail "Dine kort"
// section, the Collection view itself) can refresh without a global
// store. Same pattern as `pokemon:sync-status-changed` in the Settings
// view — small, native, no dependencies.

export const USER_DATA_CHANGED_EVENT = 'pokemon:user-data-changed';
