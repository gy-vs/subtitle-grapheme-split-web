import type {Cue} from '../shared/annotations';

/**
 * In-memory cue store. Annotation offsets in seeds are grapheme indices,
 * except cue-legacy which deliberately stores UTF-16 offsets (including one
 * annotation whose endpoints fall inside the family emoji cluster) to
 * exercise deterministic migration.
 */
export function seedCues(): Cue[] {
  return [
    {
      id: 'cue-family', revision: 1, startMs: 1000, endMs: 4000,
      text: 'Hello 👨‍👩‍👧‍👦 family', // graphemes: Hello(0-4) ␣ 👨‍👩‍👧‍👦(6) ␣ family(8-13) = 14
      annotationUnits: 'grapheme',
      annotations: [
        {id: 'sp1', kind: 'speaker', start: 0, end: 14, label: 'MIRA'},
        {id: 'w1', kind: 'word', start: 0, end: 5, label: 'Hello', startMs: 1000, endMs: 1600},
        {id: 'w2', kind: 'word', start: 6, end: 7, label: '👨‍👩‍👧‍👦', startMs: 1700, endMs: 2400},
        {id: 'w3', kind: 'word', start: 8, end: 14, label: 'family', startMs: 2500, endMs: 3800},
      ],
    },
    {
      id: 'cue-flags', revision: 1, startMs: 0, endMs: 2000,
      text: 'Go 🇺🇸🇨🇦 team', // graphemes: Go(0-1) ␣ 🇺🇸(3) 🇨🇦(4) ␣ team(6-9) = 10
      annotationUnits: 'grapheme',
      annotations: [
        {id: 'sp1', kind: 'speaker', start: 0, end: 10, label: 'LEE'},
        {id: 'w1', kind: 'word', start: 0, end: 2, label: 'Go', startMs: 0, endMs: 500},
        {id: 'w2', kind: 'word', start: 3, end: 5, label: '🇺🇸🇨🇦', startMs: 600, endMs: 1200},
        {id: 'w3', kind: 'word', start: 6, end: 10, label: 'team', startMs: 1300, endMs: 2000},
      ],
    },
    {
      id: 'cue-nfd', revision: 1, startMs: 0, endMs: 1500,
      text: 'Cafe\u0301 noir', // NFD: é = e + U+0301, one cluster; 9 graphemes
      annotationUnits: 'grapheme',
      annotations: [
        {id: 'sp1', kind: 'speaker', start: 0, end: 9, label: 'CHEF'},
        {id: 'w1', kind: 'word', start: 0, end: 4, label: 'Café', startMs: 0, endMs: 800},
        {id: 'w2', kind: 'word', start: 5, end: 9, label: 'noir', startMs: 900, endMs: 1500},
      ],
    },
    {
      id: 'cue-bidi', revision: 1, startMs: 0, endMs: 3000,
      text: 'abc \u202Bשלום\u202C def', // RLE … PDF around Hebrew; controls are own clusters; 14 graphemes
      annotationUnits: 'grapheme',
      annotations: [
        {id: 'sp1', kind: 'speaker', start: 0, end: 14, label: 'DANA'},
        {id: 'w1', kind: 'word', start: 0, end: 3, label: 'abc', startMs: 0, endMs: 700},
        {id: 'w2', kind: 'word', start: 5, end: 9, label: 'שלום', startMs: 800, endMs: 1800},
        {id: 'w3', kind: 'word', start: 11, end: 14, label: 'def', startMs: 1900, endMs: 2600},
      ],
    },
    {
      id: 'cue-empty', revision: 1, startMs: 0, endMs: 0,
      text: '',
      annotationUnits: 'grapheme',
      annotations: [],
    },
    {
      id: 'cue-legacy', revision: 1, startMs: 500, endMs: 3500,
      text: 'A 👨‍👩‍👧‍👦 day 🏳️‍🌈!', // utf16 len 25; graphemes: A ␣ 👨‍👩‍👧‍👦 ␣ d a y ␣ 🏳️‍🌈 ! = 10
      annotationUnits: 'utf16',
      annotations: [
        {id: 'sp1', kind: 'speaker', start: 0, end: 25, label: 'OMAR'},
        {id: 'w1', kind: 'word', start: 0, end: 1, label: 'A', startMs: 500, endMs: 800},
        {id: 'w2', kind: 'word', start: 2, end: 13, label: '👨‍👩‍👧‍👦', startMs: 900, endMs: 1600},
        {id: 'w3', kind: 'word', start: 14, end: 17, label: 'day', startMs: 1700, endMs: 2200},
        {id: 'w4', kind: 'word', start: 18, end: 24, label: '🏳️‍🌈', startMs: 2300, endMs: 3000},
        // Broken legacy annotation: both endpoints sit inside the family
        // emoji cluster (utf16 2..13). Migration floors start to 2 and ceils
        // end to 13 in utf16 terms, i.e. grapheme range [2, 3).
        {id: 'w5', kind: 'word', start: 3, end: 12, label: '👨‍👩‍👧‍👦', startMs: 900, endMs: 1600},
      ],
    },
  ];
}

export type CueStore = {
  cues: Cue[];
  undoStack: Cue[][];
};

export function createCueStore(): CueStore {
  return {cues: seedCues(), undoStack: []};
}

/** Push a deep snapshot before a mutation so POST /api/undo can restore it. */
export function snapshot(store: CueStore): void {
  store.undoStack.push(structuredClone(store.cues));
}

export function undo(store: CueStore): boolean {
  const previous = store.undoStack.pop();
  if (!previous) return false;
  store.cues = previous;
  return true;
}
