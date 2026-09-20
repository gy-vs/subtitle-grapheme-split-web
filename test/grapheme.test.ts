import {describe, expect, it} from 'vitest';
import {
  graphemeCount,
  graphemes,
  graphemeToUtf16,
  isGraphemeBoundaryUtf16,
  snapUtf16,
  snapUtf16ToGrapheme,
  utf16ToGrapheme,
} from '../src/shared/grapheme';

describe('grapheme segmentation', () => {
  it('treats ZWJ emoji sequences as a single cluster', () => {
    expect(graphemes('👨‍👩‍👧‍👦')).toEqual(['👨‍👩‍👧‍👦']);
    expect(graphemeCount('👨‍👩‍👧‍👦')).toBe(1);
    expect('👨‍👩‍👧‍👦'.length).toBe(11); // UTF-16: 4 people + 3 ZWJ
    expect(graphemes('🧑🏽‍💻')).toEqual(['🧑🏽‍💻']); // skin-tone modifier + ZWJ
  });

  it('treats regional-indicator pairs (flags) as a single cluster', () => {
    expect(graphemes('🇫🇷')).toEqual(['🇫🇷']);
    expect(graphemes('🇫🇷🇩🇪')).toEqual(['🇫🇷', '🇩🇪']); // two flags, not four letters
    expect(graphemes('a🇫🇷b')).toEqual(['a', '🇫🇷', 'b']);
  });

  it('keeps NFD combining marks attached to their base', () => {
    expect(graphemes('e\u0301')).toEqual(['e\u0301']);
    expect(graphemes('Cafe\u0301')).toHaveLength(4);
    expect(graphemes('x\u0301\u0327')).toEqual(['x\u0301\u0327']); // stacked combining marks
  });

  it('handles astral characters (surrogate pairs)', () => {
    expect(graphemes('😀')).toEqual(['😀']);
    expect('😀'.length).toBe(2);
  });

  it('segments bidirectional text in logical order', () => {
    const text = 'abc שלום 123';
    expect(graphemeCount(text)).toBe(12);
    expect(graphemes(text).slice(4, 8).join('')).toBe('שלום');
  });

  it('treats bidi control characters as standalone clusters', () => {
    expect(graphemeCount('\u202Eabc\u202C')).toBe(5);
  });

  it('segments the empty string into zero clusters', () => {
    expect(graphemes('')).toEqual([]);
    expect(graphemeCount('')).toBe(0);
  });
});

describe('coordinate mapping', () => {
  // UTF-16: a=0, 😀=1..2, b=3, c=4 (length 5); graphemes: a=0, 😀=1, b=2, c=3
  const text = 'a😀bc';

  it('maps boundary offsets exactly under every mode', () => {
    for (const mode of ['start', 'end', 'nearest'] as const) {
      expect(utf16ToGrapheme(text, 0, mode)).toBe(0);
      expect(utf16ToGrapheme(text, 1, mode)).toBe(1);
      expect(utf16ToGrapheme(text, 3, mode)).toBe(2);
      expect(utf16ToGrapheme(text, 5, mode)).toBe(4);
    }
  });

  it('maps offsets inside a cluster deterministically', () => {
    expect(utf16ToGrapheme(text, 2, 'start')).toBe(1); // floor: the emoji cluster
    expect(utf16ToGrapheme(text, 2, 'end')).toBe(2); // ceil: boundary after it
    expect(utf16ToGrapheme(text, 2, 'nearest')).toBe(2); // tie resolves forward
  });

  it('snaps UTF-16 carets to the nearest boundary', () => {
    expect(snapUtf16(text, 2)).toBe(3);
    expect(snapUtf16ToGrapheme(text, 2)).toBe(2);
    expect(snapUtf16(text, 1)).toBe(1); // already on a boundary
    expect(snapUtf16(text, 99)).toBe(5); // clamped to the end
    expect(snapUtf16(text, -4)).toBe(0); // clamped to the start
  });

  it('snaps carets inside ZWJ sequences and flags to a sequence edge', () => {
    const text = '👨‍👩‍👧‍👦x🇫🇷';
    expect(graphemeCount(text)).toBe(3);
    expect(snapUtf16ToGrapheme(text, 4)).toBe(0); // inside the family, nearer the start
    expect(snapUtf16ToGrapheme(text, 9)).toBe(1); // inside the family, nearer the end
    expect(snapUtf16ToGrapheme(text, 13)).toBe(2); // inside the flag, nearer its start
    expect(snapUtf16ToGrapheme(text, 14)).toBe(3); // exactly mid-flag: tie resolves forward
  });

  it('identifies boundaries', () => {
    expect(isGraphemeBoundaryUtf16(text, 2)).toBe(false);
    expect(isGraphemeBoundaryUtf16(text, 3)).toBe(true);
    expect(isGraphemeBoundaryUtf16('', 0)).toBe(true);
  });

  it('round-trips grapheme indices through UTF-16 offsets', () => {
    const text = '👨‍👩‍👧‍👦x🇫🇷e\u0301';
    expect(graphemeCount(text)).toBe(4);
    for (let i = 0; i <= graphemeCount(text); i += 1) {
      expect(utf16ToGrapheme(text, graphemeToUtf16(text, i), 'nearest')).toBe(i);
    }
  });
});
