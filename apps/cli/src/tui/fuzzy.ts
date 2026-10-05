/**
 * Subsequence matching with a bias toward matches at word starts and runs of
 * adjacent characters — enough for command and history search, no dependency.
 */
export function fuzzyScore(needle: string, haystack: string): number | null {
  if (!needle) return 0;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  let score = 0;
  let hi = 0;
  let prevMatch = -2;
  for (const ch of n) {
    const found = h.indexOf(ch, hi);
    if (found < 0) return null;
    if (found === prevMatch + 1) score += 8; // adjacent
    if (found === 0 || /[\s/_\-.:]/.test(h[found - 1] ?? "")) score += 6; // word start
    score -= Math.min(4, found - hi); // distance penalty
    prevMatch = found;
    hi = found + 1;
  }
  return score - Math.max(0, haystack.length - needle.length) * 0.05;
}

export function fuzzyFilter<T>(items: T[], needle: string, key: (t: T) => string, limit = 8): T[] {
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const s = fuzzyScore(needle, key(item));
    if (s !== null) scored.push({ item, score: s });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.item);
}

/** Indices of the matched characters, for highlighting. */
export function matchPositions(needle: string, haystack: string): Set<number> {
  const out = new Set<number>();
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  let hi = 0;
  for (const ch of n) {
    const found = h.indexOf(ch, hi);
    if (found < 0) break;
    out.add(found);
    hi = found + 1;
  }
  return out;
}
