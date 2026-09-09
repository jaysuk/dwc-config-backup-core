# Google Drive over OAuth Device Authorization Grant — implementation plan

Status: **proposed**, not started. Follows this repo's usual convention (see
`ENCRYPTED-BACKUPS-PLAN.md`/`REDACTION-EXCLUSIONS-PLAN.md`): investigate with real evidence, write a
grounded plan, implement phase by phase.

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
- UI call sites: `BackupCreatePanel.vue` (`isOriginSupported()` gate at
  [BackupCreatePanel.vue:258](../Flexible-Layouts/src/configBackup/BackupCreatePanel.vue#L258) and the
  `signIn()` call at
  [BackupCreatePanel.vue:527-531](../Flexible-Layouts/src/configBackup/BackupCreatePanel.vue#L527-L531))
  and `CloudPanel.vue`'s client-ID settings field
  ([CloudPanel.vue:233](../Flexible-Layouts/src/configBackup/CloudPanel.vue#L233) and the surrounding
  `driveClientId`/`driveConfigured`/`driveOriginOk` refs at
  [CloudPanel.vue:618-693](../Flexible-Layouts/src/configBackup/CloudPanel.vue#L618-L693)) both need
  real changes - this is a UI-visible flow change, not a drop-in swap.

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
shape, not two). **Migration decision needed (§9.1):** an existing stored bare `clientId` string from
before this change won't parse as `GoogleDriveSettings` - given this repo's own credential-encryption
suffix list already includes `drive.clientId`
([credentials.ts:101](src/credentials.ts#L101) - `ENCRYPTABLE_SUFFIXES`), the storage key itself likely
needs to change too (e.g. `drive.settings`), which sidesteps parsing an old shape under a new key
entirely - a user with Drive already configured just sees it as "not configured" once, same one-time
cost as any credential-shape change, not a silent crash.

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
  | { status: "pending" }      // user hasn't finished yet - caller keeps polling
  | { status: "slow_down" }    // caller must increase its own poll interval
  | { status: "denied" }       // user declined, or the code expired
  | { status: "error"; message: string };

/** Step 2, called once per poll interval until "authorized"/"denied"/"error". */
export async function pollDeviceToken(clientId: string, clientSecret: string, deviceCode: string): Promise<DeviceTokenOutcome>;
```

`signIn()` is deleted; `isOriginSupported()` is deleted.

### §4.4 UI flow shape

Replaces the current "click Sign In, a popup appears" interaction with: click Sign In → show the code
and a clickable link to `verificationUrl` (`https://www.google.com/device`) → a small polling indicator
→ resolves automatically once the user finishes authorizing elsewhere (their phone, another tab, doesn't
matter) → falls through to the existing `driveUploadBackup(...)` call, unchanged. A "Cancel" action
should stop polling (device codes expire on their own per `expiresInSeconds`, typically ~1800s, but
there's no reason to keep a `setInterval` running after the user navigates away from the dialog).

### §4.5 Error-state handling in the poll loop

`pollDeviceToken`'s five outcomes map to real states Google's docs describe for this exact grant
(`authorization_pending`, `slow_down`, `access_denied`, `expired_token`, plus network/HTTP failures) -
the poll loop needs to actually branch on all of them, not just "success or generic failure":
`slow_down` must increase the interval it's already polling at (Google's docs call this out
specifically), not be treated as a plain retry-as-is.

## §5 Implementation phases

### Phase 1 - core (`dwc-config-backup-core`)

1. `credentials.ts`: `GoogleDriveSettings`, `getGoogleDriveSettings`/`setGoogleDriveSettings` (§4.2),
   replacing the bare-string getter/setter; update `ENCRYPTABLE_SUFFIXES` for the new key name.
2. `googleDrive.ts`: delete `signIn`/`isOriginSupported`/`loadGisScript`/`GIS_SCRIPT_URL`/
   `TokenClient`/`GoogleAccountsGlobal`; add `requestDeviceCode`/`pollDeviceToken`/`DeviceCodeInfo`/
   `DeviceTokenOutcome` (§4.3). `uploadBackup`/`findOrCreateFolder`/`driveFetch` are untouched.
3. Update the module doc comment (currently says "Google requires an HTTPS (or localhost) JavaScript
   origin... not something the plugin can work around" - that sentence becomes actively wrong).

### Phase 2 - UI in one host first (`duet-config-backup-plugin`)

1. `CloudPanel.vue`: client-ID field becomes client-ID + client-secret fields; drop the
   `driveOriginOk`/`isOriginSupported` gate entirely - Drive is just "configured or not" now, same as
   every other destination.
2. `BackupCreatePanel.vue`: replace the `signIn()` call with the request-code → show-code-and-link →
   poll → resolve sequence (§4.4/§4.5), reusing whatever Promise-based dialog pattern
   `askUnredacted`/`askPublicRepoConfirm` already establish in this file.
3. i18n strings for the new dialog (code display, link, "waiting for authorization...", each error
   state from §4.5).

### Phase 3 - port to Flexible Layouts and the 3.6 plugin

Same shape as every other feature port in this family: Flexible Layouts is a near-identical Vue 3 copy;
the 3.6 plugin is a genuine Vue 2 / Vuetify 2 rewrite of the same interaction, not copy-paste.

## §6 Testing

Core (`test/googleDrive.test.ts` - the existing `isOriginSupported`/`signIn` describe blocks are
deleted, not kept skipped):

- `requestDeviceCode` parses a mocked `device/code` response into `DeviceCodeInfo` correctly (field
  name mapping: Google's response uses snake_case `device_code`/`user_code`/`verification_url`/
  `expires_in`/`interval`).
- `pollDeviceToken` maps each of `authorization_pending`/`slow_down`/`access_denied`/`expired_token`/a
  successful `access_token` response to the correct `DeviceTokenOutcome` variant.
- `pollDeviceToken` on an unexpected HTTP failure (network error, 500) returns `{ status: "error" }`
  rather than throwing - callers are a polling loop, not a one-shot try/catch site.

Host: a test (or manual verification, per this repo's own precedent of some UI flows only being
manually verified) that the poll loop actually widens its interval on `slow_down` and stops polling on
`denied`/`error`/user-cancel.

## §7 Risks

| Risk | Mitigation |
| --- | --- |
| Existing users' stored `drive.clientId` silently stops working | Storage key change makes this an explicit "reconfigure" prompt, not a silent parse failure (§4.2) |
| User doesn't understand "go authorize on another device" UX | Copy should say plainly this can be done on THIS SAME browser in a new tab too - "another device" is the general case, not a requirement |
| Poll loop left running after the dialog is closed/navigated away | Explicit cancel path (§4.4) clears the interval; device codes also self-expire server-side as a backstop |
| `slow_down` mishandled as a plain retry | Explicit outcome variant forces the caller to branch on it (§4.3/§4.5) |
| Google changes/deprecates this grant type | Low near-term risk - device flow is a standard, long-lived OAuth 2.0 grant (RFC 8628), not a Google-specific experimental feature |

## §8 Open questions

1. **§4.2's migration**: reset silently (user just sees "not configured" once) or attempt to detect the
   old bare-string shape and show a "Drive needs reconfiguring" one-time notice? Given `drive.clientId`
   already required manual setup once (pasting an OAuth client ID), the cost of doing that again is
   probably fine either way - leaning toward silent reset for simplicity, but worth a call before
   Phase 1.
2. Should the verification link also render as a QR code (scan-with-phone, no typing the short URL) -
   a nice-to-have for a printer's touchscreen/kiosk-style browser context specifically, not needed for
   a normal desktop browser tab?
3. Does the "TVs and Limited Input devices" client type in Google Cloud Console require a distinct
   OAuth consent screen configuration from the existing "Web application" client already set up for the
   old flow, or can it reuse the same consent screen / same scopes list? Needs an actual walkthrough of
   the Console UI to confirm before writing user-facing setup instructions.
