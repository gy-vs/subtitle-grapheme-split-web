import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

describe('service',()=>{
  it('loads and conditionally updates a record',async()=>{
    const app=createApp();
    const before=await request(app).get('/api/tracks/alpha').expect(200);
    await request(app).put('/api/tracks/alpha').send({content:'updated',revision:before.body.revision}).expect(200);
    await request(app).put('/api/tracks/alpha').send({content:'stale',revision:before.body.revision}).expect(409);
  });
});

describe('cue api (grapheme coordinate protocol)',()=>{
  it('lists seeded cues with grapheme counts',async()=>{
    const app=createApp();
    const res=await request(app).get('/api/cues').expect(200);
    const ids=res.body.map((c:{id:string})=>c.id);
    expect(ids).toEqual(['cue-family','cue-flags','cue-nfd','cue-bidi','cue-empty','cue-legacy']);
    const family=res.body.find((c:{id:string})=>c.id==='cue-family');
    expect(family.graphemeCount).toBe(14);
    expect(res.body.find((c:{id:string})=>c.id==='cue-empty').graphemeCount).toBe(0);
    expect(res.body.find((c:{id:string})=>c.id==='cue-legacy').annotationUnits).toBe('utf16');
  });

  it('serves legacy cues migrated to grapheme units without persisting',async()=>{
    const app=createApp();
    const res=await request(app).get('/api/cues/cue-legacy').expect(200);
    expect(res.body.units).toBe('grapheme');
    expect(res.body.migration.migratedFrom).toBe('utf16');
    const byId=Object.fromEntries(res.body.annotations.map((a:{id:string})=>[a.id,a]));
    expect([byId.w2.start,byId.w2.end]).toEqual([2,3]); // family emoji cluster
    expect([byId.w5.start,byId.w5.end]).toEqual([2,3]); // broken legacy range expanded to the cluster
    expect([byId.sp1.start,byId.sp1.end]).toEqual([0,10]);
    const again=await request(app).get('/api/cues/cue-legacy').expect(200);
    expect(again.body.migration.migratedFrom).toBe('utf16'); // read did not persist
  });

  it('splits a cue at a grapheme boundary and remaps annotations',async()=>{
    const app=createApp();
    const res=await request(app).post('/api/cues/cue-family/split').send({position:6,units:'grapheme',revision:1}).expect(200);
    expect(res.body.left.text).toBe('Hello ');
    expect(res.body.right.text).toBe('👨‍👩‍👧‍👦 family');
    expect(res.body.timeSplitMs).toBe(2286);
    expect(res.body.report.find((e:{id:string})=>e.id==='sp1').action).toBe('split-two');
    const list=await request(app).get('/api/cues').expect(200);
    expect(list.body.map((c:{id:string})=>c.id)).toEqual(['cue-family','cue-family~r','cue-flags','cue-nfd','cue-bidi','cue-empty','cue-legacy']);
    const right=await request(app).get('/api/cues/cue-family~r').expect(200);
    expect(right.body.annotations.find((a:{id:string})=>a.id==='w2')).toMatchObject({start:0,end:1});
  });

  it('snaps a legacy utf16 split position to the nearest grapheme boundary',async()=>{
    const app=createApp();
    // utf16 offset 8 sits inside the family emoji cluster (utf16 6..17)
    const res=await request(app).post('/api/cues/cue-family/split').send({position:8,units:'utf16',revision:1}).expect(200);
    expect(res.body.requestedUnits).toBe('utf16');
    expect(res.body.requestedPosition).toBe(8);
    expect(res.body.snapped).toBe(true);
    expect(res.body.position).toBe(6);
    expect(res.body.left.text).toBe('Hello ');
  });

  it('snaps a utf16 position inside a flag pair, tie low',async()=>{
    const app=createApp();
    // 'Go 🇺🇸🇨🇦 team': 🇺🇸 spans utf16 [3,7); offset 5 is the exact middle
    const res=await request(app).post('/api/cues/cue-flags/split').send({position:5,units:'utf16',revision:1}).expect(200);
    expect(res.body.snapped).toBe(true);
    expect(res.body.position).toBe(3);
    expect(res.body.left.text).toBe('Go ');
    expect(res.body.right.text).toBe('🇺🇸🇨🇦 team');
  });

  it('rejects invalid split positions and unknown units',async()=>{
    const app=createApp();
    const tooFar=await request(app).post('/api/cues/cue-family/split').send({position:15,units:'grapheme'}).expect(422);
    expect(tooFar.body.graphemeCount).toBe(14);
    await request(app).post('/api/cues/cue-family/split').send({position:2.5,units:'grapheme'}).expect(422);
    await request(app).post('/api/cues/cue-family/split').send({position:'6',units:'grapheme'}).expect(422);
    await request(app).post('/api/cues/cue-family/split').send({position:3,units:'codepoints'}).expect(400);
    await request(app).post('/api/cues/nope/split').send({position:0,units:'grapheme'}).expect(404);
  });

  it('detects revision conflicts on split',async()=>{
    const app=createApp();
    const res=await request(app).post('/api/cues/cue-family/split').send({position:6,units:'grapheme',revision:99}).expect(409);
    expect(res.body.error).toBe('revision_conflict');
  });

  it('splits an empty cue',async()=>{
    const app=createApp();
    const res=await request(app).post('/api/cues/cue-empty/split').send({position:0,units:'grapheme'}).expect(200);
    expect(res.body.left.text).toBe('');
    expect(res.body.right.text).toBe('');
    expect(res.body.left.annotations).toEqual([]);
  });

  it('splits a bidi cue without orphaning control characters',async()=>{
    const app=createApp();
    const res=await request(app).post('/api/cues/cue-bidi/split').send({position:5,units:'grapheme',revision:1}).expect(200);
    expect(res.body.left.text).toBe('abc \u202B');
    expect(res.body.right.text).toBe('שלום\u202C def');
    expect(res.body.left.text+res.body.right.text).toBe('abc \u202Bשלום\u202C def');
  });

  it('round-trips save then reload with identical text and annotations',async()=>{
    const app=createApp();
    const before=await request(app).get('/api/cues/cue-nfd').expect(200);
    const saved=await request(app).put('/api/cues/cue-nfd').send({text:before.body.text,annotations:before.body.annotations,units:'grapheme',revision:before.body.revision}).expect(200);
    const reloaded=await request(app).get('/api/cues/cue-nfd').expect(200);
    expect(reloaded.body.text).toBe(saved.body.text);
    expect(reloaded.body.annotations).toEqual(saved.body.annotations);
    expect(reloaded.body.revision).toBe(saved.body.revision);
  });

  it('rejects out-of-range annotations on save',async()=>{
    const app=createApp();
    const cue=await request(app).get('/api/cues/cue-nfd').expect(200);
    const res=await request(app).put('/api/cues/cue-nfd').send({text:cue.body.text,annotations:[{id:'w1',kind:'word',start:0,end:99}],units:'grapheme',revision:cue.body.revision}).expect(422);
    expect(res.body.error).toBe('invalid_annotations');
    expect(res.body.problems[0]).toContain('w1');
  });

  it('migrates utf16 annotation payloads on save',async()=>{
    const app=createApp();
    const cue=await request(app).get('/api/cues/cue-flags').expect(200);
    // 'Go 🇺🇸🇨🇦 team' in utf16: flags span [3,11)
    const res=await request(app).put('/api/cues/cue-flags').send({text:cue.body.text,annotations:[{id:'w2',kind:'word',start:3,end:11,label:'🇺🇸🇨🇦',startMs:600,endMs:1200}],units:'utf16',revision:cue.body.revision}).expect(200);
    expect(res.body.annotations[0]).toMatchObject({start:3,end:5});
    expect(res.body.migration.migratedFrom).toBe('utf16');
    const reloaded=await request(app).get('/api/cues/cue-flags').expect(200);
    expect(reloaded.body.annotations[0]).toMatchObject({start:3,end:5});
  });

  it('persists legacy migration explicitly and idempotently',async()=>{
    const app=createApp();
    const first=await request(app).post('/api/cues/cue-legacy/migrate').expect(200);
    expect(first.body.changed).toBe(true);
    expect(first.body.cue.annotationUnits).toBe('grapheme');
    const second=await request(app).post('/api/cues/cue-legacy/migrate').expect(200);
    expect(second.body.changed).toBe(false);
  });

  it('splits a legacy cue by migrating first, keeping annotations aligned',async()=>{
    const app=createApp();
    const res=await request(app).post('/api/cues/cue-legacy/split').send({position:3,units:'grapheme',revision:1}).expect(200);
    expect(res.body.left.text).toBe('A 👨‍👩‍👧‍👦');
    expect(res.body.right.text).toBe(' day 🏳️‍🌈!');
    const rightIds=res.body.right.annotations.map((a:{id:string})=>a.id);
    expect(rightIds).toContain('w3');
    expect(rightIds).toContain('sp1~r');
    expect(res.body.left.annotations.map((a:{id:string})=>a.id)).toContain('w2');
  });

  it('undo restores the exact pre-split text and annotations',async()=>{
    const app=createApp();
    const before=await request(app).get('/api/cues/cue-family').expect(200);
    await request(app).post('/api/cues/cue-family/split').send({position:6,units:'grapheme',revision:1}).expect(200);
    await request(app).post('/api/undo').expect(200);
    const after=await request(app).get('/api/cues/cue-family').expect(200);
    expect(after.body.text).toBe(before.body.text);
    expect(after.body.annotations).toEqual(before.body.annotations);
    expect(after.body.revision).toBe(before.body.revision);
    const list=await request(app).get('/api/cues').expect(200);
    expect(list.body.map((c:{id:string})=>c.id)).not.toContain('cue-family~r');
  });

  it('undo restores the exact pre-save state',async()=>{
    const app=createApp();
    const before=await request(app).get('/api/cues/cue-nfd').expect(200);
    await request(app).put('/api/cues/cue-nfd').send({text:'Café',annotations:[],units:'grapheme',revision:before.body.revision}).expect(200);
    await request(app).post('/api/undo').expect(200);
    const after=await request(app).get('/api/cues/cue-nfd').expect(200);
    expect(after.body.text).toBe(before.body.text);
    expect(after.body.annotations).toEqual(before.body.annotations);
  });

  it('undo on a fresh store conflicts',async()=>{
    const app=createApp();
    await request(app).post('/api/undo').expect(409);
  });
});
