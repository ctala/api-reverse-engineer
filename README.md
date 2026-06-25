# 🔬 API Reverse Engineer — Chrome Extension

> Capture every API call on any website — fetch + XHR — while you browse normally. Perfect for reverse engineering undocumented APIs.

Built by [@ctala](https://github.com/ctala) | 🌐 [cristiantala.com](https://cristiantala.com)

![Version](https://img.shields.io/badge/version-1.10.0-22c55e)
![Manifest](https://img.shields.io/badge/manifest-v3-3b82f6)
![License](https://img.shields.io/badge/license-MIT-94a3b8)

---

## What It Does

Instead of digging through DevTools Network tab, this extension gives you a clean one-click recording experience:

1. Open the extension on any tab
2. Pick a preset (LinkedIn, GraphQL, JSON API… or Generic) or set a URL filter
3. Click **Start Recording** — pause and resume anytime
4. Use the website as you normally would
5. Click **Stop → Download JSONL**

You get a JSON-Lines file with every captured request — method, URL, request/response headers and bodies, status codes, and timing. Live counters show total and unique endpoints. Need the auth to replay an API? One click downloads the site's cookies (incl. httpOnly tokens like `li_at`) to a local `.json`, with the `Cookie` header ready for curl/Postman.

**Recording is scoped to the active tab only.** Other tabs are not affected.

---

## ✨ Features

- **Intercepts fetch + XHR + WebSocket** on any website — no DevTools needed
- **Tab-scoped recording** — only the active tab
- **Live request counter** on the toolbar icon
- **Pause / Resume** — survives the MV3 service worker sleeping, no lost captures
- **Presets + URL filter** (domain, path, keyword, regex, glob) with noise exclusion
- **Secret redaction ON by default** — cookies, CSRF, and auth tokens masked before saving
- **Download site cookies** (incl. httpOnly) for API replay
- **Streams to disk (OPFS)** — handles long, large capture sessions
- **English + Spanish UI** — follows your browser language (`chrome.i18n`)
- **Clean dark UI · Manifest V3**

Privacy: all captures stay on your device. Secrets are redacted by default. The `cookies` permission is used only when you click Download Cookies. No servers, no analytics, no tracking.

**Roadmap:** see [ROADMAP.md](ROADMAP.md). **WebSocket capture** shipped in 1.10.0; next up: large-capture streaming download + `QuotaExceededError` handling.

---

## Screenshots

<!-- Add screenshots here -->

---

## 📥 Installation

### From Chrome Web Store (Recommended)

Get the extension directly from the Chrome Web Store:

🔗 **[Install from Chrome Web Store](https://chromewebstore.google.com/detail/dhpkbbfammoldcjhnngopbipkfmlpnej)**

> **Privacy-First:** Zero tracking, zero analytics, zero external servers. [Read our Privacy Policy](https://github.com/ctala/api-reverse-engineer/blob/main/PRIVACY-POLICY.md)

### From Source (Developer Mode)

1. Clone or download this repository
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer Mode** (toggle in top-right corner)
4. Click **Load unpacked** → select the project folder
5. The 🟢 icon appears in your Chrome toolbar

> Firefox support is planned (Manifest V3 with minor adjustments).

---

## Changelog

> Full history in **[CHANGELOG.md](CHANGELOG.md)**. Highlights since v1.3.0:
> **1.10.0** capture fidelity (fetch(Request) body, big-int IDs, form bodies, reused XHR) + page safety (streaming no longer hangs the page) + **WebSocket capture** · **1.9.2** honest redaction (recurse arrays/deep nesting/URL params) · **1.9.1** decode blob/arraybuffer XHR bodies · **1.9.0** capture page-load API calls (document_start injection) + XHR responseType crash fix · **1.8.0** i18n (English default + Spanish) · **1.7.0** download site cookies (.json) for replay · **1.6.0** real LinkedIn preset (rsc-action) + filter fix + live counter · **1.5.0** captures again (importScripts fix) + async OPFS + Pause/Resume.

### v1.3.0 (2026-06-23) — Capture Mode
**Added:**
- **Profile presets** — `[Generic]`, `[LinkedIn Voyager]`, `[GraphQL]`, `[JSON API]`. One-click pre-fill of URL filter and redact patterns.
- **Multi-line URL filter** with AND/OR mode. Patterns can be literal, glob, or `/regex/`.
- **Redact secrets toggle (default ON)** — cookies, CSRF tokens, auth headers, password / token body fields are replaced with `[REDACTED:<key>]` placeholders in the MAIN-world interceptor, before any serialization crosses a process boundary. The raw secret never appears in `postMessage`, `chrome.runtime.sendMessage`, `chrome.storage`, the popup preview, or the downloaded file.
- **JSON-Lines export** (default) + legacy JSON array toggle. New schema documented in `docs/spec/capture-mode-spec.md`.
- **5 MB body cap** + binary skip (`image/*`, `video/*`, `audio/*`, `application/pdf`, `application/octet-stream`) + 10,000-event per-session cap with auto-stop warning.
- **Privacy** — updated `PRIVACY-POLICY.md` for v1.3.0 Capture Mode. Added sections on local data processing, user controls, and what is NOT captured. No changes to data flow. New `docs/spec/PRIVACY-COMPLIANCE-SUMMARY.md` for Chrome Web Store reviewers.

**Not in this release:**
- WebSocket capture, Service Worker internals, cross-origin iframes, replay, HAR import/export, redaction level slider — deferred to v1.4.

### v1.2.3 (2026-02-20)
**Fixed:**
- CSP bypass for ultra-strict sites (Skool, etc.) — now uses `chrome.scripting.executeScript` with `world: 'MAIN'` instead of DOM script injection
- Works on any site regardless of Content Security Policy

### v1.2.2 (2026-02-20)
**Fixed:**
- CSP violation on strict sites (now injects via `<script src>` instead of inline)
- Storage access error in content script (removed premature `chrome.storage.session.get()`)
- Undefined `isRecording` crash (simplified state management — only background controls state)

### v1.2.1 (2026-02-20)
**Fixed:**
- Service worker persistence (state now saved to `chrome.storage.session`)

### v1.1.0 (2026-02-20)
**Added:**
- Tab-scoped recording (only captures in the tab where you clicked Start)

### v1.0.0 (2026-02-20)
**Initial release:**
- fetch + XHR interception
- Live badge counter
- URL filtering
- Deduplication by endpoint
- JSON download

---

## Usage

### Basic

1. Navigate to the website you want to analyze
2. Click the extension icon in the toolbar
3. *(Optional)* Enter a URL filter to narrow captures:
   - `api2.skool.com` — only calls to this domain
   - `/api/v1` — only paths containing this string
   - `graphql` — only GraphQL requests
4. Click **▶ Start**
5. The badge shows live request count
6. Click **⏹ Stop** when done
7. Click **⬇ Download JSON** to save the capture file

### Output File

The downloaded file is named `api-capture-{hostname}-{timestamp}.json`:

```json
{
  "meta": {
    "capturedAt": "2026-02-20T14:32:00.000Z",
    "total": 47,
    "uniqueEndpoints": 23,
    "site": "www.skool.com"
  },
  "endpoints": [
    {
      "type": "fetch",
      "method": "POST",
      "url": "https://api2.skool.com/posts",
      "requestHeaders": {
        "content-type": "application/json",
        "x-aws-waf-token": "..."
      },
      "requestBody": {
        "title": "Test post",
        "body": "Hello world"
      },
      "status": 200,
      "responseBody": {
        "id": "abc123",
        "created_at": "2026-02-20T14:32:01Z"
      },
      "duration": 142,
      "timestamp": "2026-02-20T14:32:00.000Z",
      "isNewEndpoint": true
    }
  ],
  "all": [...]
}
```

**`endpoints`** — deduplicated list (one entry per unique `METHOD:URL` pair)  
**`all`** — every single request captured, including repeated calls

---

## Features

- ✅ Intercepts **fetch** and **XHR** requests
- ✅ Captures request headers, body, response headers, response body
- ✅ **Tab-scoped recording** — only captures from the tab where you clicked Start
- ✅ Live counter badge on the extension icon
- ✅ Optional **URL filter** to reduce noise
- ✅ Deduplication — `endpoints` array has one entry per unique endpoint
- ✅ Works on any website, any protocol
- ✅ Clean dark-mode popup UI
- ✅ **Clear** button to reset captures
- ✅ Manifest V3 (modern Chrome extension standard)

---

## Use Cases

- **Reverse engineering private APIs** — document undocumented endpoints
- **Building integrations** — understand the exact payloads a web app sends
- **API documentation** — auto-generate docs for internal apps
- **Security research** — understand what data a site is sending
- **Learning** — see how modern web apps communicate with their backends

---

## How It Works

The extension uses a 3-layer architecture to capture requests in the page's actual execution context:

```
content.js (extension context)
    └── injects → injected.js (page context)
                      ├── Patches window.fetch
                      └── Patches window.XMLHttpRequest

injected.js → dispatches CustomEvent('__ARE_REQUEST__')
    └── content.js listens → forwards to background.js
                                  └── Stores + counts + updates badge
```

**Why the injection layer?** Chrome extensions run in an isolated context and can't directly access the page's `fetch`. By injecting a `<script>` tag, `injected.js` runs in the page's own JavaScript environment and can intercept real network calls.

---

## File Structure

```
api-reverse-engineer-extension/
├── manifest.json          # Extension config (Manifest V3)
├── popup.html             # Popup UI
├── src/
│   ├── popup.js           # Popup logic
│   ├── background.js      # Service worker (stores captures, manages state)
│   ├── content.js         # Content script (bridge between page and extension)
│   └── injected.js        # Page-context script (intercepts fetch + XHR)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## Roadmap

- [ ] Firefox support (WebExtensions API)
- [ ] Export as OpenAPI / Swagger spec
- [ ] Copy individual endpoint as cURL command
- [ ] Response diffing (detect API changes over time)
- [ ] Replay captured requests
- [ ] HAR import/export compatibility
- [ ] Regex URL filter support

---

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m 'Add my feature'`
4. Push: `git push origin feature/my-feature`
5. Open a Pull Request

---

## Privacy & Security

Your data stays on your device. **No tracking, no analytics, no external requests.** v1.3.0 Capture Mode adds secret redaction in the page (cookies, CSRF tokens, and auth headers are replaced with placeholders before they ever leave the page), so even the in-memory capture buffer never contains raw secrets.

📋 [Privacy Policy](PRIVACY-POLICY.md) · [Compliance Summary (for reviewers)](docs/spec/PRIVACY-COMPLIANCE-SUMMARY.md) · 🌐 [Hosted version](https://cristiantala.com/privacy/api-reverse-engineer/)

---

## License

MIT — see [LICENSE](LICENSE).

---

## 👤 About

**API Reverse Engineer** is maintained with ❤️ by **[Cristian Tala](https://cristiantala.com)** — a developer, entrepreneur, and automation enthusiast.

**Connect:**
- 🌐 **Website:** [cristiantala.com](https://cristiantala.com)
- 💼 **LinkedIn:** [@ctala](https://linkedin.com/in/ctala)
- 🐙 **GitHub:** [@ctala](https://github.com/ctala)
- 📦 **Repository:** [github.com/ctala/api-reverse-engineer](https://github.com/ctala/api-reverse-engineer)

---

### Support & Feedback

Found a bug? Have a feature request?  
**[Open an issue on GitHub](https://github.com/ctala/api-reverse-engineer/issues)**

If you find this extension useful, please:
- ⭐ **Star the repository** on GitHub
- 🌟 **Leave a review** on the Chrome Web Store
- 🔗 **Share** with fellow developers

---

*Privacy Policy: [Read here](PRIVACY-POLICY.md) | All data stays on your device.*
