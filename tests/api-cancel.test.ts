// Cancellation wiring in the typed API client: the abort signal must reach
// fetch, and an abort must stay distinguishable from a network failure so the
// UI can ignore it instead of showing an error.
import { describe, it, expect, afterEach } from 'vitest';
import { ApiError, isAbortError, getCameras, postRoute } from '../client/src/lib/api';
import { AUSTIN } from './helpers';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

const DEST = { lat: 30.35, lon: -97.7 };

describe('api: aborts are forwarded and not swallowed as errors', () => {
  it('postRoute passes the caller signal through to fetch', async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      seen = init?.signal ?? undefined;
      return jsonResponse({ routes: [], rankedBy: 'heuristic', jevMode: 'fake' });
    }) as unknown as typeof fetch;

    const ctrl = new AbortController();
    await postRoute({ origin: AUSTIN, destination: DEST }, { signal: ctrl.signal });

    expect(seen).toBe(ctrl.signal);
  });

  it('getCameras passes the caller signal through to fetch', async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      seen = init?.signal ?? undefined;
      return jsonResponse({ cameras: [] });
    }) as unknown as typeof fetch;

    const ctrl = new AbortController();
    await getCameras({ minLon: -98, minLat: 29, maxLon: -97, maxLat: 31 }, 50, {
      signal: ctrl.signal,
    });

    expect(seen).toBe(ctrl.signal);
  });

  it('with no signal the request still works (signal omitted)', async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = (async (_url: unknown, i: RequestInit) => {
      init = i;
      return jsonResponse({ cameras: [] });
    }) as unknown as typeof fetch;

    await getCameras({ minLon: -98, minLat: 29, maxLon: -97, maxLat: 31 });
    expect(init?.signal ?? undefined).toBeUndefined();
  });

  it('an aborted request rejects with an AbortError, not ApiError(0)', async () => {
    globalThis.fetch = ((_url: unknown, init: RequestInit) =>
      new Promise((_res, rej) => {
        const s = init?.signal;
        const fail = () => {
          const e = new Error('The operation was aborted.');
          e.name = 'AbortError';
          rej(e);
        };
        if (s?.aborted) fail();
        else s?.addEventListener('abort', fail);
      })) as unknown as typeof fetch;

    const ctrl = new AbortController();
    const p = postRoute({ origin: AUSTIN, destination: DEST }, { signal: ctrl.signal });
    ctrl.abort();
    const err = await p.then(
      () => null,
      (e) => e,
    );

    expect(err).toBeTruthy();
    expect(isAbortError(err)).toBe(true);
    expect(err instanceof ApiError).toBe(false);
  });

  it('a genuine network failure is still an ApiError(0), not an abort', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const err = await postRoute({ origin: AUSTIN, destination: DEST }).then(
      () => null,
      (e) => e,
    );

    expect(err instanceof ApiError).toBe(true);
    expect((err as ApiError).status).toBe(0);
    expect(isAbortError(err)).toBe(false);
  });

  it('isAbortError ignores ordinary errors and non-errors', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError('boom')).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});
