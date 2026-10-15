import { getLocalStorage } from './env.js';

/**
 * The persisted session, as one JSON value under one localStorage key.
 *
 * Persisting tokens is a deliberate, documented decision:
 * memory-only storage costs a full redirect on every reload and in
 * every new tab, and XSS — which memory-only does not actually prevent — is an
 * accepted risk here given first-party apps, ~10 minute access tokens and
 * refresh rotation with reuse detection.
 *
 * `expires_at` and `refresh_pending.at` are whole SECONDS since the epoch, the
 * same unit as a JWT `exp`.
 */
export interface StoredSession {
  v: 1;
  issuer: string;
  client_id: string;
  access_token: string;
  refresh_token?: string;
  id_token: string;
  expires_at: number;
  /**
   * Set immediately before a refresh POST and cleared by the write that stores
   * the response. Seeing one that nobody is currently resolving means a tab died
   * mid-refresh and the stored refresh token may already have been spent.
   */
  refresh_pending?: { at: number };
}

export type SessionListener = (record: StoredSession | null) => void;

/**
 * Where a write ended up. `'persisted'` means the value was written AND read
 * back from localStorage; `'memory'` means this page is keeping it to itself.
 * The refresh path needs the difference, because a token rotation that other
 * documents cannot see is a rotation that will be replayed by one of them.
 */
export type PersistOutcome = 'persisted' | 'memory';

/** An undo point for the store's in-process state. See `checkpoint`. */
export interface StoreCheckpoint {
  readonly memory: StoredSession | null;
  readonly degraded: boolean;
}

/**
 * Owns the single localStorage key and everything that can go wrong around it.
 *
 * # Failure semantics
 *
 * Reading is total: an unreadable key, malformed JSON, a wrong envelope version
 * and a record belonging to another issuer or client all read as "no session"
 * rather than as an error. (The issuer is part of the key AND of the envelope,
 * so a client id reused against a second issuer can never carry the first
 * issuer's refresh token to the second one's token endpoint.)
 *
 * Writing degrades instead of failing: where localStorage throws — a Safari
 * private window, a third-party storage block — the session continues IN MEMORY
 * for the life of this page. Sign-in still works; persistence and cross-tab
 * synchronisation do not. Hard-failing login there would be a worse trade.
 *
 * # Notification
 *
 * Same-document mutations update the in-memory view and notify subscribers
 * SYNCHRONOUSLY. The `storage` event is only the other documents' path — it does
 * not fire in the document that made the change — so relying on it alone would
 * leave this tab's own writes invisible to its own subscribers.
 */
export class SessionStore {
  private readonly key: string;
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly listeners = new Set<SessionListener>();

  /** Authoritative only once `degraded` is true. */
  private memory: StoredSession | null = null;
  private degraded = false;
  private fingerprint: string;
  private storageHandler: ((event: StorageEvent) => void) | null = null;

  constructor(key: string, issuer: string, clientId: string) {
    this.key = key;
    this.issuer = issuer;
    this.clientId = clientId;
    this.fingerprint = fingerprintOf(this.read());
  }

  /** True once a write failed and this page fell back to in-memory only. */
  get isDegraded(): boolean {
    return this.degraded;
  }

  read(): StoredSession | null {
    if (this.degraded) return this.memory;

    const storage = getLocalStorage();
    if (!storage) return null;

    let raw: string | null;
    try {
      raw = storage.getItem(this.key);
    } catch {
      return null;
    }
    if (raw === null) return null;

    return this.parse(raw);
  }

  /**
   * Stores a record and reports whether it is durable.
   *
   * The write is CONFIRMED by reading it back: a storage that accepts
   * `setItem` and keeps nothing would otherwise leave this page believing
   * other documents can see the value.
   */
  write(record: StoredSession): PersistOutcome {
    this.memory = record;
    let outcome: PersistOutcome = 'memory';
    if (!this.degraded) {
      const storage = getLocalStorage();
      const serialized = JSON.stringify(record);
      try {
        if (!storage) throw new Error('localStorage is unavailable');
        storage.setItem(this.key, serialized);
        if (storage.getItem(this.key) !== serialized) throw new Error('write was not retained');
        outcome = 'persisted';
      } catch {
        this.degraded = true;
      }
    }
    this.notify();
    return outcome;
  }

  /**
   * Removes the PERSISTED copy while keeping the in-memory session, and reports
   * whether localStorage is confirmed to no longer hold it.
   *
   * This is the second half of the rule that a refresh may not be POSTed until
   * the predecessor is either superseded durably or gone: a record that stays
   * visible to other documents while this page rotates in memory is a refresh
   * token another tab will present after it has been spent, which is what the
   * server's reuse detection revokes a whole family for.
   */
  dropPersisted(): boolean {
    // Whatever is about to stop being durable has to survive in memory. Only
    // when nothing is held here: an in-flight write has already put the newer
    // record in `memory`, and that one must not be replaced by the older
    // persisted copy.
    if (this.memory === null) this.memory = this.read();

    const storage = getLocalStorage();
    if (!storage) {
      // Nothing of ours can be visible to another document either.
      this.degraded = true;
      return true;
    }
    try {
      storage.removeItem(this.key);
      if (storage.getItem(this.key) !== null) return false;
    } catch {
      return false;
    }
    this.degraded = true;
    return true;
  }

  /**
   * Everything a caller may need to put back: the in-memory record and whether
   * this page had already fallen back to memory.
   *
   * Paired with `rollback`, this makes a sequence of attempted writes an
   * all-or-nothing change. `write` has to mutate memory before it knows whether
   * localStorage will accept the value — degradation is exactly the case where
   * it does not — so a caller that gives up afterwards would otherwise leave
   * this process holding a record that was never agreed with anybody.
   */
  checkpoint(): StoreCheckpoint {
    return { memory: this.memory, degraded: this.degraded };
  }

  /** Puts the store back to a checkpoint, notifying if the record changed. */
  rollback(checkpoint: StoreCheckpoint): void {
    this.memory = checkpoint.memory;
    this.degraded = checkpoint.degraded;
    this.notify();
  }

  /**
   * Signs this browser out of the record: memory unconditionally, and the
   * persisted copy by an attempted, READ-BACK-CONFIRMED removal — on a
   * degraded page too. `degraded` means WRITES stopped being durable; an
   * older record may still sit under the key (the page degraded mid-write,
   * or a predecessor left it), and a sign-out that skips it is a sign-out
   * the next page load silently undoes, with a refresh token that was never
   * withdrawn. When removal cannot be confirmed the page stays degraded and
   * the leftover eventually dies server-side: the IdP's end-session revokes
   * the family, and the first refresh against it answers `invalid_grant`.
   */
  clear(): void {
    this.memory = null;
    const storage = getLocalStorage();
    try {
      if (!storage) throw new Error('localStorage is unavailable');
      storage.removeItem(this.key);
      if (storage.getItem(this.key) !== null) throw new Error('removal was not retained');
    } catch {
      this.degraded = true;
    }
    this.notify();
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Starts listening for the OTHER documents' mutations of this key. */
  startCrossTabSync(): void {
    if (this.storageHandler || typeof window === 'undefined') return;
    this.storageHandler = (event: StorageEvent) => {
      // `key === null` is a whole-storage clear(), which affects ours too.
      if (event.key !== null && event.key !== this.key) return;
      // Once this page is memory-only its own state is the truth; adopting
      // another document's view would silently drop the session it is holding.
      if (this.degraded) return;
      this.notify();
    };
    window.addEventListener('storage', this.storageHandler);
  }

  /** Recomputes the current record and fires subscribers if it changed. */
  private notify(): void {
    const current = this.read();
    const next = fingerprintOf(current);
    if (next === this.fingerprint) return;
    this.fingerprint = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(current);
      } catch {
        // A subscriber that throws is the application's problem, not a reason
        // to leave the remaining subscribers un-notified.
      }
    }
  }

  private parse(raw: string): StoredSession | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;

    if (value['v'] !== 1) return null;
    if (value['issuer'] !== this.issuer) return null;
    if (value['client_id'] !== this.clientId) return null;

    const accessToken = value['access_token'];
    const idToken = value['id_token'];
    const expiresAt = value['expires_at'];
    if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
    if (typeof idToken !== 'string' || idToken.length === 0) return null;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;

    const record: StoredSession = {
      v: 1,
      issuer: this.issuer,
      client_id: this.clientId,
      access_token: accessToken,
      id_token: idToken,
      expires_at: expiresAt,
    };

    const refreshToken = value['refresh_token'];
    if (refreshToken !== undefined) {
      if (typeof refreshToken !== 'string' || refreshToken.length === 0) return null;
      record.refresh_token = refreshToken;
    }

    const pending = value['refresh_pending'];
    if (pending !== undefined) {
      // A malformed marker is treated as a malformed RECORD, not as an absent
      // marker: dropping it would re-enable exactly the replay it exists to
      // prevent.
      if (typeof pending !== 'object' || pending === null || Array.isArray(pending)) return null;
      const at = (pending as Record<string, unknown>)['at'];
      if (typeof at !== 'number' || !Number.isFinite(at)) return null;
      record.refresh_pending = { at };
    }

    return record;
  }
}

/**
 * A stable string identity for a record. Built from a fixed field ORDER rather
 * than from the parsed object, so that key order — which comes from whatever
 * document wrote the value — cannot make an unchanged record look changed.
 */
function fingerprintOf(record: StoredSession | null): string {
  if (!record) return '';
  // Serialised as an ARRAY: element order is fixed here, and JSON escaping
  // removes any question of a value colliding with a separator.
  return JSON.stringify([
    record.v,
    record.issuer,
    record.client_id,
    record.access_token,
    record.refresh_token ?? null,
    record.id_token,
    record.expires_at,
    record.refresh_pending ? record.refresh_pending.at : null,
  ]);
}
