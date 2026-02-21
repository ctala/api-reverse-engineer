# Chrome Web Store Listing

## Summary (max 132 chars)
```
Capture every API call on any website. Reverse engineer undocumented APIs instantly.
```
(86 characters - well under the 132 limit)

---

## Detailed Description

### Overview
API Reverse Engineer is a Chrome extension that captures every API call (fetch + XHR) while you browse normally. No DevTools needed—just one click to start recording, and download a clean JSON with all endpoints captured.

**Perfect for:**
- Reverse engineering undocumented private APIs
- Building integrations and automation
- Security research and auditing
- API documentation generation
- Learning how web applications communicate

### How It Works
1. Open the extension on any tab
2. *(Optional)* Set a URL filter to reduce noise
3. Click **▶ Start Recording**
4. Use the website as you normally would
5. Click **⏹ Stop → ⬇ Download JSON**

You get a complete JSON export with every unique endpoint: methods, headers, request/response bodies, status codes, and timing info.

### Key Features
✅ **Intercepts fetch + XHR requests** — catches all modern API calls  
✅ **Tab-scoped recording** — only captures from the tab where you start  
✅ **Live counter badge** — see request count in real-time  
✅ **Optional URL filter** — filter by domain, path, or keyword  
✅ **Deduplication** — endpoints array shows one entry per unique endpoint  
✅ **Works everywhere** — any website, any protocol  
✅ **Clean dark UI** — minimal, fast, keyboard-friendly  
✅ **Manifest V3** — modern, secure Chrome extension standard  

### Output Format
Downloaded file: `api-capture-{site}-{timestamp}.json`

```json
{
  "meta": {
    "capturedAt": "2026-02-20T14:32:00Z",
    "total": 47,
    "uniqueEndpoints": 23,
    "site": "www.example.com"
  },
  "endpoints": [
    {
      "method": "POST",
      "url": "https://api.example.com/v1/posts",
      "requestHeaders": {...},
      "requestBody": {...},
      "status": 200,
      "responseBody": {...},
      "duration": 142,
      "timestamp": "2026-02-20T14:32:00Z"
    },
    ...
  ]
}
```

### Privacy & Security
**Local-only recording** — All captures stay on your device. No server uploads, no analytics, no tracking. Your data never leaves your browser.

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
- Firefox support (WebExtensions)
- Export as OpenAPI / Swagger spec
- Copy endpoint as cURL command
- Response diffing (track API changes)
- HAR import/export
- Replay captured requests

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
