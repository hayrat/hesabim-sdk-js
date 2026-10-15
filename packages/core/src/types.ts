/** The public type surface. Everything here is exported from the package root. */

/**
 * A scope target: one node of the reference-data geography.
 *
 * The four literals are the types the issuer mints TODAY; the `(string & {})`
 * arm keeps the union open (while preserving editor autocompletion) because
 * grant semantics are pure `(type, id)` equality — a fifth reference-data type
 * added issuer-side must be usable against this SDK without a recompile or a
 * cast, exactly as the Go SDK's plain-string `Scope.Type` is.
 */
export type HayratScope = {
  type: 'region' | 'province' | 'district' | 'school' | (string & {});
  id: number;
};

/** The profile the ID token carries. There is no `/userinfo` endpoint in v1. */
export interface HesabimUser {
  sub: string;
  name?: string;
  gender?: string;
  /**
   * `hayrat_profile_ver`: the user's profile version at the issuer. Compare with
   * the version your application stored; when larger, refresh the profile
   * through your backend. Undefined when the token carries none.
   */
  profileVersion?: number;
}

export interface HesabimConfig {
  /** Issuer URL, e.g. `https://hesabim.hayrat.com`. Trailing slash optional. */
  issuer: string;
  /** The OIDC client id registered for this application. */
  clientId: string;
  /**
   * The registered redirect URI. Must be absolute and must live on
   * `location.origin` — a callback landing on another origin could not read the
   * flow state this SDK stores in `sessionStorage`.
   */
  redirectUri: string;
  /** Space-separated scopes. Default: `openid profile offline_access`. */
  scopes?: string;
  /** Must also be registered with the IdP, which validates it. */
  postLogoutRedirectUri?: string;
  /** Leeway applied to ID token `exp`/`iat`. Default: 30. */
  clockSkewSec?: number;
  /**
   * Optional hierarchy resolver, consulted only when an exact scope match
   * fails (the SDK does not know that a province contains its districts).
   */
  scopeResolver?: (granted: HayratScope, target: HayratScope) => boolean;
}

export interface HesabimClient {
  /** Redirects to the authorization endpoint. The returned promise never resolves. */
  login(opts?: { returnTo?: string }): Promise<never>;
  /** Completes the redirect on the callback page. Call once, on that page only. */
  handleCallback(): Promise<{ returnTo?: string }>;
  /** Clears local state, then redirects to the end-session endpoint. */
  logout(): Promise<never>;
  /** Returns a usable access token, refreshing when required. */
  getAccessToken(): Promise<string>;
  /** Reads the profile out of the stored ID token. Synchronous. */
  getUser(): HesabimUser | null;
  /**
   * UX-only authorization check. The backend remains the authority: this reads
   * an unverified copy of the access token that lives in this browser.
   */
  can(role: string, ...targets: HayratScope[]): boolean;
  isAuthenticated(): boolean;
  /** Fires on every change of the stored session record. Returns an unsubscribe. */
  onAuthStateChanged(cb: (authenticated: boolean) => void): () => void;
}
