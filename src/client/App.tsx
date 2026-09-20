import {useEffect, useState} from 'react';
import {FlaskConical, Play, Save, Scissors, Undo2} from 'lucide-react';
import {Cue, Track} from '../shared/cues';
import {graphemeCount, graphemes, isGraphemeBoundaryUtf16, snapUtf16ToGrapheme} from '../shared/grapheme';
import {canUndo, historyOf, pushHistory, undoHistory, type History} from './history';

type Summary = {id: string; name: string; revision: number; updatedAt: string; cueCount: number};
type Caret = {cueId: string; utf16: number; grapheme: number; boundary: boolean};

const palette = ['#fde68a', '#bfdbfe', '#fbcfe8', '#bbf7d0', '#ddd6fe', '#fecaca'];

function speakerColor(name: string, names: string[]): string {
  const i = names.indexOf(name);
  return palette[(i < 0 ? 0 : i) % palette.length];
}

/**
 * Highlighted cue text. Renders one span per grapheme cluster and colors it
 * by the annotations that cover its grapheme index, so highlights can never
 * drift from the text — no UTF-16 offsets are involved anywhere.
 */
function CueText({cue}: {cue: Cue}) {
  const clusters = graphemes(cue.text);
  const names = Array.from(new Set(cue.speakers.map(s => s.speaker)));
  if (clusters.length === 0) return <div className="cue-text empty">(empty cue)</div>;
  return (
    <div className="cue-text" dir="auto">
      {clusters.map((cluster, i) => {
        const speaker = cue.speakers.find(s => s.start <= i && i < s.end);
        const word = cue.words.find(w => w.start <= i && i < w.end);
        return (
          <span
            key={i}
            className={word ? 'word' : undefined}
            style={speaker ? {background: speakerColor(speaker.speaker, names)} : undefined}
            title={speaker ? `${speaker.speaker} [${speaker.start},${speaker.end})` : undefined}
          >{cluster}</span>
        );
      })}
    </div>
  );
}

function WordTable({cue}: {cue: Cue}) {
  const clusters = graphemes(cue.text);
  if (cue.words.length === 0) return null;
  return (
    <table className="words">
      <thead><tr><th>word</th><th>range</th><th>time</th></tr></thead>
      <tbody>
        {cue.words.map((w, i) => (
          <tr key={i}>
            <td dir="auto">{clusters.slice(w.start, w.end).join('')}</td>
            <td>[{w.start},{w.end})</td>
            <td>{w.t0.toFixed(2)}–{w.t1.toFixed(2)}s</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function App() {
  const [items, setItems] = useState<Summary[]>([]);
  const [selected, setSelected] = useState('alpha');
  const [track, setTrack] = useState<Track | null>(null);
  const [hist, setHist] = useState<History<Cue[]>>({past: [], present: []});
  const [caret, setCaret] = useState<Caret | null>(null);
  const [analysis, setAnalysis] = useState<unknown>(null);
  const [status, setStatus] = useState('Ready');

  useEffect(() => {
    fetch('/api/tracks').then(r => r.json()).then(setItems);
  }, []);

  useEffect(() => {
    setStatus('Loading');
    setCaret(null);
    setAnalysis(null);
    fetch('/api/tracks/' + selected).then(r => r.json()).then((value: Track) => {
      setTrack(value);
      setHist(historyOf(value.cues));
      setStatus(value.migratedFrom ? `Loaded (migrated from ${value.migratedFrom} coordinates)` : 'Loaded');
    });
  }, [selected]);

  const cues = hist.present;

  async function save() {
    if (!track) return;
    setStatus('Saving');
    const response = await fetch('/api/tracks/' + track.id, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision: track.revision, cues: hist.present}),
    });
    const value = await response.json();
    if (!response.ok) {
      setStatus(value.error === 'revision_conflict' ? 'Revision conflict' : `Save failed: ${value.error}`);
      return;
    }
    setTrack(value);
    setHist(h => ({past: h.past, present: value.cues}));
    setStatus('Saved');
  }

  async function split(cue: Cue, position: number) {
    if (!track) return;
    setStatus('Splitting');
    const response = await fetch(`/api/tracks/${track.id}/split`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({revision: track.revision, cueId: cue.id, position, coord: 'grapheme'}),
    });
    const value = await response.json();
    if (!response.ok) {
      setStatus(`Split failed: ${value.error}`);
      return;
    }
    setTrack(value);
    setHist(h => pushHistory(h, value.cues));
    setCaret(null);
    setStatus(`Split ${value.split.cueId} at grapheme ${value.split.position} → ${value.split.leftId} + ${value.split.rightId}`);
  }

  async function analyze() {
    if (!track) return;
    setStatus('Analyzing');
    const response = await fetch(`/api/tracks/${track.id}/analyze`, {method: 'POST'});
    setAnalysis(await response.json());
    setStatus('Ready');
  }

  function undo() {
    setHist(h => undoHistory(h));
    setCaret(null);
    setStatus('Undone — save to persist');
  }

  function editCueText(cueId: string, text: string) {
    setHist(h => pushHistory(h, h.present.map(c => (c.id === cueId ? {...c, text} : c))));
  }

  function trackCaret(cue: Cue, el: HTMLTextAreaElement) {
    const utf16 = el.selectionStart ?? 0;
    // The textarea caret is a UTF-16 offset; snap it to the nearest grapheme
    // boundary with the shared protocol function and show the actual position.
    setCaret({
      cueId: cue.id,
      utf16,
      grapheme: snapUtf16ToGrapheme(cue.text, utf16),
      boundary: isGraphemeBoundaryUtf16(cue.text, utf16),
    });
  }

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20}/>
        <strong>Subtitle Timing Studio</strong>
        <small>Grapheme coordinate protocol v2</small>
      </header>
      <section className="workspace">
        <aside className="pane">
          <h2>Items</h2>
          <div className="list">
            {items.map(item => (
              <button className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)} key={item.id}>
                {item.name}<br/>
                <small>Revision {item.revision} · {item.cueCount} cues</small>
              </button>
            ))}
          </div>
        </aside>
        <section className="pane">
          <div className="toolbar">
            <button className="primary" onClick={save}><Save size={15}/>Save</button>
            <button onClick={undo} disabled={!canUndo(hist)}><Undo2 size={15}/>Undo</button>
            <button onClick={analyze}><Play size={15}/>Analyze</button>
            <span>{status}</span>
          </div>
          {cues.map(cue => {
            const count = graphemeCount(cue.text);
            const here = caret && caret.cueId === cue.id ? caret : null;
            const canSplit = here !== null && here.grapheme > 0 && here.grapheme < count;
            return (
              <article className="cue-card" key={cue.id}>
                <header>
                  <span className="pill">{cue.id}</span>
                  <span className="times">{cue.start.toFixed(2)}s → {cue.end.toFixed(2)}s</span>
                  <span className="count">{count} graphemes</span>
                  <button className="split" disabled={!canSplit} onClick={() => here && split(cue, here.grapheme)}>
                    <Scissors size={14}/>Split at grapheme {here ? here.grapheme : '–'}
                  </button>
                </header>
                <CueText cue={cue}/>
                <textarea
                  aria-label={`Cue ${cue.id} text`}
                  dir="auto"
                  rows={2}
                  value={cue.text}
                  onChange={event => editCueText(cue.id, event.target.value)}
                  onSelect={event => trackCaret(cue, event.currentTarget)}
                />
                <div className="caret-note">
                  {here
                    ? <>Caret: grapheme {here.grapheme}/{count}{here.boundary
                        ? ' (on a boundary)'
                        : ` — snapped from UTF-16 offset ${here.utf16}, which is inside a cluster`}</>
                    : 'Click in the text to place the caret'}
                </div>
                <div className="chips">
                  {cue.speakers.map((s, i) => (
                    <span className="chip" key={i} style={{background: speakerColor(s.speaker, Array.from(new Set(cue.speakers.map(x => x.speaker))))}}>
                      {s.speaker} [{s.start},{s.end})
                    </span>
                  ))}
                </div>
                <WordTable cue={cue}/>
              </article>
            );
          })}
        </section>
        <aside className="pane">
          <h2>Inspection</h2>
          <span className="pill">{selected}</span>
          <pre>{JSON.stringify(analysis ?? {revision: track?.revision, coord: track?.coord, protocol: track?.protocol, caret}, null, 2)}</pre>
        </aside>
      </section>
    </main>
  );
}
