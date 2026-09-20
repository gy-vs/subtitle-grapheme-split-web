import {useCallback,useEffect,useMemo,useState} from 'react';
import {FlaskConical,Save,Scissors,Undo2} from 'lucide-react';
import {graphemeCount,graphemeIndexToUtf16,resolveCursor,type CursorPosition} from '../shared/grapheme';
import type {Annotation,Cue} from '../shared/annotations';

type CueSummary={id:string;revision:number;startMs:number;endMs:number;text:string;graphemeCount:number;annotationCount:number;annotationUnits:string};
type Migration={migratedFrom:string;report:Array<{id:string;from:{start:number;end:number};to:{start:number;end:number};adjusted:boolean}>};
type CueDetail=Cue&{units:string;migration?:Migration};
type SplitResponse={position:number;requestedPosition:number;requestedUnits:string;snapped:boolean;timeSplitMs:number;left:Cue;right:Cue;report:Array<{id:string;kind:string;action:string}>};

/** Render text with annotation highlights; grapheme ranges are converted to
 *  UTF-16 only at the slice boundary, so clusters are never torn. */
function HighlightedText({text,annotations}:{text:string;annotations:Annotation[]}){
  const segments=useMemo(()=>{
    const cuts=new Set<number>([0,graphemeCount(text)]);
    for(const a of annotations){cuts.add(a.start);cuts.add(a.end)}
    const sorted=[...cuts].sort((x,y)=>x-y);
    const out:Array<{key:number;slice:string;kinds:string[]}>=[];
    for(let i=0;i+1<sorted.length;i++){
      const start=sorted[i],end=sorted[i+1];
      if(start===end)continue;
      const kinds=[...new Set(annotations.filter(a=>a.start<=start&&a.end>=end).map(a=>a.kind))].sort();
      out.push({key:start,slice:text.slice(graphemeIndexToUtf16(text,start),graphemeIndexToUtf16(text,end)),kinds});
    }
    return out;
  },[text,annotations]);
  return <p className="preview">{segments.map(seg=><span key={seg.key} className={seg.kinds.map(k=>'hl-'+k).join(' ')}>{seg.slice}</span>)}</p>;
}

export default function App(){
  const [cues,setCues]=useState<CueSummary[]>([]);
  const [selected,setSelected]=useState<string>('');
  const [detail,setDetail]=useState<CueDetail|null>(null);
  const [draft,setDraft]=useState('');
  const [cursor,setCursor]=useState<CursorPosition|null>(null);
  const [migration,setMigration]=useState<Migration|null>(null);
  const [lastSplit,setLastSplit]=useState<SplitResponse|null>(null);
  const [status,setStatus]=useState('Ready');

  const refreshCues=useCallback(async()=>{
    const list:CueSummary[]=await (await fetch('/api/cues')).json();
    setCues(list);
    return list;
  },[]);

  useEffect(()=>{refreshCues().then(list=>{if(list.length>0)setSelected(current=>current||list[0].id)})},[refreshCues]);

  useEffect(()=>{
    if(!selected)return;
    setStatus('Loading');
    fetch('/api/cues/'+selected).then(r=>r.json()).then((value:CueDetail)=>{
      setDetail(value);setDraft(value.text);setMigration(value.migration??null);setLastSplit(null);
      setCursor(resolveCursor(value.text,0));setStatus('Ready');
    });
  },[selected]);

  function trackCursor(element:HTMLTextAreaElement){
    setCursor(resolveCursor(element.value,element.selectionStart??0));
  }

  async function save(){
    if(!detail)return;
    setStatus('Saving');
    // Annotations are clamped to the edited text before saving, deterministically.
    const count=graphemeCount(draft);
    const annotations=detail.annotations.map(a=>{
      const start=Math.min(a.start,count);
      return {...a,start,end:Math.max(start,Math.min(a.end,count))};
    });
    const response=await fetch('/api/cues/'+detail.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({text:draft,annotations,units:'grapheme',revision:detail.revision})});
    const value=await response.json();
    if(!response.ok){setStatus(response.status===409?'Revision conflict':`Save failed: ${value.error}`);return}
    setDetail({...value,units:'grapheme'});setMigration(null);setStatus('Saved');
    await refreshCues();
  }

  async function split(){
    if(!detail||!cursor)return;
    setStatus('Splitting');
    const response=await fetch(`/api/cues/${detail.id}/split`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({position:cursor.grapheme,units:'grapheme',revision:detail.revision})});
    const value=await response.json();
    if(!response.ok){setStatus(`Split failed: ${value.error??response.status}`);return}
    setLastSplit(value);
    setStatus(`Split at grapheme ${value.position}${value.requestedUnits==='utf16'?' (utf16 request snapped)':''}`);
    await refreshCues();
    // The left cue keeps the original id, so reload the detail explicitly.
    const fresh=await (await fetch('/api/cues/'+value.left.id)).json();
    setSelected(value.left.id);
    setDetail(fresh);setDraft(fresh.text);setMigration(fresh.migration??null);setCursor(resolveCursor(fresh.text,0));
  }

  async function undoLast(){
    setStatus('Undoing');
    const response=await fetch('/api/undo',{method:'POST'});
    if(!response.ok){setStatus('Nothing to undo');return}
    const list=await refreshCues();
    const id=list.some(cue=>cue.id===selected)?selected:list[0]?.id??'';
    if(id!==selected)setSelected(id); // the detail effect reloads
    else{
      const value=await (await fetch('/api/cues/'+id)).json();
      setDetail(value);setDraft(value.text);setMigration(value.migration??null);setCursor(resolveCursor(value.text,0));
    }
    setStatus('Undone');
  }

  return <main className="shell">
    <header className="topbar"><FlaskConical size={20}/><strong>Subtitle Timing Studio</strong><small>Grapheme coordinate protocol v1</small></header>
    <section className="workspace">
      <aside className="pane"><h2>Cues</h2><div className="list">{cues.map(cue=><button className={cue.id===selected?'active':''} onClick={()=>setSelected(cue.id)} key={cue.id}>
        {cue.id}<br/><small>{cue.startMs}–{cue.endMs}ms · {cue.graphemeCount} graphemes · {cue.annotationCount} annotations{cue.annotationUnits==='utf16'?' · legacy utf16':''}</small>
      </button>)}</div></aside>
      <section className="pane">
        <div className="toolbar">
          <button className="primary" onClick={save} disabled={!detail}><Save size={15}/>Save</button>
          <button onClick={split} disabled={!detail||!cursor}><Scissors size={15}/>Split at cursor</button>
          <button onClick={undoLast}><Undo2 size={15}/>Undo</button>
          <span>{status}</span>
        </div>
        <textarea aria-label="Cue text" value={draft} onChange={event=>{setDraft(event.target.value);trackCursor(event.target)}} onSelect={event=>trackCursor(event.currentTarget)} onKeyUp={event=>trackCursor(event.currentTarget)} onClick={event=>trackCursor(event.currentTarget)}/>
        <p className="cursor-line" aria-live="polite">
          {cursor&&<>
            cursor utf16 <strong>{cursor.utf16}</strong> → grapheme <strong>{cursor.grapheme}</strong> / {cursor.graphemeCount}
            {cursor.snapped&&<em> (mid-cluster, snapped to utf16 {cursor.snappedUtf16})</em>}
          </>}
        </p>
        {migration&&<p className="migration">Migrated from {migration.migratedFrom}: {migration.report.filter(e=>e.adjusted).length} of {migration.report.length} annotations adjusted to grapheme boundaries.</p>}
        {lastSplit&&<div className="report"><h3>Split report @ grapheme {lastSplit.position} · time {lastSplit.timeSplitMs}ms</h3>
          <ul>{lastSplit.report.map(entry=><li key={entry.id}><code>{entry.id}</code> ({entry.kind}) → {entry.action}</li>)}</ul>
          <small>left: “{lastSplit.left.text}” · right: “{lastSplit.right.text}”</small>
        </div>}
      </section>
      <aside className="pane">
        <h2>Annotations</h2>
        {detail&&<><span className="pill">{detail.id} · rev {detail.revision} · {detail.units}</span>
        <HighlightedText text={detail.text} annotations={detail.annotations}/>
        <table className="annotations"><thead><tr><th>id</th><th>kind</th><th>range</th><th>label</th><th>ms</th></tr></thead>
        <tbody>{detail.annotations.map(a=><tr key={a.id}><td>{a.id}</td><td>{a.kind}</td><td>[{a.start}, {a.end})</td><td>{a.label}</td><td>{a.startMs!==undefined?`${a.startMs}–${a.endMs}`:''}</td></tr>)}</tbody></table></>}
      </aside>
    </section>
  </main>;
}
