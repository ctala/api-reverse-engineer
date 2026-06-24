# Changelog

All notable changes to API Reverse Engineer are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
