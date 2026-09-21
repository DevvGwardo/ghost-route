// Request supersession: the last user intent must always win.
import { describe, it, expect } from 'vitest';
import { createRequestGuard } from '../client/src/lib/requestGuard';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('requestGuard: last intent wins', () => {
  it('starts at seq 0 and hands out monotonic tickets', () => {
    const g = createRequestGuard();
    expect(g.seq).toBe(0);
    expect(g.begin().seq).toBe(1);
    expect(g.begin().seq).toBe(2);
    expect(g.seq).toBe(2);
  });

  it('aborting the previous request when a new one starts', () => {
    const g = createRequestGuard();
    const t1 = g.begin();
    expect(t1.signal.aborted).toBe(false);
    const t2 = g.begin();
    expect(t1.signal.aborted).toBe(true);
    expect(t2.signal.aborted).toBe(false);
  });

  it('out-of-order responses: a slow older response cannot overwrite fresh state', async () => {
    const g = createRequestGuard();
    let state = 'none';
    const apply = (t: { seq: number }, v: string) => {
      if (g.isCurrent(t)) state = v;
    };
    const slow = deferred<string>();
    const fast = deferred<string>();

    // First request starts, then is superseded by the second.
    const first = (async () => {
      const t = g.begin();
      apply(t, await slow.promise);
    })();
    const second = (async () => {
      const t = g.begin();
      apply(t, await fast.promise);
    })();

    // The NEW response lands first; the stale one lands second.
    fast.resolve('fresh');
    await second;
    slow.resolve('stale');
    await first;

    expect(state).toBe('fresh');
  });

  it('isCurrent is true only for the newest ticket', () => {
    const g = createRequestGuard();
    const a = g.begin();
    const b = g.begin();
    const c = g.begin();
    expect([g.isCurrent(a), g.isCurrent(b), g.isCurrent(c)]).toEqual([false, false, true]);
  });

  it('abort() cancels the in-flight request but keeps the newer intent current', () => {
    const g = createRequestGuard();
    const t = g.begin();
    g.abort();
    expect(t.signal.aborted).toBe(true);
    // A plain abort (e.g. unmount) is not a supersession: no newer request
    // exists, so the aborted ticket is still the current one.
    expect(g.isCurrent(t)).toBe(true);
  });

  it('invalidate() aborts AND retires the ticket without a replacement', () => {
    const g = createRequestGuard();
    const t = g.begin();
    g.invalidate();
    expect(t.signal.aborted).toBe(true);
    // Unlike abort(), the in-flight ticket may no longer apply — this is the
    // gap between "endpoints changed" and the debounced replacement starting.
    expect(g.isCurrent(t)).toBe(false);
    expect(g.seq).toBe(2);
  });

  it('a response already on the wire cannot apply after invalidate()', async () => {
    const g = createRequestGuard();
    let state = 'none';
    const slow = deferred<string>();
    const inFlight = (async () => {
      const t = g.begin();
      const value = await slow.promise;
      if (g.isCurrent(t)) state = value;
    })();

    // User changed the origin: cancel before the debounced replacement starts.
    g.invalidate();
    slow.resolve('for-the-old-origin');
    await inFlight;

    expect(state).toBe('none');
  });

  it('begin() after invalidate() still hands out the newest ticket', () => {
    const g = createRequestGuard();
    const t1 = g.begin();
    g.invalidate();
    const t2 = g.begin();
    expect(g.isCurrent(t1)).toBe(false);
    expect(g.isCurrent(t2)).toBe(true);
    expect(t2.signal.aborted).toBe(false);
  });

  it('separate guards are independent', () => {
    const a = createRequestGuard();
    const b = createRequestGuard();
    const ta = a.begin();
    b.begin();
    b.begin();
    expect(ta.signal.aborted).toBe(false);
    expect(a.isCurrent(ta)).toBe(true);
  });
});
