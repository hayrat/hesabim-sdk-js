/**
 * The three error classes the SDK throws. Nothing else is exported, and none of
 * them ever carries a token byte, a claim value, an `error_description` or any
 * other part of a server response body: an exception message reaches logs and
 * error trackers the application does not control.
 */

/**
 * The user has no usable session and interactive sign-in is required.
 *
 * Throwing this always means the stored session was (or already had been)
 * discarded — the caller's remedy is `login()`.
 */
export class AuthRequiredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthRequiredError';
  }
}

/**
 * Something the SDK depends on is temporarily unavailable — the network, the
 * discovery document, or the token endpoint answering with anything other than
 * a well-formed `invalid_grant`.
 *
 * The stored session is deliberately PRESERVED when this is thrown, so an
 * operational blip does not log every user out. Note that a refresh POST is
 * never retried automatically: if a refresh attempt failed after its in-flight
 * marker was written, the next refresh will find that marker unresolved and
 * escalate to `AuthRequiredError` rather than replay a possibly-spent refresh
 * token.
 */
export class AuthUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthUnavailableError';
  }
}

/**
 * The authorization server answered the redirect (or the code exchange) with an
 * OAuth error.
 *
 * `code` is the machine-readable OAuth/OIDC error code, verbatim (truncated to a
 * sane length). `error_description` is deliberately dropped — it is
 * server-controlled free text and turning user-facing wording into a leak
 * channel is not worth the debugging convenience.
 */
export class CallbackError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    // Only a code that looks like an OAuth error code (RFC 6749 registers
    // snake_case identifiers) is interpolated into the message; anything else
    // stays exclusively on `.code`, where a caller has to opt into reading it.
    const safe = /^[a-z][a-z0-9_]{0,63}$/.test(code);
    super(
      safe
        ? `the authorization server returned "${code}"`
        : 'the authorization server returned an error',
      options,
    );
    this.name = 'CallbackError';
    this.code = code.slice(0, 128);
  }
}
