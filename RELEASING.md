# Releasing

Both packages share one version and are released together:
`@hayrat/hesabim-core` first, then `@hayrat/hesabim-vue` (which depends on it).

Releases are published by [`release.yml`](.github/workflows/release.yml) with
**npm Trusted Publishing** (OIDC). There is no npm token anywhere — not in this
repository, not in GitHub secrets.

## One-time setup

1. **npm scope.** The `@hayrat` scope is the npm user account `hayrat` (not an
   org). Publishing requires that account, with 2FA enabled. Converting it to an
   org later is possible but irreversible.

2. **First publish — from a local machine.** A Trusted Publisher can only be
   attached to a package that already exists, so `0.1.0` goes out by hand:

   ```sh
   npm login                       # as the `hayrat` account, 2FA enabled
   npm ci && npm run typecheck && npm test && npm run build
   npm publish --workspace @hayrat/hesabim-core --access public --provenance=false
   npm publish --workspace @hayrat/hesabim-vue  --access public --provenance=false
   ```

   `--provenance=false` is **required** here. Both packages set
   `publishConfig.provenance: true`, which npm reads as configuration; outside a
   supported CI provider that makes `npm publish` fail with
   `EUSAGE: Automatic provenance generation not supported for provider: null`.
   The first version therefore ships without a provenance statement; every
   release from `release.yml` has one.

3. **Trusted Publisher, per package.** On npmjs.com open each package →
   **Settings → Trusted Publisher → GitHub Actions** and enter:

   | Field | Value |
   | --- | --- |
   | Organization or user | `hayrat` |
   | Repository | `hesabim-sdk-js` |
   | Workflow filename | `release.yml` |
   | Environment | `npm` |

   Then, on the same settings page, set **Publishing access** to
   "Require two-factor authentication and disallow tokens" so the workflow is
   the only way to publish.

4. *(Optional)* In GitHub → Settings → Environments → `npm`, add required
   reviewers so every release waits for an approval.

## Every release after that

1. Bump the version in **both** `packages/core/package.json` and
   `packages/vue/package.json` (keep them equal). If the Vue adapter needs a
   newer core, raise its `@hayrat/hesabim-core` range too. Run `npm install`
   so `package-lock.json` follows.
2. Commit, merge to `main`, wait for `ci` to pass.
3. Tag and push:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

The workflow refuses a tag that does not match both package versions, runs the
full test suite, and publishes core, then vue, with provenance. A re-run skips
any version that is already on the registry.

## Versioning

`0.x` while the API settles: a minor bump (`0.1 → 0.2`) may break the API, a
patch bump must not. `1.0.0` is cut once a pilot application has run on the SDK
in production.
