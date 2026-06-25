/**
 * API Reverse Engineer — Injected Script (v1.3.0)
 * Corre en el contexto REAL de la página (MAIN world, acceso a window.fetch).
 * Intercepta fetch + XMLHttpRequest y los reporta via window events.
 *
 * Capture Mode (v1.3.0): antes de despachar el evento __ARE_REQUEST__:
 *   1. shouldCapture(url, patterns, mode) — descarte temprano si no matchea.
 *   2. redactHeaders(headers, names) + redactBody(body, keys) — reescribe
 *      headers y bodies IN PLACE en el objeto entry antes de cruzar el
 *      bridge hacia el content script. El secret raw nunca sale de MAIN world.
 *
 * Espera que `window.CaptureConfig` esté disponible (cargado antes por
 * background.js en el mismo `chrome.scripting.executeScript` batch).
 */

(function () {
  'use strict';

  // B9 fix: guard against double-wrapping. The interceptor is injected via
  // chrome.scripting.executeScript on every START (and, once enabled, via a
  // declarative document_start MAIN-world content_script). Without this guard
  // each injection wraps window.fetch / window.XMLHttpRequest AGAIN, so every
  // request is dispatched once per wrapper layer → duplicate captures after a
  // STOP→START on the same page. Idempotent install: re-injection is a no-op,
  // the original interceptor stays active and keeps receiving captureConfig
  // updates via the existing postMessage listener.
  if (window.__ARE_PATCHED__) return;
  window.__ARE_PATCHED__ = true;

  var CC = (typeof window !== 'undefined' && window.CaptureConfig) || null;
  // Capture-config may not have loaded (race or load failure). In that case,
  // fall back to a permissive default (capture everything, no redaction) so
  // the extension still records. The popup will warn if redaction is off.
  var shouldCapture = CC ? CC.shouldCapture : function () { return true; };
  var redactHeaders = CC ? CC.redactHeaders : function (h) { return h || {}; };
  var redactBody = CC ? CC.redactBody : function (b) { return b; };
  var redactUrl = (CC && CC.redactUrl) ? CC.redactUrl : function (u) { return u; };

  // captureConfig is updated by content.js via window.postMessage. Shape:
  // {
  //   preset: 'linkedin-voyager' | 'generic' | ...,
  //   patterns: Array<{type, value}>,
  //   filterMode: 'AND' | 'OR',
  //   redact: { enabled: boolean, headers: string[], body: string[] }
  // }
  var captureConfig = null;

  // document_start buffering (B9): the interceptor is now installed at
  // document_start (declarative MAIN-world content script), so it patches
  // fetch/XHR BEFORE the page fires its load-time calls (LinkedIn's Voyager
  // graphql fires on navigation, before the popup's START reaches us). Until
  // the captureConfig arrives we don't know the filter/redaction rules, so we
  // buffer the RAW entries HERE in MAIN world (where the secrets already live —
  // nothing crosses the bridge) and flush them, filtered + redacted, the moment
  // the config arrives. If recording never starts the buffer is dropped on page
  // unload; no unredacted data ever leaves MAIN world. Capped so a
  // never-recorded page can't grow it unbounded.
  var pendingRaw = [];
  var MAX_PENDING = 200;
  var MAX_PENDING_BYTES = 8 * 1024 * 1024; // #17: also cap by bytes — a feed page can buffer MBs
  var pendingBytes = 0;
  var pendingDropWarned = false;

  function _estimateEntrySize(e) {
    var n = 256;
    try { if (e && e.responseBody != null) n += (typeof e.responseBody === 'string' ? e.responseBody.length : JSON.stringify(e.responseBody).length); } catch (x) {}
    try { if (e && e.requestBody != null) n += (typeof e.requestBody === 'string' ? e.requestBody.length : JSON.stringify(e.requestBody).length); } catch (x) {}
    return n;
  }

  // Listen for captureConfig updates from content.js (which receives them
  // from the background service worker).
  window.addEventListener('message', function (event) {
    if (!event || !event.data) return;
    var msg = event.data;
    if (msg && msg.__ARE_CAPTURE_CONFIG__) {
      captureConfig = msg.captureConfig || null;
      if (captureConfig && pendingRaw.length) {
        // Flush the load-time buffer THROUGH the filter + redaction now that we
        // know the rules. This is what captures the page-load Voyager calls.
        var buffered = pendingRaw;
        pendingRaw = [];
        pendingBytes = 0;
        pendingDropWarned = false;
        for (var i = 0; i < buffered.length; i++) {
          var processed = applyCapture(buffered[i]);
          if (processed) {
            window.dispatchEvent(new CustomEvent('__ARE_REQUEST__', { detail: processed }));
          }
        }
      } else if (!captureConfig) {
        pendingRaw = []; // recording cleared — drop the buffer
        pendingBytes = 0;
        pendingDropWarned = false;
      }
    }
  });

  // Resolve a (possibly relative) URL to absolute, using the page location as
  // base. SPAs like LinkedIn fetch with relative URLs (/voyager/api/…); the
  // filter patterns are absolute-friendly substrings, and an absolute URL is
  // also more useful for reverse engineering.
  function _absoluteUrl(u) {
    try {
      return new URL(String(u), (typeof location !== 'undefined' ? location.href : undefined)).href;
    } catch (e) {
      return u;
    }
  }

  // applyCapture — runs INSIDE the interceptors, BEFORE dispatching the event.
  // Returns the (possibly redacted) entry, or null if it should be skipped.
  function applyCapture(entry) {
    var cfg = captureConfig;
    if (!cfg) {
      // No config loaded yet — let it through unmodified (v1.2.3 compat).
      return entry;
    }

    // 1. URL filter (early skip — redaction is skipped entirely if filtered out).
    // exclude wins over include (filters telemetry/static noise).
    if (!shouldCapture(entry.url, cfg.patterns || [], cfg.filterMode || 'OR', cfg.exclude || [])) {
      return null;
    }

    // 2. Redaction. Done on a shallow clone so we never mutate what fetch/XHR
    //    still hold; the redacted copy is what we dispatch.
    var redacted = {
      type: entry.type,
      method: entry.method,
      url: entry.url,
      requestHeaders: entry.requestHeaders,
      requestBody: entry.requestBody,
      requestBodyRaw: entry.requestBodyRaw,
      status: entry.status,
      responseHeaders: entry.responseHeaders,
      responseBody: entry.responseBody,
      duration: entry.duration,
      timestamp: entry.timestamp,
      preset: cfg.preset || 'generic'
    };

    if (entry.error) redacted.error = entry.error; // pass through fetch errors

    if (cfg.redact && cfg.redact.enabled) {
      // URL query/fragment secrets (audit #2) — uses the body key list so
      // ?access_token=/?code= are masked the same as a body field.
      redacted.url = redactUrl(redacted.url, cfg.redact.body || []);
      redacted.requestHeaders = redactHeaders(redacted.requestHeaders, cfg.redact.headers || []);
      redacted.responseHeaders = redactHeaders(redacted.responseHeaders, cfg.redact.headers || []);
      redacted.requestBody = redactBody(redacted.requestBody, cfg.redact.body || []);
      redacted.requestBodyRaw = redactBody(redacted.requestBodyRaw, cfg.redact.body || []);
      redacted.responseBody = redactBody(redacted.responseBody, cfg.redact.body || []);
    }

    return redacted;
  }

  function dispatch(entry) {
    if (!captureConfig) {
      // No config yet (interceptor installed at document_start; recording not
      // started, or the config is still in flight after a navigation). Buffer
      // the RAW entry in MAIN world; it'll be filtered + redacted + dispatched
      // when the config arrives (see the message listener above). #17: bounded
      // by BOTH count and bytes so a heavy page can't balloon page memory.
      var sz = _estimateEntrySize(entry);
      if (pendingRaw.length < MAX_PENDING && pendingBytes + sz <= MAX_PENDING_BYTES) {
        pendingRaw.push(entry);
        pendingBytes += sz;
      } else if (!pendingDropWarned) {
        pendingDropWarned = true;
        // #16: surface the drop (DevTools) instead of losing entries silently.
        try {
          console.warn('[API Reverse Engineer] Pre-recording buffer full (' + MAX_PENDING + ' entries / ' +
            Math.round(MAX_PENDING_BYTES / 1048576) + ' MB) — earlier page-load calls beyond this are not buffered. ' +
            'Start recording before loading the page to capture them all.');
        } catch (e) {}
      }
      return;
    }
    var processed = applyCapture(entry);
    if (!processed) return; // filtered out
    window.dispatchEvent(new CustomEvent('__ARE_REQUEST__', {
      detail: processed
    }));
  }

  // ---- Request body capture (#5 form bodies, #6 big-int fidelity) ----
  // Returns { value, raw }: `value` is a readable form (parsed JSON / string /
  // typed placeholder); `raw` is the byte-exact wire string when we have one.
  // Why `raw`: JSON.parse(body) truncates integers > 2^53 (LinkedIn entityUrn,
  // Skool/Twitter snowflake IDs) — replay needs the exact bytes. And
  // URLSearchParams/FormData are serialized instead of collapsing to {}.
  function _captureRequestBody(body) {
    if (body === null || body === undefined) return { value: null };
    if (typeof body === 'string') {
      var parsed; try { parsed = JSON.parse(body); } catch (e) { parsed = body; }
      // Keep raw only when parsing produced an object (the lossy case); for a
      // plain-string body parsed === string, so raw would be redundant.
      return { value: parsed, raw: (parsed && typeof parsed === 'object') ? body : undefined };
    }
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      var s = body.toString();
      return { value: s, raw: s };
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      var obj = {};
      try {
        body.forEach(function (v, k) {
          obj[k] = (typeof File !== 'undefined' && v instanceof File)
            ? { _file: v.name, _size: v.size, _type: v.type } : v;
        });
      } catch (e) {}
      return { value: obj };
    }
    if (typeof TextDecoder !== 'undefined' && (ArrayBuffer.isView(body) || (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer))) {
      try {
        var txt = new TextDecoder('utf-8').decode(body);
        var p; try { p = JSON.parse(txt); } catch (e) { p = txt; }
        return { value: p, raw: (p && typeof p === 'object') ? txt : undefined };
      } catch (e) { return { value: { _skipped: 'binary-body' } }; }
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      return { value: { _skipped: 'blob-body', _size: body.size, _type: body.type } };
    }
    // ReadableStream or unknown — never JSON.stringify a live object (→ '{}').
    return { value: { _skipped: 'unreadable-body', _kind: Object.prototype.toString.call(body) } };
  }

  // ---- Response body capture: streaming-safe + byte-capped (#1, #7, #10) ----
  // The page's response is returned IMMEDIATELY; the body is read from an
  // independent CLONE in a detached task. text/event-stream (SSE) is never
  // buffered (placeholder) so the read can't hang. Everything else is read
  // through the stream reader with a hard byte cap so a multi-MB body can't
  // balloon page memory or block anything.
  var MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // mirrors the SW truncation cap

  function _decodeBody(text) {
    if (text == null) return null;
    if (text === '') return '';
    try { return JSON.parse(text); } catch (e) { return text; }
  }

  function _readStreamCapped(stream, maxBytes) {
    var reader = stream.getReader();
    var chunks = [];
    var received = 0;
    var truncated = false;
    function done() {
      var text = '';
      try {
        var merged = new Uint8Array(received);
        var off = 0;
        for (var i = 0; i < chunks.length; i++) { merged.set(chunks[i], off); off += chunks[i].length; }
        text = new TextDecoder('utf-8').decode(merged);
      } catch (e) { text = ''; }
      if (truncated) return { _truncated: true, _bytes: received, _preview: text };
      return _decodeBody(text);
    }
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return done();
        if (r.value && r.value.length) { chunks.push(r.value); received += r.value.length; }
        if (received >= maxBytes) { truncated = true; try { reader.cancel(); } catch (e) {} return done(); }
        return pump();
      }).catch(function () { return done(); });
    }
    return pump();
  }

  function _readResponseBody(cloned, contentType) {
    var ct = String(contentType || '');
    if (/event-stream/i.test(ct)) {
      // SSE / server push never ends — reading it would hang the task forever.
      return Promise.resolve({ _skipped: 'stream', _contentType: ct });
    }
    if (cloned.body && typeof cloned.body.getReader === 'function' && typeof TextDecoder !== 'undefined') {
      return _readStreamCapped(cloned.body, MAX_RESPONSE_BYTES);
    }
    return cloned.text().then(function (t) { return _decodeBody(t); }).catch(function () { return null; });
  }

  // --- FETCH interceptor ---
  var originalFetch = window.fetch;

  window.fetch = async function () {
    var args = Array.prototype.slice.call(arguments);
    var resource = args[0];
    var options = args[1] || {};
    var isRequest = (typeof Request !== 'undefined') && (resource instanceof Request);
    var url = _absoluteUrl(isRequest ? resource.url : (typeof resource === 'string' ? resource : (resource && resource.url) || ''));
    // B8: con fetch(new Request(url, {method, headers, body})) el method/headers
    // viven en el Request, no en args[1].
    var method = options.method || (isRequest ? resource.method : 'GET');
    var startTime = Date.now();

    var requestHeaders = {};
    try {
      if (isRequest && resource.headers && typeof resource.headers.forEach === 'function') {
        resource.headers.forEach(function (v, k) { requestHeaders[k] = v; });
      }
      if (options.headers) {
        var h = new Headers(options.headers);
        h.forEach(function (v, k) { requestHeaders[k] = v; });
      }
    } catch (e) {}

    // Request body. #9: fetch(new Request(url,{body})) carries the body on the
    // Request, not in options — read a CLONE of it (async, non-destructive) so
    // RSC/GraphQL write payloads aren't lost as body:null.
    var reqInfo = _captureRequestBody(options.body);
    var reqBodyReady;
    if ((reqInfo.value === null || reqInfo.value === undefined) && isRequest && resource.body) {
      reqBodyReady = (function () {
        try { return resource.clone().text().then(function (t) { return _captureRequestBody(t); }); }
        catch (e) { return Promise.resolve({ value: null }); }
      })().catch(function () { return { value: null }; });
    } else {
      reqBodyReady = Promise.resolve(reqInfo);
    }

    try {
      var response = await originalFetch.apply(this, args);
      var duration = Date.now() - startTime;

      // #10: guard clone() — a disturbed/locked body (e.g. another MAIN-world
      // wrapper read it first) makes clone() throw. NEVER let that reach the
      // page; capture without a body instead and still return the real response.
      var cloned = null;
      try { cloned = response.clone(); } catch (e) { cloned = null; }

      var responseHeaders = {};
      try { response.headers.forEach(function (v, k) { responseHeaders[k] = v; }); } catch (e) {}
      var contentType = '';
      try { contentType = response.headers.get('content-type') || ''; } catch (e) {}
      var status = response.status;

      // #1/#7: DETACH the body read. Return `response` to the page NOW; read the
      // independent clone in the background (stream-skip + byte cap) so we never
      // hang the page (SSE) or balloon memory (multi-MB body).
      var bodyReady = cloned ? _readResponseBody(cloned, contentType)
                             : Promise.resolve({ _skipped: 'clone-failed' });
      Promise.all([reqBodyReady, bodyReady]).then(function (r) {
        var ri = r[0] || { value: null };
        dispatch({
          type: 'fetch',
          method: method,
          url: url,
          requestHeaders: requestHeaders,
          requestBody: ri.value,
          requestBodyRaw: ri.raw,
          status: status,
          responseHeaders: responseHeaders,
          responseBody: r[1],
          duration: duration,
          timestamp: new Date().toISOString()
        });
      }).catch(function () {});

      return response;
    } catch (error) {
      reqBodyReady.then(function (ri) {
        ri = ri || { value: null };
        dispatch({
          type: 'fetch',
          method: method,
          url: url,
          requestHeaders: requestHeaders,
          requestBody: ri.value,
          requestBodyRaw: ri.raw,
          status: 'ERROR',
          error: error && error.message,
          duration: Date.now() - startTime,
          timestamp: new Date().toISOString()
        });
      }).catch(function () {});
      throw error;
    }
  };

  // --- XHR interceptor ---
  var OriginalXHR = window.XMLHttpRequest;

  window.XMLHttpRequest = function () {
    var xhr = new OriginalXHR();
    var method = 'GET';
    var url = '';
    var requestHeaders = {};

    var originalOpen = xhr.open.bind(xhr);
    xhr.open = function (m, u) {
      method = m;
      url = _absoluteUrl(u);
      // #12: native XHR clears request headers on open(); mirror that so a
      // REUSED instance (open/send again) doesn't accumulate stale headers.
      requestHeaders = {};
      var rest = Array.prototype.slice.call(arguments, 2);
      return originalOpen.apply(null, [m, u].concat(rest));
    };

    // B7: capturar los request headers que el sitio setea vía setRequestHeader.
    var originalSetRequestHeader = xhr.setRequestHeader.bind(xhr);
    xhr.setRequestHeader = function (k, v) {
      try { requestHeaders[k] = v; } catch (e) {}
      return originalSetRequestHeader(k, v);
    };

    var originalSend = xhr.send.bind(xhr);
    xhr.send = function (body) {
      // #12: snapshot per-send state into locals so a reused XHR can't overwrite
      // an in-flight request's labels. #5/#6: faithful form/big-int body capture.
      var sendStart = Date.now();
      var sentMethod = method;
      var sentUrl = url;
      var sentInfo = _captureRequestBody(body);
      var snapHeaders = {};
      for (var hk in requestHeaders) {
        if (Object.prototype.hasOwnProperty.call(requestHeaders, hk)) snapHeaders[hk] = requestHeaders[hk];
      }

      // #11: {once:true} — a reused instance must NOT accumulate one loadend
      // listener per send (that double/triple-captured the same response).
      xhr.addEventListener('loadend', function () {
        // B-XHR-responseType: xhr.responseText THROWS unless responseType is
        // ''/'text'. Handle the finite enum; LinkedIn serves Voyager JSON over
        // responseType='blob', decoded here. Never throws into the page.
        var rt = '';
        try { rt = xhr.responseType || ''; } catch (e) { rt = ''; }

        function finish(responseBody) {
          var responseHeaders = {};
          try {
            var raw = xhr.getAllResponseHeaders() || '';
            raw.trim().split(/[\r\n]+/).forEach(function (line) {
              var idx = line.indexOf(':');
              if (idx > 0) responseHeaders[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
            });
          } catch (e) {}
          dispatch({
            type: 'xhr',
            method: sentMethod,
            url: sentUrl,
            requestHeaders: snapHeaders,
            requestBody: sentInfo.value,
            requestBodyRaw: sentInfo.raw,
            status: xhr.status,
            responseHeaders: responseHeaders,
            responseBody: responseBody,
            duration: Date.now() - sendStart,
            timestamp: new Date().toISOString()
          });
        }

        if (rt === '' || rt === 'text') {
          var t = null;
          try { t = xhr.responseText; } catch (e) { t = null; }
          finish(_decodeBody(t));
        } else if (rt === 'json') {
          var j = null;
          try { j = xhr.response; } catch (e) { j = null; }
          finish(j);
        } else if (rt === 'arraybuffer') {
          var decoded = null;
          try {
            if (xhr.response && typeof TextDecoder !== 'undefined') {
              decoded = new TextDecoder('utf-8').decode(xhr.response);
            }
          } catch (e) { decoded = null; }
          finish(decoded == null ? { _skipped: 'arraybuffer-decode-failed', _responseType: rt } : _decodeBody(decoded));
        } else if (rt === 'blob' && xhr.response && typeof xhr.response.text === 'function') {
          xhr.response.text().then(function (text) {
            finish(_decodeBody(text));
          }).catch(function () {
            finish({ _skipped: 'blob-read-failed', _responseType: rt });
          });
        } else {
          finish({ _skipped: 'non-text-responseType', _responseType: rt });
        }
      }, { once: true });

      return originalSend(body);
    };

    return xhr;
  };

  // --- WebSocket interceptor (#20) — LinkedIn/Skool realtime chat ---
  // window.WebSocket carries realtime messaging (inbound messages, read
  // receipts, presence) that never touches fetch/XHR — previously a total blind
  // spot. Proxy the constructor; capture outbound send() payloads and inbound
  // message events as type:'websocket' entries. A separate listener is used so
  // the page's own handlers are unaffected.
  var OriginalWebSocket = window.WebSocket;
  if (OriginalWebSocket && !window.__ARE_WS_PATCHED__) {
    window.__ARE_WS_PATCHED__ = true;
    var WSProxy = function (url, protocols) {
      var ws = (protocols !== undefined) ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
      var wsUrl = _absoluteUrl(url);
      var openedAt = Date.now();
      function frameBody(data) {
        if (typeof data === 'string') { try { return JSON.parse(data); } catch (e) { return data; } }
        return { _skipped: 'binary-frame', _kind: Object.prototype.toString.call(data) };
      }
      function emit(direction, data) {
        try {
          dispatch({
            type: 'websocket',
            method: direction === 'send' ? 'WS_SEND' : 'WS_RECV',
            url: wsUrl,
            requestHeaders: {},
            requestBody: direction === 'send' ? frameBody(data) : null,
            status: 'WS',
            responseHeaders: {},
            responseBody: direction === 'recv' ? frameBody(data) : null,
            duration: Date.now() - openedAt,
            timestamp: new Date().toISOString()
          });
        } catch (e) {}
      }
      try {
        var originalSend = ws.send.bind(ws);
        ws.send = function (data) { emit('send', data); return originalSend(data); };
      } catch (e) {}
      try {
        ws.addEventListener('message', function (ev) { emit('recv', ev && ev.data); });
      } catch (e) {}
      return ws;
    };
    try {
      WSProxy.prototype = OriginalWebSocket.prototype;
      WSProxy.CONNECTING = OriginalWebSocket.CONNECTING;
      WSProxy.OPEN = OriginalWebSocket.OPEN;
      WSProxy.CLOSING = OriginalWebSocket.CLOSING;
      WSProxy.CLOSED = OriginalWebSocket.CLOSED;
    } catch (e) {}
    window.WebSocket = WSProxy;
  }

  // Self-check: confirm captureConfig shim is loaded so redaction actually runs.
  if (!CC) {
    // eslint-disable-next-line no-console
    console.warn('[API Reverse Engineer] window.CaptureConfig missing — capture will be unfiltered and unredacted. Reload the page or check the extension files.');
  } else {
    // eslint-disable-next-line no-console
    console.log('[API Reverse Engineer] Interceptores activos (capture mode v1.3.0)');
  }
})();
