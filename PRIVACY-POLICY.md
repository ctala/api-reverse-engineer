# Privacy Policy - API Reverse Engineer

**Effective Date:** February 2026  
**Last Updated:** February 21, 2026

## Summary
API Reverse Engineer is a privacy-first extension. **We collect zero data.** All API captures happen locally on your device and never leave your browser.

---

## What We Collect
**Nothing.** 

This extension:
- ❌ Does NOT send data to any external server
- ❌ Does NOT use analytics or tracking
- ❌ Does NOT store data in cloud services
- ❌ Does NOT require account login or authentication
- ❌ Does NOT use cookies
- ❌ Does NOT log user behavior

---

## How It Works
All API capture and processing happens **entirely on your device**:

1. **Content Script** (in your browser context)
   - Intercepts network requests from the page you're visiting
   - Listens to fetch and XHR events

2. **Background Service Worker** (local to your browser)
   - Stores captures in `chrome.storage.session`
   - Computes statistics (count, deduplication)
   - Updates the extension badge

3. **Popup UI** (local to your browser)
   - Displays captured data
   - Generates JSON export file
   - All processing happens in-browser

**No external calls are made at any point.**

---

## Data You Generate
When you download a capture, you get a JSON file that includes:
- Request methods, URLs, headers, request bodies
- Response status codes, bodies, timing info
- Timestamp of capture
- Site domain where capture occurred

**This file is yours.** You can delete it anytime. We never see it.

---

## Permissions We Request
The extension requests these permissions from Chrome:

| Permission | Why | Sensitive? |
|-----------|-----|-----------|
| `<all_urls>` | To intercept API calls on any website | Yes, but strictly local |
| `tabs` | To identify which tab is recording | No |
| `activeTab` | To scope recording to active tab only | No |
| `storage` | To store session captures temporarily | No |
| `scripting` | To inject interceptor code into pages | No |

**Important:** These permissions are only used locally. We never collect, transmit, or log any data.

---

## Retention & Deletion
- Captures are stored in `chrome.storage.session` only
- Cleared automatically when you close the tab or browser session
- You control deletion via the "Clear" button in the extension popup
- Downloaded JSON files are stored only on your computer

---

## Third-Party Services
**None.** This extension uses:
- ✅ Only Chrome APIs (built-in, no external calls)
- ✅ JavaScript (vanilla, no frameworks that might phone home)
- ✅ Your browser's native fetch/XHR interception

No third-party libraries, no external API calls, no CDN resources.

---

## Changes to This Policy
We may update this policy occasionally. Any changes will be reflected here with an updated "Last Updated" date.

---

## Contact
Questions about privacy? Please open an issue on GitHub:  
https://github.com/ctala/api-reverse-engineer/issues

Or email: privacy@cristiantala.com

---

## Legal
This extension is provided "as is" without any warranty. By using it, you agree to the [MIT License](https://github.com/ctala/api-reverse-engineer/blob/main/LICENSE).

We respect your privacy. Period.
