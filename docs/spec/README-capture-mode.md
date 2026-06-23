# API Reverse Engineer v1.3.0 — Capture Mode

> Plugin for Chrome / Chromium / Edge / Brave. Captures `fetch` and
> `XMLHttpRequest` traffic while you use a site normally.
>
> v1.3.0 adds **Capture Mode**: profile presets, secret redaction, and
> JSON-Lines export. Designed for the
> [`linkedin-all-in-one-api`](https://github.com/ctala/linkedin-all-in-one-api)
> reverse-engineering workflow, but works on any JSON API.

---

## What's new in v1.3.0

- **Profile presets** — pick `[LinkedIn Voyager]`, `[GraphQL]`, `[JSON API]`,
  or `[Generic]` from a dropdown. The plugin pre-fills the URL filter and
  the secret redaction patterns.
- **Multi-line URL filter with AND/OR mode** — keep using the v1.2.3-style
  single filter (now in `OR` mode), or split into multiple patterns and
  toggle AND/OR.
- **Secret redaction, ON by default** — cookies (`li_at`, `li_a`,
  `JSESSIONID`, `bscookie`), CSRF tokens, and common auth fields are
  redacted **before** anything crosses a process boundary. You see
  `[REDACTED:cookie]` in the popup preview and in the downloaded file.
- **JSON-Lines (`.jsonl`) output** — one event per line, append-friendly,
  `jq -c`-friendly, git-diff-friendly. The legacy JSON array output is
  still available behind a toggle.
- **Bodies truncated to 5 MB**; binaries (images, video, audio, PDFs,
  fonts) are skipped (only `content-type` and size are recorded).

The full design is in [`docs/spec/capture-mode-spec.md`](./docs/spec/capture-mode-spec.md).
The reasoning for JSON-Lines is in
[`docs/spec/adr-0001-capture-mode.md`](./docs/spec/adr-0001-capture-mode.md).

---

## Quickstart — "Capture LinkedIn Voyager"

This is the workflow the `linkedin-all-in-one-api` project uses to build
its reference documents.

### 1. Open LinkedIn, logged in

In a regular Chrome tab, navigate to <https://www.linkedin.com> and make
sure you are logged in. **Do not** log in inside the recording tab — the
plugin is a *passive* interceptor; it does not see credentials you type
into the login form, but starting from a logged-in state keeps the
capture focused on Voyager calls.

### 2. Click the plugin icon → pick the preset

Click the **🔬 API Reverse Engineer** icon in the Chrome toolbar. The
popup opens. In the **Preset** dropdown, pick **`[LinkedIn Voyager]`**.

The plugin pre-fills:
- URL filter: `^https://www\.linkedin\.com/(voyager/api/|li/track)` (regex)
- Redact patterns: the LinkedIn-specific cookie + header + body list

You can edit either before starting — the preset is a starting point, not
a lock.

### 3. Click ▶ Iniciar (Start)

The badge on the plugin icon turns red and shows `●`. The popup shows
"Grabando en `www.linkedin.com`".

### 4. Use LinkedIn normally

Open your profile, search for someone, view a post, leave a comment, send
a connection request, send a message. The plugin records every
`voyager/api/...` and `li/track` call in the background. The popup live
preview shows the most recent unique endpoints.

### 5. Click ⏹ Detener (Stop)

The badge clears. The ⬇ Descargar JSON button enables.

### 6. Click ⬇ Descargar (Download)

A file named
`are-capture-linkedin-voyager-2026-06-23T12-34-56.jsonl` downloads to your
default Chrome download folder. The `2026-06-23T12-34-56` is the moment
you clicked Stop.

### 7. Drop the file into `linkedin-all-in-one-api/captures-live/`

```bash
# in your linkedin-all-in-one-api checkout
mkdir -p captures-live
mv ~/Downloads/are-capture-linkedin-voyager-2026-06-23T12-34-56.jsonl \
   captures-live/
```

The dev's import script picks it up:

```bash
npm run import:capture -- captures-live/are-capture-linkedin-voyager-2026-06-23T12-34-56.jsonl
```

The import script validates every line against the
`NormalizedResponse` envelope shape, then promotes the file into the
project's reference set.

### Filename convention

`are-capture-{preset}-{YYYY-MM-DDTHH-mm-ss}.jsonl`

| Example | Meaning |
|---|---|
| `are-capture-linkedin-voyager-2026-06-23T12-34-56.jsonl` | LinkedIn Voyager preset, captured 23 Jun 2026 12:34:56 local. |
| `are-capture-graphql-2026-06-23T14-02-11.jsonl` | GraphQL preset. |
| `are-capture-generic-2026-06-23T15-18-30.jsonl` | Generic preset (no URL filter, just redact on). |

If you want to override the filename, the `linkedin-all-in-one-api` repo
accepts the alternative pattern
`YYYY-MM-DDTHH-mm-ss-{preset}-{shortHint}.jsonl` — the import script
matches both.

---

## Quickstart — "Capture any JSON API"

Same idea, different preset.

1. Open the site (e.g. `app.example.com`).
2. Click the plugin icon → **`[Generic]`** (or `[JSON API]` for a
   content-type-based filter).
3. Optionally type a URL filter in the box (e.g. `api2.skool.com`).
4. ▶ Iniciar → use the site → ⏹ Detener → ⬇ Descargar.
5. The downloaded `.jsonl` has every request whose URL contained the
   filter (or every JSON response, for `[JSON API]`).

---

## What the file looks like

```jsonl
{"ts":"2026-06-23T12:34:56.789Z","tab":1823456712,"preset":"linkedin-voyager","request":{"method":"GET","url":"https://www.linkedin.com/voyager/api/me","headers":{"accept":"application/vnd.linkedin.normalized+json+2.1","csrf-token":"[REDACTED:csrf-token]","cookie":"[REDACTED:cookie]","x-restli-protocol-version":"2.0.0"},"body":null},"response":{"status":200,"headers":{"content-type":"application/vnd.linkedin.normalized+json+2.1"},"body":{"data":{"plainId":18222594,"$type":"com.linkedin.voyager.common.Me"},"included":[]},"bodyBytes":214,"duration_ms":187}
```

One line per captured request. Fields:

| Field | Meaning |
|---|---|
| `ts` | When the request finished (ISO 8601, ms precision). |
| `tab` | Chrome tab id. |
| `preset` | Which preset was active. |
| `request.method` | HTTP verb. |
| `request.url` | Full URL. |
| `request.headers` | Lowercased keys, redacted values. |
| `request.body` | Parsed JSON if possible, else raw text, else `null`. |
| `response.status` | HTTP status. |
| `response.headers` | Lowercased keys, redacted values. |
| `response.body` | Parsed JSON if possible, else raw text. Truncated to 5 MB. Binaries are replaced with `{"_skipped":"binary",...}`. |
| `response.bodyBytes` | Size of the untruncated body in bytes. |
| `duration_ms` | Wall time from request open to response end. |

### Useful `jq` one-liners

```bash
# All URLs in the capture
jq -r '.request.url' captures-live/are-capture-linkedin-voyager-2026-06-23T12-34-56.jsonl

# Every Voyager GraphQL call
jq -c 'select(.request.url | test("/voyager/api/graphql"))' \
   captures-live/are-capture-linkedin-voyager-2026-06-23T12-34-56.jsonl

# Every 4xx/5xx response
jq -c 'select(.response.status >= 400)' \
   captures-live/are-capture-linkedin-voyager-2026-06-23T12-34-56.jsonl

# Pretty-print just the response bodies, one per line
jq -c '.response.body' \
   captures-live/are-capture-linkedin-voyager-2026-06-23T12-34-56.jsonl
```

### Recover the v1.2.3 "endpoints + all" shape

The v1.2.3 export grouped by unique `method:url`. If you want that view
back from a `.jsonl`:

```bash
# Unique endpoints, with the first occurrence of each
jq -s 'group_by(.request.method + " " + (.request.url | split("?")[0]))
        | map(.[0])
        | {meta: {total: length, capturedAt: "..."}, endpoints: .}' \
   captures-live/are-capture-linkedin-voyager-2026-06-23T12-34-56.jsonl
```

---

## Migrating from v1.2.3

**No action is required.** v1.3.0 is a strict superset of v1.2.3:

- The **single-string URL filter** still works exactly as before (it is
  converted internally to a one-pattern `OR` list).
- The **`__ARE_REQUEST__` event shape** in the injected script is
  unchanged in field names and types. A consumer of the v1.2.3 schema
  reading v1.3.0 output still finds every field it expects.
- The **JSON array output** (the v1.2.3 shape with `meta`, `endpoints`,
  `all`) is still available — pick "JSON array (legacy)" in the Format
  toggle.
- The **default output format changes** from JSON array to JSON-Lines.
  This is the only user-visible behaviour change. Existing scripts that
  read the v1.2.3 JSON array will need either:
  - The Format toggle set to "JSON array (legacy)", **or**
  - To be updated to read JSONL (recommended — see the `jq` one-liners
    above for the basic operations).

If you have an existing v1.2.3 `.json` capture and want it in JSONL form:

```bash
# One event per line, with the meta block as a comment-like first line
jq -c '.all[]' api-capture-www.linkedin.com-1718000000000.json \
   > are-capture-legacy-converted.jsonl
```

The dev reserves the right to remove the legacy JSON array output in a
future major version. v1.3.x will keep it.

---

## Privacy and safety

- The plugin **does not phone home**. No analytics, no remote config, no
  usage reporting. See [`PRIVACY-POLICY.md`](./PRIVACY-POLICY.md) (the
  same one v1.2.x shipped with).
- The plugin **redacts auth tokens before they cross the postMessage
  bridge** between the page context and the extension context. The
  service worker never sees raw `li_at`, `JSESSIONID`, or `csrf-token`
  values.
- The plugin **does not capture login flows**. If you start recording on
  a LinkedIn tab that is not yet logged in, the capture includes only the
  `voyager/api/...` calls that happen *after* you log in; the login POST
  itself is to `linkedin.com/uas/...` and is filtered out by the
  LinkedIn Voyager preset URL pattern.
- **Turn off redaction at your own risk.** The popup shows a red warning
  when redaction is off. Captures with raw `li_at` should not be
  committed to a public repo.

---

## Troubleshooting

### The popup shows "0 requests" after a minute of clicking around

The URL filter is too tight. Open the popup, clear the filter, click
▶ Iniciar again, and the live preview should fill up. (If it still
shows 0, the site may be using WebSockets for the data — see
[What's NOT captured](#what-is-not-captured) below.)

### A `li_at=...` value still shows up in my `.jsonl`

You turned redaction off. The popup would have shown the red warning. To
fix: turn redaction back on, re-capture, and scrub the previous file
with:

```bash
sed -i '' 's/li_at=[A-Za-z0-9-_]*/li_at=[REDACTED]/g' the-old-file.jsonl
```

### The downloaded file is "weird" — all the bodies are `{"_skipped":"binary",...}`

The site is returning mostly images. Switch the preset to
`[LinkedIn Voyager]` (or `[GraphQL]`) and re-capture, or turn on a URL
filter that targets the JSON endpoints specifically.

### Service worker restarts mid-capture and the badge clears

`chrome.storage.session` preserves the capture across SW restarts. Reopen
the popup — the counts come back. (This was a v1.2.0 fix and is
preserved in v1.3.0.)

---

## What is NOT captured

- **WebSocket traffic** (`wss://...`) — out of scope for v1.3.0.
  If a site uses WebSockets for its data plane (some chat apps, some
  games), the capture will be empty or sparse.
- **Service Worker internal traffic** — Chrome does not let a content
  script observe another extension's (or a page's own) SW requests.
- **Login flows** — `linkedin.com/uas/...` is filtered out by the
  LinkedIn Voyager preset. If you need to see the login POST, use the
  `[Generic]` preset.
- **Streaming responses** — the plugin reads `response.clone().text()` /
  `.json()` *after* the response ends. A long-lived `ReadableStream` is
  captured only after it closes.
- **HAR round-trip** — the `.jsonl` format is purpose-built for the
  capture-and-reference workflow. It is not a Chrome DevTools HAR
  replacement and is not designed to round-trip with the DevTools
  Network panel. If you need HAR, use the DevTools "Save all as HAR
  with content" feature directly.

---

## Changelog

### v1.3.0 — Capture Mode (2026-06-23)

- **Added** — Profile preset dropdown (`[Generic]`, `[LinkedIn Voyager]`,
  `[GraphQL]`, `[JSON API]`).
- **Added** — Multi-line URL filter with AND/OR mode toggle. Backward
  compatible with v1.2.3 single-string filter.
- **Added** — Secret redaction, ON by default. Cookies (`li_at`, `li_a`,
  `JSESSIONID`, `bscookie`), CSRF tokens, and common auth fields are
  replaced with `[REDACTED:<key>]` placeholders. Applied at the
  injection site, before any postMessage.
- **Added** — JSON-Lines (`.jsonl`) output as the new default. One event
  per line. See
  [`docs/spec/adr-0001-capture-mode.md`](./docs/spec/adr-0001-capture-mode.md)
  for the rationale.
- **Added** — Body truncation at 5 MB; binary content-types (image,
  video, audio, PDF, font) recorded as `{"_skipped":"binary",...}`.
- **Added** — Max events per session: 10,000 (warning at 9,000;
  auto-stop at 10,000).
- **Added** — Output format toggle: "JSON-Lines (recommended)" vs
  "JSON array (legacy)". Default = JSON-Lines.
- **Changed** — Default output format is now JSON-Lines (was JSON
  array). Legacy output still available behind a toggle.
- **Changed** — `captureConfig` (preset + filter + redact patterns) is
  persisted in `chrome.storage.session`, so a service worker wake-up
  mid-recording keeps the user's settings.

### v1.2.3 — Maintenance

- Updated Chrome Web Store link, privacy policy link, fixed LinkedIn
  handle to `/in/ctala`.

### v1.2.0 / v1.2.1 / v1.2.2 — Stability

- Service worker persistence (v1.2.0).
- CSP bypass + debug logging + immediate badge feedback (v1.2.1).
- (v1.2.2 — internal).

See [`CHANGELOG.md`](./CHANGELOG.md) for the full history.

---

## License

MIT. See [`LICENSE`](./LICENSE).
