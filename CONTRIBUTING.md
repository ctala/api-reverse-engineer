# Contributing to API Reverse Engineer

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

1. Clone the repo:
   ```bash
   git clone https://github.com/ctala/api-reverse-engineer.git
   cd api-reverse-engineer
   ```

2. Load in Chrome:
   - Open `chrome://extensions/`
   - Enable **Developer Mode**
   - Click **Load unpacked** → select the project folder

3. After any change to `src/` or `popup.html`:
   - Go to `chrome://extensions/`
   - Click the **🔄 refresh** button on the extension card

## Architecture Overview

The extension has 4 layers:

| File | Context | Role |
|------|---------|------|
| `popup.js` | Extension popup | UI, start/stop/download |
| `background.js` | Service worker | State, dedup, storage |
| `content.js` | Extension (per tab) | Bridge between page and extension |
| `injected.js` | Page JavaScript | Patches `fetch` and `XHR` |

**Important:** `injected.js` runs in the page's own JS context via a `<script>` tag injection. This is the only way to intercept real `fetch` calls before they go out.

## How to Add a Feature

### New capture field
Add it to the `entry` object in `injected.js`, then update the popup rendering in `popup.js`.

### New export format
Add a handler in `background.js` (message type `EXPORT_FORMAT_X`) and a button in `popup.html` + `popup.js`.

### New filter type
The current filter is a simple `url.includes(filter)` check in `content.js`. For regex support, parse the filter string and use `new RegExp(filter).test(url)`.

## Guidelines

- Keep `injected.js` as small as possible — it runs on every page
- No external dependencies — the extension must work offline
- Test on Chrome stable before submitting a PR
- Describe your change clearly in the PR description

## Reporting Bugs

Open a [GitHub Issue](https://github.com/ctala/api-reverse-engineer/issues) with:
- Chrome version
- What you were capturing (site type, not necessarily the actual site)
- What happened vs what you expected
- Any console errors (from the extension's service worker or the page)
