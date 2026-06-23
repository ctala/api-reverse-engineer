# ADR-0001: Capture Mode output format — JSON-Lines (default) + JSON array (legacy)

- **Status:** Accepted
- **Date:** 2026-06-23
- **Deciders:** linkedin-architect (architecture), Cristian Tala (product owner)
- **Supersedes:** v1.2.3 default of JSON array (additive — legacy still supported)
- **Related:** [`capture-mode-spec.md`](./capture-mode-spec.md)

## Context

The current v1.2.3 plugin (`api-reverse-engineer`) serializes a recording
session as a single JSON object of shape:

```json
{
  "meta": { "capturedAt": "...", "total": N, "uniqueEndpoints": M, "site": "..." },
  "endpoints": [ { /* one entry per unique method:url */ } ],
  "all": [ { /* every event, including duplicates */ } ]
}
```

This is fine for one-shot manual review. It is awkward for the workflow
the `linkedin-all-in-one-api` project needs:

1. **Append-friendly** — the dev wants to `cat` two captures and treat the
   result as one stream. With JSON array, the only way to merge two captures
   is to parse both, concat the `all` arrays, and re-serialize. With
   JSON-Lines, `cat a.jsonl b.jsonl > merged.jsonl` works.
2. **`jq -c` friendly** — `jq -c '. | select(.url | contains("/voyager/api/me"))'`
   on a JSON array requires `jq '.all[] | ...'` (annoying); on JSONL it is
   just `jq -c 'select(.request.url | contains("/voyager/api/me"))'`.
3. **Streaming-write friendly** — a JSON array must be fully built before
   it is valid (no trailing comma). JSONL is line-by-line: we can `fsync`
   after each event if we want crash-safe capture.
4. **One event = one line = grep-friendly** — `grep '"preset":"linkedin-voyager"'`
   is the kind of thing we do during a multi-step Voyager walk.
5. **Diff-friendly in version control** — adding one new event to a JSONL
   file is a one-line diff in `captures-live/`. Adding one event to a JSON
   array is a reformat of the entire file.

## Decision

**Default to JSON-Lines (`.jsonl`) for the Capture Mode output of v1.3.0.**
**Keep the JSON array (`.json`) output available behind a toggle** for
backwards compatibility with any existing scripts and the existing
`captures/` directory layout.

## Why JSON-Lines specifically (and not NDJSON / not CSV / not a custom format)

- **NDJSON is a synonym.** The format is formally called "Newline-Delimited
  JSON" (NDJSON) by the IETF-ish spec at <https://ndjson.org/>. We use the
  `.jsonl` extension in the filename and the term "JSON-Lines" in the UI
  because (a) it is more recognizable to general developers and (b) every
  major tool (`jq`, `cat`, `grep`, `awk`, Python `json.loads` line-by-line,
  Node `readline`) already handles it. NDJSON and JSONL are identical
  wire format; the only difference is filename convention. We chose
  `.jsonl` because it is what `linkedin-all-in-one-api` already calls them
  in conversation and what the dev expects.
- **Not CSV.** Nested JSON bodies (which are most of the value) do not
  flatten cleanly to CSV columns. The `response.body` field can be a
  3 MB normalized envelope; in CSV that becomes a single cell of
  un-escaped JSON, which is worse than what we have.
- **Not a custom binary format.** A custom format means a custom reader.
  The `linkedin-all-in-one-api` scripts (in TypeScript, in Python for
  ad-hoc analysis) need to read these without a special parser.

## Format spec (recap; full version in capture-mode-spec.md)

```jsonl
{"ts":"...","tab":1234,"preset":"linkedin-voyager","request":{...},"response":{...},"duration_ms":234}
{"ts":"...","tab":1234,"preset":"linkedin-voyager","request":{...},"response":{...},"duration_ms":189}
...
```

- One event per line.
- `\n` (LF) line terminator. No `\r\n`.
- UTF-8, no BOM.
- No trailing newline requirement (most writers add one; readers must
  tolerate either).
- No leading `[\n`, no trailing `]\n` — that is what makes it a *stream*
  and not an array.

## Alternatives considered

### A. Keep JSON array as the only output (status quo, no v1.3.0 output change)

- **Pro:** Zero migration risk. Existing scripts keep working.
- **Con:** Doesn't address the append / jq / streaming / diff pain points
  that motivated Capture Mode in the first place.
- **Why rejected:** The whole point of Capture Mode is to make the
  `linkedin-all-in-one-api` reverse-engineering workflow smooth. The JSON
  array output is a known friction point.

### B. Make JSONL the only output, drop JSON array

- **Pro:** Simpler UI (no format toggle), simpler code (no branching).
- **Con:** Breaks any existing script that consumed the v1.2.3 output.
  The Chrome Web Store review process also looks at "did you break user
  workflows?" — a hard break would be flagged.
- **Why rejected:** The cost of keeping the legacy path is one toggle
  in the popup and one branch in the background. That is cheap insurance
  for backwards compatibility.

### C. JSONL with a wrapper header (like `git` fast-import)

- **Pro:** Can carry a session-level `meta` block (preset, startedAt, etc.)
  in a structured way.
- **Con:** Re-introduces the "must parse a header before the data" problem.
  Loses the cat / jq friendliness.
- **Why rejected:** Session-level metadata can live in the filename
  (`are-capture-linkedin-voyager-2026-06-23T12-34-56.jsonl`) and in
  per-event fields (`preset`, `ts`). The wrapper header is a complexity
  tax with no clear benefit.

### D. Per-event file (`captures-live/2026-06-23T12-34-56-001.json`,
`...-002.json`, …)

- **Pro:** Trivially parallel-safe; each event is its own commit unit.
- **Con:** Loses the "one file per session" mental model the user has
  today. Filesystem overhead (1 file per API call = thousands of files
  in an hour). Hard to ship as a single artifact to a teammate.
- **Why rejected:** JSONL gives us the "one file per session" model
  with all the streaming benefits inside.

### E. SQLite / IndexedDB export

- **Pro:** Queryable, schema-validated, easy filtering in the UI later.
- **Con:** A SQLite file is not human-readable, not greppable, not
  committable to `captures-live/` as a reference artifact. The plugin
  gains a dependency. IndexedDB does not survive profile resets the way
  the user expects.
- **Why rejected:** Out of scope for v1.3.0. The Capture Mode spec
  explicitly avoids "replace HAR"; a SQLite export is a bigger
  conversation.

## Consequences

### Positive

- `cat captures-live/*.jsonl | jq -c 'select(.preset == "linkedin-voyager")'`
  is now a one-liner.
- The dev can `tail -F` a live capture (if we ever add streaming write —
  not in v1.3.0 but the door is open).
- The `linkedin-all-in-one-api` `import-capture.ts` script can read
  line-by-line, validate per event, and bail on a single corrupt line
  without losing the rest of the capture.
- Diffing two captures in `git` is now line-level, not whole-file
  reformat.

### Negative / risks

- **Tooling assumption.** A consumer that naively does `JSON.parse(file)`
  on a `.jsonl` file will fail. We mitigate by:
  - Using the `.jsonl` extension (not `.json`) — most tooling
    recognises this.
  - Documenting the format in `README-capture-mode.md`.
  - Keeping the legacy `.json` output available.
- **The `meta` block is gone from the file itself.** Session-level info
  moves to the filename + per-event fields. The dev who wants a
  per-session `meta` block can run `jq -s '{ meta: { total: length }, all: . }'`
  to wrap it back. This is documented in the README.
- **The `endpoints` vs `all` split is gone.** The v1.2.3 `endpoints`
  array (unique method:url pairs) and `all` array (every event) are
  collapsed into a single stream. To recover the unique-endpoint view:
  `jq -s 'group_by(.request.method + " " + (.request.url | split("?")[0])) | ...'`.
  Also documented in the README.

### Neutral

- The `__ARE_REQUEST__` event payload in `injected.js` is unchanged in
  field names. The new format is just a different *serialization* of the
  same data.

## Rollout plan

1. **v1.3.0 ships with JSONL as default, JSON array as legacy toggle.**
2. The Chrome Web Store release notes call out the new format and point
   to `README-capture-mode.md` for migration.
3. The `linkedin-all-in-one-api` `import-capture.ts` script is added in
   a separate task (dev) and reads JSONL. Existing JSON captures in
   `captures/` are left as-is; future captures go to `captures-live/`
   in JSONL.
4. We do NOT auto-migrate v1.2.3 `.json` exports. They keep working via
   the legacy toggle, and the dev can choose to re-capture if they want
   the JSONL form.

## Decision record

Accepted 2026-06-23 by Cristian Tala, on the recommendation of
linkedin-architect. Reasoning: the `linkedin-all-in-one-api` workflow
needs append/streaming/diff-friendly captures; JSONL is the lowest-cost
format that delivers those without breaking existing scripts.
