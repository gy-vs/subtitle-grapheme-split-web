import express from 'express';
import {fileURLToPath} from 'node:url';
import {graphemeCount, snapUtf16, utf16ToGrapheme} from '../shared/grapheme';
import {migrateAnnotations, migrateCue, splitCue, SplitPositionError, validateAnnotations, type Annotation, type CoordinateUnits, type Cue} from '../shared/annotations';
import {createCueStore, snapshot, undo, type CueStore} from './cues';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary timed cues',revision:3,content:'timed cues: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary timed cues',revision:5,content:'timed cues: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

type CueSummary = Pick<Cue,'id'|'revision'|'startMs'|'endMs'|'text'|'annotationUnits'>&{graphemeCount:number;annotationCount:number};
function summarize(cue:Cue):CueSummary{
  return {id:cue.id,revision:cue.revision,startMs:cue.startMs,endMs:cue.endMs,text:cue.text,annotationUnits:cue.annotationUnits,graphemeCount:graphemeCount(cue.text),annotationCount:cue.annotations.length};
}

function parseUnits(value:unknown):CoordinateUnits|null{
  if(value===undefined)return 'grapheme';
  return value==='grapheme'||value==='utf16'?value:null;
}

export function createApp(store:CueStore=createCueStore()){
  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"subtitle-timing",count:rows.length}));
  app.get('/api/tracks',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/tracks/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/tracks/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/tracks/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});

  // --- Cues: all offsets in requests and responses are grapheme indices ---
  // (protocol v1). Legacy 'utf16' payloads are accepted on writes and
  // migrated deterministically; responses always use grapheme units.

  app.get('/api/cues',(_req,res)=>res.json(store.cues.map(summarize)));

  app.get('/api/cues/:id',(req,res)=>{
    const cue=store.cues.find(value=>value.id===req.params.id);
    if(!cue)return res.status(404).json({error:'not_found'});
    if(cue.annotationUnits==='utf16'){
      const migrated=migrateCue(cue);
      return res.json({...migrated.cue,units:'grapheme',migration:{migratedFrom:'utf16',report:migrated.report}});
    }
    res.json({...cue,units:'grapheme'});
  });

  app.put('/api/cues/:id',(req,res)=>{
    const index=store.cues.findIndex(value=>value.id===req.params.id);
    if(index<0)return res.status(404).json({error:'not_found'});
    const cue=store.cues[index];
    if(req.body.revision!==cue.revision)return res.status(409).json({error:'revision_conflict',current:summarize(cue)});
    const units=parseUnits(req.body.units);
    if(!units)return res.status(400).json({error:'unknown_units',allowed:['grapheme','utf16']});
    const text=String(req.body.text??'');
    const rawAnnotations=(Array.isArray(req.body.annotations)?req.body.annotations:[]) as Annotation[];
    const {annotations,report}=migrateAnnotations(text,rawAnnotations,units);
    const problems=validateAnnotations({text,annotations});
    if(problems.length>0)return res.status(422).json({error:'invalid_annotations',units:'grapheme',graphemeCount:graphemeCount(text),problems});
    snapshot(store);
    const saved:Cue={...cue,text,annotations,annotationUnits:'grapheme',revision:cue.revision+1};
    store.cues[index]=saved;
    res.json({...saved,units:'grapheme',migration:units==='utf16'?{migratedFrom:'utf16',report}:undefined});
  });

  app.post('/api/cues/:id/split',(req,res)=>{
    const index=store.cues.findIndex(value=>value.id===req.params.id);
    if(index<0)return res.status(404).json({error:'not_found'});
    if(req.body.revision!==undefined&&req.body.revision!==store.cues[index].revision){
      return res.status(409).json({error:'revision_conflict',current:summarize(store.cues[index])});
    }
    const units=parseUnits(req.body.units);
    if(!units)return res.status(400).json({error:'unknown_units',allowed:['grapheme','utf16']});
    const requestedPosition=req.body.position;
    if(typeof requestedPosition!=='number'||!Number.isInteger(requestedPosition)){
      return res.status(422).json({error:'invalid_position',message:'position must be an integer',graphemeCount:graphemeCount(store.cues[index].text)});
    }
    // Migrate legacy annotations first so the split runs in canonical units.
    const cue=migrateCue(store.cues[index]).cue;
    // Resolve the split position into the canonical grapheme coordinate.
    let position:number;
    let snapped=false;
    if(units==='utf16'){
      const snap=snapUtf16(cue.text,requestedPosition);
      position=utf16ToGrapheme(cue.text,snap.offset,'nearest');
      snapped=snap.moved;
    }else{
      position=requestedPosition;
    }
    let result;
    try{
      result=splitCue(cue,position);
    }catch(error){
      if(error instanceof SplitPositionError){
        return res.status(422).json({error:'invalid_position',message:error.message,graphemeCount:error.graphemeCount});
      }
      throw error;
    }
    snapshot(store);
    store.cues.splice(index,1,result.left,result.right);
    res.json({units:'grapheme',requestedUnits:units,requestedPosition,position:result.position,snapped,timeSplitMs:result.timeSplitMs,left:result.left,right:result.right,report:result.report});
  });

  app.post('/api/cues/:id/migrate',(req,res)=>{
    const index=store.cues.findIndex(value=>value.id===req.params.id);
    if(index<0)return res.status(404).json({error:'not_found'});
    const cue=store.cues[index];
    if(cue.annotationUnits==='grapheme')return res.json({changed:false,cue,units:'grapheme'});
    const {cue:migrated,report}=migrateCue(cue);
    snapshot(store);
    store.cues[index]={...migrated,revision:cue.revision+1};
    res.json({changed:true,cue:store.cues[index],units:'grapheme',migration:{migratedFrom:'utf16',report}});
  });

  app.post('/api/undo',(_req,res)=>{
    if(!undo(store))return res.status(409).json({error:'nothing_to_undo'});
    res.json({restored:true,cues:store.cues.map(summarize)});
  });

  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
