# Privacy Policy — API Reverse Engineer

**Effective Date:** June 23, 2026
**Last Updated:** June 23, 2026
**Applies to version:** v1.3.0 (Capture Mode) and later

> A versioned history of this policy lives in the Git repository
> ([`PRIVACY-POLICY.md`](https://github.com/ctala/api-reverse-engineer/blob/main/PRIVACY-POLICY.md)).

---

## Summary

API Reverse Engineer is a **local-first, zero-telemetry** browser extension.
v1.3.0 introduces **Capture Mode** with profile presets, multi-line URL
filters, secret redaction, and JSON-Lines export. Redaction is enabled by
default and runs **inside the page** (the "MAIN world"), so raw secret values
never cross any process boundary, never touch the content script, and never
reach the service worker.

**Plain-English version:** the extension reads the network traffic your own
browser is making on the page you're looking at, removes the secret parts
(cookies, CSRF tokens, auth headers) right there, and then hands you the
sanitized file. Nothing is sent to us, to a server, or to any third party.
If you turn the redaction switch off, that's your choice — the extension
shows a red warning and the secrets land in your download file, on your disk,
under your control.

---

## What the extension does

API Reverse Engineer is a developer tool. It intercepts HTTP requests and
responses made by the page you're viewing, lets you filter them by URL,
redacts secret values, and exports the result as a JSON or JSON-Lines file
that you save to your own computer. The extension runs entirely in your
local browser; there is no companion backend, no account system, and no
remote service of any kind.

---

## Data the extension accesses

To intercept a network call, the extension's injected script
(`src/injected.js`) must run in the same JavaScript execution context as
the page itself. This context is called the **MAIN world** in Chrome's
extension model. To do its job, the injected script reads:

- **Request URLs**, including the path and query string.
- **Request headers** — including `Cookie`, `Set-Cookie`, `csrf-token`,
  `Authorization`, `x-li-pem-metadata`, `x-restli-protocol-version`, and any
  other header the page sends.
- **Request bodies** — including JSON payloads, form-encoded payloads, and
  raw text. For LinkedIn Voyager captures, this includes the body of GraphQL
  POSTs (e.g. `query`, `variables`).
- **Response status codes, response headers, and response bodies** — including
  the same kind of secrets (cookies set in responses, JSON payloads that
  echo auth tokens, etc.).
- **Timing information** (start time, end time, duration in milliseconds).
- **Tab id** — to know which tab the capture belongs to.

This access is technically necessary. The Chrome `webRequest` API cannot see
bodies, and the `chrome.debugger` API is destructive. The only practical
way to capture both request and response bodies is to patch `window.fetch`
and `window.XMLHttpRequest` in the MAIN world — which is what the injected
script does. **No other class of data** (clipboard, storage state, cookies
not transmitted by the page, autofill data, downloads history, etc.) is read
by the extension.

---

## Data the extension processes locally

As soon as the injected script sees a request, it runs the following pipeline
**in the MAIN world, before any serialization or cross-process message**:

1. **Filter check** — does the URL match any of the user's filter patterns
   (literal, glob, or regex, AND/OR mode)? If not, the request is dropped
   immediately. The secret data is not read into a redaction buffer.
2. **Header redaction** — for every header whose *name* matches a redact
   pattern (case-insensitive substring, e.g. `cookie`, `csrf-token`),
   the *value* is replaced with the string `"[REDACTED:<original-name>]"`
   (e.g. `"[REDACTED:cookie]"`).
3. **Body redaction** — for JSON bodies, the *key* of every property
   (top-level and one nested level deep) is checked against the redact
   patterns. Matching values are replaced with the same placeholder.
   For raw-text and form-encoded bodies, `key=value` and `key: value`
   substrings are scanned and replaced.
4. **Truncation** — bodies larger than 5 MB are truncated to 5 MB and
   tagged with `_truncated: true`. Binary responses (images, video, audio,
   PDFs) are recorded as `{"_skipped":"binary", ...}` and never copied
   into the capture file.
5. **Dispatch** — the redacted (and possibly truncated) entry is the
   *only* representation of the event that is sent over the
   `postMessage` bridge into the content script, and onward to the
   service worker.

This is the privacy-critical property: **redaction happens in the same
execution context that sees the raw data, before any other code can
observe it**. The raw secret never appears in the content script, never
appears in the service worker, never appears in `chrome.storage`, and
never appears in the downloaded file. The plugin also never `console.log`s
a redacted value — debug logs show the placeholder, not the original.

---

## Data the extension stores

The extension uses two Chrome storage areas, each with a distinct purpose.

| Storage area | What goes in it | Lifetime | Sent off-device? |
|---|---|---|---|
| `chrome.storage.session` | The `captureConfig` object (preset name, filter patterns, AND/OR mode, redact toggle, redact pattern lists, output format toggle). Does **not** contain captured request/response data. | Cleared when the browser session ends. | **No.** |
| `chrome.storage.local` | The last-used `captureConfig` (so re-opening the popup restores the user's selection). Does **not** contain captured request/response data. | Persistent across browser restarts until the user uninstalls the extension or clicks "Clear". | **No.** |
| `chrome.storage.session` (legacy v1.2.x) | Captured request/response entries. **In v1.3.0 this remains the live capture buffer** — the extension's working memory between events and download. Cleared on tab close, on browser shutdown, or when the user clicks Clear / Stop. | Per-recording session. | **No.** |
| `chrome.downloads` | The exported JSON or JSONL file is written to **the user's chosen file path** via `chrome.downloads.download`. The extension never picks the path. | Whatever the user decides — the file is on the user's disk, owned by the user. | **No.** |

> **Note on the legacy v1.2.x capture buffer:** v1.3.0 keeps the same
> `chrome.storage.session` capture buffer that v1.2.x used. The difference
> is that, in v1.3.0, *what gets written to that buffer is already
> redacted* — so even the in-memory buffer is secret-free. The buffer
> never leaves the local browser.

---

## Data the extension sends externally

**None.** The extension does not communicate with any server, any
analytics provider, any error-reporting service, any update channel,
any remote-config endpoint, or any third party. The extension's
network footprint is exactly zero. The Chrome Web Store's "Limited Use
of User Data" policy is satisfied by construction.

Concretely, the extension **does not**:

- Send captured request or response data to any server.
- Send any header, body, URL, status code, or timing information off-device.
- Send anonymized, aggregated, hashed, or otherwise transformed
  representations of your activity to any server.
- Use Google Analytics, Mixpanel, Amplitude, Segment, Sentry, Bugsnag,
  Datadog, New Relic, Hotjar, FullStory, LogRocket, or any similar tool.
- Use cookies for tracking. (The extension never sets or modifies cookies.
  Cookies that appear in captured traffic are *content of the page's network
  calls* and are redacted by default. The opt-in **Download Cookies** button
  reads them via `chrome.cookies` ONLY on an explicit user click and saves
  them to a local file — that is not tracking and nothing is transmitted.)
- Make any `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, or
  `Image().src` request to any non-`chrome://` or non-extension URL.
- Use remote-config, feature flags, A/B test buckets, or any other
  mechanism that requires a network round trip.
- Phone home for license checks, version checks, or kill-switch signals.

The only outbound network behavior in the entire extension is the
**inbound** network traffic the page itself generates (e.g. the user
loading `linkedin.com/voyager/api/...` from their own logged-in session),
which is intercepted in the MAIN world and turned into a capture event.
That traffic is from the page to its own backend, not from the extension
to anywhere.

---

## User controls

Every privacy-sensitive behavior in v1.3.0 is exposed to the user in the
extension popup, with safe defaults.

| Control | Where | Default | What it does |
|---|---|---|---|
| **Preset** | Popup dropdown | `[Generic]` | Pre-fills the URL filter and the redact pattern lists. The user can edit both afterward. |
| **URL filter (multi-line)** | Popup textarea | empty (capture all) | One pattern per line: literal substring, glob, or `/regex/`. Combined with AND/OR. |
| **Filter mode** | Popup radio | `OR` (matches v1.2.x behavior) | Switches between matching all patterns (AND) or any pattern (OR). |
| **Redact secrets** | Popup checkbox | **ON** | When ON, the extension replaces values for matching header names and body keys with `[REDACTED:<key>]` placeholders, in the MAIN world, before any storage or download. When OFF, the popup shows a red warning. |
| **Output format** | — | JSON-Lines | Captures download as JSON-Lines (one JSON object per line). |
| **Download Cookies** | Popup button | n/a | On an explicit click, reads the active site's cookies (incl. httpOnly auth like `li_at`) via `chrome.cookies` and saves them to a local `.json` for API replay. Never part of a capture, never transmitted. |
| **File location** | Browser's standard download dialog | User-selected | The browser's native save dialog. The extension never writes to a fixed path. |
| **Clear** | Popup button | n/a | Wipes the in-memory capture buffer (`chrome.storage.session`) immediately. |
| **Stop** | Popup button | n/a | Stops recording; buffer is preserved in `chrome.storage.session` until the user clicks Clear or closes the tab/browser. |
| **Uninstall** | Chrome `chrome://extensions` | n/a | Removes the extension and all its storage (`chrome.storage.session`, `chrome.storage.local`). |

Turning the **Redact secrets** checkbox off is the only switch that
changes a privacy property. The popup makes the consequence visible:
the red warning text reads "Captures may include `li_at`, `JSESSIONID`,
and other auth tokens. Do not commit these." The user is in control.

---

## What is NOT captured

The extension is opinionated and bounded. The following are
**explicitly out of scope** for v1.3.0 and are never recorded:

- **WebSocket traffic** (`new WebSocket(url)`, `WebSocket.send`,
  `message` events). v1.3.0 interceptors cover `fetch` and
  `XMLHttpRequest` only.
- **Server-Sent Events / `EventSource`** streams. Same reason.
- **Service Worker internals** — traffic generated or proxied by a
  Service Worker registered on the page is not visible to a content
  script and is therefore not captured.
- **Cross-origin iframes** — only the top-level frame's requests are
  captured. If a page embeds a third-party widget in an iframe, that
  iframe's network traffic is not intercepted.
- **Browser-level chrome:// pages**, extension pages, the Chrome Web
  Store, and the DevTools itself.
- **Requests the user makes *outside* the active recording tab** —
  recording is tab-scoped. Other tabs are not affected even if they
  match the filter.
- **The passive capture never reads `chrome.cookies`.** The recording only
  sees cookies the page itself sends in request headers (and redacts them by
  default). Reading the browser's cookie jar happens ONLY via the separate,
  opt-in **Download Cookies** button — on an explicit user click, saved to a
  local file, never part of a capture, never transmitted.
- **Clipboard, autofill, form data, history, bookmarks, saved
  passwords, geolocation, microphone, camera, or any other browser
  surface.** The extension declares no permission for these.

The captured file is therefore a *deliberately narrow* slice of the
user's network activity — only the HTTP/HTTPS `fetch` and `XHR` calls
made by the page the user explicitly chose to record, on the tab the
user explicitly chose to record in.

---

## Permissions we request

The extension's `manifest.json` declares the following permissions.
Every one of them has a single, narrow purpose, and every one of them
is exercised entirely on the user's device.

| Permission | Why we need it | Sensitive? | Sent off-device? |
|---|---|---|---|
| `<all_urls>` (host permission) | To inject the interceptor into the page the user wants to record. | Yes, but the extension runs only on the tab the user started recording in. | No. |
| `activeTab` | To scope recording to the tab where the user clicked the extension icon. | No. | No. |
| `tabs` | To read the tab id (so the download filename includes the originating tab) and to know when the user closes the tab (so we can clean up). | No. | No. |
| `storage` | To use `chrome.storage.session` (in-memory capture buffer, captureConfig) and `chrome.storage.local` (last-used captureConfig). | No. | No. |
| `scripting` | To inject `injected.js` into the active tab on Start. Bypasses page CSP. | No. | No. |
| `cookies` | Powers the **Download Cookies** button. On an explicit click, the extension reads the cookies for the active tab's site (including httpOnly auth cookies such as `li_at` / `JSESSIONID`) and lets the user save them to a **local `.json` file** for replaying the site's API. Read-only, on-demand, never part of a capture, never transmitted off-device. | Yes — it can read auth cookies, but ONLY when the user clicks the button, and the result is saved locally. | No. |
| `unlimitedStorage` | To stream large captures to the extension's OPFS (Origin Private File System) without the ~10 MB quota. The file never leaves the device. | No. | No. |

The extension does **not** request `webRequest`,
`webRequestBlocking`, `debugger`, `proxy`, `vpnProvider`, `nativeMessaging`,
`desktopCapture`, `tabCapture`, `offscreen`, `browsingData`, `history`,
`bookmarks`, `clipboardRead`, `clipboardWrite`, `geolocation`,
`notifications`, `idle`, `power`, `system.cpu`, `system.memory`, or
`system.storage`. None of these are needed for v1.3.0 Capture Mode.

---

## Retention and deletion

- **In-memory capture buffer** (`chrome.storage.session`): cleared
  automatically when the tab is closed or the browser session ends.
  The user can also clear it manually with the **Clear** button in
  the popup, or implicitly by clicking **Stop** and then **Clear**.
- **`captureConfig` in `chrome.storage.session`**: same lifetime as
  the buffer above — per browser session.
- **`captureConfig` in `chrome.storage.local`**: persistent across
  browser restarts so the popup can restore the last selection. The
  user can clear it by uninstalling the extension, by clicking
  **Clear** (which also wipes the local copy of the config in v1.3.0),
  or by using Chrome's site-data clearing tools.
- **Downloaded JSON / JSONL file**: stored on the user's disk at a
  path the user chose at download time. The extension has no access
  to it after the save dialog closes. The user can delete it like any
  other file.

There is no remote backup, no cloud sync, no "restore my captures"
feature. When the local storage is cleared, the data is gone for good.

---

## Third-party services

**None.** The extension is built with vanilla JavaScript. It loads
no third-party scripts, no remote stylesheets, no fonts from a CDN,
no analytics SDK, no A/B testing library, and no remote error
reporter. The only network requests the extension's own code makes
are to `chrome://` and `chrome-extension://` URLs (the extension's
own UI pages). All other network behavior is the *page's own* HTTP
traffic, intercepted for capture.

The bundled source code is small enough to read end-to-end
(see [`src/`](https://github.com/ctala/api-reverse-engineer/tree/main/src)).
The full extension is auditable in under an hour by a reviewer
familiar with the Chrome extension APIs.

---

## Compliance with Chrome Web Store policies

API Reverse Engineer complies with the Chrome Web Store
[**Developer Program Policies**](https://developer.chrome.com/docs/webstore/program-policies/),
including the following:

- **User Data Privacy** — the extension's only access to user data
  is the in-page network traffic described above, and that data is
  processed locally and never transmitted off-device.
- **Limited Use of User Data** — the extension does not use any
  user data for any purpose other than the single, narrow purpose
  of producing the local capture file the user explicitly requested.
  No user data is used for advertising, no user data is used for
  credit checks, no user data is sold or transferred, no user data
  is used to train any model.
- **Single Purpose** — the extension does one thing: it captures
  HTTP traffic on the page the user is recording, with optional
  redaction and filtering, and exports the result to a local file.
- **No Unexpected Uses** — the `<all_urls>` host permission is
  used solely to inject the page-context interceptor, not to read
  the contents of pages, not to inject UI, and not to modify the
  page in any way visible to the user.
- **Secure Transmission / Handling** — the extension never
  transmits user data. There is therefore no transmission to
  secure.
- **Transparency** — this policy is published in the repository
  and linked from the extension's Chrome Web Store listing.
- **Data Usage** — the extension does not declare any of the
  "User Data" categories (location, personal communication, user
  activity, website content) in the Chrome Web Store Developer
  Dashboard. The "Website content" category is sometimes used for
  extensions that read page content; this extension reads network
  traffic metadata and bodies, not page DOM, and we have chosen
  not to declare the category because we never *use* the captured
  data for any purpose other than the user's own export.

---

## Open source and auditability

The extension is open source under the [MIT License](https://github.com/ctala/api-reverse-engineer/blob/main/LICENSE).
Every release is reproducible from the repository. The version of the
extension that this policy applies to is **v1.3.0**. To verify the
behavior described here against the source:

- Interception + MAIN world: [`src/injected.js`](https://github.com/ctala/api-reverse-engineer/blob/main/src/injected.js)
- Content-script bridge: [`src/content.js`](https://github.com/ctala/api-reverse-engineer/blob/main/src/content.js)
- Service worker (storage, JSONL, download): [`src/background.js`](https://github.com/ctala/api-reverse-engineer/blob/main/src/background.js)
- Capture Mode spec (incl. privacy guarantees): [`docs/spec/capture-mode-spec.md`](https://github.com/ctala/api-reverse-engineer/blob/main/docs/spec/capture-mode-spec.md)
- LinkedIn Voyager preset (incl. redact pattern list): [`docs/spec/linkedin-voyager-preset.md`](https://github.com/ctala/api-reverse-engineer/blob/main/docs/spec/linkedin-voyager-preset.md)
- ADR-0001 (Capture Mode design rationale): [`docs/spec/adr-0001-capture-mode.md`](https://github.com/ctala/api-reverse-engineer/blob/main/docs/spec/adr-0001-capture-mode.md)

---

## Changes to this policy

We may update this policy when the extension's behavior changes. Any
change will be reflected here with an updated "Last Updated" date and
will ship as a release note. The previous version of this policy
(covering v1.2.x) is preserved in the git history.

Notable change log:

- **v1.3.0 (2026-06-23)** — Capture Mode. Expanded the policy to
  describe what the MAIN-world interceptor sees, where redaction
  happens, what the storage areas contain, what is and is not
  captured (WebSocket, Service Worker, cross-origin iframes), and
  the user controls. The data flow did not change: v1.2.x already
  intercepted in the MAIN world, already used `chrome.storage.session`
  and `chrome.downloads.download`, and already had zero external
  network calls. v1.3.0 makes the privacy properties more
  conservative by adding a default-on redact step.
- **v1.2.x (2026-02-21)** — Initial policy. Described the v1.2.x
  intercept → buffer → export flow with the same zero-telemetry
  guarantees.

---

## Contact

Questions about privacy? Open an issue:
<https://github.com/ctala/api-reverse-engineer/issues>

Or email: **privacy@cristiantala.com**

For Chrome Web Store privacy-related complaints, you can also reach
the Chrome Web Store team directly:
<https://support.google.com/chrome_webstore/contact/privacy>

---

## Legal

This extension is provided "as is" without any warranty. By using it,
you agree to the [MIT License](https://github.com/ctala/api-reverse-engineer/blob/main/LICENSE).

You are responsible for the captures you produce. The extension gives
you the tools (filter, redact, format) to capture safely; the
decisions about what to record, what to redact, and where to store
the resulting file are yours. If you turn redaction off, the secrets
are in the file, and you should treat the file accordingly (do not
commit it, do not upload it, do not share it with people you would
not give your session cookie to).

We respect your privacy. The extension does not have any of its own
to violate.
