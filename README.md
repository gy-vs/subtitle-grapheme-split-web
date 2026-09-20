# Subtitle Timing Studio

Local workbench for timed cues.

Run `npm install`, then `npm run dev`.

## Coordinate protocol v2

Cursor positions, API payloads and the server-side split logic all speak one
coordinate system: **grapheme indices** — counts of extended grapheme clusters
(UAX #29, via `Intl.Segmenter`). A position `i` addresses the boundary before
the i-th cluster, so a cue with `n` clusters can be split exactly at
`1..n-1`. ZWJ emoji, regional-indicator flags, NFD combining sequences and
surrogate pairs are therefore impossible to cut, and bidirectional text is
always split in logical order.

- `src/shared/grapheme.ts` — segmentation and coordinate mapping, shared by
  the client and the server. The client snaps the textarea caret (a UTF-16
  offset) to the nearest grapheme boundary (ties resolve forward) and shows
  the actual position used; the server applies the same function to legacy
  requests.
- `src/shared/cues.ts` — cue model, `splitCue`, migration, validation.

### Splitting

`POST /api/tracks/:id/split` with `{revision, cueId, position, coord?}` splits
one cue at a grapheme boundary:

- Speaker ranges that **truly span** the split point are split into two
  rebased segments; ranges that merely touch the boundary stay whole, and no
  zero-length segments are created.
- Word timings are atomic and are never cut. A word spanning the split point
  is attributed wholesale by word boundary (majority of graphemes wins, ties
  go to the earlier cue), and the cue's time range splits at that word's
  boundary so its timing stays intact. When no word spans the point but the
  proportional split time would land inside a word's time interval, the split
  time snaps to that word's boundary instead.
- Splitting an empty cue or a non-boundary position is rejected
  (`empty_cue` / `invalid_position`).

### Legacy UTF-16 migration

Tracks stored with UTF-16 code-unit ranges (`coord: "utf16"`, protocol v1)
are migrated deterministically: range starts map to the containing cluster
(floor), range ends to the boundary after it (ceil), boundary-exact offsets
are unchanged. Migration happens on read (and on `PUT`/`split` with
`coord: "utf16"`) and always yields the same grapheme coordinates.

### Undo / save fidelity

The editor keeps snapshot history (`src/client/history.ts`). Undo restores
the exact pre-split cues; saving after undo persists them with the latest
revision, so a reload returns text and annotations identical to the original.
