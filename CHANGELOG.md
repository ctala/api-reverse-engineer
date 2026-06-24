# Changelog

All notable changes to API Reverse Engineer are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.2] — 2026-06-24 — Runtime bug fixes (counter, badge, download) + QA harness

### Fixed

- **Counter stale after START (bug #1).** In v1.4.1, the `REQUESTS`
  counter stayed at 0 (or the initial value) after clicking Iniciar,
  while `ÚNICOS` (the dedup set) correctly incremented. Cause: the
  START handler set `activeBuffer` asynchronously via
  `opfsBuffer.init().then(...)`. Any `CAPTURE` that arrived during the
  init window (before the `.then()` callback ran) was silently dropped
  by the `if (activeBuffer)` guard in the CAPTURE handler, so
  `inMemoryCount` was never updated. Fix: in the START handler, set
  `activeBuffer = memoryBuffer` SYNCHRONOUSLY. CAPTUREs during the init
  window now go to the memory buffer (counted + retrievable). When the
  async OPFS init resolves, the `.then()` callback migrates the
  memory snapshot to the OPFS file in order (no duplicates) and
  switches `activeBuffer` to `opfsBuffer`. The counter is now correct
  from the first CAPTURE, and the OPFS file still has the full set
  of events at download time.
- **Badge shows red dot while recording (bug #2 UX).** In v1.4.1, the
  icon badge alternated between the red `●` (on START) and the counter
  number (on every CAPTURE). The user saw a flickery badge and never
  knew if the SW was actively recording. Fix: the badge is now driven
  purely by the `isRecording` flag, not by the counter. The
  `_setBadge(tabId)` helper shows `●` red while `isRecording === true`
  and clears the badge when stopped. The counter goes in the popup
  only. START, STOP, AUTO_STOP, and SW restore all call
  `_setBadge(tabId)` atomically, so the badge always reflects the
  current state.
- **Download does nothing after STOP (bug #3).** In v1.4.1, the
  DOWNLOAD handler either built a JSONL with stale/empty data
  (because `inMemoryCount` was 0 from the counter bug) or — when
  OPFS was active — produced a base64-encoded text file that the
  popup wrote verbatim to disk (a pre-existing popup-side decode
  bug). The user clicked Descargar and got a useless file. Fixes:
  (1) DOWNLOAD now validates `inMemoryCount > 0` up front and
  returns `{ok: false, error: "No captures to download. Did you
  navigate a page after clicking Iniciar?"}` if there is nothing
  to download. (2) The OPFS path is unchanged but its response
  shape (`{data: <base64>, encoding: "base64", lineCount, ...}`)
  is now matched by the in-memory fallback path. The memory
  fallback also returns base64, so the popup can decode uniformly
  with a single code path. (3) If both OPFS and memory paths
  fail, DOWNLOAD returns `{ok: false, error: "Download failed:
  ..."}` instead of silently producing an empty file. The
  accompanying popup-side decode fix is a follow-up.
- **SW restart left the badge blank (bug #4).** In v1.4.1, after
  the service worker restarted mid-session, `isRecording` was
  restored from `chrome.storage.session` but the badge was not
  re-set, so the user saw no indicator that the SW was still in
  a recording state. Fix: the SW restore callback now calls
  `_setBadge(recordingTabId)` if `isRecording === true`. Combined
  with a defensive null-buffer fallback in the CAPTURE handler
  (if `activeBuffer` is null but `isRecording` is true, fall back
  to the memory buffer), the post-SW-restart state is now
  consistent and visible.

### Added

- **Automated QA harness for the service worker.** New
  `test/_chrome-mock.js` shared mock helper + `test/background.test.mjs`
  with **12 unit tests** that load `src/background.js` into Node
  with a mocked `chrome.*` surface (tabs, runtime, action, storage,
  scripting, downloads) and an in-memory OPFS mock. The harness
  covers all 3 production bugs Cristian reported plus the
  surrounding edge cases (OPFS upgrade migration, OPFS init
  failure, SW restart badge, GET_STATE totals, 0-capture download
  short-circuit, base64 JSONL output). Run: `node test/background.test.mjs`.
- **Total test count is now 71/71 across 4 suites:**
  `capture-config` 34/34, `memory-buffer` 8/8, `opfs-buffer` 17/17,
  `background` 12/12.

### Notes

- Patch bump 1.4.1 → 1.4.2 (bugfixes only, no new permissions, no
  breaking changes to the JSONL output shape).
- The JSONL output is compatible with v1.4.0/v1.4.1 — the importer
  in `linkedin-all-in-one-api` needs no changes.
- The OPFS streaming buffer is still the primary path. The memory
  buffer is the synchronous fallback that the START handler now
  uses during the OPFS init window. Once OPFS init resolves, the
  memory snapshot is migrated to the OPFS file (no duplicates in
  the output) and the active buffer switches to OPFS. The 50 MB
  FIFO cap and the v1.3.2 in-memory fallback are still available
  for environments where OPFS is unavailable (Chrome < 102 or
  strict permissioning).
- **Follow-up (out of scope for v1.4.2):** the popup's DOWNLOAD
  handler should be updated to decode the base64 response and
  pass an `ArrayBuffer` (or `Blob`) to `URL.createObjectURL`, not
  the base64 string. With v1.4.2's uniform base64 response, the
  popup can use a single decode path. This will be a v1.4.3
  patch.

### Privacy guarantees

- All redaction defaults (cookies, csrf, body fields) are unchanged.
- The OPFS file is local-only. The plugin still has zero telemetry,
  zero remote-config, zero network calls.
- The new test harness lives in `test/`. No production code in
  `src/` was changed to expose internals for testing. The mock
  surfaces are entirely in `test/_chrome-mock.js`.

## [1.4.0] — 2026-06-24 — OPFS streaming buffer (ADR-0002)

### Changed

- **Capture buffer rewritten: in-memory `captured[]` → OPFS streaming
  append.** The service worker no longer accumulates every captured
  request in a JS array. Each event is now streamed to
  `captures.jsonl` in the extension's Origin Private File System via
  `navigator.storage.getDirectory()` + `createSyncAccessHandle()`. The
  SW only keeps lightweight metadata in memory (event count, dedup set,
  `isRecording` flag). See `docs/spec/adr-0002-chrome-mv3-capture-buffer-architecture.md`
  for the full rationale and the alternatives that were rejected.
- **Quota risk on long sessions: eliminated.** v1.3.2 still bounded the
  in-memory array to 50 MB (FIFO eviction of the oldest events). v1.4.0
  pushes the buffer to disk, so sessions of 100 MB – 1 GB are now
  supported without OOM. The `MAX_TOTAL_BYTES = 50 MB` cap and FIFO
  eviction logic from v1.3.2 are kept as a *fallback* path (used when
  OPFS is unavailable — see below).
- **Service worker lifecycle robustness.** The OPFS file persists in the
  extension sandbox across SW restarts and browser close. v1.3.2 lost
  the entire buffer on every SW wake-up; v1.4.0 preserves the file on
  disk so a future `restoreFromExisting()` can re-open it. (See the
  "Fresh-start policy" note below for the v1.4.0 trade-off.)

### Added

- **`unlimitedStorage` permission in `manifest.json`.** OPFS quota
  scales with this permission; without it, OPFS is capped at ~10 % of
  disk space, which is still enough for our use case but the
  permission is the documented MV3 pattern. The permission is the
  same one the Chrome Web Store review board expects for plugins that
  store large amounts of local data; it is declared in our
  `PRIVACY-POLICY.md` (ADR-0001).
- **`src/opfs-buffer.js` — new UMD module.** Encapsulates the OPFS
  state machine (`init`, `append`, `getFile`, `clear`, `close`,
  `restoreFromExisting`, `inFallbackMode`). Loaded the same way as
  `src/capture-config.js`: window-attached in the SW, CJS-exported
  for node tests. The `background.js` SW is now a thin dispatcher
  over the buffer.
- **`src/memory-buffer.js` — new UMD module.** Encapsulates the
  v1.3.2 in-memory array as the fallback when OPFS is unavailable.
  Mirrors the `OpfsBuffer` API so the SW can use either buffer with
  the same `.append()` / `.getCount()` / `.clear()` shape. The 50 MB
  FIFO cap moved here from `background.js`. Result: `background.js`
  no longer references the legacy `captured[]` array at all
  (verified by `grep captured.push src/background.js` → 0 matches).
- **17 new unit tests in `test/opfs-buffer.test.mjs`** covering:
  navigator mock, single + 100-event writes, JSONL round-trip, blob
  size = sum of lines, fallback paths (no `getDirectory`, null
  navigator, throwing `getDirectory`), CLEAR, SW-restart file
  persistence + restore, restore on empty directory, multi-tab
  isolation, idempotent close, append-before-init safety, fresh-start
  truncation, 5 MB payload, re-init after clear.
- **8 new unit tests in `test/memory-buffer.test.mjs`** covering:
  fallback-mode semantics, `append` + `getCount`, `snapshot()` copy
  semantics, `clear()`, FIFO eviction under the byte cap, `isOpen()`,
  `getBytesWritten()`.
- **`restoreFromExisting()` API** in `OpfsBuffer`. Used by the SW on
  wake-up to detect a leftover `captures.jsonl` from a prior session
  and offer the user a resume option (F4 feature — not auto-resumed
  in v1.4.0, see "Fresh-start policy" below).
- **Fallback warning in the badge.** When OPFS init fails (Chrome <
  102 or permission denied), the badge colour shifts from green to
  amber-yellow (`#eab308`) so the user knows the capture is in
  fallback mode and is bounded by the v1.3.2 50 MB cap.

### Fixed

- The v1.3.2 service-worker OOM risk on multi-thousand-event sessions
  is now structurally eliminated (the in-memory array is gone on the
  primary path), not just capped. The cap remains as a defensive
  fallback only.

### Fallback path (when OPFS is unavailable)

When `navigator.storage.getDirectory()` throws (Chrome < 102, strict
permissioning, browser bug), the plugin transparently degrades to the
v1.3.2 logic:

1. The buffer is held in a JS array (`captured[]`).
2. A 50 MB FIFO cap is enforced (oldest events are dropped first).
3. The badge colour shifts to amber-yellow as a visible warning.
4. The popup's `GET_STATE` response includes `fallbackMode: true` so
   the UI can render a "Running in fallback mode" hint (F4).

This path is covered by three of the new tests (lines 159-194 of
`opfs-buffer.test.mjs`). In a normal Chrome 102+ install the fallback
is never reached; it exists for edge cases only.

### Fresh-start policy (documented trade-off)

`OpfsBuffer.init()` **truncates** `captures.jsonl` on every START. This
is intentional (ADR-0002 §"Decision" + §"Consequences"):

- Predictability: the user clicks START, gets a clean file. No "why are
  there events from yesterday in this file?" debugging session.
- SW-restart safety: if a previous SW write left the file in a partial
  state, the next START cleanly resets it.
- Trade-off: a user that wants append-mode (resume a session across
  browser restarts) needs the F4 `restoreFromExisting()` workflow,
  which is **not wired into the popup in v1.4.0**. The API exists in
  the module; UI integration is a follow-up.

### Privacy posture (unchanged from v1.3.x)

- Redaction still happens at the injection site (`injected.js` MAIN
  world). No raw cookies / csrf tokens ever cross `postMessage` or
  reach the SW.
- The OPFS file contains the same redacted content as the v1.3.x
  in-memory array. No new data is captured.
- The OPFS file is sandboxed to the extension and never uploaded. The
  user is the only entity that can read it (via Download, which copies
  to a local file).
- `unlimitedStorage` is a *local* quota extension, not a network
  permission. The plugin still makes zero network calls.
- The CHROME-STORE-FINAL-REPORT privacy summary is updated to mention
  the OPFS path. See "Privacy guarantees" below.

### Migration from v1.3.2

- **No action required for end users.** The plugin keeps working the
  same way: click Iniciar → use the site → click Detener → click
  Descargar. The output file (`are-capture-*.jsonl`) has the same
  format as v1.3.x — the linkedin-all-in-one-api importer does not
  need any changes.
- **For users on Chrome < 102:** the plugin still works in fallback
  mode. Sessions are still bounded to ~50 MB; large captures may drop
  the oldest events (FIFO). Same trade-off as v1.3.2.
- **For developers:** the new `src/opfs-buffer.js` module is the
  public surface. If you need to consume the buffer from another SW
  handler, use the `OpfsBuffer` factory. The legacy in-memory array
  is still wired in background.js for the fallback path.

### Privacy guarantees

- All redaction defaults (cookies, csrf, body fields) are unchanged.
- The OPFS file is local-only. The plugin still has zero telemetry,
  zero remote-config, zero network calls.
- The `unlimitedStorage` permission is the documented MV3 pattern for
  local-only high-volume storage. The privacy policy declares the
  model: local-first, no upload, user-controlled.

## [1.4.1] — 2026-06-24 — Capture Mode stability hotfix

### Fixed

- **"Receiving end does not exist" on START_RECORDING.** When the user
  clicked Iniciar, the SW injected the MAIN-world interceptors via
  `chrome.scripting.executeScript` and then immediately sent
  `START_RECORDING` via `chrome.tabs.sendMessage`. If the content
  script's message listener wasn't fully registered yet (race
  condition on tab load, after reload, or on slow pages), the send
  landed in a no-receiver state and capture never started. The widget
  showed the recording state (badge + REQUESTS counter) but no events
  were intercepted. Fix: poll the content script with PING (timeout
  2s) before sending START_RECORDING. The content script responds
  with `{ready: true, version: '1.4.0'}` and the SW proceeds. If the
  poll times out, log a warning and let the user retry.

### Notes

- Patch bump 1.4.0 → 1.4.1.
- No new automated tests (the race is hard to test deterministically
  without a fake content script harness). Manual soak on Cristian's
  machine will confirm.

## [1.3.0] — 2026-06-23 — Capture Mode

### Added

- **Profile preset dropdown** in the popup: `[Generic]`, `[LinkedIn Voyager]`,
  `[GraphQL]`, `[JSON API]`. Picking a preset pre-fills the URL filter and
  the redaction patterns. The user can still edit either before starting.
- **Multi-line URL filter with AND/OR mode toggle**. One pattern per line.
  Lines wrapped in `/.../flags` are regex, lines containing `*` or `?`
  are globs, everything else is a literal substring. Default mode is `OR`
  (preserves v1.2.3 single-string filter behaviour exactly).
- **Secret redaction, ON by default**. Cookies (`li_at`, `li_a`,
  `JSESSIONID`, `bscookie`), CSRF tokens, and common auth fields are
  replaced with `[REDACTED:<key>]` placeholders. Applied at the injection
  site (`injected.js` / MAIN world), so raw secrets never cross the
  `postMessage` bridge into the content script or the service worker.
  Toggle in the popup lets the dev opt out (with a red warning).
- **JSON-Lines (`.jsonl`) output** as the new default format. One event per
  line, append-friendly, `jq -c` / `cat` / `tail -F` / git-diff friendly.
  Designed to drop directly into
  `linkedin-all-in-one-api/captures-live/` for offline replay and
  reference-document construction.
- **Output format toggle**: `JSON-Lines (recommended)` vs `JSON array
  (legacy v1.2.x)`. Legacy output remains available for any existing
  scripts that consumed the v1.2.3 `{meta, endpoints, all}` shape.
- **Body truncation at 5 MB** per response. If exceeded, the body is
  replaced with `{_truncated, _originalBytes, _keptBytes, _preview}`.
- **Binary skip**: `image/*`, `video/*`, `audio/*`, `application/octet-stream`,
  `application/pdf`, `application/zip`, `font/*` are recorded as
  `{_skipped: "binary", _contentType, _contentLength}` (request still kept).
- **Max events per session: 10,000**. Warning at 9,000 (badge turns amber);
  auto-stop at 10,000.

### Changed

- Default output format is now JSON-Lines (was JSON array). Legacy output
  still available behind a toggle — no forced migration.
- `captureConfig` (preset + filter + redact patterns) is persisted in
  `chrome.storage.session` alongside `captured` / `uniqueKeys`, so a
  service worker wake-up mid-recording keeps the user's settings.
- Popup state (last filter, preset, redact toggle, output format) is
  persisted in `chrome.storage.local` so reopening the popup restores the
  last selection.

### Not changed (intentional, for backwards compatibility)

- The `__ARE_REQUEST__` event payload in `injected.js` keeps the same
  field names and types as v1.2.3 (`type`, `method`, `url`, `requestHeaders`,
  `requestBody`, `status`, `responseHeaders`, `responseBody`, `duration`,
  `timestamp`). v1.3.0 adds a `preset` field; the rest are untouched.
- The v1.2.3 single-string `filter` is still accepted. If the popup sees
  a `filter` but no multi-line `patterns`, it converts to a one-element
  `patterns` array in `OR` mode (preserves current behaviour exactly).
- **No new permissions** requested in `manifest.json`. The plugin still
  uses `storage`, `activeTab`, `scripting`, `tabs`, and `<all_urls>` — all
  the same as v1.2.3.

### Privacy guarantees

- Redaction is applied at the injection site (`injected.js`), not in the
  service worker. The raw secret never crosses `postMessage` or
  `chrome.runtime.sendMessage`.
- The redacted value placeholder `"[REDACTED:<original-key>]"` preserves
  the key so the dev can still grep for `Set-Cookie` and find
  `[REDACTED:Set-Cookie]`. The value is gone.
- No telemetry. The plugin does not phone home. No analytics, no
  remote-config, no usage reporting. (True in v1.2.x; stays true in v1.3.0.)

### Migration from v1.2.3

- Existing captures (`*.json` from v1.2.3) continue to be valid input for
  any tool that consumed them before. We are additive, not breaking.
- New captures go to `*.jsonl` by default. To get the legacy format back,
  pick the `JSON array (legacy v1.2.x)` toggle in the popup before
  downloading.
- The popup UI grew from one input to four (preset, filter, redact,
  format). Everything is pre-filled with sensible defaults so the
  one-click workflow is unchanged: open popup → Start → use site → Stop
  → Download.

## [1.3.2] — 2026-06-24 — Capture Mode stability

### Fixed

- **`Session storage quota bytes exceeded` on long LinkedIn Voyager
  sessions.** `chrome.storage.session` has a 10MB quota total. The
  service worker previously persisted the full `captured[]` array on
  every CAPTURE message, which threw this error after ~10-50 large
  LinkedIn profile/feed responses (each 500KB-1MB). Fix: persist ONLY
  metadata (counters + isRecording + captureConfig). The actual
  `captured[]` buffer stays in memory only. If the SW crashes mid-session
  you lose the buffer, but in normal flow (Stop + Download) no data is
  lost.
- **Service worker OOM on multi-thousand-event sessions.** The captured
  array was unbounded in memory. At MAX_EVENTS=10000 with 5MB-per-event
  cap, worst case was 50GB. Added `MAX_TOTAL_BYTES = 50MB` cap with
  FIFO eviction of the oldest events when exceeded. The user sees a
  slightly truncated session but the SW stays alive.

### Notes

- Patch bump 1.3.1 → 1.3.2.
- Side effect: after a SW restart (browser close, manual reload in
  `chrome://extensions/`), the popup may briefly show '0 REQUESTS' even
  though `isRecording=true` is persisted. The next CAPTURE event will
  reset the counter. This is acceptable for a v1.3.2 hotfix; a clean
  re-record on browser close is a separate F4 task.

## [1.3.1] — 2026-06-24 — Capture Mode bugfix

### Fixed

- **LinkedIn Voyager preset captured nothing.** The preset's URL filter
  regex was stored as a raw `^...` string in `PRESET_DEFAULTS`. When the
  user selected the preset, `applyPreset` wrote it into the URL filter
  textarea, and `buildCaptureConfig` parsed each line. The parser only
  treats `/regex/flags` as regex (slash-wrapped form), so the unwrapped
  regex fell through to the literal-substring case — producing a filter
  that matched no real LinkedIn URL. Fix: wrap the preset regex in
  `/.../` so the round-trip through the textarea preserves the regex
  type. Pattern now reads
  `/^https:\/\/www\.linkedin\.com\/(voyager\/api\/|li\/track)/`.
- **Detener button did not appear after starting capture, REQUESTS
  counter stuck at 0.** `isRecording` is a module-level variable that
  starts at `false` on every popup open. The polling `setInterval` only
  fired `refreshPreview` when `isRecording` was `true`; if the initial
  `GET_STATE` response was delayed (service worker cold start), the UI
  stayed on `Iniciar` indefinitely even though the background was
  actively recording. Fix: when `!isRecording`, still poll `GET_STATE`
  every 1.5s so the popup recovers from the initial race within one
  tick of opening.

### Notes

- Version bumped 1.3.0 → 1.3.1 (patch: bugfix only, no API surface change).
- All Capture Mode v1.3.0 features unchanged: presets, multi-line filter,
  redaction at injection site, JSONL output.
- Privacy posture unchanged: redaction default ON, no raw secrets leave
  the user's machine.

## [1.2.3] — earlier release

Initial published version on the Chrome Web Store. Single-string URL
filter, JSON array output, no redaction.
