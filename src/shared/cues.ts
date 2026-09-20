import {graphemeCount, graphemes, utf16ToGrapheme} from './grapheme';

/**
 * Cue model. All annotation ranges (`SpeakerRange`, `WordTiming`) are
 * half-open `[start, end)` intervals in *grapheme indices* over `Cue.text`
 * (protocol v2). `start`/`end` on the cue itself are seconds on the timeline;
 * `t0`/`t1` on a word are absolute seconds within the cue's time range.
 */
export type SpeakerRange = {start: number; end: number; speaker: string};
export type WordTiming = {start: number; end: number; t0: number; t1: number};
export type Cue = {
  id: string;
  start: number;
  end: number;
  text: string;
  speakers: SpeakerRange[];
  words: WordTiming[];
};

export type Coord = 'grapheme' | 'utf16';
export const PROTOCOL_VERSION = 2;

export type Track = {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  coord: 'grapheme';
  protocol: number;
  cues: Cue[];
  migratedFrom?: 'utf16';
};

export type SplitErrorCode = 'empty_cue' | 'invalid_position';

export class SplitError extends Error {
  readonly code: SplitErrorCode;
  constructor(code: SplitErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Split text at a grapheme boundary; the two halves always concatenate to the original. */
export function splitText(text: string, position: number): [string, string] {
  const clusters = graphemes(text);
  return [clusters.slice(0, position).join(''), clusters.slice(position).join('')];
}

/**
 * Partition speaker ranges at a grapheme boundary. Only ranges that *truly
 * span* the position (start < p < end) are split into two segments; ranges
 * that merely touch the boundary stay whole on their side. No zero-length
 * segments are ever produced.
 */
export function splitSpeakers(ranges: SpeakerRange[], position: number): {left: SpeakerRange[]; right: SpeakerRange[]} {
  const left: SpeakerRange[] = [];
  const right: SpeakerRange[] = [];
  for (const r of ranges) {
    if (r.end <= position) {
      left.push({...r});
    } else if (r.start >= position) {
      right.push({start: r.start - position, end: r.end - position, speaker: r.speaker});
    } else {
      left.push({start: r.start, end: position, speaker: r.speaker});
      right.push({start: 0, end: r.end - position, speaker: r.speaker});
    }
  }
  return {left, right};
}

const clampTime = (w: WordTiming, lo: number, hi: number): WordTiming => ({
  ...w,
  t0: Math.min(Math.max(w.t0, lo), hi),
  t1: Math.min(Math.max(w.t1, lo), hi),
});

/**
 * Partition word timings at a grapheme boundary. Words are atomic and are
 * never cut: a word that truly spans the position is attributed wholesale by
 * word boundary — the side holding the majority of the word's graphemes wins,
 * ties go to the earlier cue — and its text range is clamped to that cue.
 *
 * The cue's time range is always split at a word boundary when one is at
 * stake: at the spanning word's boundary on the attribution side (its `t1` if
 * the word stays left, its `t0` if it moves right), or — when no word spans
 * the text but the proportional split time would land inside a word's time
 * interval — at that word's boundary on the side where its text lies. Only
 * when no word timing is involved does time split proportionally to the
 * grapheme position. Word times therefore always fit inside their cue.
 */
export function splitWords(
  words: WordTiming[],
  position: number,
  count: number,
  cueStart: number,
  cueEnd: number,
): {left: WordTiming[]; right: WordTiming[]; time: number} {
  const proportional = () => cueStart + (cueEnd - cueStart) * (position / count);
  const left: WordTiming[] = [];
  const right: WordTiming[] = [];
  let time: number | undefined;
  for (const w of words) {
    if (w.end <= position) {
      left.push({...w});
    } else if (w.start >= position) {
      right.push({start: w.start - position, end: w.end - position, t0: w.t0, t1: w.t1});
    } else {
      const leftLen = position - w.start;
      const rightLen = w.end - position;
      if (leftLen >= rightLen) {
        left.push({start: w.start, end: position, t0: w.t0, t1: w.t1});
        time = w.t1;
      } else {
        right.push({start: 0, end: w.end - position, t0: w.t0, t1: w.t1});
        time = w.t0;
      }
    }
  }
  if (time === undefined) {
    const candidate = proportional();
    const straddler = words.find(w => w.t0 < candidate && candidate < w.t1);
    time = straddler ? (straddler.end <= position ? straddler.t1 : straddler.t0) : candidate;
  }
  if (!(time > cueStart && time < cueEnd)) {
    time = proportional(); // degenerate boundary time — fall back and clamp below
  }
  return {
    left: left.map(w => clampTime(w, cueStart, time as number)),
    right: right.map(w => clampTime(w, time as number, cueEnd)),
    time,
  };
}

/**
 * Split a cue at grapheme index `position`. Only grapheme boundaries are
 * splittable: for a text of `n` clusters the valid positions are `1..n-1`.
 * Anything else (edges, non-integers, empty cues) raises `SplitError`.
 */
export function splitCue(cue: Cue, position: number, leftId: string, rightId: string): {left: Cue; right: Cue; time: number} {
  const count = graphemeCount(cue.text);
  if (count === 0) throw new SplitError('empty_cue', 'cannot split an empty cue');
  if (!Number.isInteger(position) || position <= 0 || position >= count) {
    throw new SplitError('invalid_position', `position ${position} is not a splittable grapheme boundary (valid: 1..${count - 1})`);
  }
  const [leftText, rightText] = splitText(cue.text, position);
  const speakers = splitSpeakers(cue.speakers, position);
  const words = splitWords(cue.words, position, count, cue.start, cue.end);
  const left: Cue = {id: leftId, start: cue.start, end: words.time, text: leftText, speakers: speakers.left, words: words.left};
  const right: Cue = {id: rightId, start: words.time, end: cue.end, text: rightText, speakers: speakers.right, words: words.right};
  return {left, right, time: words.time};
}

/**
 * Deterministic migration of a legacy cue whose annotation ranges are UTF-16
 * code-unit offsets (protocol v1) to grapheme indices (v2). Range starts map
 * with `'start'` (floor) and ends with `'end'` (ceil), so a migrated range
 * always covers exactly the clusters its UTF-16 range touched. Boundary-exact
 * offsets are unchanged. Applying this to the same input always yields the
 * same output.
 */
export function migrateCueFromUtf16(cue: Cue): Cue {
  return {
    ...cue,
    speakers: cue.speakers.map(r => ({
      speaker: r.speaker,
      start: utf16ToGrapheme(cue.text, r.start, 'start'),
      end: utf16ToGrapheme(cue.text, r.end, 'end'),
    })),
    words: cue.words.map(w => ({
      t0: w.t0,
      t1: w.t1,
      start: utf16ToGrapheme(cue.text, w.start, 'start'),
      end: utf16ToGrapheme(cue.text, w.end, 'end'),
    })),
  };
}

/** Structural validation of a cue whose ranges are in grapheme coordinates. */
export function validateCue(cue: Cue): string[] {
  if (!cue || typeof cue.id !== 'string' || typeof cue.text !== 'string'
    || typeof cue.start !== 'number' || typeof cue.end !== 'number'
    || !Array.isArray(cue.speakers) || !Array.isArray(cue.words)) {
    return ['cue is malformed'];
  }
  const problems: string[] = [];
  const count = graphemeCount(cue.text);
  if (!(cue.start <= cue.end)) problems.push('cue time range is inverted');
  cue.speakers.forEach((r, i) => {
    if (!r || !Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 0 || r.start >= r.end || r.end > count) {
      problems.push(`speaker range ${i} [${r?.start},${r?.end}) is empty or outside 0..${count}`);
    }
  });
  let prevEnd = 0;
  cue.words.forEach((w, i) => {
    if (!w || !Number.isInteger(w.start) || !Number.isInteger(w.end) || w.start < 0 || w.start >= w.end || w.end > count) {
      problems.push(`word ${i} [${w?.start},${w?.end}) is empty or outside 0..${count}`);
      return;
    }
    if (w.start < prevEnd) problems.push(`word ${i} overlaps the previous word`);
    prevEnd = Math.max(prevEnd, w.end);
    if (!(w.t0 <= w.t1)) problems.push(`word ${i} time range is inverted`);
  });
  return problems;
}
