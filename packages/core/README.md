# @hayrat/hesabim-core

Browser client for the Hayrat Hesabım identity provider. OpenID Connect
Authorization Code + PKCE (`S256`), no runtime dependencies, TypeScript types
included.

Integration guide (Turkish, end to end): [`IMPLEMENTATION.md`](https://github.com/hayrat/hesabim-sdk-js/blob/main/IMPLEMENTATION.md).

## Install

```
npm install @hayrat/hesabim-core
```

Requires Node ≥ 20 to build, and a browser with `crypto.subtle` — that is, a
**secure context**. Serve local development over **`https://localhost`**: the
live Hesabım issuer does not accept an `http://` redirect URI for a browser
(public) client, localhost included. See
[IMPLEMENTATION.md §4.1](../../IMPLEMENTATION.md).

## Quick start

```ts
import { createHesabimClient, AuthRequiredError } from '@hayrat/hesabim-core';

export const hesabim = createHesabimClient({
  issuer: 'https://hesabim.hayrat.com',
  clientId: 'my-spa',
  redirectUri: 'https://app.example.com/auth/callback', // registered, and on THIS origin
  // scopes: 'openid profile offline_access',      // the default
  // postLogoutRedirectUri: 'https://app.example.com/',
});
```

Sign in:

```ts
await hesabim.login({ returnTo: '/reports?page=2' });
// never returns — the page navigates to the IdP
```

On the callback page (`/auth/callback`), once:

```ts
const { returnTo } = await hesabim.handleCallback();
router.replace(returnTo ?? '/');
```

Call your API:

```ts
try {
  const token = await hesabim.getAccessToken();
  await fetch('/api/reports', { headers: { Authorization: `Bearer ${token}` } });
} catch (err) {
  if (err instanceof AuthRequiredError) await hesabim.login({ returnTo: location.pathname });
  else /* AuthUnavailableError: transient — keep the session, show a retry */;
}
```

Sign out:

```ts
await hesabim.logout(); // clears local state, then redirects to end_session
```

## API

| Member | Notes |
| --- | --- |
| `createHesabimClient(config)` | Synchronous. Validates the config and throws on anything wrong. Requires a browser. |
| `login(opts?)` | `Promise<never>` — redirects. Rejects with `AuthUnavailableError` if discovery fails or the sign-in flow cannot be stored in `sessionStorage`. |
| `handleCallback()` | `Promise<{ returnTo?: string }>`. Call once, on the callback page. |
| `logout()` | `Promise<never>` — clears storage, then redirects to the IdP's end-session endpoint. With no stored ID token it skips the IdP (which requires `id_token_hint`) and returns straight to `postLogoutRedirectUri`, or to the origin. |
| `getAccessToken()` | `Promise<string>`. Refreshes when needed. Throws `AuthRequiredError` / `AuthUnavailableError`. |
| `getUser()` | `HesabimUser \| null`, synchronous, read from the ID token. |
| `can(role, ...targets)` | `boolean`, synchronous. **UX only.** |
| `isAuthenticated()` | `boolean`. True while a usable record exists, including "access token expired but refreshable". |
| `onAuthStateChanged(cb)` | Fires on every change of the stored record. Returns an unsubscribe function. |

### Configuration

| Field | Required | Default |
| --- | --- | --- |
| `issuer` | yes | — absolute `https` URL (`http` only on `localhost`/`127.0.0.1`) |
| `clientId` | yes | — |
| `redirectUri` | yes | — absolute, and **same origin as the page** |
| `scopes` | no | `openid profile offline_access` |
| `postLogoutRedirectUri` | no | — must also be registered with the IdP |
| `clockSkewSec` | no | `30` |
| `scopeResolver` | no | — see below |

No endpoint path is ever configured or hardcoded: everything comes from
`<issuer>/.well-known/openid-configuration`. The document's own `issuer` member
must match the configured one or the SDK refuses it, redirects are not followed,
and the body is capped at 1 MiB.

The fetch starts when the client is created — `createHesabimClient` stays
synchronous, it just does not wait — so the first sign-in does not pay for it. A
failure is retried by the next operation that needs it, because nothing was
accepted and a blip during page load should not disable the client. The first
document that **does** validate is final for the life of the page: re-fetching
later would let a change in what the issuer advertises move the token endpoint
under a session that already holds a refresh token.

## Authorization: `can(role, ...targets)`

The access token carries one entry per role, each with **its own** scopes:

```json
"hayrat_grants": [
  { "role": "moderator", "scopes": [{ "type": "province", "id": 6 }] },
  { "role": "viewer",    "scopes": [] }
]
```

`can` finds the grant for the role and asks whether **that grant's** scopes cover
the target(s):

```ts
hesabim.can('moderator', { type: 'province', id: 6 });  // true
hesabim.can('moderator', { type: 'province', id: 35 }); // false — that is the viewer grant
hesabim.can('viewer');                                  // true — empty scopes = project-wide
hesabim.can('moderator');                               // false — a scoped grant is not project-wide
hesabim.can('moderator', ankara, izmir);                // AND: every target must be covered
```

There is deliberately **no** `hasRole()` and no `inScope()`. Two independent
predicates invite `hasRole('moderator') && inScope(İzmir)`, which authorizes a
combination nobody granted — the exact reason the token pairs a role with its
scopes.

Matching is exact on `(type, id)`. The SDK does not know that a province
contains its districts; if your application needs that, supply a resolver, which
is consulted only when the exact match fails:

```ts
scopeResolver: (granted, target) =>
  granted.type === 'province' && target.type === 'district' && districtsOf(granted.id).includes(target.id),
```

A malformed target (empty `type`, non-integer or out-of-range `id`) denies
without ever calling the resolver — including against a project-wide grant.

Scope ids are read out of the token by the SDK's own JSON reader rather than
`JSON.parse`, and are accepted only when they are **written** as plain integers
in `[1, 2^53-1]`. `JSON.parse` turns `1.00000000000000001` into `1` and
`9007199254740991.1` into `9007199254740991` before any check can see them, and
an authorization answer about a rounded id is an answer about a different place.

## Errors

| Class | Meaning | Stored session |
| --- | --- | --- |
| `AuthRequiredError` | Sign-in required (no session, rejected refresh token, failed callback). | discarded |
| `AuthUnavailableError` | Transient: network, discovery, a 5xx, an unusable token response. | **kept** |
| `CallbackError` | The authorization server returned an OAuth error. `.code` carries it. | untouched |

`error_description` is never put into an exception, and no token byte or claim
value ever appears in a message. Machine-readable codes only.

## Security notes

**Tokens live in `localStorage`.** This is a deliberate decision, not an
oversight: memory-only storage forces a redirect on
every reload and in every new tab, and it does not actually stop XSS from using
the tokens it can reach. The accepted mitigations are elsewhere — first-party
applications, ~10 minute access tokens, and refresh rotation with reuse
detection on the server. **Any XSS in your application is a full account
compromise.** A strict CSP is the control that matters here.

The stored value is one JSON envelope under
`hayrat.hesabim.<issuer>.<clientId>`:

```jsonc
{ "v": 1, "issuer": "...", "client_id": "...",
  "access_token": "...", "refresh_token": "...", "id_token": "...",
  "expires_at": 1893456000,          // epoch SECONDS
  "refresh_pending": { "at": ... } } // present only during a rotation
```

The key contains the issuer as well as the client id, so the same client id
pointed at a second issuer can never carry the first one's refresh token to the
second one's token endpoint. A record whose `issuer`/`client_id` do not match the
configuration, or whose JSON is broken, reads as "signed out" rather than as an
error.

**Signatures are NOT verified in the browser.** Every token this SDK reads came
out of the token endpoint over TLS, in this page, in response to a request this
SDK made — the same decision `oidc-client-ts` v2 and `auth0-spa-js` take. The
exemption covers exactly those tokens; a token from anywhere else is not
something this SDK will accept, and your backend must verify signatures against
the JWKS (the Go SDK, [`hesabim-sdk-go`](https://github.com/hayrat/hesabim-sdk-go), does exactly
that). `at_hash` is not verified either: without
a signature it binds nothing an attacker able to substitute the ID token could
not also substitute.

**The backend is the authority.** `can()` and `getUser()` read an unverified copy
of the tokens in this browser and exist to decide what to render. Every
authorization decision that matters is made by the resource server, on the
verified access token.

**Cross-tab refresh.** Refresh tokens rotate, so two tabs presenting the same one
would trip the server's reuse detection and revoke the whole family — correctly,
but the user gets signed out. The SDK serialises rotation with the Web Locks API
(`navigator.locks`), re-reading storage inside the lock so a tab that queued
behind another simply uses the token that one obtained. Where Web Locks are
unavailable the guarantee shrinks to a single tab; that is an accepted
degradation.

Immediately before the refresh POST the SDK writes a `refresh_pending` marker,
and the write that stores the answer clears it. The marker is read in exactly
one place — **by whoever holds the refresh lock** — and finding
one there means some tab POSTed and never recorded the result, so the
stored refresh token may already be spent. The SDK then **clears the session and
requires a fresh sign-in** rather than replaying it. A refresh POST is never
retried automatically. A wrong sign-in prompt is cheaper than a false security
alarm and a revoked token family.

Everything else — `isAuthenticated()`, `getUser()`, `can()`, the cross-tab
listener — ignores the marker completely and reports the session as live. A tab
that treated another tab's in-flight rotation as a sign-out would flash through
"logged out" once per rotation and bounce route guards on the way, and it could
tear down a refresh that was going perfectly well.

**When Web Storage is blocked** (Safari private browsing, third-party storage
restrictions), writes fail. The in-memory fallback covers the **token store
only**: an already established session continues in memory for the life of the
page, without persistence across reloads and without cross-tab
synchronisation. **Starting a sign-in needs a working `sessionStorage`** — the
flow (state, nonce, PKCE verifier) must survive the redirect to the IdP and
back. When it cannot be stored, `login()` rejects with `AuthUnavailableError`
before redirecting, instead of sending the user on a round trip whose callback
is certain to fail.

Refresh is stricter, because a rotation nobody else can see is a rotation
another tab will repeat. Before the POST, the SDK requires one of two things:
the marked record is written **and read back** from `localStorage`, so every
other document sees that this token is being spent; or the persisted record is
**confirmed gone**, so no other document can find the token at all (this page
then continues in memory). If neither can be confirmed, the refresh is refused
with `AuthUnavailableError` and the existing session is left untouched — it
simply cannot renew in this browser until storage works again. A session that
was never persisted in the first place has no predecessor for anyone to find, so
it keeps rotating in memory as before.

**CORS.** The token endpoint only accepts origins derived from the redirect URIs
registered for your client. If your SPA's origin is not registered, the browser
blocks the token response and it never reaches JavaScript. What you see:

- console: `Access to fetch at 'https://hesabim.hayrat.com/oauth/token' from origin
  'https://app.example.com' has been blocked by CORS policy`;
- the SDK throws `AuthUnavailableError` (a blocked request is indistinguishable
  from a network failure from inside the page);
- the network panel shows the request to `/oauth/token` with no
  `Access-Control-Allow-Origin` in its response. The SDK's token request is a
  form-encoded `POST`, which usually needs **no** preflight — do not go looking
  for an `OPTIONS`; the blocked request may be the `POST` itself.

An `http://` origin is never opened on the live issuer, `localhost` included —
serve local development over `https://localhost:<port>`.

The fix is registration, not code: add the exact redirect URI to your client
registration (ask the Hesabım administrator). Wildcards are not supported anywhere.

**SSR.** Importing the package on the server is safe; `createHesabimClient()` on
the server is not — it throws, because it needs `location` and Web Storage.
Create the client inside a browser-only path.

## License

[MIT](LICENSE).
