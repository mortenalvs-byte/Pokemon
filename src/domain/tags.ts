// Tag normalization for holdings.
//
// Users type tags as a comma-separated string in the holding form
// ("favorite, to_grade, HIGH_VALUE,favorite"). The repo stores them as
// `tags: string[]` on `HoldingRecord`. Run every input through
// `parseTags()` so the stored array is canonical: trimmed, lowercased,
// deduplicated, with empty entries dropped. Order matches first
// occurrence in the input.

export function parseTags(input: string): string[] {
  if (input.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of input.split(',')) {
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function formatTags(tags: readonly string[]): string {
  return tags.join(', ');
}
