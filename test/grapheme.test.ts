import {describe,expect,it} from 'vitest';
import {graphemeBoundaries,graphemeCount,graphemeIndexToUtf16,resolveCursor,sliceByGraphemes,snapUtf16,utf16ToGrapheme} from '../src/shared/grapheme';

const NFD='Cafe\u0301'; // NFD: e + combining acute
const NFC='Caf\u00e9'; // NFC: precomposed é
const BIDI='abc \u202Bשלום\u202C def'; // RLE … PDF around Hebrew

describe('grapheme segmentation',()=>{
  it('treats a ZWJ emoji sequence as one cluster',()=>{
    expect(graphemeCount('👨‍👩‍👧‍👦')).toBe(1);
    expect(graphemeBoundaries('👨‍👩‍👧‍👦')).toEqual([0,11]);
  });
  it('pairs regional indicators into single flag clusters',()=>{
    expect(graphemeCount('🇺🇸')).toBe(1);
    expect(graphemeBoundaries('🇺🇸🇨🇦')).toEqual([0,4,8]);
    expect(graphemeCount('🇺🇸🇨🇦')).toBe(2);
  });
  it('keeps NFD combining sequences together',()=>{
    expect(graphemeCount('é')).toBe(1);
    expect(graphemeCount(NFD)).toBe(4);
    expect(graphemeCount(NFC)).toBe(4);
    expect(graphemeBoundaries(NFD)).toEqual([0,1,2,3,5]);
  });
  it('keeps emoji tag sequences together',()=>{
    expect(graphemeCount('🏴󠁧󠁢󠁥󠁮󠁧󠁿')).toBe(1);
  });
  it('gives bidi control characters their own clusters',()=>{
    expect(graphemeCount(BIDI)).toBe(14);
    expect(sliceByGraphemes(BIDI,4,5)).toBe('\u202B');
    expect(sliceByGraphemes(BIDI,9,10)).toBe('\u202C');
  });
  it('handles empty text',()=>{
    expect(graphemeCount('')).toBe(0);
    expect(graphemeBoundaries('')).toEqual([0]);
    expect(sliceByGraphemes('',0,0)).toBe('');
  });
});

describe('coordinate conversion',()=>{
  const text='a👨‍👩‍👧‍👦b'; // utf16 boundaries [0,1,12,13]
  it('converts boundary offsets exactly',()=>{
    expect(utf16ToGrapheme(text,0)).toBe(0);
    expect(utf16ToGrapheme(text,1)).toBe(1);
    expect(utf16ToGrapheme(text,12)).toBe(2);
    expect(utf16ToGrapheme(text,13)).toBe(3);
  });
  it('floors and ceils mid-cluster offsets',()=>{
    expect(utf16ToGrapheme(text,5,'floor')).toBe(1);
    expect(utf16ToGrapheme(text,5,'ceil')).toBe(2);
  });
  it('snaps to the nearest boundary, ties low',()=>{
    expect(utf16ToGrapheme(text,4,'nearest')).toBe(1); // 3 vs 8
    expect(utf16ToGrapheme(text,9,'nearest')).toBe(2); // 8 vs 3
    expect(utf16ToGrapheme('a🇺🇸b',3,'nearest')).toBe(1); // tie 2 vs 2 -> low
  });
  it('round-trips grapheme index -> utf16 -> grapheme',()=>{
    for(let i=0;i<=graphemeCount(text);i++){
      expect(utf16ToGrapheme(text,graphemeIndexToUtf16(text,i))).toBe(i);
    }
  });
  it('clamps out-of-range offsets',()=>{
    expect(utf16ToGrapheme(text,-3)).toBe(0);
    expect(utf16ToGrapheme(text,99)).toBe(3);
    expect(graphemeIndexToUtf16(text,99)).toBe(13);
    expect(graphemeIndexToUtf16(text,-1)).toBe(0);
  });
  it('slices by grapheme indices without tearing clusters',()=>{
    expect(sliceByGraphemes('Hello 👨‍👩‍👧‍👦 family',6,7)).toBe('👨‍👩‍👧‍👦');
    expect(sliceByGraphemes('Hello 👨‍👩‍👧‍👦 family',0,6)).toBe('Hello ');
    expect(sliceByGraphemes('🇺🇸🇨🇦',0,1)).toBe('🇺🇸');
    expect(sliceByGraphemes('🇺🇸🇨🇦',1,2)).toBe('🇨🇦');
  });
});

describe('cursor resolution',()=>{
  it('reports the actual position when snapping mid-cluster',()=>{
    const cursor=resolveCursor('a👨‍👩‍👧‍👦b',5);
    expect(cursor.snapped).toBe(true);
    expect(cursor.snappedUtf16).toBe(1);
    expect(cursor.grapheme).toBe(1);
    expect(cursor.graphemeCount).toBe(3);
  });
  it('passes boundary carets through unchanged',()=>{
    const cursor=resolveCursor('a👨‍👩‍👧‍👦b',12);
    expect(cursor.snapped).toBe(false);
    expect(cursor.grapheme).toBe(2);
  });
  it('snaps a caret inside a flag pair',()=>{
    const cursor=resolveCursor('🇺🇸',2);
    expect(cursor.snapped).toBe(true);
    expect(cursor.grapheme).toBe(0);
  });
  it('handles an empty cue',()=>{
    const cursor=resolveCursor('',0);
    expect(cursor.grapheme).toBe(0);
    expect(cursor.graphemeCount).toBe(0);
    expect(cursor.snapped).toBe(false);
  });
  it('snapUtf16 reports whether the offset moved',()=>{
    expect(snapUtf16(NFD,4)).toEqual({offset:3,moved:true}); // inside e + U+0301, tie -> low
    expect(snapUtf16(NFD,5)).toEqual({offset:5,moved:false});
  });
});
