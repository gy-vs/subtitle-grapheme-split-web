import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {snapUtf16ToGrapheme} from '../src/shared/grapheme';

describe('protocol', () => {
  it('exposes the unified grapheme coordinate protocol', async () => {
    const app = createApp();
    const res = await request(app).get('/api/bootstrap').expect(200);
    expect(res.body).toMatchObject({family: 'subtitle-timing', protocol: 2, coord: 'grapheme'});
  });

  it('serves tracks in grapheme coordinates', async () => {
    const app = createApp();
    const res = await request(app).get('/api/tracks/alpha').expect(200);
    expect(res.headers.etag).toBe('3');
    expect(res.body.coord).toBe('grapheme');
    expect(res.body.cues).toHaveLength(3);
    expect(res.body.cues[0].text).toBe('Hello 👨‍👩‍👧‍👦 world!');
  });
});

describe('legacy UTF-16 migration', () => {
  it('migrates a legacy track deterministically on read', async () => {
    const app = createApp();
    const first = await request(app).get('/api/tracks/gamma').expect(200);
    expect(first.body.coord).toBe('grapheme');
    expect(first.body.migratedFrom).toBe('utf16');
    const [g1, g2] = first.body.cues;
    // g1 "a😀bc": UTF-16 [0,3) → grapheme [0,2) = "a😀"
    expect(g1.speakers).toEqual([{start: 0, end: 2, speaker: 'Ana'}]);
    expect(g1.words).toEqual([
      {start: 0, end: 1, t0: 0, t1: 0.4},
      {start: 2, end: 4, t0: 0.5, t1: 0.9},
    ]);
    // g2 "😀x́y": ends inside 😀 ceil, starts inside "x́" floor
    expect(g2.speakers).toEqual([
      {start: 0, end: 1, speaker: 'Ana'},
      {start: 1, end: 3, speaker: 'Bo'},
    ]);
    // A second read returns the identical migrated coordinates.
    const second = await request(app).get('/api/tracks/gamma').expect(200);
    expect(second.body.cues).toEqual(first.body.cues);
    expect(second.body.revision).toBe(first.body.revision);
  });

  it('accepts a legacy UTF-16 save and stores it migrated', async () => {
    const app = createApp();
    const before = await request(app).get('/api/tracks/gamma').expect(200);
    const legacy = {
      id: 'n1', start: 0, end: 1, text: 'a😀bc',
      speakers: [{start: 0, end: 3, speaker: 'Ana'}], // UTF-16 offsets
      words: [],
    };
    const res = await request(app)
      .put('/api/tracks/gamma')
      .send({revision: before.body.revision, coord: 'utf16', cues: [legacy]})
      .expect(200);
    expect(res.body.coord).toBe('grapheme');
    expect(res.body.cues[0].speakers).toEqual([{start: 0, end: 2, speaker: 'Ana'}]);
  });
});

describe('split endpoint', () => {
  it('splits a cue at a grapheme boundary and rebases annotations', async () => {
    const app = createApp();
    const before = await request(app).get('/api/tracks/alpha').expect(200);
    const res = await request(app)
      .post('/api/tracks/alpha/split')
      .send({revision: before.body.revision, cueId: 'c1', position: 7, coord: 'grapheme'})
      .expect(200);
    expect(res.body.revision).toBe(4);
    expect(res.body.split).toMatchObject({cueId: 'c1', leftId: 'c1-l', rightId: 'c1-r', position: 7});
    // The emoji word's time (0.9–1.3s) straddles the proportional split time
    // (1.2s), so the cue time splits at the word boundary: its t1.
    expect(res.body.split.time).toBeCloseTo(1.3);
    const [left, right] = res.body.cues;
    expect(left.text).toBe('Hello 👨‍👩‍👧‍👦');
    expect(right.text).toBe(' world!');
    expect(left.text + right.text).toBe(before.body.cues[0].text);
    expect(left.speakers).toEqual([{start: 0, end: 5, speaker: 'Ana'}]);
    expect(right.speakers).toEqual([{start: 1, end: 7, speaker: 'Bo'}]);
    expect(left.words).toEqual([
      {start: 0, end: 5, t0: 0, t1: 0.8},
      {start: 6, end: 7, t0: 0.9, t1: 1.3}, // time kept whole, fits the left cue exactly
    ]);
    expect(right.words).toEqual([{start: 1, end: 7, t0: 1.4, t1: 2.2}]);
    expect(res.body.cues).toHaveLength(4);
    // Persisted: a reload returns the same split result.
    const after = await request(app).get('/api/tracks/alpha').expect(200);
    expect(after.body.cues).toEqual(res.body.cues);
  });

  it('snaps a legacy UTF-16 caret with the shared rule before splitting', async () => {
    const app = createApp();
    const before = await request(app).get('/api/tracks/alpha').expect(200);
    const text = before.body.cues[0].text as string;
    // UTF-16 offset 10 is inside the 👨‍👩‍👧‍👦 sequence (which spans offsets 6..17).
    const res = await request(app)
      .post('/api/tracks/alpha/split')
      .send({revision: before.body.revision, cueId: 'c1', position: 10, coord: 'utf16'})
      .expect(200);
    expect(res.body.split.position).toBe(6);
    expect(res.body.split.position).toBe(snapUtf16ToGrapheme(text, 10));
    expect(res.body.cues[0].text).toBe('Hello ');
    expect(res.body.cues[1].text).toBe('👨‍👩‍👧‍👦 world!');
  });

  it('rejects splitting an empty cue', async () => {
    const app = createApp();
    const before = await request(app).get('/api/tracks/beta').expect(200);
    const res = await request(app)
      .post('/api/tracks/beta/split')
      .send({revision: before.body.revision, cueId: 'c2', position: 1})
      .expect(400);
    expect(res.body.error).toBe('empty_cue');
  });

  it('rejects positions that are not splittable grapheme boundaries', async () => {
    const app = createApp();
    const before = await request(app).get('/api/tracks/alpha').expect(200);
    for (const position of [0, 14, -1, 2.5]) {
      const res = await request(app)
        .post('/api/tracks/alpha/split')
        .send({revision: before.body.revision, cueId: 'c1', position})
        .expect(400);
      expect(res.body.error).toBe('invalid_position');
      expect(res.body.count).toBe(14);
    }
  });

  it('rejects unknown tracks, unknown cues and stale revisions', async () => {
    const app = createApp();
    const before = await request(app).get('/api/tracks/alpha').expect(200);
    await request(app).post('/api/tracks/nope/split').send({revision: 1, cueId: 'c1', position: 1}).expect(404);
    const missing = await request(app)
      .post('/api/tracks/alpha/split')
      .send({revision: before.body.revision, cueId: 'nope', position: 1})
      .expect(404);
    expect(missing.body.error).toBe('cue_not_found');
    const stale = await request(app)
      .post('/api/tracks/alpha/split')
      .send({revision: before.body.revision - 1, cueId: 'c1', position: 1})
      .expect(409);
    expect(stale.body.error).toBe('revision_conflict');
  });
});

describe('save / undo round trip', () => {
  it('restores text and annotations exactly after split → undo → save', async () => {
    const app = createApp();
    const before = await request(app).get('/api/tracks/alpha').expect(200);
    const original = before.body.cues;
    // Split (server mutates), then the client undoes locally and saves the
    // restored cues with the post-split revision.
    const split = await request(app)
      .post('/api/tracks/alpha/split')
      .send({revision: before.body.revision, cueId: 'c1', position: 7})
      .expect(200);
    expect(split.body.cues).not.toEqual(original);
    const saved = await request(app)
      .put('/api/tracks/alpha')
      .send({revision: split.body.revision, cues: original})
      .expect(200);
    const after = await request(app).get('/api/tracks/alpha').expect(200);
    expect(after.body.cues).toEqual(original);
    expect(after.body.revision).toBe(saved.body.revision);
  });

  it('rejects invalid annotations with diagnostics', async () => {
    const app = createApp();
    const before = await request(app).get('/api/tracks/alpha').expect(200);
    const broken = [{
      id: 'x', start: 0, end: 1, text: 'a😀b',
      speakers: [{start: 0, end: 9, speaker: 'Ana'}], // beyond the 3 graphemes
      words: [],
    }];
    const res = await request(app)
      .put('/api/tracks/alpha')
      .send({revision: before.body.revision, cues: broken})
      .expect(400);
    expect(res.body.error).toBe('invalid_cues');
    expect(res.body.diagnostics[0].cueId).toBe('x');
    expect(res.body.diagnostics[0].problems.length).toBeGreaterThan(0);
  });

  it('keeps the conditional-update conflict behavior', async () => {
    const app = createApp();
    const before = await request(app).get('/api/tracks/alpha').expect(200);
    const cues = before.body.cues;
    await request(app).put('/api/tracks/alpha').send({cues, revision: before.body.revision}).expect(200);
    const stale = await request(app)
      .put('/api/tracks/alpha')
      .send({cues, revision: before.body.revision})
      .expect(409);
    expect(stale.body.error).toBe('revision_conflict');
  });
});

describe('analyze endpoint', () => {
  it('reports grapheme counts and validation diagnostics', async () => {
    const app = createApp();
    const res = await request(app).post('/api/tracks/alpha/analyze').expect(200);
    expect(res.body).toMatchObject({id: 'alpha', coord: 'grapheme', cues: 3, graphemes: 42, diagnostics: []});
  });
});
