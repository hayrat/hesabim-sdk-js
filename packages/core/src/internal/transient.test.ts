import { describe, expect, it, vi } from 'vitest';
import { FLOW_KEY_PREFIX, STORAGE_KEY, nowSec } from '../test-support/harness.js';
import type { FlowState } from './transient.js';
import { FLOW_TTL_SEC, TransientStore } from './transient.js';

function flow(overrides: Partial<FlowState> = {}): FlowState {
  return {
    v: 1,
    state: 'state-1',
    nonce: 'nonce-1',
    code_verifier: 'verifier-1',
    created_at: nowSec(),
    ...overrides,
  };
}

describe('TransientStore', () => {
  it('round-trips a flow, including returnTo', () => {
    const store = new TransientStore(STORAGE_KEY);
    const saved = flow({ return_to: '/reports' });
    store.save(saved);

    expect(store.consume('state-1')).toEqual(saved);
  });

  it('is single use', () => {
    const store = new TransientStore(STORAGE_KEY);
    store.save(flow());

    expect(store.consume('state-1')).not.toBeNull();
    expect(store.consume('state-1')).toBeNull();
  });

  it('removes the record even when it is too old to use', () => {
    const store = new TransientStore(STORAGE_KEY);
    store.save(flow({ created_at: nowSec() - FLOW_TTL_SEC - 1 }));

    expect(store.consume('state-1')).toBeNull();
    expect(window.sessionStorage.getItem(`${FLOW_KEY_PREFIX}state-1`)).toBeNull();
  });

  it('accepts a flow that is just inside the TTL', () => {
    const store = new TransientStore(STORAGE_KEY);
    store.save(flow({ created_at: nowSec() - FLOW_TTL_SEC + 5 }));

    expect(store.consume('state-1')).not.toBeNull();
  });

  it('keeps two parallel sign-ins apart', () => {
    const store = new TransientStore(STORAGE_KEY);
    store.save(flow({ state: 'state-a', code_verifier: 'verifier-a' }));
    store.save(flow({ state: 'state-b', code_verifier: 'verifier-b' }));

    expect(store.consume('state-b')?.code_verifier).toBe('verifier-b');
    expect(store.consume('state-a')?.code_verifier).toBe('verifier-a');
  });

  it('returns null for an unknown state', () => {
    const store = new TransientStore(STORAGE_KEY);
    expect(store.consume('never-issued')).toBeNull();
  });

  it('ignores a stored flow that is malformed', () => {
    const store = new TransientStore(STORAGE_KEY);
    window.sessionStorage.setItem(`${FLOW_KEY_PREFIX}state-1`, '{oops');
    expect(store.consume('state-1')).toBeNull();

    window.sessionStorage.setItem(
      `${FLOW_KEY_PREFIX}state-1`,
      JSON.stringify({ ...flow(), code_verifier: '' }),
    );
    expect(store.consume('state-1')).toBeNull();
  });

  it('refuses a record filed under a state other than its own', () => {
    const store = new TransientStore(STORAGE_KEY);
    window.sessionStorage.setItem(
      `${FLOW_KEY_PREFIX}state-1`,
      JSON.stringify(flow({ state: 'state-other' })),
    );
    expect(store.consume('state-1')).toBeNull();
  });

  it('sweeps expired flows when a new one is saved', () => {
    const store = new TransientStore(STORAGE_KEY);
    store.save(flow({ state: 'old', created_at: nowSec() - FLOW_TTL_SEC - 1 }));
    expect(window.sessionStorage.getItem(`${FLOW_KEY_PREFIX}old`)).not.toBeNull();

    store.save(flow({ state: 'new' }));

    expect(window.sessionStorage.getItem(`${FLOW_KEY_PREFIX}old`)).toBeNull();
    expect(window.sessionStorage.getItem(`${FLOW_KEY_PREFIX}new`)).not.toBeNull();
  });

  it('does not hand back a record it could not remove', () => {
    // Single use is the invariant. A storage that throws on removal would
    // otherwise leave a replayable flow behind.
    const store = new TransientStore(STORAGE_KEY);
    store.save(flow());
    vi.spyOn(window.sessionStorage, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(store.consume('state-1')).toBeNull();
  });

  it('does not hand back a record whose removal was silently ignored', () => {
    const store = new TransientStore(STORAGE_KEY);
    store.save(flow());
    vi.spyOn(window.sessionStorage, 'removeItem').mockImplementation(() => {
      /* accepted, and ignored */
    });

    expect(store.consume('state-1')).toBeNull();
  });

  it('refuses a flow stamped in the future', () => {
    // Without the lower bound, a future timestamp pushes the TTL out as far as
    // whoever wrote it likes.
    const store = new TransientStore(STORAGE_KEY);
    window.sessionStorage.setItem(
      `${FLOW_KEY_PREFIX}state-1`,
      JSON.stringify(flow({ created_at: nowSec() + 5 })),
    );

    expect(store.consume('state-1')).toBeNull();
  });

  it('refuses a created_at that is not a whole number of seconds', () => {
    const store = new TransientStore(STORAGE_KEY);
    for (const createdAt of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '123']) {
      window.sessionStorage.setItem(
        `${FLOW_KEY_PREFIX}state-1`,
        JSON.stringify({ ...flow(), created_at: createdAt }),
      );
      expect(store.consume('state-1'), String(createdAt)).toBeNull();
    }
  });

  it('survives a sessionStorage that refuses to write', () => {
    const store = new TransientStore(STORAGE_KEY);
    vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(store.save(flow())).toBe(false);
    // Nothing was stored, so the callback will fail closed on the state lookup.
    expect(store.consume('state-1')).toBeNull();
  });
});
