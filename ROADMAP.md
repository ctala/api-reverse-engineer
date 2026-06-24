# Roadmap — API Reverse Engineer

> The default is **restraint**. A focused tool that does one thing well beats a
> bloated one — and Chrome's "single purpose" policy literally penalizes scope
> creep. Things land here only when they finish the core job (capture network
> traffic for reverse engineering) or there's real user demand.

## Principles (the guardrails)

- **100% local, zero data.** No backend, no account, no cloud sync, no
  dashboards. This is both the privacy moat and what keeps the single-purpose
  story clean. The moment there's a server, both are lost.
- **One purpose:** capture a site's network traffic so you can reverse engineer
  and document its API. New protocols (WebSocket, SSE) are *the same purpose*;
  new product surfaces (accounts, hosting) are not.
- **Honest about limits.** We say what the tool does NOT do, instead of
  overpromising.
- **The verde must mean production.** Every feature ships with honest tests
  (unit where it makes sense + e2e in real Chromium) — never green against a
  mock that lies.

## Next up

### 🔌 WebSocket (+ SSE) capture

Reverse engineer realtime / chat protocols — e.g. understanding the **Skool or
LinkedIn chat** so you can decide how to automate it. The extension is the
*recon* here; it is decoupled from where any automation runs:

- Capturing the chat usually reveals that **sending** a message is a plain HTTP
  POST (the WS is often receive-only). If so, no WS runtime is needed — it
  becomes a normal HTTP write action (e.g. in the Apify Skool actor).
- Only **listening** in real time needs a persistent connection, which belongs
  in an always-on service (a Coolify microservice / n8n long-running / the
  Spark stack) — **not** in a run-based Apify actor.

WebSocket is different from fetch/XHR: one long-lived connection with many frames
both directions. The design keeps it ordered:

- **Model — two levels:** *Connection* (`connId`, url, subprotocols, open/close,
  close code) + *Frame* (`connId` + `seq` per-connection counter + ts +
  `dir` send/recv + data + bytes).
- **Output — JSONL, already ordered.** One line per event (`ws-open`, `ws`,
  `ws-close`). Order is guaranteed on two axes: chronological (file order) and
  per-connection (`connId` + `seq`). No second format — the JSONL handles it.
- **Auth:** browser WebSocket cannot send custom headers, so nothing is hidden
  in the handshake. Auth always comes via cookies (→ Download Cookies), the URL,
  a subprotocol, or the first message — all captured. Bonus: the HTTP that
  bootstraps the socket (e.g. a token fetch) is captured in the same session.
- **Redaction + binary:** text/JSON frames redacted like the rest; binary frames
  marked `{_binary:true, bytes:N}` (not decoded).
- **Out of scope (honest):** building the automation client — replicating
  heartbeats, `ref`/`seq` management, and the message format in n8n/code is the
  automation itself, not something a capture tool does. Binary-format decoding
  and WS running inside an iframe/Worker are also not covered.
- **Build:** patch `window.WebSocket` in `injected.js` (constructor + `send` +
  `message` + close) behind the `__ARE_PATCHED__` guard; `capture-config`
  handles the `ws` type (URL filter + payload redaction); a real WS fixture
  server + e2e in real Chromium proves send/recv. Likely lands as **v1.8.0**,
  spec'd in ADR-0004.

## Considered / later (only with demand)

- **Export to Postman collection / OpenAPI spec.** The *real* differentiation
  vs DevTools — a structured, batch export of the whole capture, not a
  single-request copy. Serves the "API documentation generation" use case.
- **Curated preset library** (LinkedIn, Skool, Stripe, Notion…). Cheap, the
  preset system already supports it, makes the tool the go-to for those sites,
  and feeds content ("how I reverse-engineered the X API").
- **HAR import/export** for interop with DevTools and other tools.
- **WebSocket binary-frame decoding** helpers, if real captures need them.
- **Firefox support** (WebExtensions, minor MV3 adjustments).

## Explicitly NOT planned

- **Accounts, login, cloud sync, hosting, dashboards, any server-side
  component** — kills the all-local privacy moat and the single-purpose story.
- **Single "Copy as cURL".** Chrome DevTools already does this (right-click a
  request → Copy as cURL). We don't reinvent it; if anything, the batch export
  above is the version worth building.
- **Anything that captures or transmits data without an explicit user action.**

## Strategic note

This extension is a **funnel / credibility asset**, not a product to monetize
directly. It's the living proof of the "I reverse-engineered Skool's API → built
the Apify actor" story. The roadmap therefore optimizes for **adoption and that
narrative** (broader protocol coverage, a preset library, content) over
features — and never at the cost of the local-only / single-purpose guarantees.
