# Google Drive over OAuth Device Authorization Grant — implementation plan

Status: **proposed**, not started. Follows this repo's usual convention (see
`ENCRYPTED-BACKUPS-PLAN.md`/`REDACTION-EXCLUSIONS-PLAN.md`): investigate with real evidence, write a
grounded plan, implement phase by phase.

> **Revision note (post-review).** An earlier draft of this plan contained three errors that would each
> have produced a working-looking-but-broken implementation. They're corrected below and called out
> explicitly in §4.5 and §4.6 so an implementer doesn't reintroduce them from memory of the RFC:
> Google's polling errors arrive with **non-2xx HTTP status codes** (a normal "still waiting" is
> **HTTP 428**, not 200); Google returns **`invalid_grant`**, not RFC 8628's `expired_token`; and
> `slow_down`/`access_denied` **share** status 403. The draft also missed a real consumer
> (`credentialsMigrate.ts`, §3) and under-resolved the migration question (now settled in §4.2).

## §1 The problem, restated precisely

`isOriginSupported()` ([googleDrive.ts:21-23](src/destinations/googleDrive.ts#L21-L23)) gates the
current Google Drive sign-in on `location.protocol === "https:" || location.hostname === "localhost"`.
That's necessary but not sufficient: Google's Cloud Console additionally validates that an "Authorized
JavaScript origin" is a real, syntactically-plausible domain (protocol + registrable domain against the
Public Suffix List) - a `.local` mDNS hostname (the overwhelmingly common way a Duet is actually
reached on a LAN) is rejected outright in the Console UI, before a backup even ships. **HTTPS alone
does not fix this** - a `.local` hostname stays unregistrable as a JS origin whether it's http or
https. This is why the TLS work done elsewhere in this session doesn't unblock Google Drive by itself.

## §2 What's verified, not assumed

**The current GIS (`initTokenClient`) flow is fundamentally origin-bound** - this is Google's Identity
Services library performing a postMessage handshake with an iframe scoped to the calling page's own
registered origin. There's no configuration flag that relaxes this; it's the mechanism.

**OAuth 2.0 Device Authorization Grant has no origin or redirect-URI requirement at all**, confirmed
directly from Google's own docs (developers.google.com/identity/protocols/oauth2/limited-input-device):
the user authorizes on a **separate** device/tab via a short code and a fixed URL
(`https://www.google.com/device`) - nothing about the calling page's own hostname is ever presented to
Google. `drive.file` (the scope already used) is explicitly one of the scopes this grant type supports
(along with `drive.appdata`, and the OpenID/YouTube scopes) - not blocked.

**CORS was verified empirically, not assumed from the docs** (general web commentary about "Google
OAuth doesn't support CORS" is about the older `/o/oauth2/*` web-flow endpoints - a different endpoint
family, and trusting that commentary here would have been a dead end). Live `curl` requests against the
actual endpoints, spoofing `Origin: http://myprinter.local`:

```
$ curl -i -X OPTIONS https://oauth2.googleapis.com/device/code -H "Origin: http://myprinter.local" ...
HTTP/1.1 200 OK
Access-Control-Allow-Origin: http://myprinter.local
Access-Control-Allow-Methods: DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT
...

$ curl -i -X POST https://oauth2.googleapis.com/device/code -H "Origin: http://myprinter.local" -d "client_id=test&scope=test"
HTTP/1.1 401 Unauthorized          # expected - fake client_id, but note:
Access-Control-Allow-Origin: http://myprinter.local
...

$ curl -i -X POST https://oauth2.googleapis.com/token -H "Origin: http://myprinter.local" -d "grant_type=urn:ietf:params:oauth:grant-type:device_code&..."
HTTP/1.1 401 Unauthorized
Access-Control-Allow-Origin: http://myprinter.local
...
```

Both `oauth2.googleapis.com/device/code` and `/token` **reflect whatever `Origin` header is sent** -
i.e. genuinely open CORS, not an allowlist. A browser `fetch()` from any DWC host, `.local` or not,
http or https, can call these endpoints directly with zero backend/proxy needed. This is the load-
bearing fact the whole plan depends on, and it's now confirmed against the live endpoints rather than
inferred.

**The client-secret requirement is not a real secrecy regression.** Device Authorization Grant needs a
"TVs and Limited Input devices" OAuth client type, and its token exchange takes a `client_secret`
parameter - but Google's own docs for installed/public-client types say plainly that this value "is
obviously not treated as a secret" for this client category (it can't be, since it ships inside a
distributed app/plugin bundle by design). Embedding it in this plugin's bundled JS is the documented,
expected pattern for this client type, not a corner cut.

**Works over plain HTTP too** - unlike the current flow, this doesn't need `isOriginSupported()`'s
https-or-localhost gate at all. The TLS setup done elsewhere this session is still valuable in its own
right, just not a prerequisite for *this* fix.

## §3 What already exists (and what doesn't transfer)

- `signIn(clientId): Promise<string>` ([googleDrive.ts:49-66](src/destinations/googleDrive.ts#L49-L66))
  - the whole GIS flow - is replaced outright (§4.1), not kept alongside the new one.
- `isOriginSupported()` becomes dead code once the GIS flow is gone - device flow has nothing
  equivalent to check. `credentials.ts`'s `getGoogleDriveClientId`/`setGoogleDriveClientId`
  ([credentials.ts:401-406](src/credentials.ts#L401-L406)) store a bare string; device flow needs a
  `client_secret` alongside the `client_id`, so this becomes a settings object (§4.2), the same shape
  change `GithubSettings` already went through for its own multi-field credential.
- `uploadBackup()` ([googleDrive.ts:91-106](src/destinations/googleDrive.ts#L91-L106)) is untouched -
  it only ever consumed an access token, and device flow still produces exactly that; nothing about how
  the Drive API itself is called changes.

**Complete call-site inventory** (grepped across all four repos, not recalled - the earlier draft
missed the `credentialsMigrate.ts` entries entirely):

| File | What needs doing |
| --- | --- |
| `src/destinations/googleDrive.ts` (core) | Delete GIS flow, add device flow (§4.3); rewrite module doc comment - its current claim that this is "not something the plugin can work around" becomes actively wrong |
| `src/credentials.ts:101` (core) | `ENCRYPTABLE_SUFFIXES` - `"drive.clientId"` → `"drive.settings"` |
| `src/credentials.ts:401-406` (core) | Replace bare-string getter/setter with `GoogleDriveSettings` (§4.2) |
| `src/credentialsMigrate.ts:50,66,83` (core) | **Missed by the earlier draft.** `MigratableCredentials.googleDriveClientId` field, its `readJson(..., "drive.clientId")` read, and its `setGoogleDriveClientId` write - this is the cross-plugin credential-import path. See §4.2 for why this one deliberately does NOT carry the old value forward |
| `test/googleDrive.test.ts` (core) | Delete the `isOriginSupported`/`signIn` describe blocks outright (not `.skip`); add device-flow tests (§6) |
| `test/credentialsMigrate.test.ts:6-7,59,88,99` (core) | Update for the new shape |
| `BackupCreatePanel.vue` ×3 hosts | `isOriginSupported()` gate (FL:258, standalone:258, 3.6:322) and the `signIn()` call (FL:527-531, standalone:527-531, 3.6:507-511) |
| `CloudPanel.vue` ×3 hosts | Client-ID field + `driveClientId`/`driveConfigured`/`driveOriginOk` (FL:618-693, standalone:534-607, 3.6:367-572 - note 3.6 is Options API, so these are `data()`/`computed()` members, not refs) |
| `en.json` ×3 hosts | `drive.clientIdLabel`/`clientIdHelp`/`signInButton` all need replacing, plus the new device-flow strings (§5.2) |

## §4 Design decisions

### §4.1 Replace the GIS flow entirely, don't run both

Device flow works everywhere the GIS flow did (https, localhost) plus everywhere it didn't (`.local`,
plain http, a bare LAN IP). There's no host configuration where the old flow would work but the new one
wouldn't. Keeping both would mean two credential shapes, two sign-in UIs, and a "which one do I use"
decision surfaced to the user for no actual benefit - reject that option. `signIn()` and
`isOriginSupported()` are removed, not deprecated-in-place.

### §4.2 Credential storage: `GoogleDriveSettings { clientId, clientSecret }`

Mirrors `GithubSettings`'s existing shape exactly
(`getGithubSettings`/`setGithubSettings`, [credentials.ts:391-396](src/credentials.ts#L391-L396)):

```ts
export interface GoogleDriveSettings { clientId: string; clientSecret: string }
export function getGoogleDriveSettings(): GoogleDriveSettings | null;
export function setGoogleDriveSettings(settings: GoogleDriveSettings | null): void;
```

Replaces `getGoogleDriveClientId`/`setGoogleDriveClientId` outright (same reasoning as §4.1 - one
shape, not two), stored under a **new key `drive.settings`**, with `ENCRYPTABLE_SUFFIXES`
([credentials.ts:101](src/credentials.ts#L101)) updated to match.

**Migration: deliberately do NOT carry the old client ID forward.** This was left open in the earlier
draft; it's now settled, because the old value turns out to be worse than useless. Device flow requires
a **"TVs and Limited Input devices"** OAuth client, and Google's own error table for this endpoint
lists `invalid_client` (HTTP 401) as covering a client ID that is *invalid **or of the wrong type***. A
user's existing "Web application" client ID - the only kind the current GIS flow could have used - will
therefore be rejected outright by the device endpoint. Silently migrating it into `drive.settings.clientId`
would produce the worst possible state: the UI shows Drive as *configured*, and every backup fails at
sign-in with an opaque `invalid_client`.

So: the new key starts empty, Drive reads as "not configured", and the user is prompted to create a new
OAuth client of the correct type. That is genuinely the required action, not an inconvenience being
imposed for implementation convenience.

Consequences to implement deliberately rather than by omission:
- `credentialsMigrate.ts`: `MigratableCredentials.googleDriveClientId: string | null` becomes
  `googleDrive: GoogleDriveSettings | null`, reading/writing `drive.settings`. It must **not** fall back
  to reading the old `drive.clientId` key - carrying a wrong-type client ID between plugin namespaces
  propagates the same broken state sideways.
- The orphaned `drive.clientId` localStorage entry should be **actively removed** when the new settings
  are first written, not left behind - it's dead, and leaving it means a stale secret-ish value lingering
  in storage forever.
- The UI needs a one-time explanation (§5.2) so a user whose Drive "un-configured itself" understands
  why, rather than filing it as a bug.

### §4.3 New API surface

```ts
export interface DeviceCodeInfo {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}

/** Step 1: request a device code. Shows the user `userCode`/`verificationUrl` to act on, on ANY
 *  device - nothing about THIS page's origin is ever sent to Google. */
export async function requestDeviceCode(clientId: string): Promise<DeviceCodeInfo>;

export type DeviceTokenOutcome =
  | { status: "authorized"; accessToken: string }
  | { status: "pending" }      // authorization_pending (HTTP 428) - keep polling, THE COMMON CASE
  | { status: "slowDown" }     // slow_down (403) - caller must INCREASE its poll interval
  | { status: "denied" }       // access_denied (403) - user refused
  | { status: "expired" }      // invalid_grant (400) - code expired; distinct from denied, needs a restart
  | { status: "error"; message: string };  // invalid_client, admin_policy_enforced, network failures

/** Step 2, called once per poll interval until a terminal outcome.
 *  MUST parse the JSON body regardless of HTTP status and branch on the `error` field - see §4.5.
 *  Never throws for a protocol-level error; only "error" carries a message. */
export async function pollDeviceToken(clientId: string, clientSecret: string, deviceCode: string): Promise<DeviceTokenOutcome>;
```

Note `expired` is a **separate** outcome from `denied` (the earlier draft folded them together): they
need different UI copy - "you declined access" vs "the code timed out, here's a fresh one" - and only
the latter should offer an automatic retry.

`signIn()` is deleted; `isOriginSupported()` is deleted.

### §4.4 UI flow shape

Replaces the current "click Sign In, a popup appears" interaction with: click Sign In → show the code
and a clickable link to `verificationUrl` (`https://www.google.com/device`) → a small polling indicator
→ resolves automatically once the user finishes authorizing elsewhere (their phone, another tab, doesn't
matter) → falls through to the existing `driveUploadBackup(...)` call, unchanged. A "Cancel" action
should stop polling (device codes expire on their own per `expiresInSeconds`, typically ~1800s, but
there's no reason to keep a `setInterval` running after the user navigates away from the dialog).

### §4.5 Error-state handling in the poll loop — three corrections, each a guaranteed bug if missed

These are quoted from Google's own error table for this endpoint, and each one contradicts what an
implementer would reasonably assume (either from RFC 8628 or from how the rest of this codebase talks
to HTTP APIs). **The earlier draft of this plan got all three wrong.**

| Google returns | HTTP status | Meaning |
| --- | --- | --- |
| `authorization_pending` | **428** | Normal. User simply hasn't finished yet. **This is the common case.** |
| `slow_down` | **403** | Polling too fast - increase the interval |
| `access_denied` | **403** | User refused |
| `invalid_grant` | **400** | Device code expired or already used |
| `invalid_client` | **401** | Client ID invalid **or of the wrong type** (see §4.2) |
| `admin_policy_enforced` | **400** | Google Workspace policy blocks it |

**Correction 1 — non-2xx is the normal case, so `res.ok` must not gate parsing.** The existing
`driveFetch` helper ([googleDrive.ts:68-75](src/destinations/googleDrive.ts#L68-L75)) throws on
`!res.ok` before reading the body. Routing the poll through anything shaped like that turns *every
single poll before the user finishes authorizing* into a thrown error - the flow would never succeed.
`pollDeviceToken` must read and parse the JSON body **regardless of status**, and branch on the `error`
field inside it. Do not reuse `driveFetch` here.

**Correction 2 — the error string is `invalid_grant`, not `expired_token`.** RFC 8628 specifies
`expired_token`; Google does not send it. Code (or a test) written against the RFC name will silently
never match, so an expired device code would fall through to the generic error branch and report
something unhelpful instead of "your code expired, start again".

**Correction 3 — `slow_down` and `access_denied` share HTTP 403.** Branching on status code alone
cannot tell "wait longer" from "the user said no". **Always branch on the `error` string**, treating
the status code as informational only.

Handling requirements: `slow_down` must actually increase the caller's polling interval (Google calls
this out explicitly - a fixed retry ignores the instruction and can escalate). `admin_policy_enforced`
deserves its own distinct message, since the user genuinely cannot fix it themselves - it's their
Workspace admin's policy, and a generic "sign-in failed" would send them hunting in the wrong place.

## §5 Implementation phases

### Phase 1 - core (`dwc-config-backup-core`)

1. `credentials.ts`: `GoogleDriveSettings`, `getGoogleDriveSettings`/`setGoogleDriveSettings` (§4.2),
   replacing the bare-string getter/setter; update `ENCRYPTABLE_SUFFIXES` for the new key name; remove
   the orphaned `drive.clientId` entry when the new settings are first written (§4.2).
2. `credentialsMigrate.ts`: `MigratableCredentials.googleDrive: GoogleDriveSettings | null` replacing
   `googleDriveClientId`, reading/writing `drive.settings`, **not** falling back to the old key (§4.2).
3. `googleDrive.ts`: delete `signIn`/`isOriginSupported`/`loadGisScript`/`GIS_SCRIPT_URL`/
   `TokenClient`/`GoogleAccountsGlobal`; add `requestDeviceCode`/`pollDeviceToken`/`DeviceCodeInfo`/
   `DeviceTokenOutcome` (§4.3). `uploadBackup`/`findOrCreateFolder` are untouched. **`driveFetch` is
   deliberately NOT reused by the poll path** (§4.5, correction 1) - its `!res.ok` throw is correct for
   the Drive API calls it already serves and wrong for the token endpoint.
4. Update the module doc comment (currently says "Google requires an HTTPS (or localhost) JavaScript
   origin... not something the plugin can work around" - that sentence becomes actively wrong).

### Phase 2 - UI in one host first (`duet-config-backup-plugin`)

1. `CloudPanel.vue`: client-ID field becomes client-ID + client-secret fields; drop the
   `driveOriginOk`/`isOriginSupported` gate entirely - Drive is just "configured or not" now, same as
   every other destination. Setup help text must state the client type explicitly ("TVs and Limited
   Input devices"), since picking the wrong type is the one setup mistake that yields a confusing
   `invalid_client` later (§4.2).
2. `BackupCreatePanel.vue`: replace the `signIn()` call with the request-code → show-code-and-link →
   poll → resolve sequence (§4.4/§4.5), reusing whatever Promise-based dialog pattern
   `askUnredacted`/`askPublicRepoConfirm` already establish in this file.
3. A one-time "Google Drive needs reconfiguring" explanation for users who had the old flow working
   (§4.2) - without it, "my Drive settings vanished" reads as a bug.
4. i18n strings for the new dialog: code display, verification link, "waiting for authorization...",
   and a **distinct** message per terminal outcome from §4.5 - `denied`, `expired`, `invalid_client`
   (wrong client type - point at the setup help), `admin_policy_enforced` (Workspace admin blocked it;
   the user cannot fix this themselves). Replaces the existing `drive.signInButton`/`clientIdLabel`/
   `clientIdHelp` keys.

### Phase 3 - port to Flexible Layouts and the 3.6 plugin

Same shape as every other feature port in this family: Flexible Layouts is a near-identical Vue 3 copy;
the 3.6 plugin is a genuine Vue 2 / Vuetify 2 rewrite of the same interaction, not copy-paste.

## §6 Testing

Core (`test/googleDrive.test.ts` - the existing `isOriginSupported`/`signIn` describe blocks are
deleted, not kept skipped):

- `requestDeviceCode` parses a mocked `device/code` response into `DeviceCodeInfo` correctly. **Field
  names verified against Google's live docs**, snake_case: `device_code`, `user_code`,
  **`verification_url`** (Google's spelling - RFC 8628 says `verification_uri`; a test written against
  the RFC name would pass against a wrongly-mocked response and fail against the real API),
  `expires_in`, `interval`.
- **`pollDeviceToken` returns `{ status: "pending" }` for an HTTP 428 response** - the single most
  important test here, since it's the case that happens on nearly every poll, and the one a naive
  `res.ok` implementation breaks (§4.5, correction 1).
- `pollDeviceToken` maps each error string to the right variant, driven by the **`error` field, not the
  HTTP status**: `slow_down` (403) → `slowDown` and `access_denied` (403) → `denied` must be
  distinguished *despite sharing status 403* (§4.5, correction 3); `invalid_grant` (400) → `expired`
  (§4.5, correction 2); `invalid_client` (401) and `admin_policy_enforced` (400) → `error`.
- A successful 200 response with an `access_token` → `{ status: "authorized" }`.
- `pollDeviceToken` on an unexpected transport failure (network error, 500, unparseable body) returns
  `{ status: "error" }` rather than throwing - callers are a polling loop, not a one-shot try/catch site.

Host: a test (or manual verification, per this repo's own precedent of some UI flows only being
manually verified) that the poll loop actually widens its interval on `slow_down` and stops polling on
`denied`/`error`/user-cancel.

## §7 Risks

| Risk | Mitigation |
| --- | --- |
| Existing users' stored `drive.clientId` silently stops working | Deliberate: the old Web-application client ID is rejected by the device endpoint anyway, so it's cleared rather than migrated, with a one-time explanation (§4.2) |
| Implementer reuses `driveFetch` for polling, breaking every poll | Called out explicitly (§4.5 correction 1), enforced by the HTTP-428 test (§6) |
| Implementer codes `expired_token` from RFC 8628 memory | Called out explicitly (§4.5 correction 2), enforced by the `invalid_grant` test (§6) |
| User picks the wrong OAuth client type in the Console | Setup help names the required type; `invalid_client` gets its own message pointing back at it (§5.2) |
| User doesn't understand "go authorize on another device" UX | Copy should say plainly this can be done on THIS SAME browser in a new tab too - "another device" is the general case, not a requirement |
| Poll loop left running after the dialog is closed/navigated away | Explicit cancel path (§4.4) clears the interval; device codes also self-expire server-side as a backstop |
| `slow_down` mishandled as a plain retry | Explicit outcome variant forces the caller to branch on it (§4.3/§4.5) |
| Google changes/deprecates this grant type | Low near-term risk - device flow is a standard, long-lived OAuth 2.0 grant (RFC 8628), not a Google-specific experimental feature |

## §8 Open questions

1. ~~**§4.2's migration**~~ - **resolved during review.** Not a judgement call after all: the old
   client ID is the wrong OAuth client *type* and is rejected by the device endpoint, so preserving it
   would actively manufacture a broken "looks configured, always fails" state. Clear it, explain once.
2. Should the verification link also render as a QR code (scan-with-phone, no typing the short URL) -
   a nice-to-have for a printer's touchscreen/kiosk-style browser context specifically, not needed for
   a normal desktop browser tab?
3. Does the "TVs and Limited Input devices" client type in Google Cloud Console require a distinct
   OAuth consent screen configuration from the existing "Web application" client already set up for the
   old flow, or can it reuse the same consent screen / same scopes list? **Needs an actual walkthrough
   of the Console UI** before writing user-facing setup instructions - this is the one remaining
   unknown that can't be settled from the API docs alone, and the machine with TLS set up is a good
   place to do a real end-to-end run.
4. Access tokens from this grant are still short-lived (~1h) and the current design remains
   memory-only, so a long backup session could in principle outlive its token. The device grant *can*
   return a refresh token - worth deciding whether to use one (and if so, whether storing it crosses a
   line the current "token never persisted" design deliberately avoids), or to simply re-run the device
   flow on expiry as today's flow effectively does.
