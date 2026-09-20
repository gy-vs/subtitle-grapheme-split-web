import {describe, expect, it} from 'vitest';
import {canUndo, historyOf, pushHistory, undoHistory} from '../src/client/history';
import {Cue, splitCue} from '../src/shared/cues';

describe('editor history', () => {
  it('cannot undo past the initial state', () => {
    const h = historyOf(['a']);
    expect(canUndo(h)).toBe(false);
    expect(undoHistory(h).present).toEqual(['a']);
  });

  it('restores the exact previous snapshot on undo', () => {
    const v0 = ['a', 'b'];
    const v1 = ['a', 'b', 'c'];
    let h = historyOf(v0);
    h = pushHistory(h, v1);
    expect(h.present).toBe(v1);
    h = undoHistory(h);
    expect(h.present).toBe(v0); // same reference, not a re-derivation
    expect(canUndo(h)).toBe(false);
  });

  it('split → undo → save round trip preserves text and annotations exactly', () => {
    const cue: Cue = {
      id: 'c1', start: 0, end: 2.4, text: 'Hello 👨‍👩‍👧‍👦 world!',
      speakers: [{start: 0, end: 5, speaker: 'Ana'}, {start: 8, end: 14, speaker: 'Bo'}],
      words: [
        {start: 0, end: 5, t0: 0, t1: 0.8},
        {start: 6, end: 7, t0: 0.9, t1: 1.3},
        {start: 8, end: 14, t0: 1.4, t1: 2.2},
      ],
    };
    const original: Cue[] = [cue];
    let h = historyOf(original);
    // Split at grapheme 7 (the boundary after the family emoji).
    const {left, right} = splitCue(cue, 7, 'c1-l', 'c1-r');
    h = pushHistory(h, [left, right]);
    expect(h.present).toHaveLength(2);
    // Undo, then "save": the persisted state must equal the original exactly.
    h = undoHistory(h);
    expect(h.present).toEqual(original);
    expect(h.present[0].text).toBe('Hello 👨‍👩‍👧‍👦 world!');
    expect(h.present[0].speakers).toEqual(original[0].speakers);
    expect(h.present[0].words).toEqual(original[0].words);
  });
});
