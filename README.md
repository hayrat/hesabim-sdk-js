# Hayrat Hesabım — JavaScript SDK

Browser SDK for the Hayrat Hesabım identity provider
(OIDC, Authorization Code + PKCE).

| Package | What it is |
| --- | --- |
| [`packages/core`](packages/core/README.md) — `@hayrat/hesabim-core` | The client. Framework agnostic, **zero runtime dependencies**. |
| [`packages/vue`](packages/vue/README.md) — `@hayrat/hesabim-vue` | Vue 3 plugin + composable over the core. Only `vue@^3` as a peer. |

**Integrating an application?** Start with [`IMPLEMENTATION.md`](IMPLEMENTATION.md)
(Turkish) — a step-by-step guide written so that a developer or a coding agent
can wire sign-in into an existing SPA end to end.

```
npm install @hayrat/hesabim-core        # any framework
npm install @hayrat/hesabim-vue @hayrat/hesabim-core   # Vue 3
```

## Development

```
npm install
npm run typecheck   # tsc --noEmit in both packages
npm test            # vitest (happy-dom) in both packages
npm run build       # tsup: ESM + CJS + d.ts, core first
```

Node ≥ 20. `package-lock.json` is committed, and `npm audit` is clean.

The root `package.json` pins one `overrides` entry: `esbuild` to `^0.28.1`.
tsup and vite both range on `^0.27`, which is the range GHSA-g7r4-m6w7-qqqr
covers; the override is the only way to get a fixed version through a transitive
dependency. It applies to the build toolchain only — neither published package
has a runtime dependency.

## Layout

```
packages/core/src
  client.ts          the client: login, callback, refresh, logout, can
  errors.ts          AuthRequiredError / AuthUnavailableError / CallbackError
  types.ts           the public type surface
  internal/
    claims.ts        the ONE fail-closed access-claim decoder + ID token rules
    json.ts          lexeme-preserving JSON reader (lossless scope ids)
    discovery.ts     .well-known fetch and its acceptance rules
    storage.ts       the localStorage envelope, degradation, cross-tab sync
    transient.ts     per-flow state/nonce/verifier in sessionStorage
    scope.ts         can(role, ...targets)
    pkce.ts jwt.ts base64url.ts http.ts url.ts env.ts
packages/vue/src
  index.ts           createHesabim() plugin + useHesabim() composable
```

Tests sit next to what they cover (`*.test.ts`) and share the fixtures in
`src/test-support/`.

Security notes (token storage, the signature-verification exemption, multi-tab
refresh, what a CORS failure looks like) are in the [core package README](packages/core/README.md#security-notes).

## Releasing

See [`RELEASING.md`](RELEASING.md).

## License

[MIT](LICENSE). Security reports: see [`SECURITY.md`](SECURITY.md).