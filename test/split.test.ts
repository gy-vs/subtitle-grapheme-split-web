import {describe, expect, it} from 'vitest';
import {Cue, splitCue, SplitError, validateCue} from '../src/shared/cues';
import {graphemeCount, graphemes} from '../src/shared/grapheme';

const cue = (over: Partial<Cue>): Cue => ({id: 'c', start: 0, end: 2, text: '', speakers: [], words: [], ...over});

const splitCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as SplitError).code;
  }
  throw new Error('expected a SplitError');
};

describe('splitCue text integrity', () => {
  it('never cuts a ZWJ emoji sequence', () => {
    const c = cue({text: 'ab👨‍👩‍👧‍👦cd', speakers: [{start: 0, end: 5, speaker: 'A'}]});
    const {left, right} = splitCue(c, 2, 'l', 'r');
    expect(left.text).toBe('ab');
    expect(right.text).toBe('👨‍👩‍👧‍👦cd');
    expect(left.text + right.text).toBe(c.text);
    // The spanning speaker range is split into exactly two segments.
    expect(left.speakers).toEqual([{start: 0, end: 2, speaker: 'A'}]);
    expect(right.speakers).toEqual([{start: 0, end: 3, speaker: 'A'}]);
  });

  it('never cuts a regional-indicator flag', () => {
    const c = cue({text: 'x🇫🇷🇩🇪y'});
    const {left, right} = splitCue(c, 2, 'l', 'r');
    expect(graphemes(left.text)).toEqual(['x', '🇫🇷']);
    expect(graphemes(right.text)).toEqual(['🇩🇪', 'y']);
    expect(left.text + right.text).toBe(c.text);
  });

  it('never separates an NFD combining mark from its base', () => {
    const c = cue({text: 'cafe\u0301 au lait'});
    const {left, right} = splitCue(c, 4, 'l', 'r');
    expect(left.text).toBe('cafe\u0301'); // ends with the complete e+́ cluster
    expect(left.text.normalize('NFC')).toBe('café');
    expect(left.text + right.text).toBe(c.text);
  });

  it('splits bidirectional text in logical order', () => {
    const c = cue({text: 'ab שלום cd', speakers: [{start: 0, end: 10, speaker: 'A'}]});
    const {left, right} = splitCue(c, 4, 'l', 'r');
    expect(left.text).toBe('ab ש');
    expect(right.text).toBe('לום cd');
    expect(left.text + right.text).toBe(c.text);
    expect(left.speakers).toEqual([{start: 0, end: 4, speaker: 'A'}]);
    expect(right.speakers).toEqual([{start: 0, end: 6, speaker: 'A'}]);
  });

  it('keeps text and annotations consistent at every boundary of a mixed text', () => {
    const text = 'a👨‍👩‍👧‍👦b🇫🇷cafe\u0301 שלום!';
    const count = graphemeCount(text);
    for (let p = 1; p < count; p += 1) {
      const c = cue({
        text,
        speakers: [{start: 0, end: count, speaker: 'A'}],
        words: [
          {start: 0, end: 2, t0: 0, t1: 0.5},
          {start: 3, end: 5, t0: 0.6, t1: 1.0},
        ],
      });
      const {left, right} = splitCue(c, p, 'l', 'r');
      expect(left.text + right.text).toBe(text);
      expect(validateCue(left)).toEqual([]);
      expect(validateCue(right)).toEqual([]);
      expect(left.end).toBe(right.start);
      expect(left.end).toBeGreaterThan(0);
      expect(right.start).toBeLessThan(2);
    }
  });
});

describe('splitCue position validation', () => {
  it('rejects splitting an empty cue', () => {
    expect(splitCode(() => splitCue(cue({text: ''}), 0, 'l', 'r'))).toBe('empty_cue');
  });

  it('rejects positions that are not strictly inside the cue', () => {
    const c = cue({text: 'ab👨‍👩‍👧‍👦'}); // 3 graphemes
    expect(splitCode(() => splitCue(c, 0, 'l', 'r'))).toBe('invalid_position');
    expect(splitCode(() => splitCue(c, 3, 'l', 'r'))).toBe('invalid_position');
    expect(splitCode(() => splitCue(c, -1, 'l', 'r'))).toBe('invalid_position');
    expect(splitCode(() => splitCue(c, 1.5, 'l', 'r'))).toBe('invalid_position');
  });
});

describe('speaker ranges at the split point', () => {
  it('does not split ranges that merely touch the boundary', () => {
    const c = cue({text: 'aabb', speakers: [{start: 0, end: 2, speaker: 'A'}, {start: 2, end: 4, speaker: 'B'}]});
    const {left, right} = splitCue(c, 2, 'l', 'r');
    // Exactly on the boundary: each range stays whole on its side,
    // and no zero-length segments are created.
    expect(left.speakers).toEqual([{start: 0, end: 2, speaker: 'A'}]);
    expect(right.speakers).toEqual([{start: 0, end: 2, speaker: 'B'}]);
  });

  it('rebases right-side ranges and keeps left-side ranges untouched', () => {
    const c = cue({text: 'aabbcc', speakers: [{start: 0, end: 1, speaker: 'A'}, {start: 4, end: 6, speaker: 'B'}]});
    const {left, right} = splitCue(c, 3, 'l', 'r');
    expect(left.speakers).toEqual([{start: 0, end: 1, speaker: 'A'}]);
    expect(right.speakers).toEqual([{start: 1, end: 3, speaker: 'B'}]);
  });
});

describe('word timings at the split point', () => {
  const timed = () => cue({
    text: 'hello world', // 11 graphemes
    start: 0,
    end: 2,
    words: [
      {start: 0, end: 5, t0: 0, t1: 0.8},
      {start: 6, end: 11, t0: 1.0, t1: 1.8},
    ],
  });

  it('partitions words at a word boundary without touching their times', () => {
    const {left, right, time} = splitCue(timed(), 6, 'l', 'r');
    expect(left.words).toEqual([{start: 0, end: 5, t0: 0, t1: 0.8}]);
    expect(right.words).toEqual([{start: 0, end: 5, t0: 1.0, t1: 1.8}]);
    // The proportional split time (≈1.09) would land inside "world"'s time
    // interval, so the cue splits at the word boundary instead: its t0.
    expect(time).toBe(1.0);
    expect(left.end).toBe(1.0);
    expect(right.start).toBe(1.0);
  });

  it('attributes a spanning word wholesale to the right when most of it is right', () => {
    const {left, right, time} = splitCue(timed(), 8, 'l', 'r');
    expect(left.text).toBe('hello wo');
    expect(right.text).toBe('rld');
    expect(left.words).toEqual([{start: 0, end: 5, t0: 0, t1: 0.8}]);
    expect(right.words).toEqual([{start: 0, end: 3, t0: 1.0, t1: 1.8}]); // clamped to the cue, times kept
    expect(time).toBe(1.0); // cue time splits at the word boundary (its t0)
    expect(left.end).toBe(1.0);
    expect(right.start).toBe(1.0);
  });

  it('attributes a spanning word wholesale to the left when most of it is left', () => {
    const {left, right, time} = splitCue(timed(), 9, 'l', 'r');
    expect(left.words).toEqual([
      {start: 0, end: 5, t0: 0, t1: 0.8},
      {start: 6, end: 9, t0: 1.0, t1: 1.8}, // clamped to the cue, times kept
    ]);
    expect(right.words).toEqual([]);
    expect(time).toBe(1.8); // cue time splits at the word boundary (its t1)
    expect(left.end).toBe(1.8);
    expect(right.start).toBe(1.8);
  });

  it('resolves an exactly-half spanning word to the earlier cue', () => {
    const c = cue({
      text: 'test x',
      words: [
        {start: 0, end: 4, t0: 0, t1: 1.0},
        {start: 5, end: 6, t0: 1.2, t1: 1.6},
      ],
    });
    const {left, right, time} = splitCue(c, 2, 'l', 'r');
    expect(left.words).toEqual([{start: 0, end: 2, t0: 0, t1: 1.0}]);
    expect(right.words).toEqual([{start: 3, end: 4, t0: 1.2, t1: 1.6}]);
    expect(time).toBe(1.0);
  });

  it('splits cue time at the boundary of the word whose time straddles it', () => {
    const c = cue({
      text: 'abcdef',
      start: 0,
      end: 6,
      words: [{start: 0, end: 2, t0: 0, t1: 4}], // its time would straddle the proportional split (3)
    });
    const {left, right, time} = splitCue(c, 3, 'l', 'r');
    expect(time).toBe(4); // attributed by word boundary: the word's t1
    expect(left.words).toEqual([{start: 0, end: 2, t0: 0, t1: 4}]); // untouched
    expect(right.start).toBe(4);
  });

  it('clamps word times only when the boundary time is degenerate', () => {
    const c = cue({
      text: 'abcdef',
      start: 0,
      end: 6,
      words: [{start: 0, end: 2, t0: 0, t1: 6}], // t1 == cue end → boundary time unusable
    });
    const {left, right} = splitCue(c, 3, 'l', 'r');
    expect(right.start).toBe(3); // proportional fallback
    expect(left.words).toEqual([{start: 0, end: 2, t0: 0, t1: 3}]); // clamped to the left cue
  });
});
