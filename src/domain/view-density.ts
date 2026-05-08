// PR 26 — view density domain helpers. Per-view in-memory state only;
// no DB persistence in PR 26. The master-gap report uses these to flip
// table padding/font-size; other views may adopt the same enum later.

export type ViewDensity = 'comfortable' | 'compact';

export function viewDensityLabel(density: ViewDensity): string {
  return density === 'compact' ? 'Kompakt' : 'Komfortabel';
}

export function nextViewDensity(density: ViewDensity): ViewDensity {
  return density === 'compact' ? 'comfortable' : 'compact';
}
