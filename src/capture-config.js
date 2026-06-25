/**
 * API Reverse Engineer — Capture Config (v1.3.0)
 *
 * Pure helpers used by `injected.js` (MAIN world) to gate capture and redact
 * secrets BEFORE the entry crosses the postMessage bridge into the content
 * script. No DOM, no chrome.* APIs, no network. ES2022, no dependencies.
 *
 * Loaded two ways:
 *   - Browser / Chrome extension (classic script via <script> tag or
 *     chrome.scripting.executeScript): attaches `window.CaptureConfig`.
 *   - Node tests (CJS via createRequire): returns `module.exports`.
 *
 * Four helpers:
 *   1. parseFilter(rawText) → Array<{type, value}>
 *        One pattern per line. Lines wrapped in `/.../i` (or `/.../`) are
 *        treated as regex. Lines containing `*` or `?` outside regex
 *        wrappers are treated as globs (translated to anchored regex).
 *        Everything else is a literal substring.
 *   2. shouldCapture(url, patterns, mode) → boolean
 *        Empty patterns === capture-all. Mode is 'AND' or 'OR' (default OR).
 *        Regex is compiled lazily with a WeakMap cache.
 *   3. redactHeaders(headers, names) → headers (returns a new object, original casing)
 *        Case-insensitive substring match against header NAME (not value).
 *        Replaces VALUE with "[REDACTED:<original-name>]". Never logs raw value.
 *   4. redactBody(body, keys) → body
 *        Case-insensitive substring match against top-level + 1 nested key.
 *        Replaces VALUE with "[REDACTED:<original-key>]". For raw string
 *        bodies, redacts `key=value` and `key: value` segments.
 *
 * Naming is pinned by reviewer checklist (docs/spec/.pr-body-capture-mode.md,
 * commit b090d6a, 2026-06-23): redactHeaders / redactBody. Do NOT rename.
 */

(function (root, factory) {
  'use strict';
  var api = factory();
  // Browser / extension classic-script context — attach to the global.
  // Works in MAIN world (window == page window) and ISOLATED world.
  if (typeof window !== 'undefined') {
    window.CaptureConfig = api;
  }
  // Service worker / Node CJS — module.exports.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  // Fallback for any other global context (Node ESM via globalThis).
  if (typeof globalThis !== 'undefined' && typeof globalThis.CaptureConfig === 'undefined') {
    globalThis.CaptureConfig = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // -------------------------------------------------------------------------
  // PRESETS — the four profile presets surfaced in the popup dropdown.
  // -------------------------------------------------------------------------

  var PRESETS = Object.freeze({
    generic: Object.freeze({
      id: 'generic',
      label: '[Generic]',
      sortOrder: 99,
      patterns: [], // empty → capture everything
      filterMode: 'OR',
      redact: Object.freeze({
        enabled: true,
        headers: Object.freeze([
          'cookie', 'set-cookie', 'authorization', 'x-api-key',
          'x-auth-token', 'csrf-token', 'x-csrf-token'
        ]),
        body: Object.freeze([
          'password', 'client_secret', 'access_token', 'refresh_token',
          'id_token', 'session_token', 'csrf_token', 'private_key',
          'privateKey', 'code', 'cookie', 'set-cookie'
        ])
      })
    }),
    'linkedin-voyager': Object.freeze({
      id: 'linkedin-voyager',
      label: '[LinkedIn]',
      sortOrder: 1,
      // Endpoints reales del LinkedIn web 2026: además del Voyager clásico
      // (/voyager/api/), el flagship-web moderno usa RSC actions
      // (/rsc-action/) y GraphQL. Patterns por substring para que funcionen
      // con URLs relativas resueltas a absolutas (ver injected.js).
      patterns: Object.freeze([
        Object.freeze({ type: 'literal', value: '/voyager/api/' }),
        Object.freeze({ type: 'literal', value: '/rsc-action/' }),
        Object.freeze({ type: 'literal', value: '/api/graphql' }),
        // #20: LinkedIn realtime WebSocket (messaging/presence) lives at a
        // 'realtime' host/path; capture its frames with the LinkedIn preset.
        Object.freeze({ type: 'literal', value: 'realtime' })
      ]),
      // Excluir el ruido de telemetría/estáticos que no es API de datos.
      exclude: Object.freeze([
        Object.freeze({ type: 'literal', value: 'trackO11y' }),
        Object.freeze({ type: 'literal', value: 'sensorCollect' }),
        Object.freeze({ type: 'literal', value: 'trackingApiService' }),
        Object.freeze({ type: 'literal', value: 'trackMedia' }),
        Object.freeze({ type: 'literal', value: '/li/track' }),
        Object.freeze({ type: 'literal', value: '/sct' }),
        Object.freeze({ type: 'literal', value: 'static.licdn.com' })
      ]),
      filterMode: 'OR',
      redact: Object.freeze({
        enabled: true,
        headers: Object.freeze([
          'cookie', 'set-cookie', 'csrf-token', 'x-li-pem-metadata',
          'x-li-pem', 'x-li-track', 'x-li-decorators', 'authorization'
          // B10: x-restli-protocol-version NO se redacta — es la constante
          // '2.0.0', no un secreto, y se necesita para replay.
        ]),
        body: Object.freeze([
          'password', 'client_secret', 'access_token', 'refresh_token',
          'id_token', 'session_token', 'csrf_token',
          'private_key', 'privateKey', 'code', 'cookie', 'set-cookie'
        ])
      })
    }),
    graphql: Object.freeze({
      id: 'graphql',
      label: '[GraphQL]',
      sortOrder: 2,
      patterns: Object.freeze([
        Object.freeze({ type: 'literal', value: '/graphql' })
      ]),
      filterMode: 'OR',
      redact: Object.freeze({
        enabled: true,
        headers: Object.freeze([
          'cookie', 'set-cookie', 'authorization', 'x-api-key',
          'x-auth-token', 'csrf-token', 'x-csrf-token'
        ]),
        body: Object.freeze([
          'password', 'client_secret', 'access_token', 'refresh_token',
          'id_token', 'session_token', 'csrf_token', 'private_key',
          'privateKey', 'code', 'cookie', 'set-cookie'
        ])
      })
    }),
    'json-api': Object.freeze({
      id: 'json-api',
      label: '[JSON API]',
      sortOrder: 3,
      patterns: [], // empty → capture all; JSON filtering is content-type side
      filterMode: 'OR',
      redact: Object.freeze({
        enabled: true,
        headers: Object.freeze([
          'cookie', 'set-cookie', 'authorization', 'x-api-key',
          'x-auth-token', 'csrf-token', 'x-csrf-token'
        ]),
        body: Object.freeze([
          'password', 'client_secret', 'access_token', 'refresh_token',
          'id_token', 'session_token', 'csrf_token', 'private_key',
          'privateKey', 'code', 'cookie', 'set-cookie'
        ])
      })
    })
  });

  // Default preset used when popup hasn't chosen one (or for legacy v1.2.3 path).
  // Generic = capturar todo, redacción de secretos comunes ON. El usuario elige
  // un preset específico (LinkedIn, GraphQL…) cuando quiere narrowear.
  var DEFAULT_PRESET_ID = 'generic';

  // -------------------------------------------------------------------------
  // parseFilter
  // -------------------------------------------------------------------------

  /**
   * Parse a multi-line filter string into an array of pattern descriptors.
   *
   * Each non-empty line becomes one pattern:
   *   - "/^.../flags" → regex (with optional flags)
   *   - contains `*` or `?` outside regex wrapper → glob → anchored regex
   *   - otherwise → literal substring
   *
   * Invalid regex lines do not throw; they are kept as literals with
   * `invalid: true` so callers can surface a warning to the user.
   */
  function parseFilter(rawText) {
    if (typeof rawText !== 'string' || rawText.length === 0) return [];
    var out = [];
    var lines = rawText.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var trimmed = String(lines[i]).trim();
      if (trimmed.length === 0) continue;

      // Regex form: /pattern/flags — must start with `/` and contain a closing `/`
      if (trimmed.charAt(0) === '/') {
        var lastSlash = trimmed.lastIndexOf('/');
        if (lastSlash > 0) {
          var pattern = trimmed.slice(1, lastSlash);
          var flags = trimmed.slice(lastSlash + 1);
          try {
            // Validate by compiling; discard the result (shouldCapture caches its own).
            new RegExp(pattern, flags);
            out.push({ type: 'regex', value: trimmed });
          } catch (e) {
            out.push({ type: 'literal', value: trimmed, invalid: true });
          }
          continue;
        }
      }

      // Glob: contains `*` or `?` outside a regex wrapper
      if (trimmed.indexOf('*') !== -1 || trimmed.indexOf('?') !== -1) {
        out.push({ type: 'glob', value: trimmed });
        continue;
      }

      out.push({ type: 'literal', value: trimmed });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // shouldCapture
  // -------------------------------------------------------------------------

  // WeakMap cache: pattern object → compiled RegExp. Pattern objects are stable
  // across calls (parsed once per page-load from chrome.storage), so this works.
  var _regexCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  function _compileRegex(patternValue) {
    // Wrapped form: /pat/flags — typical user-entered pattern from the textarea.
    if (patternValue.charAt(0) === '/') {
      var lastSlash = patternValue.lastIndexOf('/');
      if (lastSlash > 0) {
        return new RegExp(
          patternValue.slice(1, lastSlash),
          patternValue.slice(lastSlash + 1)
        );
      }
    }
    // Raw source form (preset patterns): value is already the regex source,
    // no flags. Compile with 'i' default so case-insensitive matching Just Works.
    try {
      return new RegExp(patternValue, 'i');
    } catch (e) {
      return null;
    }
  }

  function _globToRegex(glob) {
    // Glob syntax (intentionally simple — no [...] char-class support):
    //   *  → any chars
    //   ?  → single char
    //   everything else → literal (regex meta-chars are escaped)
    var META = { '.': 1, '+': 1, '^': 1, '$': 1, '{': 1, '}': 1,
                 '(': 1, ')': 1, '|': 1, '[': 1, ']': 1, '\\': 1 };
    var body = '';
    var s = String(glob);
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '*') body += '.*';
      else if (ch === '?') body += '.';
      else if (META[ch]) body += '\\' + ch;
      else body += ch;
    }
    return new RegExp('^' + body + '$');
  }

  function _matchOne(url, pattern) {
    switch (pattern.type) {
      case 'regex': {
        var re1 = _regexCache && _regexCache.get(pattern);
        if (!re1) {
          re1 = _compileRegex(pattern.value);
          if (re1 && _regexCache) _regexCache.set(pattern, re1);
        }
        // Fallback: if compilation failed (invalid regex), treat as literal.
        return re1 ? re1.test(url) : url.indexOf(pattern.value) !== -1;
      }
      case 'glob': {
        var re2 = _regexCache && _regexCache.get(pattern);
        if (!re2) {
          re2 = _globToRegex(pattern.value);
          if (re2 && _regexCache) _regexCache.set(pattern, re2);
        }
        return re2.test(url);
      }
      case 'literal':
      default:
        return url.indexOf(pattern.value) !== -1;
    }
  }

  /**
   * @param {string} url — full URL of the request
   * @param {Array<{type, value}>} patterns — output of parseFilter
   * @param {'AND'|'OR'} [mode] — default 'OR' for backward-compat with v1.2.3
   * @returns {boolean}
   */
  function shouldCapture(url, patterns, mode, exclude) {
    var hasInclude = Array.isArray(patterns) && patterns.length > 0;
    var hasExclude = Array.isArray(exclude) && exclude.length > 0;

    if (typeof url !== 'string' || url.length === 0) {
      // Empty url: capture only if there's no include filter (capture-all).
      return !hasInclude;
    }
    // Exclude wins over include — filters telemetry/static noise even when the
    // include patterns would otherwise match.
    if (hasExclude && exclude.some(function (p) { return _matchOne(url, p); })) {
      return false;
    }
    if (!hasInclude) return true;
    var m = mode === 'AND' ? 'AND' : 'OR';
    return m === 'AND'
      ? patterns.every(function (p) { return _matchOne(url, p); })
      : patterns.some(function (p) { return _matchOne(url, p); });
  }

  // -------------------------------------------------------------------------
  // redactHeaders
  // -------------------------------------------------------------------------

  /**
   * Return a new headers object with values for matching header NAMES replaced
   * by "[REDACTED:<original-name>]". Match is case-insensitive substring.
   * Never logs raw value.
   */
  function redactHeaders(headers, names) {
    if (!headers || typeof headers !== 'object') return {};
    var nameList = Array.isArray(names) ? names : [];
    if (nameList.length === 0) {
      // No redaction requested — return a defensive copy with original casing.
      var empty = {};
      for (var k0 in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, k0)) empty[k0] = headers[k0];
      }
      return empty;
    }
    var lowerNames = nameList.map(function (n) { return String(n).toLowerCase(); });
    var out = {};
    var keys = Object.keys(headers);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var rawValue = headers[key];
      var lk = String(key).toLowerCase();
      var match = undefined;
      for (var j = 0; j < lowerNames.length; j++) {
        if (lk.indexOf(lowerNames[j]) !== -1) { match = lowerNames[j]; break; }
      }
      if (match !== undefined) {
        // Use the original-case header name in the placeholder so the dev
        // can still grep for `Set-Cookie` and find `[REDACTED:Set-Cookie]`.
        out[key] = '[REDACTED:' + key + ']';
      } else {
        out[key] = rawValue;
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // redactBody
  // -------------------------------------------------------------------------

  // Recurse fully through objects AND arrays, redacting any value whose KEY
  // matches the list (case-insensitive substring). The old version stopped at
  // ONE nested level and skipped arrays entirely — so a secret inside the
  // canonical Voyager `included:[{access_token}]` shape, or nested >1 level
  // deep, leaked through (audit findings #3/#13). Guards: MAX_REDACT_DEPTH
  // (runaway) + a DFS `seen` stack (cycle protection — captured bodies can be
  // self-referential). NOTE: this only runs when redact.enabled; in raw mode
  // (toggle off) nothing here executes, so RE fidelity is untouched.
  var MAX_REDACT_DEPTH = 24;

  function _redactValue(value, lowerKeys, depth, seen) {
    if (value === null || typeof value !== 'object') return value;
    if (depth > MAX_REDACT_DEPTH) return value;
    if (seen.indexOf(value) !== -1) return value; // cycle guard
    seen.push(value);
    var result;
    if (Array.isArray(value)) {
      result = [];
      for (var i = 0; i < value.length; i++) {
        result.push(_redactValue(value[i], lowerKeys, depth + 1, seen));
      }
    } else {
      result = {};
      var keys = Object.keys(value);
      for (var n = 0; n < keys.length; n++) {
        var k = keys[n];
        var lk = String(k).toLowerCase();
        var matched = false;
        for (var j = 0; j < lowerKeys.length; j++) {
          if (lk.indexOf(lowerKeys[j]) !== -1) { matched = true; break; }
        }
        result[k] = matched ? '[REDACTED:' + k + ']' : _redactValue(value[k], lowerKeys, depth + 1, seen);
      }
    }
    seen.pop();
    return result;
  }

  // Redact secret VALUES that ride in URL query/fragment params (audit #2):
  // ?csrfToken=…, OAuth ?access_token=… / #access_token=…. The path is left
  // intact; only param values whose key matches the list are masked.
  function redactUrl(url, keyList) {
    var raw = String(url == null ? '' : url);
    var list = Array.isArray(keyList) ? keyList : [];
    if (list.length === 0) return raw;
    var sepIdx = raw.search(/[?#]/);
    if (sepIdx === -1) return raw;
    var head = raw.slice(0, sepIdx);
    var tail = raw.slice(sepIdx); // includes the ? or #
    for (var i = 0; i < list.length; i++) {
      var safeKey = String(list[i]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var re = new RegExp('(' + safeKey + ')(=)([^&#\\s]*)', 'gi');
      tail = tail.replace(re, function (_m, k, eq) { return k + eq + '[REDACTED:' + k + ']'; });
    }
    return head + tail;
  }

  function _redactStringBody(str, keyList) {
    // Match `key=value` (terminated by `&`, `;`, whitespace, or end-of-string)
    // and `key: value` (terminated by newline, comma, or end-of-string).
    // We don't try to be perfectly RFC 3986 compliant — this is a defence
    // in depth pass for form-encoded and text/plain bodies. The structured
    // path above covers application/json.
    var safe = String(str);
    var out = safe;
    for (var i = 0; i < keyList.length; i++) {
      var key = keyList[i];
      var safeKey = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // key=value (URL-encoded form)
      var reEq = new RegExp('(' + safeKey + ')\\s*=\\s*([^&;\\s]*)', 'gi');
      out = out.replace(reEq, function (_m, k) { return k + '=[REDACTED:' + k + ']'; });
      // key: value (text/plain key-value lines)
      var reColon = new RegExp('(^|\\n|,)(\\s*)(' + safeKey + ')\\s*:\\s*([^\\n,]*)', 'gi');
      out = out.replace(reColon, function (_m, pre, ws, k) {
        return pre + ws + k + ': [REDACTED:' + k + ']';
      });
    }
    return out;
  }

  /**
   * Return a new body with values for matching KEYS replaced by
   * "[REDACTED:<original-key>]". Match is case-insensitive substring against
   * top-level and one-level-nested keys. For raw string bodies, redact
   * `key=value` and `key: value` substrings where key is in the list.
   *
   * Never logs raw value. Returns the input unchanged if it's not a structured
   * value we can reason about (number, boolean, null, undefined).
   */
  function redactBody(body, keys) {
    if (body === null || body === undefined) return body;
    var keyList = Array.isArray(keys) ? keys : [];
    if (keyList.length === 0) return body;

    // String body (raw text / form-encoded / text/plain) — redact key=value and key: value
    if (typeof body === 'string') {
      return _redactStringBody(body, keyList);
    }

    // Object OR array body — recurse fully (objects + arrays, depth/cycle-guarded)
    if (typeof body === 'object') {
      var lowerKeys = keyList.map(function (k) { return String(k).toLowerCase(); });
      return _redactValue(body, lowerKeys, 0, []);
    }

    return body;
  }

  return {
    PRESETS: PRESETS,
    DEFAULT_PRESET_ID: DEFAULT_PRESET_ID,
    parseFilter: parseFilter,
    shouldCapture: shouldCapture,
    redactHeaders: redactHeaders,
    redactBody: redactBody,
    redactUrl: redactUrl
  };
});
