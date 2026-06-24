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

  // captureConfig is updated by content.js via window.postMessage. Shape:
  // {
  //   preset: 'linkedin-voyager' | 'generic' | ...,
  //   patterns: Array<{type, value}>,
  //   filterMode: 'AND' | 'OR',
  //   redact: { enabled: boolean, headers: string[], body: string[] }
  // }
  var captureConfig = null;

  // Listen for captureConfig updates from content.js (which receives them
  // from the background service worker).
  window.addEventListener('message', function (event) {
    if (!event || !event.data) return;
    var msg = event.data;
    if (msg && msg.__ARE_CAPTURE_CONFIG__) {
      captureConfig = msg.captureConfig || null;
    }
  });

  // applyCapture — runs INSIDE the interceptors, BEFORE dispatching the event.
  // Returns the (possibly redacted) entry, or null if it should be skipped.
  function applyCapture(entry) {
    var cfg = captureConfig;
    if (!cfg) {
      // No config loaded yet — let it through unmodified (v1.2.3 compat).
      return entry;
    }

    // 1. URL filter (early skip — redaction is skipped entirely if filtered out)
    if (!shouldCapture(entry.url, cfg.patterns || [], cfg.filterMode || 'OR')) {
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
      status: entry.status,
      responseHeaders: entry.responseHeaders,
      responseBody: entry.responseBody,
      duration: entry.duration,
      timestamp: entry.timestamp,
      preset: cfg.preset || 'generic'
    };

    if (entry.error) redacted.error = entry.error; // pass through fetch errors

    if (cfg.redact && cfg.redact.enabled) {
      redacted.requestHeaders = redactHeaders(redacted.requestHeaders, cfg.redact.headers || []);
      redacted.responseHeaders = redactHeaders(redacted.responseHeaders, cfg.redact.headers || []);
      redacted.requestBody = redactBody(redacted.requestBody, cfg.redact.body || []);
      redacted.responseBody = redactBody(redacted.responseBody, cfg.redact.body || []);
    }

    return redacted;
  }

  function dispatch(entry) {
    var processed = applyCapture(entry);
    if (!processed) return; // filtered out
    window.dispatchEvent(new CustomEvent('__ARE_REQUEST__', {
      detail: processed
    }));
  }

  // --- FETCH interceptor ---
  var originalFetch = window.fetch;

  window.fetch = async function () {
    var args = Array.prototype.slice.call(arguments);
    var resource = args[0];
    var options = args[1] || {};
    var url = typeof resource === 'string' ? resource : (resource && resource.url) || '';
    var method = options.method || 'GET';
    var startTime = Date.now();

    var requestBody = null;
    try {
      if (options.body) {
        requestBody = typeof options.body === 'string'
          ? JSON.parse(options.body)
          : options.body;
      }
    } catch (e) {
      requestBody = options.body;
    }

    var requestHeaders = {};
    try {
      var h = new Headers(options.headers);
      h.forEach(function (v, k) { requestHeaders[k] = v; });
    } catch (e) {}

    try {
      var response = await originalFetch.apply(this, args);
      var cloned = response.clone();
      var duration = Date.now() - startTime;

      var responseBody = null;
      var contentType = response.headers.get('content-type') || '';
      if (contentType.indexOf('json') !== -1) {
        try { responseBody = await cloned.json(); } catch (e) {}
      } else {
        try { responseBody = await cloned.text(); } catch (e) {}
      }

      var responseHeaders = {};
      response.headers.forEach(function (v, k) { responseHeaders[k] = v; });

      dispatch({
        type: 'fetch',
        method: method,
        url: url,
        requestHeaders: requestHeaders,
        requestBody: requestBody,
        status: response.status,
        responseHeaders: responseHeaders,
        responseBody: responseBody,
        duration: duration,
        timestamp: new Date().toISOString()
      });

      return response;
    } catch (error) {
      dispatch({
        type: 'fetch',
        method: method,
        url: url,
        requestHeaders: requestHeaders,
        requestBody: requestBody,
        status: 'ERROR',
        error: error && error.message,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  };

  // --- XHR interceptor ---
  var OriginalXHR = window.XMLHttpRequest;

  window.XMLHttpRequest = function () {
    var xhr = new OriginalXHR();
    var method = 'GET';
    var url = '';
    var requestBody = null;
    var startTime = { value: null };

    var originalOpen = xhr.open.bind(xhr);
    xhr.open = function (m, u) {
      method = m;
      url = u;
      var rest = Array.prototype.slice.call(arguments, 2);
      return originalOpen.apply(null, [m, u].concat(rest));
    };

    var originalSend = xhr.send.bind(xhr);
    xhr.send = function (body) {
      startTime.value = Date.now();
      try {
        requestBody = body ? JSON.parse(body) : null;
      } catch (e) {
        requestBody = body;
      }

      xhr.addEventListener('loadend', function () {
        var responseBody = null;
        try {
          responseBody = JSON.parse(xhr.responseText);
        } catch (e) {
          responseBody = xhr.responseText;
        }

        var entry = {
          type: 'xhr',
          method: method,
          url: url,
          requestBody: requestBody,
          status: xhr.status,
          responseBody: responseBody,
          duration: Date.now() - (startTime.value || Date.now()),
          timestamp: new Date().toISOString()
        };

        // XHR rarely carries headers we set ourselves; response headers are
        // not exposed via the XHR object in the same way. Attach what we have.
        dispatch(entry);
      });

      return originalSend(body);
    };

    return xhr;
  };

  // Self-check: confirm captureConfig shim is loaded so redaction actually runs.
  if (!CC) {
    // eslint-disable-next-line no-console
    console.warn('[API Reverse Engineer] window.CaptureConfig missing — capture will be unfiltered and unredacted. Reload the page or check the extension files.');
  } else {
    // eslint-disable-next-line no-console
    console.log('[API Reverse Engineer] Interceptores activos (capture mode v1.3.0)');
  }
})();
