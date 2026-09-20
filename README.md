# Subtitle Timing Studio

Local workbench for timed cues.

Run `npm install`, then `npm run dev`.

## Grapheme coordinate protocol (v1)

Cursor positions, API payloads and the server-side split logic all share one
coordinate system: **grapheme indices** over UAX #29 extended grapheme
clusters (`Intl.Segmenter`). A position `p ∈ [0, graphemeCount(text)]` is the
boundary before the p-th cluster; only these boundaries are splittable, so a
split can never tear a surrogate pair, ZWJ emoji sequence, regional-indicator
flag, combining (NFD) sequence or bidi control run.

- `src/shared/grapheme.ts` — segmentation, UTF-16 ↔ grapheme conversion,
  caret snapping (`resolveCursor`). The UI snaps a mid-cluster caret to the
  nearest boundary (ties low) and displays the actual position used.
- `src/shared/annotations.ts` — cue/annotation model, legacy migration and
  the `splitCue` algorithm.

### Legacy UTF-16 migration

Annotations stored with UTF-16 offsets (`annotationUnits: 'utf16'`) are
migrated deterministically: range starts **floor** to the containing cluster,
range ends **ceil**, so a migrated range still covers every cluster the legacy
range touched; out-of-range offsets clamp. `GET /api/cues/:id` migrates
legacy cues on the fly (with a report, without persisting);
`POST /api/cues/:id/migrate` persists the migration idempotently; `PUT` and
`POST /api/cues/:id/split` accept `units: 'utf16'` payloads and convert them
(split positions snap to the nearest boundary, tie low, echoed as
`requestedPosition`/`position`/`snapped`).

### Split semantics (`POST /api/cues/:id/split`)

- `annotation.end <= pos` → left cue (offsets unchanged);
  `annotation.start >= pos` → right cue (offsets shift by `-pos`).
- A truly straddling **word timing** is atomic: it is attributed wholesale to
  the side holding the majority of its graphemes (ties go left), its text
  range clamps to that cue and its timing is kept whole. The cue's own time
  range splits at that word's boundary in time.
- A truly straddling **range annotation** (speaker label) is the only thing
  split into two segments, one clamped to each cue (`<id>` and `<id>~r`).
- Annotations merely touching the boundary are never split. With no
  straddling word the cue time splits proportionally to the grapheme ratio
  (midpoint for empty cues). Edge positions `0` and `graphemeCount` are valid.

`POST /api/undo` restores the exact pre-mutation state (text, annotations,
revisions) — save/split round-trips are byte-identical after undo and reload.
