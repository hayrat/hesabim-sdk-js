import { AuthRequiredError, AuthUnavailableError, CallbackError } from './errors.js';
import type { HayratScope, HesabimClient, HesabimConfig, HesabimUser } from './types.js';
import { decodeAccessClaims, profileFromIdToken } from './internal/claims.js';
import type { Discovery } from './internal/discovery.js';
import { fetchDiscovery } from './internal/discovery.js';
import { getWebLocks, hasBrowserGlobals, navigateTo, nowSec } from './internal/env.js';
import { readCappedJsonObject } from './internal/http.js';
import { codeChallengeS256, randomToken } from './internal/pkce.js';
import type { ScopeResolver } from './internal/scope.js';
import { evaluateCan } from './internal/scope.js';
import type { StoredSession } from './internal/storage.js';
import { SessionStore } from './internal/storage.js';
import type { FlowState } from './internal/transient.js';
import { TransientStore } from './internal/transient.js';
import type { ValidatedTokens } from './internal/tokenResponse.js';
import { oauthErrorCode, validateTokenResponse } from './internal/tokenResponse.js';
import { normalizeIssuer, parseAbsoluteUrl, parseIssuerUrl, sanitizeReturnTo } from './internal/url.js';

const DEFAULT_SCOPES = 'openid profile offline_access';
const DEFAULT_CLOCK_SKEW_SEC = 30;

/**
 * How long before expiry an access token stops being handed out. A token that
 * expires while a request is in flight is a 401 the application has to
 * understand; refreshing 30 seconds early costs nothing.
 */
const REFRESH_MARGIN_SEC = 30;

/** The parameters `handleCallback` strips out of the address bar when it is done. */
const CALLBACK_PARAMS = [
  'code',
  'state',
  'error',
  'error_description',
  'error_uri',
  'iss',
  'session_state',
];

interface ResolvedConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  postLogoutRedirectUri?: string;
  clockSkewSec: number;
  scopeResolver?: ScopeResolver;
}

/**
 * Creates the browser client.
 *
 * Requires a browser: it reads `location`, `localStorage` and `sessionStorage`.
 * Importing this package during SSR is fine, calling this function there is not.
 *
 * Discovery starts HERE, so the first sign-in does not wait for it. The call
 * itself stays synchronous — only the promise is kept. If that first attempt
 * fails, the next operation that needs the document tries again; once an
 * attempt succeeds, that document is the page's document and is never fetched
 * again.
 */
export function createHesabimClient(config: HesabimConfig): HesabimClient {
  return new Client(config);
}

class Client implements HesabimClient {
  private readonly cfg: ResolvedConfig;
  private readonly store: SessionStore;
  private readonly transient: TransientStore;
  private readonly lockName: string;

  /** The first document that validated. Once set, it is the page's document. */
  private discoveryDocument: Discovery | null = null;
  /** An attempt in flight. Cleared when it settles, either way. */
  private discoveryAttempt: Promise<Discovery> | null = null;
  /** The tab-local single-flight used where Web Locks are unavailable. */
  private localRefresh: Promise<string> | null = null;

  constructor(config: HesabimConfig) {
    this.cfg = resolveConfig(config);

    // The key carries the issuer as well as the client id: the same client id
    // pointed at a second issuer must not find — and must not be able to POST —
    // the first issuer's refresh token.
    const baseKey = `hayrat.hesabim.${this.cfg.issuer}.${this.cfg.clientId}`;
    this.lockName = `${baseKey}.refresh`;
    this.store = new SessionStore(baseKey, this.cfg.issuer, this.cfg.clientId);
    this.transient = new TransientStore(baseKey);

    // Deliberately NO startup marker sweep here. A marker in
    // storage at construction time is ambiguous: it may be a tab that died
    // mid-refresh — but it may equally be another tab's HEALTHY refresh in
    // flight right now, and clearing it would delete that session out from
    // under a live rotation. The one place the ambiguity resolves is the
    // refresh lock: holding it proves nobody is mid-POST, so a marker seen
    // there belongs to an attempt that never finished (refreshUnderLock). A
    // dead tab's marker reaches that same verdict on the first
    // getAccessToken(); until then the passive readers treat the record as
    // signed-in, which is what a passive reader must do anyway.
    this.store.startCrossTabSync();

    // Discovery starts NOW rather than on first use: the document is needed by
    // every network operation, and paying for it during a click is a latency
    // the page did not have to spend. The API stays synchronous — only the
    // promise is kept.
    this.beginDiscovery();
  }

  async login(opts?: { returnTo?: string }): Promise<never> {
    const discovery = await this.discovery();

    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken();
    const challenge = await codeChallengeS256(verifier);

    const flow: FlowState = {
      v: 1,
      state,
      nonce,
      code_verifier: verifier,
      created_at: nowSec(),
    };
    const returnTo = sanitizeReturnTo(opts?.returnTo, window.location.origin);
    if (returnTo !== undefined) flow.return_to = returnTo;
    if (!this.transient.save(flow)) {
      // Without sessionStorage the callback cannot find this flow, so the
      // round trip through the IdP would end in a guaranteed failure.
      throw new AuthUnavailableError('this browser will not store the sign-in flow (sessionStorage)');
    }

    const url = new URL(discovery.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('client_id', this.cfg.clientId);
    url.searchParams.set('redirect_uri', this.cfg.redirectUri);
    url.searchParams.set('scope', this.cfg.scopes);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return navigateTo(url.toString());
  }

  /**
   * Completes the redirect.
   *
   * The ORDER here is load-bearing. `state` is read and the transient record is
   * consumed BEFORE the `error` parameter is even looked at, so an attacker who
   * can put `?error=...` on the callback URL cannot cause the SDK to discard a
   * pending flow, and a replayed callback finds its single-use record gone.
   */
  async handleCallback(): Promise<{ returnTo?: string }> {
    const params = new URLSearchParams(window.location.search);

    // (1) exactly one state
    const states = params.getAll('state');
    if (states.length !== 1) {
      throw new AuthRequiredError(
        'the callback URL does not carry exactly one state parameter',
      );
    }
    const state = states[0] as string;
    if (state.length === 0) {
      throw new AuthRequiredError('the callback URL carries an empty state parameter');
    }

    // (2) find and CONSUME the flow this state belongs to
    const flow = this.transient.consume(state);
    if (!flow) {
      throw new AuthRequiredError(
        'the callback state does not match a sign-in started in this browser, or it expired',
      );
    }

    try {
      const errors = params.getAll('error');
      const codes = params.getAll('code');
      if (errors.length > 1 || codes.length > 1) {
        throw new AuthRequiredError('the callback URL carries duplicate parameters');
      }
      if (errors.length === 1 && codes.length === 1) {
        throw new AuthRequiredError('the callback URL carries both a code and an error');
      }

      // (3) only now is the server's error honoured
      if (errors.length === 1) {
        throw new CallbackError(errors[0] as string);
      }

      // (4) and only now is a code required
      const code = codes[0];
      if (code === undefined || code.length === 0) {
        throw new AuthRequiredError('the callback URL carries no authorization code');
      }

      const tokens = await this.exchangeCode(code, flow);
      this.store.write(this.recordFrom(tokens));

      return flow.return_to === undefined ? {} : { returnTo: flow.return_to };
    } finally {
      // (5) the address bar stops carrying the code, the state and any error
      // the server put there — those end up in history, in referrers and in
      // whatever the application logs.
      this.cleanCallbackUrl();
    }
  }

  async logout(): Promise<never> {
    const record = this.store.read();
    const idToken = record?.id_token;

    // Local state goes FIRST — before discovery, not just before the redirect.
    // "Sign out" must sign this browser out even when the IdP is unreachable:
    // keeping the tokens so that a retry could still send `id_token_hint`
    // optimized for the retry at the cost of the promise.
    this.store.clear();

    // `id_token_hint` is mandatory at the IdP's end-session endpoint — it is
    // that endpoint's CSRF defence, and a request without it is answered with
    // an error page. With no ID token (never signed in, signed out in another
    // tab, or a retry after a failed discovery) there is nothing to send, so
    // this browser is signed out locally and returns to the application. The
    // IdP session, if one is still alive, is untouched.
    if (!idToken) {
      return navigateTo(this.cfg.postLogoutRedirectUri ?? `${window.location.origin}/`);
    }

    const discovery = await this.discovery();

    const url = new URL(discovery.endSessionEndpoint);
    url.searchParams.set('id_token_hint', idToken);
    if (this.cfg.postLogoutRedirectUri) {
      url.searchParams.set('post_logout_redirect_uri', this.cfg.postLogoutRedirectUri);
    }
    return navigateTo(url.toString());
  }

  async getAccessToken(): Promise<string> {
    const record = this.store.read();
    if (!record) {
      throw new AuthRequiredError('there is no stored session');
    }
    // A `refresh_pending` marker is NOT read here. It means "some tab is
    // rotating", and only the holder of the refresh lock can tell that apart
    // from "some tab died mid-rotation" — a client that acted on it out here
    // would tear down another instance's healthy, in-flight refresh.
    if (this.isUsableAccessToken(record)) return record.access_token;
    return this.refresh();
  }

  getUser(): HesabimUser | null {
    const record = this.store.read();
    if (!record) return null;
    return profileFromIdToken(record.id_token);
  }

  can(role: string, ...targets: HayratScope[]): boolean {
    const record = this.store.read();
    if (!record) return false;
    const claims = decodeAccessClaims(record.access_token, this.cfg.issuer);
    if (!claims) return false;
    return evaluateCan(claims, role, targets, this.cfg.scopeResolver);
  }

  isAuthenticated(): boolean {
    const record = this.store.read();
    if (!record) return false;
    // Like every other passive reader, this ignores `refresh_pending`. Treating
    // an in-flight rotation as a signed-out user made every other tab flash
    // through "logged out" once per rotation, bouncing route guards on the way.
    // An expired access token with a refresh token still IS a session — the
    // next getAccessToken() renews it without the user noticing.
    if (this.isUsableAccessToken(record)) return true;
    return record.refresh_token !== undefined;
  }

  onAuthStateChanged(cb: (authenticated: boolean) => void): () => void {
    return this.store.subscribe(() => {
      cb(this.isAuthenticated());
    });
  }

  // --- internals ---

  /**
   * The discovery document, fetched at most once SUCCESSFULLY.
   *
   * A failure does not poison the client: nothing was accepted, so there is no
   * document to swap, and a network blip during page load must not leave the
   * SDK dead for the rest of the page's life — the next operation retries.
   *
   * The first document that validates, however, is FINAL. Re-fetching later
   * would let a mid-session change of what the issuer advertises move the token
   * endpoint under a session that already holds a refresh token.
   */
  private async discovery(): Promise<Discovery> {
    if (this.discoveryDocument) return this.discoveryDocument;
    return this.discoveryAttempt ?? this.beginDiscovery();
  }

  private beginDiscovery(): Promise<Discovery> {
    const attempt = fetchDiscovery(this.cfg.issuer).then(
      (document) => {
        this.discoveryDocument = document;
        this.discoveryAttempt = null;
        return document;
      },
      (error: unknown) => {
        this.discoveryAttempt = null;
        throw error;
      },
    );
    this.discoveryAttempt = attempt;
    // The eager attempt may have no awaiter at all; this keeps a page-load
    // failure out of the console as an unhandled rejection without hiding it
    // from anybody who does await it.
    attempt.catch(() => undefined);
    return attempt;
  }

  /**
   * Serialises refresh across tabs.
   *
   * Refresh tokens rotate, so two tabs presenting the same one is not a race the
   * IdP can forgive — reuse detection revokes the family, correctly, and the
   * user drops out. Web Locks make it one POST per rotation across every tab of
   * the origin; the lock also serialises calls within this tab, so the second
   * caller re-reads and finds the token the first one just stored.
   *
   * Without Web Locks the guarantee shrinks to this tab (an accepted
   * degradation).
   */
  private async refresh(): Promise<string> {
    const locks = getWebLocks();
    if (locks) {
      // `entered` splits the request's two failure modes. A rejection BEFORE
      // the callback ran is the lock MANAGER refusing service (sandboxed and
      // opaque-origin documents throw SecurityError here) — that document is
      // simply one without Web Locks, and it gets the same tab-local fallback,
      // not a raw DOMException escaping the documented error taxonomy. A
      // rejection AFTER the callback ran IS the refresh's outcome and is
      // rethrown untouched — falling back then would run the refresh twice.
      let entered = false;
      try {
        return await locks.request(this.lockName, () => {
          entered = true;
          return this.refreshUnderLock();
        });
      } catch (error) {
        if (entered) throw error;
      }
    }
    if (!this.localRefresh) {
      this.localRefresh = this.refreshUnderLock().finally(() => {
        this.localRefresh = null;
      });
    }
    return this.localRefresh;
  }

  private async refreshUnderLock(): Promise<string> {
    // Re-read INSIDE the lock: while this call was queued another tab may have
    // done the whole rotation already.
    const record = this.store.read();
    if (!record) {
      throw new AuthRequiredError('there is no stored session to refresh');
    }
    if (record.refresh_pending) {
      // Lock half of the marker rule. Nobody can be mid-POST while this lock is
      // held, so a marker here belongs to an attempt that never finished.
      this.store.clear();
      throw new AuthRequiredError('a previous refresh never completed; sign in again');
    }
    if (this.isUsableAccessToken(record)) return record.access_token;

    const refreshToken = record.refresh_token;
    if (refreshToken === undefined) {
      this.store.clear();
      throw new AuthRequiredError('the access token is unusable and there is no refresh token');
    }

    // Discovery BEFORE the marker: a discovery failure must not leave one
    // behind, because an unresolved marker costs the user a sign-in.
    const discovery = await this.discovery();

    // The await above is an interleaving point, and the refresh lock does not
    // cover every writer — handleCallback stores a brand-new session without
    // taking it. Re-read SYNCHRONOUSLY, with no await between this read and
    // the marker write, so the marker is stamped onto what localStorage holds
    // NOW and can never re-persist a snapshot another document has since
    // replaced.
    const current = this.store.read();
    if (!current) {
      throw new AuthRequiredError('the session was signed out while the refresh was being prepared');
    }
    if (current.refresh_pending) {
      // Same verdict as above: nobody can be mid-POST while this lock is held.
      this.store.clear();
      throw new AuthRequiredError('a previous refresh never completed; sign in again');
    }
    if (current.refresh_token !== refreshToken) {
      // The session this call set out to rotate is gone. If its replacement is
      // live, that answers the caller; rotating a token this path never read
      // synchronously is exactly the clobbering this guard exists to prevent.
      if (this.isUsableAccessToken(current)) return current.access_token;
      throw new AuthUnavailableError('the stored session changed while the refresh was being prepared');
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', refreshToken);
    body.set('client_id', this.cfg.clientId);

    const marked: StoredSession = { ...current, refresh_pending: { at: nowSec() } };

    // Written BEFORE the POST, and the POST does not happen unless this
    // succeeds. From here until the answer is stored, nobody — another tab, or
    // a reload of this page — may present this refresh token again.
    this.armRefreshMarker(marked);

    const response = await this.postForm(discovery.tokenEndpoint, body);
    const payload = await this.readJsonSafely(response);

    // The POST is an interleaving point too, and neither logout() nor
    // handleCallback() takes the refresh lock. If the record this call marked
    // is no longer the stored one, the answer belongs to a session that has
    // ended or been replaced: storing it would resurrect a signed-out user or
    // overwrite a newer sign-in, and clearing on invalid_grant would destroy
    // the newer one. Re-read synchronously and discard the stale answer.
    const after = this.store.read();
    if (!after || !after.refresh_pending || after.refresh_token !== refreshToken) {
      if (after && after.refresh_token !== refreshToken && this.isUsableAccessToken(after)) {
        return after.access_token;
      }
      throw new AuthRequiredError('the session ended while its refresh was in flight');
    }

    if (!response.ok) {
      const code = oauthErrorCode(payload);
      if (response.status >= 400 && response.status < 500 && code === 'invalid_grant') {
        // The ONLY answer that destroys a session. Everything else — a 500, a
        // proxy's HTML error page, an unparsable body — leaves the record
        // alone, because the backend deliberately answers `server_error` when
        // it is having an outage precisely so clients keep their tokens.
        this.store.clear();
        throw new AuthRequiredError('the refresh token was rejected; sign in again');
      }
      throw new AuthUnavailableError(
        `the token endpoint answered the refresh with status ${response.status}`,
      );
    }

    const tokens = validateTokenResponse(payload, {
      issuer: this.cfg.issuer,
      clientId: this.cfg.clientId,
      clockSkewSec: this.cfg.clockSkewSec,
      nowSec: nowSec(),
      requireRefreshToken: true,
      // No nonce on refresh: a refreshed ID token deliberately carries none
      // (OIDC Core 12.2). The nonce is checked in the code exchange only.
    });
    if (!tokens) {
      // Not written over the existing record, and not retried. The marker
      // stays unresolved, which turns the next attempt into a sign-in rather
      // than a replay.
      throw new AuthUnavailableError(
        'the token endpoint returned a refresh response this SDK will not accept',
      );
    }

    // One write: the new token set lands and the marker disappears together.
    this.store.write(this.recordFrom(tokens));
    return tokens.accessToken;
  }

  /**
   * Makes the rotation visible before it happens, or refuses to start it.
   *
   * Two outcomes are safe. Either the marked record is DURABLE, so every other
   * document sees that this refresh token is being spent; or the persisted
   * record is GONE, so no other document can find the token to spend. Anything
   * else — a marker this page believes it wrote while localStorage still shows
   * the unmarked predecessor — leaves a spent refresh token sitting where
   * another tab will pick it up, and the server answers that (correctly) by
   * revoking the entire family.
   *
   * So when neither can be confirmed, the POST does not happen. The user keeps
   * a session that simply cannot refresh in this browser until storage works
   * again, which is a far smaller loss than a family revocation.
   *
   * Giving up puts the store back where it started, IN MEMORY as well as in
   * localStorage. `write` marks the in-process record before it can know
   * whether the value will persist, so a bare throw would leave this client
   * holding a `refresh_pending` for a POST that never happened — and the next
   * refresh would read that marker under the lock, decide a predecessor had
   * been spent, and sign the user out while the untouched, unmarked record was
   * still sitting durably in localStorage.
   */
  private armRefreshMarker(marked: StoredSession): void {
    const checkpoint = this.store.checkpoint();
    if (this.store.write(marked) === 'persisted') return;
    if (this.store.dropPersisted()) return;

    this.store.rollback(checkpoint);
    throw new AuthUnavailableError(
      'this browser will not record the refresh, and the previous token could not be withdrawn',
    );
  }

  private async exchangeCode(code: string, flow: FlowState): Promise<ValidatedTokens> {
    const discovery = await this.discovery();

    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    body.set('redirect_uri', this.cfg.redirectUri);
    body.set('client_id', this.cfg.clientId);
    body.set('code_verifier', flow.code_verifier);

    const response = await this.postForm(discovery.tokenEndpoint, body);
    const payload = await this.readJsonSafely(response);

    if (!response.ok) {
      const errorCode = oauthErrorCode(payload);
      if (errorCode) throw new CallbackError(errorCode);
      throw new AuthUnavailableError(
        `the token endpoint answered the code exchange with status ${response.status}`,
      );
    }

    const tokens = validateTokenResponse(payload, {
      issuer: this.cfg.issuer,
      clientId: this.cfg.clientId,
      clockSkewSec: this.cfg.clockSkewSec,
      nowSec: nowSec(),
      // A refresh token only comes back when `offline_access` was requested, so
      // its absence here is legal; on the refresh path it is not.
      requireRefreshToken: false,
      nonce: flow.nonce,
    });
    if (!tokens) {
      throw new AuthRequiredError(
        'the token endpoint returned a token set this SDK will not accept',
      );
    }
    return tokens;
  }

  private async postForm(endpoint: string, body: URLSearchParams): Promise<Response> {
    try {
      return await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Accept: 'application/json',
        },
        body: body.toString(),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
      });
    } catch (cause) {
      // A blocked CORS preflight lands here too, as an opaque TypeError — see
      // the README: that is what an unregistered SPA origin looks like.
      throw new AuthUnavailableError('the token endpoint could not be reached', { cause });
    }
  }

  private async readJsonSafely(response: Response): Promise<Record<string, unknown> | null> {
    try {
      return await readCappedJsonObject(response);
    } catch {
      return null;
    }
  }

  private recordFrom(tokens: ValidatedTokens): StoredSession {
    const record: StoredSession = {
      v: 1,
      issuer: this.cfg.issuer,
      client_id: this.cfg.clientId,
      access_token: tokens.accessToken,
      id_token: tokens.idToken,
      expires_at: tokens.expiresAt,
    };
    if (tokens.refreshToken !== undefined) record.refresh_token = tokens.refreshToken;
    return record;
  }

  private isUsableAccessToken(record: StoredSession): boolean {
    if (nowSec() >= record.expires_at - REFRESH_MARGIN_SEC) return false;
    return decodeAccessClaims(record.access_token, this.cfg.issuer) !== null;
  }

  private cleanCallbackUrl(): void {
    try {
      const url = new URL(window.location.href);
      let changed = false;
      for (const name of CALLBACK_PARAMS) {
        if (url.searchParams.has(name)) {
          url.searchParams.delete(name);
          changed = true;
        }
      }
      if (!changed) return;
      const search = url.searchParams.toString();
      const cleaned = `${url.pathname}${search.length > 0 ? `?${search}` : ''}${url.hash}`;
      window.history.replaceState(window.history.state, '', cleaned);
    } catch {
      // Cosmetic. A browser that refuses replaceState does not invalidate a
      // sign-in that already succeeded.
    }
  }
}

function resolveConfig(config: HesabimConfig): ResolvedConfig {
  if (typeof config !== 'object' || config === null) {
    throw new Error('createHesabimClient requires a configuration object');
  }
  if (!hasBrowserGlobals()) {
    throw new Error(
      'createHesabimClient requires a browser environment (it reads location and Web Storage)',
    );
  }

  if (!parseIssuerUrl(config.issuer)) {
    throw new Error(
      'config.issuer must be an absolute https URL without query or fragment (http is accepted only on localhost)',
    );
  }
  const issuer = normalizeIssuer(config.issuer);

  if (typeof config.clientId !== 'string' || config.clientId.length === 0) {
    throw new Error('config.clientId is required');
  }

  const redirectUrl = parseAbsoluteUrl(config.redirectUri);
  if (!redirectUrl) {
    throw new Error('config.redirectUri must be an absolute URL');
  }
  if (redirectUrl.origin !== window.location.origin) {
    // A callback that lands on another origin cannot read the sessionStorage
    // this SDK put the state and the PKCE verifier in, so it could never
    // complete. Failing here beats failing halfway through a redirect.
    throw new Error(
      `config.redirectUri must be on this origin (${window.location.origin}), got ${redirectUrl.origin}`,
    );
  }

  const resolved: ResolvedConfig = {
    issuer,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scopes: DEFAULT_SCOPES,
    clockSkewSec: DEFAULT_CLOCK_SKEW_SEC,
  };

  if (config.scopes !== undefined) {
    if (typeof config.scopes !== 'string' || config.scopes.trim().length === 0) {
      throw new Error('config.scopes must be a non-empty, space-separated string');
    }
    resolved.scopes = config.scopes;
  }

  if (config.postLogoutRedirectUri !== undefined) {
    if (!parseAbsoluteUrl(config.postLogoutRedirectUri)) {
      throw new Error('config.postLogoutRedirectUri must be an absolute URL');
    }
    resolved.postLogoutRedirectUri = config.postLogoutRedirectUri;
  }

  if (config.clockSkewSec !== undefined) {
    if (
      typeof config.clockSkewSec !== 'number' ||
      !Number.isFinite(config.clockSkewSec) ||
      config.clockSkewSec < 0
    ) {
      throw new Error('config.clockSkewSec must be a non-negative number of seconds');
    }
    resolved.clockSkewSec = config.clockSkewSec;
  }

  if (config.scopeResolver !== undefined) {
    if (typeof config.scopeResolver !== 'function') {
      throw new Error('config.scopeResolver must be a function');
    }
    resolved.scopeResolver = config.scopeResolver;
  }

  return resolved;
}
