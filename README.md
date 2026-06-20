# 🔬 API Reverse Engineer — Chrome Extension

> Capture every API call on any website — fetch + XHR — while you browse normally. Perfect for reverse engineering undocumented APIs.

Built by [@ctala](https://github.com/ctala) | 🌐 [cristiantala.com](https://cristiantala.com)

![Version](https://img.shields.io/badge/version-1.3.0-22c55e)
![Manifest](https://img.shields.io/badge/manifest-v3-3b82f6)
![License](https://img.shields.io/badge/license-MIT-94a3b8)

---

## What It Does

Instead of digging through DevTools Network tab, this extension gives you a clean one-click recording experience:

1. Open the extension on any tab
2. Set an optional URL filter (e.g. `api.mysite.com`)
3. Click **Start Recording**
4. Use the website as you normally would
5. Click **Stop → Download JSON**

You get a clean JSON file with every unique endpoint captured — methods, headers, request bodies, response bodies, status codes, and timing.

**Recording is scoped to the active tab only.** Other tabs are not affected.

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

### v1.3.0 (2026-06-19)
**Added:**
- English locale — popup UI now follows `chrome.i18n` and the browser's language, with English and Spanish supported out of the box
- `_locales/en` and `_locales/es` message catalogs
- `default_locale` set in `manifest.json`

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

Your data stays on your device. **No tracking, no analytics, no external requests.**

📋 [Read our Privacy Policy](PRIVACY-POLICY.md) | 🌐 [Hosted version](https://cristiantala.com/privacy/api-reverse-engineer/)

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
