/**
 * Coordinate protocol v2.
 *
 * Every position exchanged between the client caret, the API and the server
 * split logic is a *grapheme index*: a count of extended grapheme clusters
 * (UAX #29, via Intl.Segmenter), never a UTF-16 code-unit offset. A grapheme
 * index `i` addresses the boundary before the i-th cluster, so valid split
 * positions for a text of `n` clusters are exactly the integers `1..n-1`.
 *
 * Legacy UTF-16 offsets are converted with the deterministic rules in
 * `utf16ToGrapheme`; both the client caret display and the server use these
 * same functions so the two ends can never disagree.
 */

const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});

export type GraphemeMap = {
  /** The clusters of the text, in logical order. */
  clusters: string[];
  /**
   * UTF-16 offset at which each cluster starts. Has `clusters.length + 1`
   * entries; the final entry is `text.length` (the end boundary).
   */
  starts: number[];
};

export function indexGraphemes(text: string): GraphemeMap {
  const clusters: string[] = [];
  const starts: number[] = [];
  for (const part of segmenter.segment(text)) {
    starts.push(part.index);
    clusters.push(part.segment);
  }
  starts.push(text.length);
  return {clusters, starts};
}

export function graphemes(text: string): string[] {
  return indexGraphemes(text).clusters;
}

export function graphemeCount(text: string): number {
  if (text.length === 0) return 0;
  let n = 0;
  for (const _ of segmenter.segment(text)) n += 1;
  return n;
}

/** UTF-16 offset of the boundary before grapheme `index` (clamped to 0..count). */
export function graphemeToUtf16(text: string, index: number): number {
  const map = indexGraphemes(text);
  const clamped = Math.min(Math.max(Math.trunc(index), 0), map.clusters.length);
  return map.starts[clamped];
}

/** True when `offset` (UTF-16) falls exactly on a grapheme boundary. */
export function isGraphemeBoundaryUtf16(text: string, offset: number): boolean {
  return indexGraphemes(text).starts.includes(offset);
}

export type Utf16Mode = 'start' | 'end' | 'nearest';

/**
 * Deterministic UTF-16 → grapheme-index conversion.
 *
 * Offsets exactly on a boundary map to that boundary under every mode.
 * Offsets inside a cluster (e.g. between the halves of a surrogate pair, or
 * between a base letter and a combining mark) resolve by mode:
 *
 * - `'start'`   floor — the index of the containing cluster. Used for
 *               annotation *starts* during migration.
 * - `'end'`     ceil — the boundary after the containing cluster. Used for
 *               annotation *ends* during migration, so a migrated range
 *               always covers at least the clusters it used to cover.
 * - `'nearest'` closest boundary; ties resolve forward (after the cluster).
 *               Used for caret snapping.
 */
export function utf16ToGrapheme(text: string, offset: number, mode: Utf16Mode): number {
  const map = indexGraphemes(text);
  const n = map.clusters.length;
  const o = Math.min(Math.max(Math.trunc(offset), 0), text.length);
  // Find the cluster i with starts[i] <= o < starts[i + 1]. When o equals
  // text.length the loop advances i to n and the boundary check returns n.
  let i = 0;
  while (i < n && map.starts[i + 1] <= o) i += 1;
  if (map.starts[i] === o) return i;
  switch (mode) {
    case 'start':
      return i;
    case 'end':
      return i + 1;
    case 'nearest': {
      const before = o - map.starts[i];
      const after = map.starts[i + 1] - o;
      return before < after ? i : i + 1; // tie → forward
    }
  }
}

/** Snap a UTF-16 caret offset to the nearest grapheme boundary (ties forward). */
export function snapUtf16(text: string, offset: number): number {
  return graphemeToUtf16(text, utf16ToGrapheme(text, offset, 'nearest'));
}

/**
 * Snap a UTF-16 caret offset to the nearest grapheme boundary and return the
 * boundary as a grapheme index. This is the single conversion both the client
 * caret and the server's legacy-coordinate path rely on.
 */
export function snapUtf16ToGrapheme(text: string, offset: number): number {
  return utf16ToGrapheme(text, offset, 'nearest');
}
