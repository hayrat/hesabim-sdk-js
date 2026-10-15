import { describe, expect, it, vi } from 'vitest';
import {
  CLIENT_ID,
  ISSUER,
  STORAGE_KEY,
  accessToken,
  idToken,
  nowSec,
  storedRecord,
} from '../test-support/harness.js';
import type { StoredSession } from './storage.js';
import { SessionStore } from './storage.js';

function newStore(): SessionStore {
  return new SessionStore(STORAGE_KEY, ISSUER, CLIENT_ID);
}

function validRecord(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    v: 1,
    issuer: ISSUER,
    client_id: CLIENT_ID,
    access_token: accessToken(),
    refresh_token: 'refresh-1',
    id_token: idToken(),
    expires_at: nowSec() + 600,
    ...overrides,
  };
}

describe('SessionStore.read', () => {
  it('reads back a record it wrote', () => {
    const store = newStore();
    const record = validRecord();
    store.write(record);
    expect(newStore().read()).toEqual(record);
  });

  it('ignores malformed JSON', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json');
    expect(newStore().read()).toBeNull();
  });

  it('ignores an envelope version it does not know', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(storedRecord({ v: 2 })));
    expect(newStore().read()).toBeNull();
  });

  it('ignores a record minted by another issuer', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(storedRecord({ issuer: 'https://other.example' })),
    );
    expect(newStore().read()).toBeNull();
  });

  it('ignores a record belonging to another client', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(storedRecord({ client_id: 'other-client' })),
    );
    expect(newStore().read()).toBeNull();
  });

  it('ignores a record with missing or wrongly typed fields', () => {
    const cases: Array<Record<string, unknown>> = [
      { ...validRecord(), access_token: '' },
      { ...validRecord(), id_token: undefined },
      { ...validRecord(), expires_at: 'soon' },
      { ...validRecord(), refresh_token: '' },
    ];
    for (const broken of cases) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(broken));
      expect(newStore().read()).toBeNull();
    }
  });

  it('treats a malformed in-flight marker as a malformed record, never as an absent marker', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...validRecord(), refresh_pending: { at: 'now' } }),
    );
    expect(newStore().read()).toBeNull();

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...validRecord(), refresh_pending: true }),
    );
    expect(newStore().read()).toBeNull();
  });

  it('keeps a well-formed marker so the caller can act on it', () => {
    const record = validRecord({ refresh_pending: { at: nowSec() } });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    expect(newStore().read()?.refresh_pending).toEqual(record.refresh_pending);
  });

  it('reads as signed out when localStorage throws', () => {
    const store = newStore();
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(store.read()).toBeNull();
  });
});

describe('SessionStore notification', () => {
  it('fires synchronously on a same-document write', () => {
    const store = newStore();
    const seen: Array<StoredSession | null> = [];
    store.subscribe((record) => seen.push(record));

    const record = validRecord();
    store.write(record);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(record);
  });

  it('fires when only the tokens change, even though the record stays present', () => {
    const store = newStore();
    store.write(validRecord());
    const seen: Array<StoredSession | null> = [];
    store.subscribe((record) => seen.push(record));

    const renamed = validRecord({ id_token: idToken({ name: 'Renamed' }) });
    store.write(renamed);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.id_token).toBe(renamed.id_token);
  });

  it('does not fire when the record is written unchanged', () => {
    const store = newStore();
    const record = validRecord();
    store.write(record);
    const listener = vi.fn();
    store.subscribe(listener);

    store.write({ ...record });

    expect(listener).not.toHaveBeenCalled();
  });

  it('fires on clear and stops firing after unsubscribe', () => {
    const store = newStore();
    store.write(validRecord());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.clear();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(null);

    unsubscribe();
    store.write(validRecord());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps notifying the other subscribers when one throws', () => {
    const store = newStore();
    const good = vi.fn();
    store.subscribe(() => {
      throw new Error('subscriber bug');
    });
    store.subscribe(good);

    store.write(validRecord());

    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe('SessionStore cross-tab sync', () => {
  it('picks up another document write through the storage event', () => {
    const store = newStore();
    store.startCrossTabSync();
    const listener = vi.fn();
    store.subscribe(listener);

    const record = validRecord();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    window.dispatchEvent(
      new StorageEvent('storage', { key: STORAGE_KEY, newValue: JSON.stringify(record) }),
    );

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.read()).toEqual(record);
  });

  it('reacts to a whole-storage clear (key === null)', () => {
    const store = newStore();
    store.write(validRecord());
    store.startCrossTabSync();
    const listener = vi.fn();
    store.subscribe(listener);

    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.read()).toBeNull();
  });

  it('ignores events for other keys', () => {
    const store = newStore();
    store.startCrossTabSync();
    const listener = vi.fn();
    store.subscribe(listener);

    window.localStorage.setItem('unrelated', 'x');
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', newValue: 'x' }));

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('SessionStore durability reporting', () => {
  it('reports a write that reached localStorage', () => {
    const store = newStore();
    expect(store.write(validRecord())).toBe('persisted');
  });

  it('reports a write that only reached memory', () => {
    const store = newStore();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(store.write(validRecord())).toBe('memory');
  });

  it('reports a write that was accepted but not retained', () => {
    // A storage that swallows setItem must not leave this page believing other
    // documents can see the value.
    const store = newStore();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      /* accepted, and ignored */
    });
    expect(store.write(validRecord())).toBe('memory');
  });

  it('drops the persisted copy while keeping the in-memory session', () => {
    const store = newStore();
    const record = validRecord();
    store.write(record);

    expect(store.dropPersisted()).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(store.read()).toEqual(record);
    expect(store.isDegraded).toBe(true);
  });

  it('keeps the newer in-memory record when the persisted one is dropped', () => {
    const store = newStore();
    store.write(validRecord());
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const marked = validRecord({ refresh_pending: { at: nowSec() } });
    store.write(marked);

    expect(store.dropPersisted()).toBe(true);
    expect(store.read()).toEqual(marked);
  });

  it('reports failure when the removal throws or is ignored', () => {
    const throwing = newStore();
    throwing.write(validRecord());
    const remove = vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(throwing.dropPersisted()).toBe(false);

    remove.mockImplementation(() => {
      /* accepted, and ignored */
    });
    expect(throwing.dropPersisted()).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('succeeds when there was never anything persisted', () => {
    const store = newStore();
    expect(store.dropPersisted()).toBe(true);
  });

  it('rolls a failed write back out of memory, fallback flag included', () => {
    const store = newStore();
    const record = validRecord();
    store.write(record);
    const checkpoint = store.checkpoint();

    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const marked = validRecord({ refresh_pending: { at: nowSec() } });
    expect(store.write(marked)).toBe('memory');
    expect(store.read()).toEqual(marked);
    expect(store.isDegraded).toBe(true);

    store.rollback(checkpoint);

    expect(store.read()).toEqual(record);
    expect(store.isDegraded).toBe(false);
  });

  it('tells subscribers the record went back', () => {
    const store = newStore();
    store.write(validRecord());
    const checkpoint = store.checkpoint();
    const seen: Array<StoredSession | null> = [];
    store.subscribe((record) => seen.push(record));

    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    store.write(validRecord({ refresh_pending: { at: nowSec() } }));
    store.rollback(checkpoint);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.refresh_pending).toMatchObject({ at: expect.any(Number) });
    expect(seen[1]?.refresh_pending).toBeUndefined();
  });
});

describe('SessionStore write failure', () => {
  it('keeps the session in memory for the life of the page', () => {
    const store = newStore();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    const record = validRecord();
    store.write(record);

    expect(store.isDegraded).toBe(true);
    expect(store.read()).toEqual(record);
    // Nothing reached localStorage, so a second store (another page) sees none of it.
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('clear removes the persisted record even on a degraded page', () => {
    const store = newStore();
    // The key holds a record other documents can see; THIS page then degrades
    // on a failed write. Sign-out must still take the persisted copy down, or
    // the next page load silently resurrects the session.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(validRecord()));
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    store.write(validRecord());
    expect(store.isDegraded).toBe(true);

    store.clear();

    setItem.mockRestore();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(store.read()).toBeNull();
  });

  it('clear confirms the removal by read-back and degrades when storage keeps the value', () => {
    const store = newStore();
    store.write(validRecord());
    // A storage that accepts removeItem and keeps the value — the same failure
    // mode write() and dropPersisted() defend against.
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {});

    store.clear();

    // This page must not believe a sign-out other documents cannot see: its
    // own truth becomes the in-memory null, and it stops trusting the storage.
    expect(store.isDegraded).toBe(true);
    expect(store.read()).toBeNull();
  });

  it('still notifies subscribers while degraded', () => {
    const store = newStore();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const listener = vi.fn();
    store.subscribe(listener);

    store.write(validRecord());
    expect(listener).toHaveBeenCalledTimes(1);

    store.clear();
    expect(store.read()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('ignores other documents once it is memory-only', () => {
    const store = newStore();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const record = validRecord();
    store.write(record);
    store.startCrossTabSync();
    const listener = vi.fn();
    store.subscribe(listener);

    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: null }));

    expect(listener).not.toHaveBeenCalled();
    expect(store.read()).toEqual(record);
  });
});
