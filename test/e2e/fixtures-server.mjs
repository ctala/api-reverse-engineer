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
import crypto from 'node:crypto';

// Minimal RFC6455 framing — enough to push one text frame and echo one back,
// so the e2e can exercise the WebSocket interceptor without a ws dependency.
function _wsFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  return Buffer.concat([header, payload]);
}
function _wsDecode(buf) {
  try {
    if (buf.length < 2) return null;
    if ((buf[0] & 0x0f) === 0x8) return null; // close frame
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f; let off = 2;
    if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
    let mask = null;
    if (masked) { mask = buf.subarray(off, off + 4); off += 4; }
    const data = Buffer.from(buf.subarray(off, off + len));
    if (mask) { for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]; }
    return data.toString('utf8');
  } catch (e) { return null; }
}

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

  // Blob-responseType XHR — historically crashed the interceptor: reading
  // xhr.responseText throws InvalidStateError when responseType !== ''/'text'.
  // LinkedIn serves Voyager JSON this way; the fix must capture it WITHOUT a
  // page-level uncaught error AND decode the JSON body (not skip it).
  window.fireBlobXhr = function () {
    return new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('GET', '/voyager/api/blob');
      x.responseType = 'blob';
      x.onloadend = resolve;
      x.onerror = resolve;
      x.send();
    });
  };

  // Fire the SAME JSON endpoint with every XHR responseType. The interceptor
  // must (a) never throw into the page and (b) DECODE the readable ones. This
  // exhausts the finite responseType enum instead of guessing which ones occur.
  window.fireResponseTypeMatrix = function () {
    const types = ['', 'text', 'json', 'blob', 'arraybuffer', 'document'];
    return Promise.all(types.map((rt) => new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('GET', '/voyager/api/rt?rt=' + (rt || 'default'));
      try { x.responseType = rt; } catch (e) {}
      x.onloadend = resolve;
      x.onerror = resolve;
      x.send();
    })));
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
  // #6 big-int: a JSON body with an integer > 2^53. JSON.parse truncates it;
  // bodyRaw must preserve the exact digits for replay.
  window.fireBigIntBody = function () {
    return fetch('/voyager/api/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"entityUrn":7123456789012345678,"text":"hi"}'
    }).catch(() => {});
  };

  // #5 URLSearchParams form body — must be serialized, not collapsed to {}.
  window.fireFormBody = function () {
    return fetch('/voyager/api/write', {
      method: 'POST',
      body: new URLSearchParams({ user: 'alice', count: '3' })
    }).catch(() => {});
  };

  // #1 SSE: a never-ending event-stream must NOT hang the page's fetch.
  // Resolve to 'resolved' if the page's fetch settles, 'timeout' if it hangs.
  window.fireSse = function () {
    return Promise.race([
      fetch('/sse').then(() => 'resolved').catch(() => 'rejected'),
      new Promise((r) => setTimeout(() => r('timeout'), 3000))
    ]);
  };
  // #20 WebSocket: connect, receive the server's push, send one frame, close.
  // Resolves to the inbound payload so the test can also assert capture.
  window.fireWebSocket = function () {
    return new Promise((resolve) => {
      var ws = new WebSocket('ws://' + location.host + '/ws');
      ws.addEventListener('message', function (ev) {
        try { ws.send(JSON.stringify({ hello: 'server' })); } catch (e) {}
        setTimeout(function () { try { ws.close(); } catch (e) {} resolve(String(ev.data)); }, 200);
      });
      ws.addEventListener('error', function () { resolve('error'); });
      setTimeout(function () { resolve('timeout'); }, 2500);
    });
  };
  document.getElementById('fire').addEventListener('click', () => window.fireRequests());
</script>
</body></html>`;

// Second page whose inline script fires a Voyager-shaped fetch IMMEDIATELY on
// parse — simulating LinkedIn's page-load graphql call. Used to prove the
// document_start MAIN-world interceptor patches fetch BEFORE the page uses it,
// so a navigation-while-recording captures the load-time call (B9).
const ONLOAD_PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>ARE onload fixture</title>
<script>
  // Fires during parse, before any user interaction. If the interceptor is not
  // already installed (document_start), this call is lost.
  fetch('/voyager/api/onload', { headers: { 'csrf-token': 'ajax:SECRET' } }).catch(() => {});
</script>
</head>
<body><h1>onload fixture</h1></body></html>`;

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

export function createFixturesServer() {
  const wsSockets = new Set();
  const server = createServer((req, res) => {
    const url = (req.url || '').split('?')[0];

    if (url === '/' || url === '/index.html') {
      return send(res, 200, {
        'content-type': 'text/html; charset=utf-8',
        // normal + httpOnly cookie (como li_at) para testear Copy Cookies.
        'set-cookie': ['sessionPref=light; Path=/', 'li_at=AUTH_TOKEN_SECRET; Path=/; HttpOnly']
      }, PAGE_HTML);
    }

    if (url === '/onload-page') {
      return send(res, 200, { 'content-type': 'text/html; charset=utf-8' }, ONLOAD_PAGE_HTML);
    }

    if (url === '/voyager/api/onload') {
      return send(res, 200, {
        'content-type': 'application/vnd.linkedin.normalized+json+2.1'
      }, JSON.stringify({ data: { loadTime: true }, included: [] }));
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

    // JSON served for blob/arraybuffer/etc-responseType XHRs — LinkedIn serves
    // Voyager JSON this way. The interceptor must DECODE the body, not skip it.
    // Drives the responseType regression + the full-enum matrix test.
    if (url === '/voyager/api/blob' || url === '/voyager/api/rt') {
      return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ data: { rt: true }, included: [] }));
    }

    // Generic write target for the request-body fidelity tests (#5, #6, #9).
    if (url === '/voyager/api/write') {
      return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ ok: true, data: { written: true } }));
    }

    // Never-ending Server-Sent-Events stream (#1): proves the interceptor
    // returns the response to the page instead of awaiting an endless body.
    if (url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
      res.write('data: hello\n\n');
      const iv = setInterval(() => { try { res.write('data: tick\n\n'); } catch (e) {} }, 300);
      req.on('close', () => clearInterval(iv));
      return; // intentionally never res.end()
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

  // #20: minimal WebSocket endpoint at /ws — completes the handshake, pushes one
  // text frame on connect, and echoes frames it receives.
  server.on('upgrade', (req, socket) => {
    if ((req.url || '').split('?')[0] !== '/ws') { socket.destroy(); return; }
    wsSockets.add(socket);
    socket.on('close', () => wsSockets.delete(socket));
    socket.on('error', () => { try { socket.destroy(); } catch (e) {} });
    const key = req.headers['sec-websocket-key'] || '';
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.write(_wsFrame(JSON.stringify({ event: 'hello-from-server' })));
    socket.on('data', (buf) => {
      if (buf.length && (buf[0] & 0x0f) === 0x8) { try { socket.end(); } catch (e) {} return; } // client close frame
      const msg = _wsDecode(buf);
      if (msg != null) { try { socket.write(_wsFrame(JSON.stringify({ echo: msg }))); } catch (e) {} }
    });
  });

  server._wsSockets = wsSockets;
  return server;
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
          // hangs waiting for idle. Force-drop live sockets first (Node 18.2+),
          // plus any hijacked WebSocket sockets (not tracked by the http server).
          try { if (server._wsSockets) server._wsSockets.forEach((s) => { try { s.destroy(); } catch (e) {} }); } catch (e) {}
          server.closeAllConnections?.();
          server.close(() => r());
        }),
      });
    });
  });
}
