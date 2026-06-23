# LinkedIn Voyager Preset — Capture Mode v1.3.0

> **Status:** Draft
> **Date:** 2026-06-23
> **Owner:** linkedin-architect
> **Companion:** [`capture-mode-spec.md`](./capture-mode-spec.md)

This document pins the exact configuration the `LinkedIn Voyager` preset
ships with. The preset is the primary user-facing path for the
`linkedin-all-in-one-api` reverse-engineering workflow: open LinkedIn in a
logged-in tab, start the plugin, walk through the site, stop, drop the
downloaded `.jsonl` into `captures-live/`.

## Preset identity

| Field | Value |
|---|---|
| `preset.id` | `linkedin-voyager` |
| `preset.label` | `[LinkedIn Voyager]` |
| `preset.sortOrder` | 1 (first non-Generic in the dropdown) |
| `preset.iconHint` | (optional, future) `🔵` |

## URL filter

```
^https://www\.linkedin\.com/(voyager/api/|li/track)
```

This is a single regex passed in `OR` mode (so it counts as one pattern).
The dev can pre-fill the multi-line filter as one entry — no need to split
into two patterns.

| Component | What it captures | Why |
|---|---|---|
| `voyager/api/` | The actual API calls (`/voyager/api/me`, `/voyager/api/feed/...`, `/voyager/api/messaging/...`, GraphQL at `/voyager/api/graphql`). | This is the surface the actor targets. |
| `li/track` | LinkedIn's analytics beacon (302 redirect before the real call). | Useful for the actor's anti-bot research; not strictly required for action replay. |

### Excluded by design

- `linkedin.com/li/track?` **with `trk=` containing `premium-`** — already
  covered by the regex; left in.
- `linkedin.com/login`, `linkedin.com/signup`, `linkedin.com/uas/...` —
  excluded. Login flows are out of scope for v1.3.0 (the actor handles
  login via Playwright cold path, not from captures).
- `static.licdn.com`, `media.licdn.com`, `px.ads.linkedin.com` — excluded.
  These are static assets and ad pixels; not API.
- `linkedin.com/voyager/api/voyagerRedirect` — excluded. Internal redirector.
- WebSocket upgrades to `wss://*.linkedin.com/...` — excluded. Out of scope
  for v1.3.0.

## Redact patterns

### Headers (case-insensitive substring match against the header NAME)

The following header names have their **value** replaced with
`"[REDACTED:<original-name>]"`:

| Header name | Why redact |
|---|---|
| `cookie` | Carries `li_at`, `li_a`, `JSESSIONID`, `bscookie` — the full auth tuple. |
| `set-cookie` | Response side; same auth tuple. |
| `csrf-token` | LinkedIn's CSRF token, required for any write operation. Compromise of this token == compromise of the account. |
| `x-li-pem-metadata` | Page-Event-Metadata: includes page URN and timestamps; we want request shape, not session analytics. |
| `x-restli-protocol-version` | Low-risk on its own, but it correlates with a specific LinkedIn build; redact for hygiene. |
| `x-li-track` | Often a JSON blob with device fingerprinting data. Redact by default; allow opt-in via "Redact OFF" if the dev is researching fingerprinting. |
| `x-li-pem` | Same family as `x-li-pem-metadata`. |
| `x-li-decorators` | Hint of build config; not a secret but clutter. |
| `authorization` | Not standard in Voyager, but if a future endpoint uses it, the Generic preset already redacts this; carry the rule forward. |

### Cookies (the value side of the `cookie` header is `[REDACTED:cookie]`)

The `cookie` header is redacted wholesale. There is no partial-redact mode in
v1.3.0 — the user gets a single string `"[REDACTED:cookie]"` rather than
`"li_at=[REDACTED:li_at]; JSESSIONID=[REDACTED:JSESSIONID]"`. The reasoning
is in [`adr-0001-capture-mode.md`](./adr-0001-capture-mode.md#alternatives-considered):
partial-redact invites accidental leak via substring matching, and full-redact
is the LinkedIn Voyager threat-model-safe default.

For the dev to test "did the cookie actually arrive?", the JSONL entry
keeps the `cookie` header KEY; only the value is gone. The dev can confirm
the request was authenticated by checking that the response status is 200
(not 401/302 to login).

### Body (case-insensitive substring match against top-level + 1 nested key)

| Body key | Why redact |
|---|---|
| `password` | Plain. |
| `client_secret` | OAuth client secret. |
| `access_token` | OAuth bearer. |
| `refresh_token` | Long-lived credential. |
| `*_token` | Glob match — covers `id_token`, `csrf_token`, `session_token`, etc. |
| `*_secret` | Glob match — covers `client_secret`, `app_secret`, `webhook_secret`. |
| `code` | OAuth auth code (short-lived but still credential). |
| `privateKey`, `private_key` | PEM private keys (LinkedIn does not return these in API, but defence in depth). |
| `cookie`, `set-cookie` | If the body is form-encoded and contains cookie values. |

For raw-text (non-JSON) bodies, redact substring `key=value` and
`key: value` segments where `key` is in the above list. This catches
`application/x-www-form-urlencoded` and the occasional
`text/plain` payload.

## Truncation

- **Body cap: 5 MB** (5,242,880 bytes) per response.
- **Binary skip**: `image/*`, `video/*`, `audio/*`, `application/octet-stream`,
  `application/pdf`, `application/zip`, `font/*` — the body is replaced with
  `{"_skipped":"binary","_contentType":"<...>","_contentLength":<n>}` and the
  request is still recorded.
- **Max events per session: 10,000.** Warning at 9,000; auto-stop at 10,000.

The 5 MB cap is high enough that **real Voyager responses do not hit it**.
The largest responses seen in the existing `captures/` directory (which use
the v1.2.3 plugin output) are ~3 MB for a profile search with 50 results.
The cap exists for the rare case of a profile-with-attachment or
messaging-attachment preview.

## Example captured line

```jsonl
{"ts":"2026-06-23T12:34:56.789Z","tab":1823456712,"preset":"linkedin-voyager","request":{"method":"GET","url":"https://www.linkedin.com/voyager/api/me","headers":{"accept":"application/vnd.linkedin.normalized+json+2.1","csrf-token":"[REDACTED:csrf-token]","cookie":"[REDACTED:cookie]","x-li-lang":"en_US","x-li-page-instance":"urn:li:page:d_flagship3_profile_view_base;","x-li-track":"[REDACTED:x-li-track]","x-restli-protocol-version":"2.0.0"},"body":null},"response":{"status":200,"headers":{"content-type":"application/vnd.linkedin.normalized+json+2.1","x-li-fabricator-env":"prod"},"body":{"data":{"plainId":18222594,"$type":"com.linkedin.voyager.common.Me"},"included":[]},"bodyBytes":214,"duration_ms":187}
```

The dev can `jq -c '.response.body.data' captures-live/<file>.jsonl` and get
the normalized envelope directly. The same shape is what
`packages/linkedin-js/src/core/normalized.ts` consumes via
`new VoyagerGraph(response)`.

## Acceptance criteria

The preset is "done" when:

1. Selecting `[LinkedIn Voyager]` in the popup pre-fills the URL filter to
   the regex above and the redact patterns to the lists above.
2. A real walk of LinkedIn (login → me → search a profile → view a post →
   comment) produces a `.jsonl` file with:
   - All `voyager/api/*` calls captured.
   - All `li/track` calls captured.
   - No `li_at` or `JSESSIONID` value present anywhere in the file
     (verifiable via `grep -E 'li_at=[A-Za-z0-9]{40,}'` → empty).
   - No `csrf-token` value present (verifiable via `grep -E '"csrf-token":"[^[]'`
     → empty; the only `csrf-token` lines should be `"[REDACTED:csrf-token]"`).
3. The downloaded file imports cleanly into
   `linkedin-all-in-one-api/scripts/import-capture.ts` (dev task; the script
   reads JSONL line-by-line, validates the envelope, and stores it in
   `captures-live/`).
4. The popup preview shows redacted values (never raw `li_at=...`).

## What this preset does NOT do (out of scope, v1.3.0)

- **Login capture.** The user is expected to log in via the browser before
  starting the plugin. Cold login + 2FA + suspicious-login are handled by
  the actor, not the plugin.
- **Replaying requests.** Replay is a consumer of the JSONL files, not the
  plugin's job.
- **Decoding protobuf.** If a Voyager response ever ships in
  `application/x-protobuf`, the body is recorded as raw text but not
  decoded. (LinkedIn normalized+json is JSON; we are safe for v1.3.0.)
- **Capturing the GraphQL queryId mapping.** The plugin captures the
  request URL (which carries `queryId=...`); the
  `linkedin-all-in-one-api` ADR-0012 GraphQL SDUI mapping is a
  separate artifact.
