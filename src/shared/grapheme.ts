/**
 * Grapheme coordinate protocol (v1).
 *
 * Canonical positions and ranges across the cursor, the API and the server are
 * expressed as *grapheme indices*: a position p in [0, graphemeCount(text)] is
 * the boundary before the p-th extended grapheme cluster (UAX #29, via
 * Intl.Segmenter). Legacy UTF-16 code-unit offsets are converted
 * deterministically at the API edge:
 *   - positions (cursor / split point): nearest boundary, ties snap low;
 *   - ranges (annotations): start floors, end ceils, so a migrated range still
 *     covers every cluster its UTF-16 range touched.
 */

const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});

/** UTF-16 offsets of every grapheme boundary, ascending: [0, ..., text.length]. */
export function graphemeBoundaries(text: string): number[] {
  const boundaries: number[] = [];
  for (const segment of segmenter.segment(text)) boundaries.push(segment.index);
  boundaries.push(text.length);
  return boundaries;
}

/** Number of grapheme clusters (== number of valid split positions - 1). */
export function graphemeCount(text: string): number {
  return graphemeBoundaries(text).length - 1;
}

/** UTF-16 offset of the boundary before grapheme `index`. Clamped to [0, count]. */
export function graphemeIndexToUtf16(text: string, index: number): number {
  const boundaries = graphemeBoundaries(text);
  const clamped = Math.min(Math.max(Math.trunc(index), 0), boundaries.length - 1);
  return boundaries[clamped];
}

/** The graphemes in [start, end) joined back into a string. */
export function sliceByGraphemes(text: string, start: number, end: number): string {
  return text.slice(graphemeIndexToUtf16(text, start), graphemeIndexToUtf16(text, end));
}

export type BoundaryMode = 'floor' | 'ceil' | 'nearest';

/**
 * Convert a (possibly mid-cluster) UTF-16 offset to a grapheme index.
 * 'nearest' resolves ties to the lower boundary. Offsets outside
 * [0, text.length] are clamped first.
 */
export function utf16ToGrapheme(text: string, offset: number, mode: BoundaryMode = 'nearest'): number {
  const boundaries = graphemeBoundaries(text);
  const target = Math.min(Math.max(Math.trunc(offset), 0), text.length);
  let low = 0;
  let high = boundaries.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (boundaries[mid] <= target) low = mid;
    else high = mid - 1;
  }
  // boundaries[low] <= target < boundaries[low + 1] (or target === text.length).
  if (mode === 'floor' || low === boundaries.length - 1) return low;
  const upper = boundaries[low + 1];
  if (boundaries[low] === target) return low;
  if (mode === 'ceil') return low + 1;
  return target - boundaries[low] <= upper - target ? low : low + 1;
}

export type SnapResult = {offset: number; moved: boolean};

/** Snap a UTF-16 offset to the nearest grapheme boundary (ties snap low). */
export function snapUtf16(text: string, offset: number): SnapResult {
  const clamped = Math.min(Math.max(Math.trunc(offset), 0), text.length);
  const index = utf16ToGrapheme(text, clamped, 'nearest');
  const snapped = graphemeIndexToUtf16(text, index);
  return {offset: snapped, moved: snapped !== clamped};
}

export type CursorPosition = {
  /** Raw UTF-16 caret offset, e.g. textarea.selectionStart. */
  utf16: number;
  /** Canonical grapheme index after snapping; the only splittable position. */
  grapheme: number;
  /** UTF-16 offset actually used (== utf16 when already on a boundary). */
  snappedUtf16: number;
  /** True when the raw offset fell inside a cluster and had to move. */
  snapped: boolean;
  graphemeCount: number;
};

/** Resolve a raw caret offset into the canonical protocol position. */
export function resolveCursor(text: string, utf16Offset: number): CursorPosition {
  const utf16 = Math.min(Math.max(Math.trunc(utf16Offset), 0), text.length);
  const snap = snapUtf16(text, utf16);
  return {
    utf16,
    grapheme: utf16ToGrapheme(text, snap.offset, 'nearest'),
    snappedUtf16: snap.offset,
    snapped: snap.moved,
    graphemeCount: graphemeBoundaries(text).length - 1,
  };
}
