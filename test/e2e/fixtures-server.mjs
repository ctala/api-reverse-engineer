/**
 * fixtures-server.mjs — deterministic local server for the e2e suite.
 *
 * Serves a page that fires fetch + XHR in the exact shapes the capture code
 * has historically mishandled, plus Voyager-shaped endpoints — WITHOUT ever
 * touching linkedin.com (no private data, fully replicable in CI):
 *
 *   1. fetch(new Request(url, {...}))  → method/headers/body live on the Request (B8)
 *   2. XHR with setRequestHeader       → request headers (B7)
 *   3. fetch with a big integer id     → JSON precision
 *   4. fetch on page-load              → timing relative to START (B9)
 *
 * No dependencies; plain node:http.
 */
import { createServer } from 'node:http';

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>ARE e2e fixture</title></head>
<body>
<h1>API Reverse Engineer — e2e fixture</h1>
<button id="fire">fire requests</button>
<script>
  // Exposed so the test can trigger requests AFTER clicking Iniciar.
  window.fireRequests = async function () {
    // 1) fetch(Request) — POST with header + body carried by the Request object.
    await fetch(new Request('/voyager/api/me', {
      method: 'POST',
      headers: { 'csrf-token': 'ajax:SECRET', 'x-restli-protocol-version': '2.0.0' },
      body: JSON.stringify({ hello: 'world' })
    })).catch(() => {});

    // 2) XHR with a request header (Voyager messaging-style).
    await new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('POST', '/voyager/api/messaging');
      x.setRequestHeader('csrf-token', 'ajax:SECRET');
      x.onloadend = resolve;
      x.send(JSON.stringify({ ping: 1 }));
    });

    // 3) plain fetch GET.
    await fetch('/voyager/api/me').catch(() => {});
  };

  // Mixed data + telemetry/static noise (todas RELATIVAS, como la SPA real) —
  // para testear que el preset LinkedIn narrowea a datos y EXCLUYE el ruido.
  window.fireMixed = async function () {
    await fetch('/voyager/api/me').catch(() => {});                            // data (include)
    await fetch('/flagship-web/rsc-action/actions/component').catch(() => {}); // data (rsc-action)
    await fetch('/rest/trackO11yApi/trackO11y').catch(() => {});               // noise (sin include)
    await fetch('/li/track?trk=x').catch(() => {});                            // noise (exclude)
    await fetch('/static/asset.js').catch(() => {});                          // noise (sin include)
  };
  document.getElementById('fire').addEventListener('click', () => window.fireRequests());
</script>
</body></html>`;

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

export function createFixturesServer() {
  return createServer((req, res) => {
    const url = (req.url || '').split('?')[0];

    if (url === '/' || url === '/index.html') {
      return send(res, 200, {
        'content-type': 'text/html; charset=utf-8',
        // normal + httpOnly cookie (como li_at) para testear Copy Cookies.
        'set-cookie': ['sessionPref=light; Path=/', 'li_at=AUTH_TOKEN_SECRET; Path=/; HttpOnly']
      }, PAGE_HTML);
    }

    if (url === '/voyager/api/me') {
      return send(res, 200, {
        'content-type': 'application/vnd.linkedin.normalized+json+2.1',
        'x-restli-protocol-version': '2.0.0'
      }, JSON.stringify({ data: { firstName: 'Test' }, included: [{ access_token: 'SHOULD_BE_REDACTED' }] }));
    }

    if (url === '/voyager/api/messaging') {
      return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ ok: true }));
    }

    // Data + noise endpoints para el test de filtro (todos 200).
    if (url === '/flagship-web/rsc-action/actions/component') {
      return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ rsc: true }));
    }
    if (url === '/rest/trackO11yApi/trackO11y' || url === '/li/track' || url === '/static/asset.js') {
      return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ noise: true }));
    }

    return send(res, 404, { 'content-type': 'text/plain' }, 'not found');
  });
}

/** Start the server on an ephemeral port. Returns { port, close() }. */
export function startFixturesServer() {
  const server = createFixturesServer();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        close: () => new Promise((r) => {
          // Chrome holds the connection keep-alive, so a plain server.close()
          // hangs waiting for idle. Force-drop live sockets first (Node 18.2+).
          server.closeAllConnections?.();
          server.close(() => r());
        }),
      });
    });
  });
}
