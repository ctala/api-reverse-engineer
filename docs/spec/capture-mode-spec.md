# Capture Mode — API Reverse Engineer v1.3.0

> **Status:** Draft (v1.3.0 design)
> **Date:** 2026-06-23
> **Owner:** linkedin-architect (architecture) + dev (implementation, separate task)
> **Branch:** `feat/capture-mode-v1.3.0`
> **Companion docs:** [`linkedin-voyager-preset.md`](./linkedin-voyager-preset.md), [`adr-0001-capture-mode.md`](./adr-0001-capture-mode.md), [`README-capture-mode.md`](./README-capture-mode.md)

## Goals

1. **LinkedIn Voyager capture end-to-end** — A user with a logged-in LinkedIn session
   can record the `voyager/api/...` and `li/track` traffic in three clicks (open
   plugin → select `LinkedIn Voyager` preset → Start), navigate the site, Stop,
   and download a `.jsonl` file that drops directly into
   `linkedin-all-in-one-api/captures-live/` for offline replay and reference
   document construction.
2. **Generic API capture** — The same feature works against any JSON API (REST
   or GraphQL) by selecting the `[Generic]` preset and entering a URL filter.
3. **Developer ergonomics** — Profile presets (LinkedIn Voyager, GraphQL, JSON
   API) one-click pre-fill the filter and redaction patterns. Multi-filter with
   AND/OR mode. Truncation is sensible, not silent.
4. **Secret safety** — Cookies, CSRF tokens, and auth headers are redacted
   **before** any serialization crosses a process boundary. The user can review
   a redacted preview in the popup before downloading.

## Non-goals

- **NOT a HAR file replacement** — we do not aim to round-trip with Chrome DevTools
  HAR or be a general-purpose network archive. We are opinionated for the
  capture-replay-of-private-API workflow.
- **NO WebSocket capture** — `WebSocket` and `EventSource` are out of scope for
  v1.3.0. The interceptors stay on `fetch` and `XMLHttpRequest`.
- **NO Service Worker request capture** — internal SW traffic is not observable
  from a content script; out of scope.
- **NOT a mitmproxy / Postman** — we do not replay requests, do not run an
  intercepting proxy, and do not manage environment variables. Replay lives in
  `linkedin-all-in-one-api` and is the consumer of our `.jsonl` files.
- **NO live UI editing of redacted values** — redaction is irreversible by
  design. The user is told *what* will be redacted up front; if they want raw
  values, they turn redaction off (and the UI shows a warning).

## Background and motivation

The current v1.2.3 plugin dumps a single `api-capture-<site>-<timestamp>.json`
array. That works for one-shot manual review, but the
`linkedin-all-in-one-api` project needs:

- **Append-friendly, streaming-friendly** capture files that the dev can `cat`,
  `tail -F`, and `jq -c '. | select(.url | contains("/voyager/api/me"))'` over
  during a multi-step Voyager walk.
- **Capture presets** so the LinkedIn reverse-engineering walkthrough is a
  one-click operation, not "type the right glob in the filter box".
- **Secret redaction** by default, because captures get committed (anonymized)
  into `captures-live/` for reference, and the dev should never have to scrub
  `li_at` out of a file by hand.

## UI / UX changes (popup)

The popup grows from one filter input to a small form. Visual layout (top to
bottom):

```
┌──────────────────────────────────────────┐
│ 🔬 API Reverse Engineer                  │  ← header (unchanged)
│ Captura requests en cualquier sitio      │
├──────────────────────────────────────────┤
│  [ 0 ]            [ 0 ]                  │  ← stats (unchanged)
│  Requests         Únicos                 │
├──────────────────────────────────────────┤
│ Preset: [ LinkedIn Voyager     ▾ ]       │  ← NEW: profile preset dropdown
│ ┌──────────────────────────────────────┐ │
│ │  [Generic]  — no filter, redact on   │ │
│ │  [LinkedIn Voyager] — voyager/*+track│ │
│ │  [GraphQL]    — /graphql endpoints   │ │
│ │  [JSON API]   — .json content-type   │ │
│ └──────────────────────────────────────┘ │
│ URL filter:                              │  ← CHANGED: multi-line + AND/OR
│  [ /voyager/api/                       ] │
│  [ /li/track                            ] │
│  Mode: ( ) AND   (•) OR                 │
│ ☑ Redact secrets (recommended)          │  ← NEW: redact toggle
│ Format:  (•) JSON-Lines  ( ) JSON array  │  ← NEW: output format toggle
├──────────────────────────────────────────┤
│ [▶ Iniciar] [⬇ Descargar] [🗑]          │  ← action row (unchanged)
├──────────────────────────────────────────┤
│ ● Grabando...                            │  ← indicator (unchanged)
├──────────────────────────────────────────┤
│ Endpoints capturados                     │  ← preview (unchanged shape,
│   POST  /voyager/api/messaging/convers…  │     but redacted headers in detail)
└──────────────────────────────────────────┘
```

### 1. Profile preset dropdown

Selecting a preset **pre-fills** (not locks) the URL filter and the redact
patterns. The user can edit either afterward.

| Preset id | Label | URL filter (default) | Redact patterns (default) |
|---|---|---|---|
| `generic` | `[Generic]` | *(empty — capture all)* | cookies, csrf-token, password, client_secret, access_token, refresh_token, `*_token` |
| `linkedin-voyager` | `[LinkedIn Voyager]` | `/voyager/api/`, `/li/track` (OR) | cookies (`li_at`, `li_a`, `JSESSIONID`, `bscookie`), `csrf-token`, `x-li-pem-metadata`, `x-restli-protocol-version`, `cookie`, `set-cookie`, body: `password`, `client_secret`, `access_token`, `refresh_token`, `*_token` |
| `graphql` | `[GraphQL]` | `/graphql` | (same as Generic + `x-graphql-operation-name` header value preserved; redact `authorization`) |
| `json-api` | `[JSON API]` | `application/json` (matched on response content-type) | (same as Generic) |

See [`linkedin-voyager-preset.md`](./linkedin-voyager-preset.md) for the full
LinkedIn Voyager config.

### 2. URL filter (multi-line + AND/OR)

- Each line is one pattern.
- A pattern can be:
  - A literal substring (e.g. `api2.skool.com`) — **backward compatible** with v1.2.3.
  - A glob (`*api*`, `/api/v[0-9]/*`).
  - A regex wrapped in slashes (`/^https:\/\/.*\/voyager\/api\/.*/i`).
- **Mode toggle**: `AND` means an event must match *all* patterns to be
  captured; `OR` (default, matches v1.2.3 single-filter behaviour) means
  *any* pattern matches.
- Empty lines are ignored.
- Invalid regex shows an inline warning, does not block recording (the line
  is treated as a literal).

### 3. Redact secrets toggle

- **ON by default.** The user must opt out.
- When ON, the popup shows a "Redaction: 12 keys (cookies + 4 headers + 6 body
  fields)" subtitle under the toggle, with an expand chevron to list them.
- When OFF, the popup shows a red warning: "Captures may include `li_at`,
  `JSESSIONID`, and other auth tokens. Do not commit these."

### 4. Output format toggle

- Default = **JSON-Lines (recommended)**.
- Legacy = JSON array (the v1.2.3 shape, for back-compat with existing
  scripts that consume the old format).

## Data flow changes

The four-message pipeline stays the same shape; we add new optional fields to
each message and a new helper in `injected.js`.

```
popup.js  ──[START]──▶  background.js  ──[START_RECORDING{captureConfig}]──▶  content.js
                                                                                │
                                                                                ▼
                                                                       injected.js (MAIN world)
                                                                                │
                              ┌─── shouldCapture(url, patterns, mode) ─────────┘
                              │       (skip if false)
                              ▼
              redactRequest(entry, redactPatterns)        ← NEW
              redactResponse(entry, redactPatterns)       ← NEW
                              │
                              ▼
              window.dispatchEvent(__ARE_REQUEST__{...redacted})
                              │
                              ▼
content.js  ──[CAPTURE{entry, captureConfigId}]──▶  background.js
                              │
                              ▼
                  captured.push(entry)  (keyed by method:url)
                              │
                              ▼
popup  ──[DOWNLOAD]──▶  background.js
                              │
                              ▼
              build JSONL (one entry per line) OR legacy JSON array
                              │
                              ▼
              chrome.downloads.download(filename = are-capture-{preset}-{ISO}.jsonl)
```

### `injected.js` — new helpers

Three new pure helpers (no DOM, no chrome.*) added to the IIFE:

```text
shouldCapture(url, patterns, mode)  → boolean
  patterns: Array<{ type: 'literal' | 'glob' | 'regex', value: string }>
  mode:     'AND' | 'OR'
  → if patterns.length === 0: return true
  → for each pattern, compile once (WeakMap cache), test url
  → return mode === 'AND' ? every : some

redactHeaders(headers, redactHeaderNames)  → headers
  - case-insensitive substring match against header NAME (not value)
  - replaces VALUE with `"[REDACTED:<original-name>]"`
  - never logs the original value

redactBody(body, redactBodyKeys)  → body
  - case-insensitive substring match against top-level key, + 1 nested level
  - replaces VALUE with `"[REDACTED:<original-key>]"`
  - if body is a string (raw text / form-encoded), redact substring `key=value`
    and `key: value` segments
  - never logs the original value
```

The interceptors call `shouldCapture` **first** (skip if false), then
`redactHeaders` + `redactBody` **before** dispatching `__ARE_REQUEST__`. This
is important: the redacted event is the only one that crosses the postMessage
boundary into the content script and then into the service worker.

### `content.js` — forward `captureConfig`

Add a new message handler `SET_CAPTURE_CONFIG` that stores:

```text
captureConfig = {
  preset: 'linkedin-voyager',
  patterns: [{ type: 'literal'|'glob'|'regex', value: '...' }, ...],
  filterMode: 'AND'|'OR',
  redact: { enabled: true, headers: [...], body: [...] }
}
```

The `__ARE_REQUEST__` listener continues to forward entries to the background,
but **with `captureConfig.redact` applied at injection time**, so the content
script never sees raw secrets either. (This matters because the content script
runs in ISOLATED world; today the v1.2.3 `__ARE_REQUEST__` carries raw headers
across the postMessage bridge.)

`START_RECORDING` and `STOP_RECORDING` keep their current shape; the popup
sends `SET_CAPTURE_CONFIG` *before* `START_RECORDING` so the config is in
place when the first request fires.

### `background.js` — JSONL output

New message type `DOWNLOAD_JSONL` (or extend the existing `DOWNLOAD` with a
`format` field). The service worker:

1. Filters `captured` through the current `captureConfig` again (defense in
   depth — injected.js already filtered, but the SW is the source of truth
   for "what gets exported").
2. Applies truncation (see policy below).
3. Builds either:
   - **JSONL**: one entry per line, `\n`-terminated, no trailing comma, UTF-8.
   - **JSON array (legacy)**: the existing `{meta, endpoints, all}` shape.
4. Returns a base64 string to the popup, which uses `chrome.downloads.download`
   to write to disk.

The service worker also persists `captureConfig` to `chrome.storage.session`
so a SW wake-up mid-recording keeps the user's filter and redact settings.

### `popup.js` — wire up the new inputs

- Save `captureConfig` to `chrome.storage.local` on every change (so reopening
  the popup restores the last selection).
- On Start, send `SET_CAPTURE_CONFIG` then `START` to the background.
- On Download, send `DOWNLOAD` (or `DOWNLOAD_JSONL` if the format toggle is
  JSONL) and use the returned string to drive `chrome.downloads.download`.

## JSON-Lines schema

One capture = one line. No wrapping array. No pretty-printing. UTF-8.

```jsonl
{"ts":"2026-06-23T12:34:56.789Z","tab":1234,"preset":"linkedin-voyager","request":{"method":"GET","url":"https://www.linkedin.com/voyager/api/graphql?...","headers":{"csrf-token":"[REDACTED:csrf-token]","cookie":"[REDACTED:cookie]","accept":"application/vnd.linkedin.normalized+json+2.1"},"body":null},"response":{"status":200,"headers":{"content-type":"application/vnd.linkedin.normalized+json+2.1"},"body":{"data":{...},"included":[...]},"bodyBytes":12345},"duration_ms":234}
```

### Field reference

| Field | Type | Notes |
|---|---|---|
| `ts` | string (ISO 8601) | Capture timestamp, ms precision. |
| `tab` | int | `chrome.tabs` id where the request originated. |
| `preset` | string | One of `generic` / `linkedin-voyager` / `graphql` / `json-api`. |
| `request.method` | string | HTTP verb (`GET`, `POST`, …). |
| `request.url` | string | Full URL including query string. |
| `request.headers` | object<string,string> | Lowercased keys, redacted values. |
| `request.body` | object \| string \| null | Parsed JSON if Content-Type was JSON, else raw string, else `null`. |
| `response.status` | int | HTTP status. |
| `response.headers` | object<string,string> | Lowercased keys, redacted values. |
| `response.body` | object \| string \| null | Parsed JSON if possible, else raw text. Truncated per policy. |
| `response.bodyBytes` | int | Size of the **untruncated** body in bytes (for forensics). |
| `duration_ms` | int | Wall time from request open to response end. |

### Truncation policy

- **Hard cap: 5 MB per response body** (`5 * 1024 * 1024`).
- If exceeded, replace the body with:

  ```json
  {"_truncated":true,"_originalBytes":12345678,"_keptBytes":5242880,"_preview":"<first 5MB UTF-8>"}
  ```

  (`_preview` is the truncated string; `_keptBytes` is its byte length.)
- **Binaries are NOT captured.** If `content-type` matches
  `^image/`, `^video/`, `^audio/`, `application/octet-stream`,
  `application/pdf`, the response is recorded as:

  ```json
  {"_skipped":"binary","_contentType":"image/png","_contentLength":482913}
  ```

  The headers and `bodyBytes` are still recorded.
- **Max events per session: 10,000.** When `captured.length` hits 9,000, the
  popup shows a warning ("1k events remaining"). At 10,000, recording
  auto-stops and the popup prompts the user to download what they have.

## Privacy guarantees

- **Redaction is applied at the injection site** (`injected.js`), not in the
  service worker. The raw secret never crosses `postMessage` or
  `chrome.runtime.sendMessage`.
- **Redact match is case-insensitive substring** against:
  - header **name** (the value is replaced)
  - body **key** (top level + 1 nested level deep)
  - body **substring** of `key=value` and `key: value` (for raw-text bodies)
- **Redacted value placeholder**: `"[REDACTED:<original-key>]"` — the
  original key is preserved in the placeholder so the dev can grep for it,
  but the value is gone.
- **The plugin never logs a redacted value.** `console.log` of `entry`
  shows `[REDACTED]` in the same position. The popup preview shows
  `[REDACTED:cookie]` etc.
- **Redaction is irreversible by design.** If the user wants raw captures,
  they turn redaction off (and the popup shows a red warning).
- **No telemetry.** The plugin does not phone home. No analytics, no
  remote-config, no usage reporting. (This was true in v1.2.x and stays
  true in v1.3.0; documented for the Chrome Web Store privacy review.)

## Backwards compatibility

- The **v1.2.3 single-string `filter` field** is still accepted. If the popup
  sees a `filter` but no multi-line `patterns`, it converts the single string
  to a one-element `patterns` array in `OR` mode (preserves current
  behaviour exactly).
- The **JSON array output** (the v1.2.3 `{meta, endpoints, all}` shape) is
  still available behind the "JSON array (legacy)" toggle. Default for new
  captures is JSON-Lines.
- The **`__ARE_REQUEST__` event shape** in `injected.js` gains the `preset`
  field and redacted values, but every other field (`type`, `method`, `url`,
  `requestHeaders`, `requestBody`, `status`, `responseHeaders`, `responseBody`,
  `duration`, `timestamp`) stays exactly the same name and type. A
  downstream consumer of the v1.2.3 schema reading v1.3.0 output will still
  find the fields it expects.
- **Old `.json` exports** continue to be valid input for any tool that
  consumed them before. We are additive, not breaking.

## Edge cases

- **Redirects** — capture only the final response. LinkedIn Voyager may 302
  through `linkedin.com/li/track` before landing on `voyager/api/...`; we
  keep the `li/track` redirect *only* if the URL filter accepts it, and we
  attribute the `*` URN params / `csrf-token` to the final destination.
- **Preflight OPTIONS** — omit. CORS preflights are noise; the actual
  request that follows is what we want.
- **304 Not Modified** — include the headers (they carry the validator), but
  the `body` is `null` (the browser did not send a body).
- **Auth retry** — capture both attempts. The first returns 401, the second
  returns 200; both are useful for reverse-engineering the auth flow.
- **Service worker restart mid-capture** — `chrome.storage.session` already
  persists `captured` and `uniqueKeys` (v1.2.0 fix). v1.3.0 also persists
  `captureConfig` and `preset` so the SW wake-up knows which filter and
  redact settings to apply.
- **Tab navigation during recording** — keep recording. LinkedIn is an SPA
  and "navigation" is a soft route change. We do not reset `captured` on
  route change.
- **Filter edit mid-recording** — re-applies on the next event. The user can
  tighten or loosen the filter without stopping; the popup shows a small
  "filter changed" indicator.
- **Disk full / download blocked** — the popup surfaces the `chrome.downloads`
  error verbatim. Captured data is still in `chrome.storage.session` so the
  user can retry from a different path.

## What the dev must build (handoff summary)

This is a spec, not code. The dev receives:

1. **UI** — three new inputs in `popup.html` + their state in `popup.js`.
2. **`injected.js` helpers** — `shouldCapture`, `redactHeaders`, `redactBody`,
   plus the wiring inside the two interceptors.
3. **`content.js`** — `SET_CAPTURE_CONFIG` message, persist `captureConfig` in
   the content-script context, forward to `injected.js` via the existing
   postMessage bridge (extending the message envelope).
4. **`background.js`** — JSONL serialization, `chrome.downloads.download`,
   truncation, `captureConfig` persistence in `chrome.storage.session`.
5. **Tests** — Vitest unit tests for `shouldCapture` (literal / glob / regex,
   AND / OR, empty patterns, invalid regex), `redactHeaders` (case-insensitive
   substring, including the `Set-Cookie` edge case), `redactBody` (top-level
   + 1-level nested, raw-text bodies, key=value form-encoded).
6. **Manifest bump** — `manifest.json` `version` field: `1.2.3` → `1.3.0`.
7. **CHANGELOG.md entry** — see [README-capture-mode.md](./README-capture-mode.md).

## Open questions (none blocking)

None. The remaining unknowns (e.g. "do we want to add a redaction *level* UI
slider?") are deferred to v1.4 and noted in the changelog as "not in this
release".
