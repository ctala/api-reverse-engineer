/**
 * API Reverse Engineer v1.3.0 — capture-config tests
 *
 * Uses node:test (Node 20+). Covers:
 *   - parseFilter: literal / glob / regex detection, empty lines, invalid regex
 *   - shouldCapture: empty patterns (capture-all), OR mode, AND mode,
 *     literal, glob, regex patterns, non-string url
 *   - redactHeaders: case-insensitive substring, Set-Cookie edge case,
 *     non-object input, names=[] passthrough
 *   - redactBody: top-level keys, nested keys, arrays, raw string bodies
 *     (key=value and key: value), null/undefined/number/boolean passthrough
 *
 * Run: `node test/capture-config.test.mjs` from the repo root.
 *
 * The file under test (src/capture-config.js) is a UMD-style classic/CJS
 * module — not ESM — because Chrome extensions need classic scripts in MAIN
 * world. We load it via createRequire to keep the test file ESM (and thus
 * modern, fast node:test).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PRESETS,
  DEFAULT_PRESET_ID,
  parseFilter,
  shouldCapture,
  redactHeaders,
  redactBody
} = require('../src/capture-config.js');

// ---------------------------------------------------------------------------
// PRESETS sanity
// ---------------------------------------------------------------------------

test('PRESETS has exactly 4 entries: generic, linkedin-voyager, graphql, json-api', () => {
  assert.deepEqual(Object.keys(PRESETS).sort(), [
    'generic', 'graphql', 'json-api', 'linkedin-voyager'
  ]);
});

test('DEFAULT_PRESET_ID is generic', () => {
  assert.equal(DEFAULT_PRESET_ID, 'generic');
});

test('LinkedIn preset captures voyager/api + rsc-action + graphql (endpoints reales 2026)', () => {
  const preset = PRESETS['linkedin-voyager'];
  assert.ok(preset.patterns.length >= 3, 'incluye los 3 endpoints de datos');
  const inc = preset.patterns, exc = preset.exclude;
  assert.equal(shouldCapture('https://www.linkedin.com/voyager/api/me', inc, 'OR', exc), true);
  assert.equal(shouldCapture('https://www.linkedin.com/flagship-web/rsc-action/actions/component', inc, 'OR', exc), true);
  assert.equal(shouldCapture('https://www.linkedin.com/voyager/api/graphql', inc, 'OR', exc), true);
  // funciona con URL relativa (substring) — como las que dispara la SPA
  assert.equal(shouldCapture('/voyager/api/feed/updates', inc, 'OR', exc), true);
});

test('LinkedIn preset EXCLUYE telemetría/estáticos (exclude gana sobre include)', () => {
  const preset = PRESETS['linkedin-voyager'];
  const inc = preset.patterns, exc = preset.exclude;
  // static.licdn matchea el include (/voyager/api/) pero el exclude gana → fuera
  assert.equal(shouldCapture('https://static.licdn.com/voyager/api/foo', inc, 'OR', exc), false);
  assert.equal(shouldCapture('https://www.linkedin.com/li/track?trk=foo', inc, 'OR', exc), false);
  // ruido que ni siquiera matchea el include → fuera
  assert.equal(shouldCapture('https://www.linkedin.com/rest/trackO11yApi/trackO11y', inc, 'OR', exc), false);
  // endpoint de datos legítimo sigue pasando
  assert.equal(shouldCapture('https://www.linkedin.com/voyager/api/me', inc, 'OR', exc), true);
});

test('shouldCapture: exclude descarta aunque el include matchee (general)', () => {
  const inc = [{ type: 'literal', value: '/api/' }];
  const exc = [{ type: 'literal', value: '/api/track' }];
  assert.equal(shouldCapture('https://x.test/api/data', inc, 'OR', exc), true);
  assert.equal(shouldCapture('https://x.test/api/track/beacon', inc, 'OR', exc), false);
  // sin exclude el comportamiento previo se mantiene
  assert.equal(shouldCapture('https://x.test/api/track/beacon', inc, 'OR'), true);
});

test('All presets have redact headers and body arrays (non-empty when redact enabled)', () => {
  for (const id of Object.keys(PRESETS)) {
    const p = PRESETS[id];
    assert.equal(p.redact.enabled, true, `${id} should default to redact enabled`);
    assert.ok(Array.isArray(p.redact.headers), `${id} redact.headers must be array`);
    assert.ok(Array.isArray(p.redact.body), `${id} redact.body must be array`);
    assert.ok(p.redact.headers.length > 0, `${id} must have at least one header pattern`);
    assert.ok(p.redact.body.length > 0, `${id} must have at least one body pattern`);
  }
});

// ---------------------------------------------------------------------------
// parseFilter
// ---------------------------------------------------------------------------

test('parseFilter: empty / whitespace / non-string → []', () => {
  assert.deepEqual(parseFilter(''), []);
  assert.deepEqual(parseFilter('   \n  \n   '), []);
  assert.deepEqual(parseFilter(null), []);
  assert.deepEqual(parseFilter(undefined), []);
  assert.deepEqual(parseFilter(123), []);
});

test('parseFilter: literal lines', () => {
  const out = parseFilter('api2.skool.com\nexample.com/users');
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'literal');
  assert.equal(out[0].value, 'api2.skool.com');
  assert.equal(out[1].type, 'literal');
  assert.equal(out[1].value, 'example.com/users');
});

test('parseFilter: lines that start with `/` are regex (per spec)', () => {
  // Spec: lines wrapped in /.../flags are regex. `/voyager/api/` looks like
  // a literal but starts with `/`, so it is parsed as regex.
  const out = parseFilter('api2.skool.com\n/voyager/api/');
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'literal');
  assert.equal(out[1].type, 'regex');
});

test('parseFilter: glob lines (containing * or ? outside /.../)', () => {
  // No leading `/`, no `[...]` char-class — pure shell-style glob.
  const out = parseFilter('*api*\nfoo?bar*');
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'glob');
  assert.equal(out[1].type, 'glob');
});

test('parseFilter: regex lines wrapped in /.../ with flags', () => {
  const out = parseFilter('/^https:\\/\\/api\\.example\\.com\\//i\n/graphql$/');
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'regex');
  assert.equal(out[0].value, '/^https:\\/\\/api\\.example\\.com\\//i');
  assert.equal(out[1].type, 'regex');
  assert.equal(out[1].value, '/graphql$/');
});

test('parseFilter: invalid regex line becomes literal-with-invalid flag (does not throw)', () => {
  const out = parseFilter('/[unclosed/');
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'literal');
  assert.equal(out[0].invalid, true);
  assert.equal(out[0].value, '/[unclosed/');
});

test('parseFilter: empty lines ignored', () => {
  const out = parseFilter('\napi.example.com\n\n/voyager/\n');
  assert.equal(out.length, 2);
});

// ---------------------------------------------------------------------------
// shouldCapture
// ---------------------------------------------------------------------------

test('shouldCapture: empty patterns → always true', () => {
  assert.equal(shouldCapture('https://anything.test', [], 'OR'), true);
  assert.equal(shouldCapture('https://anything.test', [], 'AND'), true);
  assert.equal(shouldCapture('https://anything.test', null, 'OR'), true);
  assert.equal(shouldCapture('https://anything.test', undefined, 'AND'), true);
});

test('shouldCapture: OR mode — any match passes', () => {
  const patterns = parseFilter('foo.test\n/bar/');
  assert.equal(shouldCapture('https://foo.test/x', patterns, 'OR'), true);
  assert.equal(shouldCapture('https://other.test/bar/y', patterns, 'OR'), true);
  assert.equal(shouldCapture('https://other.test/baz', patterns, 'OR'), false);
});

test('shouldCapture: AND mode — every pattern must match', () => {
  const patterns = parseFilter('foo.test\n/bar/');
  // foo.test AND /bar/
  assert.equal(shouldCapture('https://foo.test/bar/x', patterns, 'AND'), true);
  assert.equal(shouldCapture('https://foo.test/baz', patterns, 'AND'), false);
  assert.equal(shouldCapture('https://other.test/bar/y', patterns, 'AND'), false);
});

test('shouldCapture: default mode is OR (backward-compat with v1.2.3)', () => {
  const patterns = parseFilter('foo.test');
  assert.equal(shouldCapture('https://foo.test/x', patterns), true);
  assert.equal(shouldCapture('https://other.test', patterns), false);
});

test('shouldCapture: glob pattern', () => {
  // Shell-style glob: * → any chars, ? → single char. No character-class syntax.
  const patterns = parseFilter('*/api/v?/*');
  assert.equal(shouldCapture('https://example.com/api/v1/users', patterns, 'OR'), true);
  assert.equal(shouldCapture('https://example.com/api/v2/users', patterns, 'OR'), true);
  assert.equal(shouldCapture('https://example.com/api/v10/users', patterns, 'OR'), false);
  assert.equal(shouldCapture('https://example.com/api/x/users', patterns, 'OR'), false);
});

test('shouldCapture: regex pattern with flags', () => {
  const patterns = parseFilter('/^https:\\/\\/.*\\.example\\.com\\//i');
  assert.equal(shouldCapture('https://API.example.com/users', patterns, 'OR'), true);
  assert.equal(shouldCapture('https://other.com/users', patterns, 'OR'), false);
});

test('shouldCapture: empty / non-string url → false (when patterns non-empty)', () => {
  const patterns = parseFilter('foo');
  assert.equal(shouldCapture('', patterns, 'OR'), false);
  assert.equal(shouldCapture(null, patterns, 'OR'), false);
  assert.equal(shouldCapture(undefined, patterns, 'OR'), false);
});

// ---------------------------------------------------------------------------
// redactHeaders
// ---------------------------------------------------------------------------

test('redactHeaders: non-object input → empty object', () => {
  assert.deepEqual(redactHeaders(null, ['cookie']), {});
  assert.deepEqual(redactHeaders(undefined, ['cookie']), {});
  assert.deepEqual(redactHeaders('not-an-object', ['cookie']), {});
});

test('redactHeaders: case-insensitive substring match against header NAME', () => {
  const headers = {
    'Cookie': 'li_at=ABC123; JSESSIONID=xyz',
    'X-API-Key': 'secret-api-key',
    'Accept': 'application/json'
  };
  const out = redactHeaders(headers, ['cookie', 'x-api-key']);
  assert.equal(out['Cookie'], '[REDACTED:Cookie]');
  assert.equal(out['X-API-Key'], '[REDACTED:X-API-Key]');
  assert.equal(out['Accept'], 'application/json');
  // Raw secret value must not appear anywhere in the output.
  assert.ok(!JSON.stringify(out).includes('ABC123'));
  assert.ok(!JSON.stringify(out).includes('secret-api-key'));
});

test('redactHeaders: Set-Cookie edge case (value contains the substring "cookie")', () => {
  const headers = {
    'Set-Cookie': 'li_at=ABC; Path=/; HttpOnly',
    'set-cookie': 'JSESSIONID=xyz; Path=/'
  };
  const out = redactHeaders(headers, ['cookie']);
  // Both variants must be redacted (substring "cookie" matches both).
  assert.equal(out['Set-Cookie'], '[REDACTED:Set-Cookie]');
  assert.equal(out['set-cookie'], '[REDACTED:set-cookie]');
  assert.ok(!JSON.stringify(out).includes('ABC'));
  assert.ok(!JSON.stringify(out).includes('xyz'));
});

test('redactHeaders: empty names list returns a copy (defensive, original casing)', () => {
  const headers = { 'X-Foo': 'bar' };
  const out = redactHeaders(headers, []);
  assert.notEqual(out, headers);
  assert.equal(out['X-Foo'], 'bar');
  // Original casing preserved (we don't lowercase keys when not redacting).
  assert.equal(Object.keys(out)[0], 'X-Foo');
});

test('redactHeaders: never mutates input', () => {
  const headers = { Cookie: 'li_at=ABC' };
  const snapshot = JSON.stringify(headers);
  redactHeaders(headers, ['cookie']);
  assert.equal(JSON.stringify(headers), snapshot);
});

// ---------------------------------------------------------------------------
// redactBody
// ---------------------------------------------------------------------------

test('redactBody: null / undefined / non-object-primitive → passthrough', () => {
  const keys = ['password'];
  assert.equal(redactBody(null, keys), null);
  assert.equal(redactBody(undefined, keys), undefined);
  assert.equal(redactBody(42, keys), 42);
  assert.equal(redactBody(true, keys), true);
  assert.equal(redactBody('plain string', []), 'plain string');
});

test('redactBody: top-level keys redacted', () => {
  const body = {
    username: 'cristian',
    password: 'hunter2',
    access_token: 'eyJabc.def.ghi',
    nested: { password: 'inner', ok: true }
  };
  const out = redactBody(body, ['password', 'access_token']);
  assert.equal(out.username, 'cristian');
  assert.equal(out.password, '[REDACTED:password]');
  assert.equal(out.access_token, '[REDACTED:access_token]');
  // Nested (1 level) is also redacted.
  assert.equal(out.nested.password, '[REDACTED:password]');
  assert.equal(out.nested.ok, true);
  // Raw secret value must not appear anywhere in the serialized output.
  assert.ok(!JSON.stringify(out).includes('hunter2'));
  assert.ok(!JSON.stringify(out).includes('eyJabc'));
});

test('redactBody: substring match on key (case-insensitive)', () => {
  const body = {
    'X-Password': 'secret1',
    'Access_Token': 'tok',
    nested: { 'MyPassword': 'secret2', ok: 1 }
  };
  const out = redactBody(body, ['password', 'access_token']);
  assert.equal(out['X-Password'], '[REDACTED:X-Password]');
  assert.equal(out['Access_Token'], '[REDACTED:Access_Token]');
  assert.equal(out.nested['MyPassword'], '[REDACTED:MyPassword]');
});

test('redactBody: arrays — each element processed recursively', () => {
  const body = [
    { username: 'a', password: 'pw1' },
    { username: 'b', password: 'pw2' }
  ];
  const out = redactBody(body, ['password']);
  assert.equal(out[0].username, 'a');
  assert.equal(out[0].password, '[REDACTED:password]');
  assert.equal(out[1].password, '[REDACTED:password]');
  assert.ok(!JSON.stringify(out).includes('pw1'));
  assert.ok(!JSON.stringify(out).includes('pw2'));
});

test('redactBody: raw string body — key=value form-encoded', () => {
  const body = 'username=cristian&password=hunter2&remember=true';
  const out = redactBody(body, ['password']);
  assert.ok(out.includes('username=cristian'), 'non-secret part preserved');
  assert.ok(out.includes('[REDACTED:password]'), 'password redacted');
  assert.ok(!out.includes('hunter2'), 'raw password value gone');
});

test('redactBody: raw string body — key: value text/plain', () => {
  const body = 'username: cristian\npassword: hunter2\nok: true';
  const out = redactBody(body, ['password']);
  assert.ok(out.includes('username: cristian'));
  assert.ok(out.includes('[REDACTED:password]'));
  assert.ok(out.includes('ok: true'));
  assert.ok(!out.includes('hunter2'));
});

test('redactBody: empty keys list → passthrough', () => {
  const body = { password: 'hunter2', nested: { x: 1 } };
  const out = redactBody(body, []);
  assert.deepEqual(out, body);
});

test('redactBody: deeper-than-1 nesting leaves secrets untouched (documented limit)', () => {
  // Defence in depth: only top + 1 level. Deeper is unchanged.
  const body = { outer: { inner: { password: 'hunter2' } } };
  const out = redactBody(body, ['password']);
  assert.equal(out.outer.inner.password, 'hunter2');
});

test('redactBody: never mutates input', () => {
  const body = { password: 'hunter2' };
  const snapshot = JSON.stringify(body);
  redactBody(body, ['password']);
  assert.equal(JSON.stringify(body), snapshot);
});
