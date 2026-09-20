import {describe, expect, it} from 'vitest';
import {Cue, migrateCueFromUtf16, validateCue} from '../src/shared/cues';

const legacyCue = (over: Partial<Cue>): Cue => ({id: 'g', start: 0, end: 1, text: '', speakers: [], words: [], ...over});

describe('UTF-16 → grapheme migration', () => {
  it('converts boundary-exact offsets unchanged', () => {
    // UTF-16: a=0, 😀=1..2, b=3, c=4 — offsets 0,1,3,5 are all boundaries.
    const migrated = migrateCueFromUtf16(legacyCue({
      text: 'a😀bc',
      speakers: [{start: 0, end: 3, speaker: 'Ana'}],
      words: [
        {start: 0, end: 1, t0: 0, t1: 0.4},
        {start: 3, end: 5, t0: 0.5, t1: 0.9},
      ],
    }));
    expect(migrated.speakers).toEqual([{start: 0, end: 2, speaker: 'Ana'}]); // "a😀"
    expect(migrated.words).toEqual([
      {start: 0, end: 1, t0: 0, t1: 0.4}, // "a"
      {start: 2, end: 4, t0: 0.5, t1: 0.9}, // "bc"
    ]);
    expect(validateCue(migrated)).toEqual([]);
  });

  it('snaps offsets inside clusters: starts floor, ends ceil', () => {
    // UTF-16: 😀=0..1, x=2, ◌́=3, y=4 — offset 1 is inside 😀, offset 3 is inside "x́".
    const migrated = migrateCueFromUtf16(legacyCue({
      text: '😀x\u0301y',
      speakers: [{start: 0, end: 1, speaker: 'Ana'}, {start: 3, end: 5, speaker: 'Bo'}],
      words: [
        {start: 0, end: 2, t0: 0, t1: 0.5},
        {start: 2, end: 5, t0: 0.6, t1: 1.0},
      ],
    }));
    // Ana's end 1 (inside 😀) ceils to grapheme 1 → covers exactly "😀".
    // Bo's start 3 (inside "x́") floors to grapheme 1 → covers "x́y".
    expect(migrated.speakers).toEqual([
      {start: 0, end: 1, speaker: 'Ana'},
      {start: 1, end: 3, speaker: 'Bo'},
    ]);
    expect(migrated.words).toEqual([
      {start: 0, end: 1, t0: 0, t1: 0.5},
      {start: 1, end: 3, t0: 0.6, t1: 1.0},
    ]);
    expect(validateCue(migrated)).toEqual([]);
  });

  it('collapses a multi-code-unit NFD cluster to one grapheme', () => {
    const migrated = migrateCueFromUtf16(legacyCue({
      text: 'e\u0301x',
      speakers: [{start: 0, end: 2, speaker: 'Ana'}], // UTF-16 [0,2) = "é"
    }));
    expect(migrated.speakers).toEqual([{start: 0, end: 1, speaker: 'Ana'}]);
  });

  it('collapses a flag (4 UTF-16 units) to one grapheme', () => {
    const migrated = migrateCueFromUtf16(legacyCue({
      text: '🇫🇷x',
      speakers: [{start: 0, end: 4, speaker: 'Ana'}],
    }));
    expect(migrated.speakers).toEqual([{start: 0, end: 1, speaker: 'Ana'}]);
  });

  it('is deterministic', () => {
    const cue = legacyCue({
      text: 'a😀b\u0301c🇫🇷',
      speakers: [{start: 1, end: 6, speaker: 'Ana'}],
      words: [{start: 0, end: 9, t0: 0, t1: 1}],
    });
    expect(migrateCueFromUtf16(cue)).toEqual(migrateCueFromUtf16(cue));
  });
});
