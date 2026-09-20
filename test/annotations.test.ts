import {describe,expect,it} from 'vitest';
import {graphemeCount} from '../src/shared/grapheme';
import {migrateAnnotations,migrateCue,splitCue,SplitPositionError,validateAnnotations,type Cue} from '../src/shared/annotations';

function cue(partial:Partial<Cue>&Pick<Cue,'id'|'text'>):Cue{
  return {revision:1,startMs:0,endMs:0,annotations:[],annotationUnits:'grapheme',...partial};
}

const family=cue({
  id:'cue-family',startMs:1000,endMs:4000,
  text:'Hello 👨‍👩‍👧‍👦 family', // 14 graphemes; ZWJ emoji at index 6
  annotations:[
    {id:'sp1',kind:'speaker',start:0,end:14,label:'MIRA'},
    {id:'w1',kind:'word',start:0,end:5,label:'Hello',startMs:1000,endMs:1600},
    {id:'w2',kind:'word',start:6,end:7,label:'👨‍👩‍👧‍👦',startMs:1700,endMs:2400},
    {id:'w3',kind:'word',start:8,end:14,label:'family',startMs:2500,endMs:3800},
  ],
});

describe('splitCue',()=>{
  it('splits text at a grapheme boundary and remaps every annotation',()=>{
    const {left,right,timeSplitMs,report}=splitCue(family,6);
    expect(left.text).toBe('Hello ');
    expect(right.text).toBe('👨‍👩‍👧‍👦 family');
    expect(timeSplitMs).toBe(2286); // 1000 + round(3000 * 6/14)
    expect(left.id).toBe('cue-family');
    expect(right.id).toBe('cue-family~r');
    expect([left.startMs,left.endMs]).toEqual([1000,2286]);
    expect([right.startMs,right.endMs]).toEqual([2286,4000]);
    // speaker straddles -> two clamped segments
    expect(left.annotations.find(a=>a.id==='sp1')).toMatchObject({start:0,end:6});
    expect(right.annotations.find(a=>a.id==='sp1~r')).toMatchObject({start:0,end:8,label:'MIRA'});
    // words shift into right-cue coordinates
    expect(right.annotations.find(a=>a.id==='w2')).toMatchObject({start:0,end:1});
    expect(right.annotations.find(a=>a.id==='w3')).toMatchObject({start:2,end:8});
    expect(left.annotations.find(a=>a.id==='w1')).toMatchObject({start:0,end:5});
    expect(report.map(e=>e.action)).toEqual(['split-two','left','right','right']);
  });

  it('attributes a straddling word by grapheme majority and splits cue time at the word boundary',()=>{
    const {left,right,timeSplitMs,report}=splitCue(family,2); // inside "Hello" [0,5): 2 vs 3 -> right
    expect(left.text).toBe('He');
    expect(right.text).toBe('llo 👨‍👩‍👧‍👦 family');
    expect(timeSplitMs).toBe(1000); // word.startMs, word went right
    const word=right.annotations.find(a=>a.id==='w1');
    expect(word).toMatchObject({start:0,end:3,startMs:1000,endMs:1600}); // timing kept whole
    expect(report.find(e=>e.id==='w1')?.action).toBe('word-right');
    expect(left.annotations.find(a=>a.id==='w1')).toBeUndefined();
  });

  it('breaks word-majority ties to the left',()=>{
    const tie=cue({id:'t',text:'abcd',startMs:0,endMs:100,annotations:[{id:'w',kind:'word',start:0,end:4,startMs:10,endMs:90}]});
    const {left,right,timeSplitMs,report}=splitCue(tie,2); // 2 vs 2 -> left
    expect(report[0].action).toBe('word-left');
    expect(timeSplitMs).toBe(90); // word.endMs
    expect(left.annotations[0]).toMatchObject({start:0,end:2,startMs:10,endMs:90});
    expect(right.annotations).toEqual([]);
  });

  it('does not split annotations that merely touch the boundary',()=>{
    const exact=cue({id:'e',text:'abcde',startMs:0,endMs:50,annotations:[
      {id:'a',kind:'word',start:0,end:3,startMs:0,endMs:30},
      {id:'b',kind:'word',start:3,end:5,startMs:30,endMs:50},
    ]});
    const {left,right,timeSplitMs,report}=splitCue(exact,3);
    expect(report.map(e=>e.action)).toEqual(['left','right']);
    expect(left.annotations[0]).toMatchObject({id:'a',start:0,end:3});
    expect(right.annotations[0]).toMatchObject({id:'b',start:0,end:2});
    expect(timeSplitMs).toBe(30); // proportional: round(50 * 3/5)
  });

  it('keeps zero-length annotations at the split point on the left',()=>{
    const z=cue({id:'z',text:'ab',annotations:[{id:'p',kind:'word',start:1,end:1,startMs:0,endMs:0}]});
    const {left,right}=splitCue(z,1);
    expect(left.annotations).toHaveLength(1);
    expect(right.annotations).toHaveLength(0);
  });

  it('splits an empty cue at position 0',()=>{
    const {left,right,timeSplitMs,report}=splitCue(cue({id:'empty',text:'',startMs:100,endMs:200}),0);
    expect(left.text).toBe('');
    expect(right.text).toBe('');
    expect(timeSplitMs).toBe(150); // midpoint fallback
    expect(report).toEqual([]);
  });

  it('allows edge positions 0 and graphemeCount',()=>{
    const atStart=splitCue(family,0);
    expect(atStart.left.text).toBe('');
    expect(atStart.left.annotations).toEqual([]);
    expect(atStart.right.text).toBe(family.text);
    expect(atStart.right.annotations.find(a=>a.id==='sp1')).toMatchObject({start:0,end:14}); // touched, not split
    expect(atStart.timeSplitMs).toBe(1000);
    const atEnd=splitCue(family,14);
    expect(atEnd.right.text).toBe('');
    expect(atEnd.right.annotations).toEqual([]);
    expect(atEnd.left.annotations).toHaveLength(4);
    expect(atEnd.timeSplitMs).toBe(4000);
  });

  it('rejects invalid positions and non-grapheme units',()=>{
    expect(()=>splitCue(family,-1)).toThrow(SplitPositionError);
    expect(()=>splitCue(family,15)).toThrow(SplitPositionError);
    expect(()=>splitCue(family,2.5)).toThrow(SplitPositionError);
    expect(()=>splitCue({...family,annotationUnits:'utf16'},3)).toThrow(/grapheme/);
  });

  it('never tears a ZWJ emoji: mid-emoji positions do not exist',()=>{
    const count=graphemeCount('A👨‍👩‍👧‍👦B');
    expect(count).toBe(3);
    for(let p=0;p<=count;p++){
      const {left,right}=splitCue(cue({id:'e',text:'A👨‍👩‍👧‍👦B'}),p);
      expect(left.text+right.text).toBe('A👨‍👩‍👧‍👦B');
    }
  });

  it('splits between two flags and attributes the straddling flag word by tie to the left',()=>{
    const flags=cue({id:'cue-flags',startMs:0,endMs:2000,text:'Go 🇺🇸🇨🇦 team',annotations:[
      {id:'sp1',kind:'speaker',start:0,end:10,label:'LEE'},
      {id:'w1',kind:'word',start:0,end:2,label:'Go',startMs:0,endMs:500},
      {id:'w2',kind:'word',start:3,end:5,label:'🇺🇸🇨🇦',startMs:600,endMs:1200},
      {id:'w3',kind:'word',start:6,end:10,label:'team',startMs:1300,endMs:2000},
    ]});
    const {left,right,timeSplitMs,report}=splitCue(flags,4);
    expect(left.text).toBe('Go 🇺🇸');
    expect(right.text).toBe('🇨🇦 team');
    expect(report.find(e=>e.id==='w2')?.action).toBe('word-left'); // 1 vs 1 tie
    expect(timeSplitMs).toBe(1200); // w2.endMs
    expect(left.annotations.find(a=>a.id==='w2')).toMatchObject({start:3,end:4,startMs:600,endMs:1200});
    expect(right.annotations.find(a=>a.id==='w3')).toMatchObject({start:2,end:6});
    expect(right.annotations.find(a=>a.id==='sp1~r')).toMatchObject({start:0,end:6});
  });

  it('handles NFD combining characters without splitting base and mark',()=>{
    const nfd=cue({id:'n',startMs:0,endMs:1500,text:'Cafe\u0301 noir',annotations:[ // é = e + ́
      {id:'sp1',kind:'speaker',start:0,end:9,label:'CHEF'},
      {id:'w1',kind:'word',start:0,end:4,label:'Café',startMs:0,endMs:800},
      {id:'w2',kind:'word',start:5,end:9,label:'noir',startMs:900,endMs:1500},
    ]});
    const inside=splitCue(nfd,3); // between 'f' and 'é'
    expect(inside.left.text).toBe('Caf');
    expect(inside.right.text).toBe('e\u0301 noir');
    expect(inside.report.find(e=>e.id==='w1')?.action).toBe('word-left'); // 3 vs 1
    expect(inside.timeSplitMs).toBe(800);
    const after=splitCue(nfd,4); // exactly after the cluster
    expect(after.left.text).toBe('Cafe\u0301');
    expect(after.left.annotations.find(a=>a.id==='w1')).toMatchObject({start:0,end:4}); // untouched
    expect(after.report.find(e=>e.id==='w1')?.action).toBe('left');
  });

  it('keeps bidi controls intact and shifts annotations across them',()=>{
    const bidi=cue({id:'b',startMs:0,endMs:3000,text:'abc \u202Bשלום\u202C def',annotations:[
      {id:'sp1',kind:'speaker',start:0,end:14,label:'DANA'},
      {id:'w1',kind:'word',start:0,end:3,startMs:0,endMs:700},
      {id:'w2',kind:'word',start:5,end:9,startMs:800,endMs:1800},
      {id:'w3',kind:'word',start:11,end:14,startMs:1900,endMs:2600},
    ]});
    const {left,right,timeSplitMs}=splitCue(bidi,5);
    expect(left.text).toBe('abc \u202B');
    expect(right.text).toBe('שלום\u202C def');
    expect(timeSplitMs).toBe(1071); // proportional: round(3000 * 5/14)
    expect(left.annotations.find(a=>a.id==='sp1')).toMatchObject({start:0,end:5});
    expect(right.annotations.find(a=>a.id==='w2')).toMatchObject({start:0,end:4});
    expect(right.annotations.find(a=>a.id==='w3')).toMatchObject({start:6,end:9});
  });

  it('keeps every annotation in bounds for every split position',()=>{
    const count=graphemeCount(family.text);
    for(let p=0;p<=count;p++){
      const {left,right}=splitCue(family,p);
      expect(validateAnnotations(left)).toEqual([]);
      expect(validateAnnotations(right)).toEqual([]);
      expect(left.text+right.text).toBe(family.text);
      expect(left.endMs).toBe(right.startMs);
    }
  });
});

describe('migrateAnnotations (legacy utf16)',()=>{
  const text='A 👨‍👩‍👧‍👦 day 🏳️‍🌈!'; // utf16 len 25; 10 graphemes
  it('converts exact boundaries and expands mid-cluster endpoints to cover the cluster',()=>{
    const {annotations,report}=migrateAnnotations(text,[
      {id:'exact',kind:'word',start:0,end:1},
      {id:'emoji',kind:'word',start:2,end:13},
      {id:'broken',kind:'word',start:3,end:12}, // both ends inside the family emoji
      {id:'all',kind:'speaker',start:0,end:25},
    ],'utf16');
    expect(annotations.find(a=>a.id==='exact')).toMatchObject({start:0,end:1});
    expect(annotations.find(a=>a.id==='emoji')).toMatchObject({start:2,end:3});
    expect(annotations.find(a=>a.id==='broken')).toMatchObject({start:2,end:3});
    expect(annotations.find(a=>a.id==='all')).toMatchObject({start:0,end:10});
    expect(report.find(e=>e.id==='exact')?.adjusted).toBe(false);
    expect(report.find(e=>e.id==='broken')?.adjusted).toBe(true);
  });
  it('expands a range inside a surrogate pair to the whole flag',()=>{
    const {annotations}=migrateAnnotations('a🇺🇸b',[{id:'f',kind:'word',start:2,end:4}],'utf16');
    expect(annotations[0]).toMatchObject({start:1,end:2});
  });
  it('clamps out-of-range offsets',()=>{
    const {annotations}=migrateAnnotations('ab',[{id:'x',kind:'word',start:-5,end:99}],'utf16');
    expect(annotations[0]).toMatchObject({start:0,end:2});
  });
  it('handles empty text',()=>{
    const {annotations}=migrateAnnotations('',[{id:'x',kind:'word',start:0,end:0}],'utf16');
    expect(annotations[0]).toMatchObject({start:0,end:0});
  });
  it('passes grapheme-unit annotations through with an empty report',()=>{
    const source=[{id:'w',kind:'word' as const,start:1,end:2}];
    const {annotations,report}=migrateAnnotations('abc',source,'grapheme');
    expect(annotations).toEqual(source);
    expect(report).toEqual([]);
  });
  it('migrates a cue deterministically and idempotently',()=>{
    const legacy=cue({id:'l',text,annotationUnits:'utf16',annotations:[
      {id:'w2',kind:'word',start:2,end:13},
      {id:'w5',kind:'word',start:3,end:12},
    ]});
    const first=migrateCue(legacy);
    expect(first.cue.annotationUnits).toBe('grapheme');
    expect(first.cue.annotations.map(a=>[a.start,a.end])).toEqual([[2,3],[2,3]]);
    const second=migrateCue(first.cue);
    expect(second.cue.annotations).toEqual(first.cue.annotations);
    expect(second.report).toEqual([]);
  });
});

describe('validateAnnotations',()=>{
  it('accepts in-range annotations and flags broken ones',()=>{
    expect(validateAnnotations({text:'ab',annotations:[{id:'ok',kind:'word',start:0,end:2}]})).toEqual([]);
    const problems=validateAnnotations({text:'ab',annotations:[
      {id:'wide',kind:'word',start:0,end:3},
      {id:'neg',kind:'word',start:-1,end:1},
      {id:'rev',kind:'word',start:2,end:1},
      {id:'time',kind:'word',start:0,end:1,startMs:50,endMs:10},
    ]});
    expect(problems).toHaveLength(4);
    expect(problems.map(p=>p.split(':')[0])).toEqual(['wide','neg','rev','time']);
  });
});
