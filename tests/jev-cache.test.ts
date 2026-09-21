// JEV cache + shared budget (spec P2-1).
//
// The point of this suite is call accounting: identical candidate sets must
// cost ZERO upstream round-trips, a different candidate set must cost one, and
// an exhausted budget must cost none while still answering deterministically.
import { describe, it, expect, afterEach } from 'vitest';
import { jevFingerprint, rankAndEstimate } from '../server/src/jevCache';
import type { JevInput } from '../server/src/jevCache';

process.env.JEV_CACHE_TTL_MS = '60000';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/**
 * Records every upstream request body and answers it the way the DOCUMENTED
 * TypeSafe API does: `questions` is a MAP keyed by our question ids, the reply
 * is `{ model, answers: { <same id>: Answer } }`, and a choice question's
 * options live in its `criteria` map.
 */
interface StubQuestion {
  type?: string;
  criteria?: Record<string, string>;
}
interface StubBody {
  model?: string;
  state?: unknown;
  questions?: Record<string, StubQuestion>;
}

function stubSystemOne() {
  const bodies: StubBody[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as StubBody;
    bodies.push(body);
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(body.questions ?? {})) {
      if (q.type === 'choice') {
        // Always pick the first option so any tagged id set works.
        const optionIds = Object.keys(q.criteria ?? {});
        answers[id] = {
          type: 'choice',
          choice: optionIds[0],
          confidence: 0.95,
          probabilities: {},
        };
      } else {
        answers[id] = { type: 'noul', noul: 0.2 };
      }
    }
    return json({ model: body.model, answers, usage: { input_tokens: 1, output_tokens: 1 } });
  }) as unknown as typeof fetch;
  return bodies;
}

/**
 * `tag` keeps each test's candidate set distinct: the JEV cache is a module
 * singleton shared across a file, so untagged fixtures would (correctly) hit
 * a previous test's cache entry.
 */
/**
 * Models a real fetch: pending forever unless the caller's signal aborts.
 * A stub that ignores the signal would hang the test instead of exercising
 * the timeout path it is supposed to cover.
 */
function hangingFetch() {
  globalThis.fetch = ((_url: unknown, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const fail = () =>
        reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
      if (init?.signal?.aborted) fail();
      else init?.signal?.addEventListener('abort', fail, { once: true });
    })) as unknown as typeof fetch;
}

function input(mutate: (i: JevInput) => void = () => {}, tag = 'base'): JevInput {
  const a = `r1-${tag}`;
  const b = `r2-${tag}`;
  const i: JevInput = {
    rank: [
      { id: a, score: 0, distanceM: 10_000, durationS: 900, exposureCount: 0, exposurePGeo: 0 },
      { id: b, score: 10_000, distanceM: 9_500, durationS: 840, exposureCount: 1, exposurePGeo: 0.2 },
    ],
    exposure: [
      { id: a, exposurePGeo: 0, exposureCount: 0, distanceM: 10_000 },
      { id: b, exposurePGeo: 0.2, exposureCount: 1, distanceM: 9_500 },
    ],
  };
  mutate(i);
  return i;
}

/** Ids of a tagged fixture, for readable assertions. */
const r1 = (tag = 'base') => `r1-${tag}`;

describe('jevFingerprint', () => {
  it('is stable for equal inputs and sensitive to routing facts + mode', () => {
    const a = jevFingerprint(input(), 'jev', 0.4);
    expect(jevFingerprint(input(), 'jev', 0.4)).toBe(a);
    expect(jevFingerprint(input(), 'fake', 0.4)).not.toBe(a);
    expect(jevFingerprint(input(), 'jev', 0.5)).not.toBe(a);
    const slower = input((i) => {
      i.rank[1].durationS = 1200;
    });
    expect(jevFingerprint(slower, 'jev', 0.4)).not.toBe(a);
  });

  it('never contains the caller key', () => {
    const key = jevFingerprint(input(), 'jev', 0.4);
    expect(key).not.toContain('test-key');
  });
});

describe('rankAndEstimate', () => {
  it('makes zero upstream calls without a key (deterministic path)', async () => {
    const bodies = stubSystemOne();
    const out = await rankAndEstimate(input(() => {}, 'nokey'), {});
    expect(bodies).toHaveLength(0);
    expect(out.cacheHit).toBe(false);
    expect(out.rank.mode).toBe('fake');
    expect(out.exposure[r1('nokey')].source).toBe('geometric');
  });

  it('serves a repeated candidate set from cache with no added upstream calls', async () => {
    const bodies = stubSystemOne();
    const first = await rankAndEstimate(input(() => {}, 'repeat'), {
      apiKey: 'test-key',
      budgetMs: 5_000,
    });
    expect(first.cacheHit).toBe(false);
    expect(bodies).toHaveLength(2); // ranking + exposure

    const second = await rankAndEstimate(input(() => {}, 'repeat'), {
      apiKey: 'test-key',
      budgetMs: 5_000,
    });
    expect(second.cacheHit).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(second.rank.rankedIds[0]).toBe(r1('repeat'));
    expect(second.rank.mode).toBe('jev');
  });

  it('a changed candidate set is a cache miss', async () => {
    const bodies = stubSystemOne();
    await rankAndEstimate(input(() => {}, 'changed'), { apiKey: 'test-key', budgetMs: 5_000 });
    const changed = input((i) => {
      i.rank.push({
        id: 'r3-changed',
        score: 20_000,
        distanceM: 12_000,
        durationS: 1_100,
        exposureCount: 2,
        exposurePGeo: 0.4,
      });
      i.exposure.push({
        id: 'r3-changed',
        exposurePGeo: 0.4,
        exposureCount: 2,
        distanceM: 12_000,
      });
    }, 'changed');
    const out = await rankAndEstimate(changed, { apiKey: 'test-key', budgetMs: 5_000 });
    expect(out.cacheHit).toBe(false);
    expect(bodies).toHaveLength(4);
  });

  it('never reuses an authenticated result for a keyless request (mode is in the key)', async () => {
    const bodies = stubSystemOne();
    const keyed = await rankAndEstimate(input(() => {}, 'mode'), {
      apiKey: 'test-key',
      budgetMs: 5_000,
    });
    expect(keyed.rank.mode).toBe('jev');
    const before = bodies.length;
    const keyless = await rankAndEstimate(input(() => {}, 'mode'), {});
    expect(keyless.rank.mode).toBe('fake');
    expect(keyless.cacheHit).toBe(false);
    expect(bodies).toHaveLength(before);
  });

  it('an exhausted budget costs no upstream calls but still ranks deterministically', async () => {
    const bodies = stubSystemOne();
    const out = await rankAndEstimate(input(() => {}, 'nobudget'), {
      apiKey: 'test-key',
      budgetMs: 0,
    });
    expect(bodies).toHaveLength(0);
    expect(out.cacheHit).toBe(false);
    expect(out.rank.mode).toBe('jev'); // honest: a key WAS supplied
    expect(out.rank.verdicts[r1('nobudget')].fallbackUsed).toBe(true);
    expect(out.exposure[r1('nobudget')].source).toBe('geometric');
  });

  it('a hanging upstream is cut off by the budget instead of blocking the request', async () => {
    hangingFetch();
    const started = Date.now();
    const out = await rankAndEstimate(input(() => {}, 'hang'), {
      apiKey: 'test-key',
      budgetMs: 300,
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(out.rank.verdicts[r1('hang')].fallbackUsed).toBe(true);
    expect(out.exposure[r1('hang')].source).toBe('geometric');
  });

  it('a degraded (failed) result is never cached', async () => {
    const bodies = stubSystemOne();
    hangingFetch();
    const degraded = await rankAndEstimate(input(() => {}, 'nocache'), {
      apiKey: 'test-key',
      budgetMs: 200,
    });
    expect(degraded.rank.degraded).toBe(true);
    expect(bodies).toHaveLength(0);
    // Same candidate set, healthy upstream, generous budget → must refetch.
    stubSystemOne();
    const out = await rankAndEstimate(input(() => {}, 'nocache'), {
      apiKey: 'test-key',
      budgetMs: 5_000,
    });
    expect(out.cacheHit).toBe(false);
    expect(out.rank.verdicts[r1('nocache')].fallbackUsed).toBe(false);
  });
});
