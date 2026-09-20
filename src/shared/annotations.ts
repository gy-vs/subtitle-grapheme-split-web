/**
 * Cue annotations (speaker labels, word-level timings) and the split
 * algorithm. All offsets here are grapheme indices — see grapheme.ts for the
 * coordinate protocol. The split rules:
 *
 *   - annotation.end   <= pos  -> belongs to the left cue, offsets unchanged;
 *   - annotation.start >= pos  -> belongs to the right cue, offsets shift by -pos;
 *   - start < pos < end (truly straddling):
 *       * word timings are atomic: the word is attributed wholesale to the
 *         side holding the majority of its graphemes (ties go left), its text
 *         range is clamped to that cue, its time range is kept whole;
 *       * range annotations (speaker labels) are split into two segments, one
 *         clamped to each cue.
 *
 * The cue's own time range splits at the straddling word's boundary in time
 * (word.endMs when the word goes left, word.startMs when it goes right); with
 * no straddling word it splits proportionally to the grapheme ratio.
 */
import {graphemeCount, sliceByGraphemes, utf16ToGrapheme} from './grapheme';

export type AnnotationKind = 'speaker' | 'word';

export type Annotation = {
  id: string;
  kind: AnnotationKind;
  /** Grapheme range [start, end) into the owning cue's text. */
  start: number;
  end: number;
  /** Speaker name for kind 'speaker', the written word for kind 'word'. */
  label?: string;
  /** Word-level timing, milliseconds. */
  startMs?: number;
  endMs?: number;
};

export type CoordinateUnits = 'grapheme' | 'utf16';

export type Cue = {
  id: string;
  revision: number;
  startMs: number;
  endMs: number;
  text: string;
  annotations: Annotation[];
  /** Units of annotation.start/end as stored. Canonical form is 'grapheme'. */
  annotationUnits: CoordinateUnits;
};

export class SplitPositionError extends Error {
  readonly graphemeCount: number;
  constructor(position: number, count: number) {
    super(`invalid split position ${position}; expected an integer in [0, ${count}]`);
    this.name = 'SplitPositionError';
    this.graphemeCount = count;
  }
}

// ---------------------------------------------------------------------------
// Legacy UTF-16 migration
// ---------------------------------------------------------------------------

export type MigrationEntry = {
  id: string;
  from: {start: number; end: number};
  to: {start: number; end: number};
  adjusted: boolean;
};

export type MigrationResult = {
  annotations: Annotation[];
  report: MigrationEntry[];
};

/**
 * Deterministically migrate annotations whose offsets are UTF-16 code-unit
 * indices into grapheme indices. Start offsets floor to the containing
 * cluster's start, end offsets ceil to its end, so a migrated range still
 * covers every cluster the legacy range touched. Offsets outside the text
 * are clamped. Already-grapheme annotations pass through unchanged.
 */
export function migrateAnnotations(text: string, annotations: Annotation[], units: CoordinateUnits): MigrationResult {
  if (units === 'grapheme') {
    return {annotations: annotations.map(a => ({...a})), report: []};
  }
  const migrated: Annotation[] = [];
  const report: MigrationEntry[] = [];
  for (const annotation of annotations) {
    const rawStart = Math.min(Math.max(Math.trunc(annotation.start), 0), text.length);
    const rawEnd = Math.min(Math.max(Math.trunc(annotation.end), 0), text.length);
    const start = utf16ToGrapheme(text, rawStart, 'floor');
    const end = utf16ToGrapheme(text, Math.max(rawStart, rawEnd), 'ceil');
    migrated.push({...annotation, start, end});
    report.push({
      id: annotation.id,
      from: {start: annotation.start, end: annotation.end},
      to: {start, end},
      adjusted: start !== annotation.start || end !== annotation.end,
    });
  }
  return {annotations: migrated, report};
}

/** Migrate a cue in place (copy) to canonical grapheme units. */
export function migrateCue(cue: Cue): {cue: Cue; report: MigrationEntry[]} {
  const {annotations, report} = migrateAnnotations(cue.text, cue.annotations, cue.annotationUnits);
  return {cue: {...cue, annotations, annotationUnits: 'grapheme'}, report};
}

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------

export type SplitAction =
  | 'left'          // whole annotation lands in the left cue
  | 'right'         // whole annotation lands in the right cue
  | 'word-left'     // straddling word attributed to the left cue (clamped)
  | 'word-right'    // straddling word attributed to the right cue (clamped)
  | 'split-two';    // straddling range annotation split into two segments

export type SplitReportEntry = {
  id: string;
  kind: AnnotationKind;
  action: SplitAction;
  from: {start: number; end: number};
  to: Array<{cue: 'left' | 'right'; start: number; end: number}>;
};

export type SplitResult = {
  left: Cue;
  right: Cue;
  /** Canonical grapheme position the cue was split at. */
  position: number;
  /** Cue time boundary: left gets [startMs, timeSplitMs), right the rest. */
  timeSplitMs: number;
  report: SplitReportEntry[];
};

const clampMs = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/**
 * Split a cue at a grapheme boundary. The cue's annotations must already use
 * grapheme units (run migrateCue first for legacy cues).
 */
export function splitCue(cue: Cue, position: number): SplitResult {
  if (cue.annotationUnits !== 'grapheme') {
    throw new Error(`splitCue requires grapheme units, got '${cue.annotationUnits}'`);
  }
  const count = graphemeCount(cue.text);
  if (!Number.isInteger(position) || position < 0 || position > count) {
    throw new SplitPositionError(position, count);
  }

  const leftText = sliceByGraphemes(cue.text, 0, position);
  const rightText = sliceByGraphemes(cue.text, position, count);

  // Words truly straddling the split, in deterministic order.
  const straddlingWords = cue.annotations
    .filter(a => a.kind === 'word' && a.start < position && a.end > position)
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const wordSide = new Map<string, 'left' | 'right'>();
  for (const word of straddlingWords) {
    const leftLen = position - word.start;
    const rightLen = word.end - position;
    wordSide.set(word.id, leftLen >= rightLen ? 'left' : 'right');
  }

  // Cue time split: at the straddling word's boundary in time when there is
  // one, otherwise proportional to the grapheme ratio (midpoint when empty).
  let timeSplitMs: number;
  if (straddlingWords.length > 0) {
    const word = straddlingWords[0];
    const boundary = wordSide.get(word.id) === 'left'
      ? word.endMs ?? cue.endMs
      : word.startMs ?? cue.startMs;
    timeSplitMs = clampMs(boundary, cue.startMs, cue.endMs);
  } else if (count === 0) {
    timeSplitMs = Math.round((cue.startMs + cue.endMs) / 2);
  } else {
    timeSplitMs = Math.round(cue.startMs + (cue.endMs - cue.startMs) * (position / count));
  }

  const leftAnnotations: Annotation[] = [];
  const rightAnnotations: Annotation[] = [];
  const report: SplitReportEntry[] = [];
  for (const annotation of cue.annotations) {
    const from = {start: annotation.start, end: annotation.end};
    if (annotation.end <= position) {
      // Entirely left. A zero-length annotation exactly at pos lands here too.
      leftAnnotations.push({...annotation});
      report.push({id: annotation.id, kind: annotation.kind, action: 'left', from, to: [{cue: 'left', ...from}]});
    } else if (annotation.start >= position) {
      const shifted = {...annotation, start: annotation.start - position, end: annotation.end - position};
      rightAnnotations.push(shifted);
      report.push({id: annotation.id, kind: annotation.kind, action: 'right', from, to: [{cue: 'right', start: shifted.start, end: shifted.end}]});
    } else if (annotation.kind === 'word') {
      // Straddling word: atomic attribution by grapheme majority, range
      // clamped to the winning cue, timing kept whole but clamped to it.
      const side = wordSide.get(annotation.id)!;
      if (side === 'left') {
        const placed = {...annotation, end: position, startMs: clampMs(annotation.startMs ?? cue.startMs, cue.startMs, timeSplitMs), endMs: clampMs(annotation.endMs ?? cue.endMs, cue.startMs, timeSplitMs)};
        leftAnnotations.push(placed);
        report.push({id: annotation.id, kind: annotation.kind, action: 'word-left', from, to: [{cue: 'left', start: placed.start, end: placed.end}]});
      } else {
        const placed = {...annotation, start: 0, end: annotation.end - position, startMs: clampMs(annotation.startMs ?? cue.startMs, timeSplitMs, cue.endMs), endMs: clampMs(annotation.endMs ?? cue.endMs, timeSplitMs, cue.endMs)};
        rightAnnotations.push(placed);
        report.push({id: annotation.id, kind: annotation.kind, action: 'word-right', from, to: [{cue: 'right', start: placed.start, end: placed.end}]});
      }
    } else {
      // Straddling range annotation: split into two clamped segments.
      leftAnnotations.push({...annotation, end: position});
      rightAnnotations.push({...annotation, id: `${annotation.id}~r`, start: 0, end: annotation.end - position});
      report.push({
        id: annotation.id,
        kind: annotation.kind,
        action: 'split-two',
        from,
        to: [{cue: 'left', start: annotation.start, end: position}, {cue: 'right', start: 0, end: annotation.end - position}],
      });
    }
  }

  const left: Cue = {
    id: cue.id,
    revision: cue.revision + 1,
    startMs: cue.startMs,
    endMs: timeSplitMs,
    text: leftText,
    annotations: leftAnnotations,
    annotationUnits: 'grapheme',
  };
  const right: Cue = {
    id: `${cue.id}~r`,
    revision: 1,
    startMs: timeSplitMs,
    endMs: cue.endMs,
    text: rightText,
    annotations: rightAnnotations,
    annotationUnits: 'grapheme',
  };
  return {left, right, position, timeSplitMs, report};
}

/** Validate that every annotation range fits the cue text (grapheme units). */
export function validateAnnotations(cue: Pick<Cue, 'text' | 'annotations'>): string[] {
  const count = graphemeCount(cue.text);
  const problems: string[] = [];
  for (const a of cue.annotations) {
    if (!Number.isInteger(a.start) || !Number.isInteger(a.end) || a.start < 0 || a.end > count || a.start > a.end) {
      problems.push(`${a.id}: range [${a.start}, ${a.end}) outside [0, ${count}]`);
    }
    if (a.startMs !== undefined && a.endMs !== undefined && a.startMs > a.endMs) {
      problems.push(`${a.id}: startMs ${a.startMs} after endMs ${a.endMs}`);
    }
  }
  return problems;
}
