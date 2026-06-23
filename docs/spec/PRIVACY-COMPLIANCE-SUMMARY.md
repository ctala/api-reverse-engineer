# Privacy Compliance Summary — v1.3.0 Capture Mode

> **Audience:** Chrome Web Store reviewers, security teams, and non-technical
> readers who need a fast, accurate answer to "what does this extension do
> with the data it sees?"
> **Source of truth:** [`capture-mode-spec.md`](./capture-mode-spec.md) (the
> design spec, lines 299-318 hold the privacy guarantees) and
> [`PRIVACY-POLICY.md`](../../PRIVACY-POLICY.md) (the published policy).

---

## 1. Side-by-side: what the plugin sees vs. what leaves your machine

| Stage | Where the data lives | What the plugin sees there | What can leave your machine from that stage |
|---|---|---|---|
| **1. The page loads** | The browser tab you're recording | A normal web page (e.g. `linkedin.com`) | The page's own traffic, going to *its own* backend, exactly as it would without the extension. |
| **2. The page makes a request** (`fetch` or `XHR`) | The page's MAIN-world JavaScript context | The raw request: URL, headers (including `Cookie`, `csrf-token`, `Authorization`, etc.), body (JSON / form / raw text), and timing. | **Nothing yet** — this data has not been sent anywhere. |
| **3. Interceptor runs** (`src/injected.js`, MAIN world) | Same MAIN-world context, before the data crosses any bridge | The same raw data. The interceptor runs three helpers **in order**: `shouldCapture` (URL filter, AND/OR) → `redactHeaders` (replace values for matching header names) → `redactBody` (replace values for matching body keys, top-level + 1 nested). | **Nothing yet.** The raw secret has been read into the interceptor's local variables and is about to be replaced. |
| **4. Redaction produces the entry** | Same MAIN-world context | The **redacted** entry. Original `Cookie: li_at=abc...` is now `Cookie: [REDACTED:cookie]`. Original JSON `{"password": "hunter2"}` is now `{"password": "[REDACTED:password]"}`. The raw value has been dropped — JavaScript's garbage collector will eventually reclaim the memory. | **The raw secret never crosses this boundary.** |
| **5. `dispatchEvent('__ARE_REQUEST__')`** | MAIN world → content script (different execution context, separated by Chrome's `postMessage` bridge) | The content script sees the redacted entry only. The raw secret is not in the event payload. | **The raw secret never crosses `postMessage`.** |
| **6. `chrome.runtime.sendMessage`** | Content script → service worker | The service worker sees the redacted entry only. | **The raw secret never crosses `chrome.runtime.sendMessage`.** |
| **7. `chrome.storage.session.set`** | Service worker writes to in-memory storage | The redacted entry is buffered. | **The raw secret never reaches `chrome.storage`.** |
| **8. User clicks Download** | Service worker serializes the buffer | The redacted entries (with bodies truncated to 5 MB or marked `_skipped: "binary"`). | **The file is handed to `chrome.downloads.download`, which triggers the browser's native save dialog.** The user picks the path. |
| **9. File on disk** | The user's filesystem | The redacted JSON or JSONL file. | **The extension cannot read the file after the save dialog closes.** It is owned by the user, on the user's disk, under the user's control. |

**Bottom line for non-technical readers:** the raw secret is born in the
page, dies in the page, and is replaced with a placeholder before it ever
leaves the page. Every later stage (content script, service worker, storage,
download, disk) sees only the placeholder, never the original.

---

## 2. The "never crosses `postMessage`" guarantee (in plain English)

The Chrome extension architecture has a security boundary between the
*page* and the *extension*. Anything the page's JavaScript can see, the
extension's content script normally cannot see directly — and vice versa.
They communicate through a deliberately limited message bridge called
`postMessage`.

The naive way to build a request-capture extension is: let the page
forward the raw request into the extension, and let the extension redact
it. **This extension does not do that.** That design would mean the raw
secret would exist in *two* places — the page and the extension — and
would be a leak waiting to happen.

The architecture used here is different. The interceptor (the script that
*sees* the raw data) runs *inside the page*, and the redaction step
*also* runs inside the page. By the time the data is forwarded to the
extension over the `postMessage` bridge, the secret has already been
replaced. The extension's content script and service worker never have
access to the raw value.

Concretely, the contract is:

> "Raw secret values do not appear in the `postMessage` payload, do not
> appear in any `chrome.runtime.sendMessage` payload, do not appear in
> `chrome.storage`, do not appear in any `console.log` of the entry, do
> not appear in the popup preview, and do not appear in the downloaded
> file."

This is enforced by the order of operations in the interceptor: filter
first, redact second, dispatch third. There is no code path that dispatches
without redaction when redaction is enabled. The redact function is
applied at the only place where the raw value exists.

---

## 3. Storage areas — what goes where

| Storage area | Contents in v1.3.0 | Lifetime | Sent off-device? |
|---|---|---|---|
| `chrome.storage.session` (capture buffer) | The list of captured, *redacted* entries since you clicked Start. | Per browser session; cleared on tab close, browser shutdown, or Clear button. | No. |
| `chrome.storage.session` (`captureConfig`) | The active capture config: preset id, filter patterns, AND/OR mode, redact toggle, redact pattern lists, output format. **Not** capture data. | Per browser session. | No. |
| `chrome.storage.local` (`captureConfig` last-used) | The last capture config the user selected, so re-opening the popup restores the dropdown / filter / toggle. **Not** capture data. | Persistent until the user uninstalls or clicks Clear. | No. |
| `chrome.downloads` | The exported JSON or JSONL file, written to a path the user chose in the browser's native save dialog. | The file is on the user's disk; the extension has no further access to it. | No. |

No other storage areas are used. The extension does not write to
`localStorage`, `sessionStorage`, `IndexedDB`, the browser's cookie jar,
or the file system directly.

---

## 4. External network behavior

| Surface | Behavior |
|---|---|
| `fetch` / `XMLHttpRequest` initiated by the extension itself | **None.** The extension's own code makes no outbound network calls. |
| `WebSocket` / `EventSource` initiated by the extension itself | **None.** |
| `navigator.sendBeacon` | **None.** |
| `Image().src = "https://..."` (tracking pixel) | **None.** |
| `chrome.runtime.connect` to any other extension | **None.** |
| Google Analytics / Mixpanel / Amplitude / Segment / Sentry / Datadog / etc. | **None.** These are not bundled and not loaded. |
| Remote-config / feature-flag / A/B test endpoints | **None.** |
| License / version / kill-switch checks | **None.** |
| CDNs (fonts, scripts, stylesheets) | **None.** The extension ships its own assets. |

The only outbound network behavior attributable to the extension is the
*page's own* HTTP traffic, intercepted for capture. That traffic goes
from the page to the page's own backend — not from the extension to
anywhere.

---

## 5. What is NOT captured

To bound the extension's surface explicitly:

- **WebSocket traffic** — out of scope for v1.3.0.
- **Server-Sent Events (`EventSource`)** — out of scope.
- **Service Worker internals** — not visible to a content script.
- **Cross-origin iframes** — only the top-level frame is captured.
- **Browser chrome pages** (`chrome://`, `chrome-extension://`,
  Chrome Web Store, DevTools).
- **Other tabs** — recording is tab-scoped.
- **Cookies not transmitted by the page** — the extension never reads
  `chrome.cookies` or the cookie jar; it only sees cookies the page
  itself sends in headers, and in v1.3.0 with redaction on, those
  are replaced with placeholders.
- **Clipboard, autofill, form data, history, bookmarks, saved
  passwords, geolocation, microphone, camera** — the extension declares
  no permission for these and does not read them.

The capture file is therefore a *deliberately narrow* slice of HTTP/HTTPS
`fetch` and `XHR` traffic from the single tab the user chose to record,
during the time window between Start and Stop.

---

## 6. Chrome Web Store policy alignment

| Chrome Web Store policy | How this extension complies |
|---|---|
| **User Data Privacy** | The only user data accessed is the in-page network traffic described above. It is processed locally and never transmitted off-device. |
| **Limited Use of User Data** | The extension uses user data for a single purpose: producing the local capture file the user requested. No advertising, no credit checks, no sale, no transfer, no model training. |
| **Single Purpose** | One purpose: capture HTTP traffic on the recorded tab, with optional redaction, filter, and format, exported to a local file. |
| **No Unexpected Uses of `<all_urls>`** | The `<all_urls>` host permission is used solely to inject the page-context interceptor. The extension does not read page DOM, does not inject UI, and does not modify the visible page. |
| **Transparency** | This policy is published in the repository and linked from the Chrome Web Store listing. Source code is open under MIT. |
| **Data Usage declaration** | The Developer Dashboard does not list any "User Data" category. The extension does not use the data for any purpose beyond the user's own export. |
| **Secure Transmission / Handling** | The extension never transmits user data, so there is no transmission to secure. |

A reviewer can verify the technical claims by reading
[`src/injected.js`](../../src/injected.js) (the MAIN-world interceptor with
`shouldCapture`, `redactHeaders`, `redactBody`), [`src/content.js`](../../src/content.js)
(the bridge), and [`src/background.js`](../../src/background.js) (the
service worker that calls `chrome.downloads.download`). The total
extension is small enough to read in under an hour.

---

## 7. Quick "is this extension safe to install?" checklist

- [x] **No telemetry.** No analytics, no error reporting, no remote-config, no phone-home of any kind.
- [x] **Secrets redacted by default.** Cookie, CSRF, auth headers, and password / token body fields are replaced with placeholders *before* storage, *before* download, *before* logging.
- [x] **Local-only export.** The capture file is written to a path the user picks in the browser's native save dialog. The extension cannot read the file after the dialog closes.
- [x] **Tab-scoped.** Recording only happens on the tab where the user clicked Start.
- [x] **Bounded scope.** No WebSocket, no Service Worker internals, no cross-origin iframes.
- [x] **Open source.** MIT-licensed, full source in the repository.
- [x] **Minimal permissions.** `<all_urls>`, `activeTab`, `tabs`, `storage`, `scripting` — no `cookies`, `webRequest`, `debugger`, `proxy`, or `nativeMessaging`.
- [x] **User controls visible.** Redact toggle, format toggle, file location picker, Clear button.
- [x] **Compliant with the Chrome Web Store Developer Program Policies** — User Data Privacy, Limited Use, Single Purpose, No Unexpected Uses, Transparency.

---

## 8. Where to read more

- **Published policy** — [`PRIVACY-POLICY.md`](../../PRIVACY-POLICY.md)
- **Design spec, privacy guarantees at lines 299-318** — [`capture-mode-spec.md`](./capture-mode-spec.md)
- **LinkedIn Voyager preset (redact pattern list)** — [`linkedin-voyager-preset.md`](./linkedin-voyager-preset.md)
- **ADR-0001 (Capture Mode design rationale)** — [`adr-0001-capture-mode.md`](./adr-0001-capture-mode.md)
- **MAIN-world interceptor source** — [`src/injected.js`](../../src/injected.js)
- **Content-script bridge source** — [`src/content.js`](../../src/content.js)
- **Service worker source (storage + download)** — [`src/background.js`](../../src/background.js)
- **Chrome Web Store Developer Program Policies** — <https://developer.chrome.com/docs/webstore/program-policies/>
- **Chrome Web Store privacy contact** — <https://support.google.com/chrome_webstore/contact/privacy>
