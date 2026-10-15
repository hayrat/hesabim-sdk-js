# @hayrat/hesabim-vue

Vue 3 adapter for [`@hayrat/hesabim-core`](https://www.npmjs.com/package/@hayrat/hesabim-core). A plugin, a
composable, and nothing else — all behaviour, and every security note, lives in
the core package.

Integration guide (Turkish, end to end): [`IMPLEMENTATION.md`](https://github.com/hayrat/hesabim-sdk-js/blob/main/IMPLEMENTATION.md).

## Install

```
npm install @hayrat/hesabim-vue @hayrat/hesabim-core
```

`vue@^3` is a peer dependency.

## Setup

```ts
// main.ts
import { createApp } from 'vue';
import { createHesabim } from '@hayrat/hesabim-vue';
import App from './App.vue';

createApp(App)
  .use(
    createHesabim({
      issuer: 'https://hesabim.hayrat.com',
      clientId: 'my-spa',
      redirectUri: `${location.origin}/auth/callback`,
    }),
  )
  .mount('#app');
```

## Use

```vue
<script setup lang="ts">
import { useHesabim } from '@hayrat/hesabim-vue';

const { isAuthenticated, user, login, logout, can } = useHesabim();
</script>

<template>
  <button v-if="!isAuthenticated" @click="login({ returnTo: $route.fullPath })">Sign in</button>

  <template v-else>
    <p>{{ user?.name }}</p>
    <button v-if="can('moderator', { type: 'province', id: 6 })">Approve</button>
    <button @click="logout()">Sign out</button>
  </template>
</template>
```

`useHesabim()` returns:

| Member | Type |
| --- | --- |
| `isAuthenticated` | `Readonly<Ref<boolean>>` |
| `user` | `Readonly<Ref<HesabimUser \| null>>` |
| `login`, `logout`, `getAccessToken`, `can`, `handleCallback` | the core client's methods |

Both refs are read-only and are refreshed on **every** change of the stored
session — including the ones where `isAuthenticated` stays `true`, which is how a
profile updated by a token refresh, or a sign-out in another tab, reaches the
template.

## The callback page

```vue
<script setup lang="ts">
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useHesabim } from '@hayrat/hesabim-vue';

const { handleCallback } = useHesabim();
const router = useRouter();

onMounted(async () => {
  try {
    const { returnTo } = await handleCallback();
    await router.replace(returnTo ?? '/');
  } catch {
    await router.replace('/auth-error');
  }
});
</script>
```

## A navigation guard

This package has **no** router dependency: which router you use, and what an
unauthenticated visit should do, are application decisions. Four lines in your
own code:

```ts
// router/index.ts
router.beforeEach(async (to) => {
  if (!to.meta.requiresAuth) return true;
  const { isAuthenticated, login } = useHesabim();   // outside setup: see note
  if (isAuthenticated.value) return true;
  await login({ returnTo: to.fullPath });
  return false; // login() navigates away; nothing after this runs
});
```

`useHesabim()` uses `inject`, so calling it in a guard requires an active app
context — either call it inside `app.runWithContext(...)`, or keep a module-level
reference to the client you created and use that in the guard.

## Fetching with the access token

```ts
const { getAccessToken } = useHesabim();

export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();
  return fetch(path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
}
```

`getAccessToken()` refreshes when needed and throws `AuthRequiredError` when the
user has to sign in again, or `AuthUnavailableError` for a transient failure that
should NOT sign the user out. See the core README for the full taxonomy, the
token-storage decision, and the multi-tab refresh rules.

## License

[MIT](LICENSE).
