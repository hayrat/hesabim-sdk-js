import { getSessionStorage, nowSec } from './env.js';

/**
 * Everything one authorization request needs to be finished, and nothing that
 * outlives it.
 *
 * These live in sessionStorage, not localStorage: they are single-flow values,
 * and persisting them past the tab would weaken the CSRF protection they exist
 * to provide. They are keyed BY STATE so two sign-ins started in two tabs do not
 * overwrite each other's verifier.
 */
export interface FlowState {
  v: 1;
  state: string;
  nonce: string;
  code_verifier: string;
  return_to?: string;
  created_at: number;
}

/** 15 minutes. Long enough for an OTP round trip, short enough to bound replay. */
export const FLOW_TTL_SEC = 15 * 60;

export class TransientStore {
  private readonly prefix: string;

  constructor(baseKey: string) {
    this.prefix = `${baseKey}.flow.`;
  }

  /**
   * Stores one flow and opportunistically drops the expired ones.
   *
   * Returns whether the flow is CONFIRMED stored (read back after the write).
   * A flow that is not stored cannot be finished — the callback's state lookup
   * fails closed — so `login()` refuses to redirect on `false` instead of
   * sending the user through a sign-in that is certain to fail on return.
   */
  save(flow: FlowState): boolean {
    const storage = getSessionStorage();
    if (!storage) return false;
    this.sweep(storage);
    const key = this.prefix + flow.state;
    const value = JSON.stringify(flow);
    try {
      storage.setItem(key, value);
      return storage.getItem(key) === value;
    } catch {
      return false;
    }
  }

  /**
   * Reads and REMOVES the flow for a state.
   *
   * Single use is the invariant, so the removal is CONFIRMED before the record
   * is handed back: a storage that keeps the key after `removeItem` — or throws
   * on the way — would turn one authorization code into a replayable one. A
   * flow that cannot be consumed is a flow that does not complete.
   */
  consume(state: string): FlowState | null {
    const storage = getSessionStorage();
    if (!storage) return null;

    const key = this.prefix + state;
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      return null;
    }
    if (raw === null) return null;

    try {
      storage.removeItem(key);
      if (storage.getItem(key) !== null) return null;
    } catch {
      return null;
    }

    const flow = parseFlow(raw);
    if (!flow || flow.state !== state) return null;

    // Both ends of the window. A `created_at` in the future is not a young
    // record — it is a clock that moved or a value somebody wrote — and without
    // the lower bound it would push the upper one arbitrarily far away.
    const now = nowSec();
    if (flow.created_at > now) return null;
    if (now - flow.created_at > FLOW_TTL_SEC) return null;
    return flow;
  }

  private sweep(storage: Storage): void {
    try {
      const now = nowSec();
      const stale: string[] = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key === null || !key.startsWith(this.prefix)) continue;
        const flow = parseFlow(storage.getItem(key));
        // The same window `consume` applies, so a record it would refuse does
        // not sit here until the tab closes.
        if (!flow || flow.created_at > now || now - flow.created_at > FLOW_TTL_SEC) {
          stale.push(key);
        }
      }
      for (const key of stale) storage.removeItem(key);
    } catch {
      /* housekeeping only */
    }
  }
}

function parseFlow(raw: string | null): FlowState | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;

  if (value['v'] !== 1) return null;
  const state = value['state'];
  const nonce = value['nonce'];
  const verifier = value['code_verifier'];
  const createdAt = value['created_at'];
  if (typeof state !== 'string' || state.length === 0) return null;
  if (typeof nonce !== 'string' || nonce.length === 0) return null;
  if (typeof verifier !== 'string' || verifier.length === 0) return null;
  // Whole seconds, and a real number: `Number.isInteger` rejects NaN, both
  // infinities and a fractional timestamp in one test.
  if (typeof createdAt !== 'number' || !Number.isInteger(createdAt)) return null;

  const flow: FlowState = {
    v: 1,
    state,
    nonce,
    code_verifier: verifier,
    created_at: createdAt,
  };
  const returnTo = value['return_to'];
  if (typeof returnTo === 'string' && returnTo.length > 0) flow.return_to = returnTo;
  return flow;
}
