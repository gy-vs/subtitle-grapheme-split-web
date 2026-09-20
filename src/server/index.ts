import express from 'express';
import {fileURLToPath} from 'node:url';
import {Coord, Cue, migrateCueFromUtf16, PROTOCOL_VERSION, splitCue, SplitError, Track, validateCue} from '../shared/cues';
import {graphemeCount, snapUtf16ToGrapheme} from '../shared/grapheme';

type TrackRow = {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  /** Coordinate system of the stored annotation ranges. */
  coord: Coord;
  cues: Cue[];
};

/**
 * Seed data. `alpha` and `beta` are stored in protocol v2 (grapheme
 * coordinates); `gamma` is a legacy v1 track whose ranges are UTF-16
 * code-unit offsets, migrated deterministically on first read.
 */
function seedRows(): TrackRow[] {
  return [
    {
      id: 'alpha', name: 'Primary timed cues', revision: 3, updatedAt: new Date(0).toISOString(), coord: 'grapheme',
      cues: [
        {
          id: 'c1', start: 0, end: 2.4, text: 'Hello 👨‍👩‍👧‍👦 world!',
          speakers: [{start: 0, end: 5, speaker: 'Ana'}, {start: 8, end: 14, speaker: 'Bo'}],
          words: [
            {start: 0, end: 5, t0: 0, t1: 0.8},
            {start: 6, end: 7, t0: 0.9, t1: 1.3},
            {start: 8, end: 14, t0: 1.4, t1: 2.2},
          ],
        },
        {
          id: 'c2', start: 2.6, end: 5.0, text: 'Cafe\u0301 🇫🇷 naïve', // NFD: e + U+0301 combining acute
          speakers: [{start: 0, end: 12, speaker: 'Ana'}],
          words: [
            {start: 0, end: 4, t0: 2.6, t1: 3.3},
            {start: 5, end: 6, t0: 3.4, t1: 3.7},
            {start: 7, end: 12, t0: 3.8, t1: 4.8},
          ],
        },
        {
          id: 'c3', start: 5.2, end: 7.6, text: 'shalom שלום 2026',
          speakers: [{start: 0, end: 16, speaker: 'Bo'}],
          words: [
            {start: 0, end: 6, t0: 5.2, t1: 5.9},
            {start: 7, end: 11, t0: 6.0, t1: 6.7},
            {start: 12, end: 16, t0: 6.8, t1: 7.5},
          ],
        },
      ],
    },
    {
      id: 'beta', name: 'Secondary timed cues', revision: 5, updatedAt: new Date(1000).toISOString(), coord: 'grapheme',
      cues: [
        {
          id: 'c1', start: 0, end: 2.0, text: '🧑🏽‍💻 launches 🚀',
          speakers: [{start: 0, end: 12, speaker: 'Ana'}],
          words: [
            {start: 0, end: 1, t0: 0, t1: 0.5},
            {start: 2, end: 10, t0: 0.6, t1: 1.4},
            {start: 11, end: 12, t0: 1.5, t1: 1.9},
          ],
        },
        {id: 'c2', start: 2.2, end: 3.0, text: '', speakers: [], words: []},
      ],
    },
    {
      // Legacy protocol v1 track: annotation ranges are UTF-16 code-unit
      // offsets, including offsets that land inside surrogate pairs and
      // combining sequences. Migrated deterministically on read.
      id: 'gamma', name: 'Legacy UTF-16 track', revision: 1, updatedAt: new Date(2000).toISOString(), coord: 'utf16',
      cues: [
        {
          id: 'g1', start: 0, end: 1.0, text: 'a😀bc',
          speakers: [{start: 0, end: 3, speaker: 'Ana'}],
          words: [
            {start: 0, end: 1, t0: 0, t1: 0.4},
            {start: 3, end: 5, t0: 0.5, t1: 0.9},
          ],
        },
        {
          id: 'g2', start: 1.2, end: 2.2, text: '😀x\u0301y', // NFD: x + U+0301
          speakers: [{start: 0, end: 1, speaker: 'Ana'}, {start: 3, end: 5, speaker: 'Bo'}],
          words: [
            {start: 0, end: 2, t0: 1.2, t1: 1.6},
            {start: 2, end: 5, t0: 1.7, t1: 2.1},
          ],
        },
      ],
    },
  ];
}

function toTrack(row: TrackRow, migratedFrom?: 'utf16'): Track {
  return {
    id: row.id, name: row.name, revision: row.revision, updatedAt: row.updatedAt,
    coord: 'grapheme', protocol: PROTOCOL_VERSION, cues: row.cues,
    ...(migratedFrom ? {migratedFrom} : {}),
  };
}

export function createApp() {
  const rows = seedRows();
  const find = (id: string) => rows.find(row => row.id === id);

  /**
   * Ensure the row's ranges are in grapheme coordinates. Legacy UTF-16 rows
   * are migrated in place, deterministically, without bumping the revision.
   */
  const migrated = (row: TrackRow): boolean => {
    if (row.coord === 'grapheme') return false;
    row.cues = row.cues.map(migrateCueFromUtf16);
    row.coord = 'grapheme';
    return true;
  };

  const app = express();
  app.use(express.json({limit: '1mb'}));

  app.get('/api/bootstrap', (_req, res) => {
    res.json({family: 'subtitle-timing', count: rows.length, protocol: PROTOCOL_VERSION, coord: 'grapheme'});
  });

  app.get('/api/tracks', (_req, res) => {
    res.json(rows.map(row => ({id: row.id, name: row.name, revision: row.revision, updatedAt: row.updatedAt, coord: row.coord, cueCount: row.cues.length})));
  });

  app.get('/api/tracks/:id', (req, res) => {
    const row = find(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    const didMigrate = migrated(row);
    res.set('ETag', String(row.revision)).json(toTrack(row, didMigrate ? 'utf16' : undefined));
  });

  app.put('/api/tracks/:id', (req, res) => {
    const row = find(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (req.body?.revision !== row.revision) return res.status(409).json({error: 'revision_conflict', current: row.revision});
    const body = req.body?.cues;
    if (!Array.isArray(body)) return res.status(400).json({error: 'invalid_body', detail: 'cues must be an array'});
    // Unified protocol: ranges are grapheme indices. Legacy clients may send
    // UTF-16 ranges with coord:'utf16'; they are migrated deterministically.
    const cues: Cue[] = req.body.coord === 'utf16' ? body.map(migrateCueFromUtf16) : body;
    const diagnostics = cues.map(cue => ({cueId: cue?.id, problems: validateCue(cue)})).filter(d => d.problems.length > 0);
    if (diagnostics.length > 0) return res.status(400).json({error: 'invalid_cues', diagnostics});
    row.cues = cues;
    row.coord = 'grapheme';
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
    res.json(toTrack(row));
  });

  app.post('/api/tracks/:id/split', (req, res) => {
    const row = find(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (req.body?.revision !== row.revision) return res.status(409).json({error: 'revision_conflict', current: row.revision});
    migrated(row); // splitting always operates in grapheme coordinates
    const cue = row.cues.find(c => c.id === req.body?.cueId);
    if (!cue) return res.status(404).json({error: 'cue_not_found'});
    const raw = req.body?.position;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return res.status(400).json({error: 'invalid_position', detail: 'position must be a number'});
    }
    // Positions are grapheme indices. A legacy UTF-16 caret is snapped with
    // the same shared function the client uses, so both ends always agree.
    const position = req.body.coord === 'utf16' ? snapUtf16ToGrapheme(cue.text, raw) : raw;
    try {
      const {left, right, time} = splitCue(cue, position, cue.id + '-l', cue.id + '-r');
      row.cues.splice(row.cues.indexOf(cue), 1, left, right);
      row.revision += 1;
      row.updatedAt = new Date().toISOString();
      res.json({...toTrack(row), split: {cueId: cue.id, leftId: left.id, rightId: right.id, position, time}});
    } catch (error) {
      if (error instanceof SplitError) {
        return res.status(400).json({error: error.code, detail: error.message, count: graphemeCount(cue.text)});
      }
      throw error;
    }
  });

  app.post('/api/tracks/:id/analyze', (req, res) => {
    const row = find(req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    migrated(row);
    const diagnostics = row.cues.map(cue => ({cueId: cue.id, problems: validateCue(cue)})).filter(d => d.problems.length > 0);
    res.json({
      id: row.id, revision: row.revision, coord: 'grapheme', cues: row.cues.length,
      graphemes: row.cues.reduce((n, cue) => n + graphemeCount(cue.text), 0),
      diagnostics,
    });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
