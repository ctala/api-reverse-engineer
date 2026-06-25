# Chrome Web Store Listing

## Summary (max 132 chars)
```
Capture every API call on any website. Reverse engineer undocumented APIs instantly.
```
(86 characters - well under the 132 limit)

---

## Detailed Description

### Overview
API Reverse Engineer captures every API call (fetch + XHR) while you browse normally. No DevTools needed—one click to start recording, and download a JSON-Lines file with every request captured.

**Perfect for:**
- Reverse engineering undocumented private APIs
- Building integrations and automation
- Security research and auditing
- API documentation generation
- Learning how web applications communicate

### How It Works
1. Open the extension on any tab
2. Pick a preset (LinkedIn, GraphQL, JSON API… or Generic) or set a URL filter
3. Click **▶ Start Recording** — pause and resume anytime
4. Use the website as you normally would
5. Click **⏹ Stop → ⬇ Download JSONL**

You get a JSON-Lines export of every captured request: method, URL, request/response headers and bodies, status codes, and timing. Need the auth to replay an API? One click downloads the site's cookies (including httpOnly tokens like `li_at`) to a local `.json`.

### Key Features
✅ **Intercepts fetch + XHR requests** — catches all modern API calls  
✅ **Tab-scoped recording** — only the active tab  
✅ **Live request counter** on the toolbar icon  
✅ **Pause / Resume** — survives the MV3 service worker sleeping, no lost captures  
✅ **Presets + URL filter** — domain, path, keyword, regex, glob, with noise exclusion  
✅ **Secret redaction ON by default** — cookies, CSRF, and auth tokens masked before saving  
✅ **Download site cookies** (incl. httpOnly) for API replay  
✅ **Streams to disk (OPFS)** — handles long, large capture sessions  
✅ **Clean dark UI · Manifest V3**  

### Output Format
Downloaded file: `are-capture-{preset}-{timestamp}.jsonl` — one JSON object per line:

```
{"ts":"2026-06-24T14:32:00Z","preset":"linkedin-voyager","request":{"method":"POST","url":"https://www.linkedin.com/voyager/api/...","headers":{...},"body":{...}},"response":{"status":200,"headers":{...},"body":{...}},"duration_ms":142}
```

When redaction is on (default), secrets (cookies, CSRF, auth tokens) are replaced with `[REDACTED:<name>]` before the file is written.

### Privacy & Security
**Local-only** — All captures stay on your device. No server uploads, no analytics, no tracking. Secrets (cookies, CSRF, auth tokens) are redacted by default. The `cookies` permission is used only when you click Download Cookies; `unlimitedStorage` only to stream large captures to disk (OPFS). Nothing is ever uploaded.

### Permission justifications (for the Chrome Web Store "Privacy practices" tab)
- **cookies:** Powers the optional "Download Cookies" button. Only on an explicit user click, the extension reads the active tab site's cookies (including httpOnly auth cookies like `li_at`) via `chrome.cookies` and saves them to a local `.json` so the user can replay the site's own API. Never part of a capture, never transmitted off-device.
- **unlimitedStorage:** Lets the extension stream large API captures to the Origin Private File System (OPFS) without the ~10 MB quota, so long recording sessions don't lose data when the MV3 service worker restarts. All data stays on the user's device.
- **host `<all_urls>` / scripting:** To inject the fetch/XHR interceptor into the tab the user chose to record. Runs only on the active recording tab.
- **tabs:** To scope recording to the active tab and name the download file.

Learn more: [Privacy Policy](https://cristiantala.com/privacy/api-reverse-engineer/)

### Use Cases

**🔍 Reverse Engineering**
Document APIs that have no public documentation. Perfect for Skool, LinkedIn, or any SaaS platform.

**🤖 Automation & Integration**
Understand exact payloads before building integrations or automation workflows.

**📊 API Documentation**
Auto-generate docs for internal tools and forgotten APIs.

**🛡️ Security Research**
Audit what data is being sent and where. Detect privacy violations.

**👨‍💻 Learning**
See how professional web apps handle authentication, pagination, error handling, and more.

### Roadmap
- **WebSocket + SSE capture** — reverse engineer realtime / chat protocols (next up)
- Export to Postman collection / OpenAPI spec
- Curated preset library (LinkedIn, Skool, Stripe…)
- HAR import/export
- Firefox support (WebExtensions)

Stays 100% local — no accounts, no cloud, no server-side component. (Full roadmap: `ROADMAP.md`.)

### Support & Contributing
Found a bug? Have a feature request?  
Report issues and contribute on GitHub:  
https://github.com/ctala/api-reverse-engineer

### About
Built by [@ctala](https://github.com/ctala) · [cristiantala.com](https://cristiantala.com)

---

## Store Images
- **440×280 tile** — Synthwave promotional image
- **5 screenshots (1280×800 each)**
  1. Idle state (no recording)
  2. Recording active with badge
  3. Results ready to download
  4. URL filter in action
  5. JSON export preview
