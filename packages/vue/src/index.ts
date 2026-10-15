import type { App, InjectionKey, Plugin, Ref } from 'vue';
import { inject, readonly, ref, shallowRef } from 'vue';
import { createHesabimClient } from '@hayrat/hesabim-core';
import type {
  HayratScope,
  HesabimClient,
  HesabimConfig,
  HesabimUser,
} from '@hayrat/hesabim-core';

export type { HayratScope, HesabimConfig, HesabimUser } from '@hayrat/hesabim-core';

// The error classes are re-exported so that an application which installs only
// this package binds its `instanceof` checks to the SAME class identities the
// adapter's client throws. Importing them from a separately-resolved copy of
// the core package could yield different identities, and an `instanceof` that
// silently answers false is a re-login prompt that never appears.
export { AuthRequiredError, AuthUnavailableError, CallbackError } from '@hayrat/hesabim-core';

/** What `useHesabim()` returns. A thin projection of the core client. */
export interface HesabimVue {
  isAuthenticated: Readonly<Ref<boolean>>;
  user: Readonly<Ref<HesabimUser | null>>;
  login: HesabimClient['login'];
  logout: HesabimClient['logout'];
  getAccessToken: HesabimClient['getAccessToken'];
  can: HesabimClient['can'];
  handleCallback: HesabimClient['handleCallback'];
}

const HESABIM_KEY: InjectionKey<HesabimVue> = Symbol('hayrat.hesabim');

/**
 * `app.use(createHesabim({ ... }))`.
 *
 * There is deliberately NO router integration: a plugin that reaches into
 * vue-router would force a version and a routing style on every application
 * that installs it. The README shows the four-line navigation guard instead.
 */
export function createHesabim(config: HesabimConfig): Plugin {
  return {
    install(app: App) {
      const client = createHesabimClient(config);

      const isAuthenticated = ref(client.isAuthenticated());
      const user = shallowRef<HesabimUser | null>(client.getUser());

      // Fires on every change of the stored session — including the ones where
      // the boolean stays true. That is how a refreshed ID token's profile
      // reaches the template, and how a sign-out in another tab reaches this one.
      client.onAuthStateChanged(() => {
        isAuthenticated.value = client.isAuthenticated();
        user.value = client.getUser();
      });

      const api: HesabimVue = {
        isAuthenticated: readonly(isAuthenticated),
        user: readonly(user) as Readonly<Ref<HesabimUser | null>>,
        login: (opts?: { returnTo?: string }) => client.login(opts),
        logout: () => client.logout(),
        getAccessToken: () => client.getAccessToken(),
        can: (role: string, ...targets: HayratScope[]) => client.can(role, ...targets),
        handleCallback: () => client.handleCallback(),
      };

      app.provide(HESABIM_KEY, api);
    },
  };
}

export function useHesabim(): HesabimVue {
  const api = inject(HESABIM_KEY, null);
  if (!api) {
    throw new Error('useHesabim() was called before app.use(createHesabim({ ... }))');
  }
  return api;
}
