// TypeSafe request/response contract + error classification.
//
// This is the regression guard for a real bug: the client spoke an older shape
// (`{ questions: [ { type, question, options } ] }`, no `model`) which the
// documented API answers with a 422, and every non-401/403 failure was
// reported as "unreachable" — so a broken request looked like an outage.
//
// Documented shape (docs.typesafe.ai/api):
//   POST https://api.typesafe.ai/v1/systemone
//   { state, model, questions: { <id>: { type, instructions, criteria? } } }
//   → { model, answers: { <id>: { type, choice?, noul?, probabilities?, confidence? } }, usage }
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import type { RankInput, ExposureInput } from '../server/src/jev';
import { startServer, fetchJson } from './helpers';

const REAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  delete process.env.JEV_MODEL;
  delete process.env.TYPESAFE_API_KEY;
});

interface Captured {
  url: string;
  auth: string | null;
  body: Record<string, unknown>;
}

/** Stubs TypeSafe, capturing what we sent and replying in the documented shape. */
function stubTypesafe(
  reply: (body: Record<string, unknown>) => { status: number; json: unknown },
): Captured[] {
  const captured: Captured[] = [];
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    const headers = (init.headers ?? {}) as Record<string, string>;
    captured.push({ url: String(url), auth: headers.Authorization ?? null, body });
    const { status, json } = reply(body);
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return captured;
}

/** Documented choice reply: pick the first criteria key. */
function choiceReply(body: Record<string, unknown>, confidence = 0.95) {
  const questions = (body.questions ?? {}) as Record<string, { type?: string; criteria?: Record<string, string> }>;
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      answers[id] = {
        type: 'choice',
        choice: Object.keys(q.criteria ?? {})[0],
        confidence,
        probabilities: {},
      };
    } else {
      answers[id] = { type: 'noul', noul: 0.8 };
    }
  }
  return { status: 200, json: { model: body.model, answers, usage: { input_tokens: 1, output_tokens: 1 } } };
}

/** Asserts the shared, version-critical parts of every request we send. */
function assertDocumentedShape(body: Record<string, unknown>, where: string): void {
  expect(body.model, `${where}: \`model\` is required by the API`).toBe('jev-latest');
  expect(body.state, `${where}: \`state\` is required by the API`).toBeDefined();
  expect(Array.isArray(body.questions), `${where}: \`questions\` must be a MAP, not an array`).toBe(false);
  expect(typeof body.questions, `${where}: \`questions\` must be an object`).toBe('object');
  const questions = body.questions as Record<string, Record<string, unknown>>;
  expect(Object.keys(questions).length, `${where}: at least one question`).toBeGreaterThan(0);
  for (const [id, q] of Object.entries(questions)) {
    expect(typeof q.instructions, `${where}: question ${id} needs \`instructions\``).toBe('string');
    expect((q.instructions as string).length, `${where}: question ${id} instructions are empty`).toBeGreaterThan(0);
    expect(['choice', 'noul', 'score'], `${where}: question ${id} type`).toContain(q.type);
    // The legacy shape's dead giveaways must never come back.
    expect(q.question, `${where}: question ${id} uses the legacy \`question\` key`).toBeUndefined();
    expect(q.options, `${where}: question ${id} uses the legacy \`options\` key`).toBeUndefined();
  }
}

const ROUTES: RankInput[] = [
  { id: 'route-0', score: 0, distanceM: 10_000, durationS: 900, exposureCount: 0, exposurePGeo: 0 },
  { id: 'route-1', score: 10_000, distanceM: 9_500, durationS: 840, exposureCount: 1, exposurePGeo: 0.2 },
];

const EXPOSURE: ExposureInput[] = [
  { id: 'route-0', exposurePGeo: 0, exposureCount: 0, distanceM: 10_000 },
  { id: 'route-1', exposurePGeo: 0.2, exposureCount: 1, distanceM: 9_500 },
];

describe('outgoing request matches the documented TypeSafe contract', () => {
  it('verifyKey sends state + model + a questions MAP of typed questions', async () => {
    const { verifyKey } = await import('../server/src/jev');
    const captured = stubTypesafe((body) => choiceReply(body));
    const out = await verifyKey('a-real-looking-key');
    expect(out.valid).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(captured[0].auth).toBe('Bearer a-real-looking-key');
    assertDocumentedShape(captured[0].body, 'verify');
  });

  it('rankRoutes puts each candidate in the choice `criteria` map, keyed by route id', async () => {
    const { rankRoutes } = await import('../server/src/jev');
    const captured = stubTypesafe((body) => choiceReply(body));
    const out = await rankRoutes(ROUTES, { apiKey: 'k' });
    assertDocumentedShape(captured[0].body, 'rank');
    const questions = captured[0].body.questions as Record<string, { type: string; criteria?: Record<string, string> }>;
    const rank = Object.values(questions)[0];
    expect(rank.type).toBe('choice');
    expect(Object.keys(rank.criteria ?? {}).sort()).toEqual(['route-0', 'route-1']);
    // Answers come back under the same question id, which is what we parse.
    expect(out.rankedIds[0]).toBe('route-0');
    expect(out.verdicts['route-0'].fallbackUsed).toBe(false);
  });

  it('estimateExposure sends one noul question per route and parses the answers map', async () => {
    const { estimateExposure } = await import('../server/src/jev');
    const captured = stubTypesafe((body) => choiceReply(body));
    const out = await estimateExposure(EXPOSURE, { apiKey: 'k' });
    assertDocumentedShape(captured[0].body, 'exposure');
    const questions = captured[0].body.questions as Record<string, { type: string }>;
    expect(Object.values(questions).every((q) => q.type === 'noul')).toBe(true);
    expect(Object.keys(questions).sort()).toEqual(['observed_0', 'observed_1']);
    expect(out['route-0'].source).toBe('jev-noul');
    expect(out['route-0'].p).toBeCloseTo(0.8, 6);
  });

  it('honours JEV_MODEL for the model alias', async () => {
    const { rankRoutes } = await import('../server/src/jev');
    process.env.JEV_MODEL = 'jev-pinned';
    const captured = stubTypesafe((body) => choiceReply(body));
    await rankRoutes(ROUTES, { apiKey: 'k' });
    expect(captured[0].body.model).toBe('jev-pinned');
  });

  it('never sends the key in the body', async () => {
    const { verifyKey } = await import('../server/src/jev');
    const captured = stubTypesafe((body) => choiceReply(body));
    await verifyKey('super-secret-key-value');
    expect(JSON.stringify(captured[0].body)).not.toContain('super-secret-key-value');
  });

  it('still parses a legacy positional answers array', async () => {
    const { estimateExposure } = await import('../server/src/jev');
    stubTypesafe(() => ({ status: 200, json: { answers: [{ p_yes: 0.9 }, { p_yes: 0.1 }] } }));
    const out = await estimateExposure(EXPOSURE, { apiKey: 'k' });
    expect(out['route-0'].source).toBe('jev-noul');
    expect(out['route-0'].p).toBeCloseTo(0.9, 6);
  });
});

describe('failures are classified, not collapsed into "unreachable"', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [422, 'invalid-request'],
    [400, 'invalid-request'],
    [429, 'rate-limited'],
    [500, 'upstream-error'],
    [503, 'upstream-error'],
  ])('HTTP %s → %s (with the status surfaced)', async (status, expected) => {
    const { verifyKey } = await import('../server/src/jev');
    stubTypesafe(() => ({ status, json: { detail: { error_type: 'x', message: 'nope' } } }));
    const out = await verifyKey('some-key');
    expect(out.valid).toBe(false);
    expect(out.error).toBe(expected);
    expect(out.status).toBe(status);
    // The upstream detail is passed along for diagnosis, scrubbed of keys.
    expect(out.detail).toContain('nope');
    expect(JSON.stringify(out)).not.toContain('some-key');
  });

  it('a slow API is reported as `timeout`, NOT as unreachable', async () => {
    const { verifyKey } = await import('../server/src/jev');
    // Reachable, but never answers within the budget.
    globalThis.fetch = ((_url: unknown, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const fail = () =>
          reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
        if (init?.signal?.aborted) fail();
        else init?.signal?.addEventListener('abort', fail, { once: true });
      })) as unknown as typeof fetch;
    const out = await verifyKey('some-key', { timeoutMs: 40 });
    expect(out.valid).toBe(false);
    expect(
      out.error,
      'a timeout must not be misreported as a network failure — that sent people chasing a connection problem',
    ).toBe('timeout');
    expect(out.status, 'no HTTP response happened, so no status').toBeUndefined();
  });

  it('the verify budget is generous enough for a real model call', async () => {
    const { VERIFY_TIMEOUT_MS } = await import('../server/src/jev');
    // A 5s cap made a working key look unreachable. Model evaluations are not
    // sub-second; nothing here is on the routing hot path.
    expect(VERIFY_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });

  it('a network failure is the ONLY thing reported as unreachable', async () => {
    const { verifyKey } = await import('../server/src/jev');
    globalThis.fetch = (async () => {
      throw new Error('offline-simulated');
    }) as unknown as typeof fetch;
    const out = await verifyKey('some-key');
    expect(out.error).toBe('unreachable');
    expect(out.status).toBeUndefined();
  });

  it('a timeout degrades rather than hanging the request', async () => {
    const { rankRoutes } = await import('../server/src/jev');
    // A fetch that only ever rejects when the caller's budget aborts it.
    globalThis.fetch = ((_url: unknown, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const fail = () =>
          reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
        if (init?.signal?.aborted) fail();
        else init?.signal?.addEventListener('abort', fail, { once: true });
      })) as unknown as typeof fetch;
    const started = Date.now();
    const out = await rankRoutes(ROUTES, { apiKey: 'k', timeoutMs: 40 });
    expect(out.degraded, 'a timeout must be marked degraded so it is not cached').toBe(true);
    expect(Date.now() - started, 'the per-call budget must actually bound the wait').toBeLessThan(2000);
  });

  it('an exhausted budget skips the network entirely', async () => {
    const { rankRoutes, estimateExposure } = await import('../server/src/jev');
    const captured = stubTypesafe((body) => choiceReply(body));
    const ranked = await rankRoutes(ROUTES, { apiKey: 'k', timeoutMs: 0 });
    const exposure = await estimateExposure(EXPOSURE, { apiKey: 'k', timeoutMs: 0 });
    expect(captured, 'timeoutMs:0 must make zero upstream calls').toHaveLength(0);
    expect(ranked.degraded).toBe(true);
    expect(exposure['route-0'].source, 'no budget → geometric answer').toBe('geometric');
  });

  it('an oversized key is refused before any network call', async () => {
    const { verifyKey, MAX_KEY_LENGTH } = await import('../server/src/jev');
    const captured = stubTypesafe((body) => choiceReply(body));
    const out = await verifyKey('x'.repeat(MAX_KEY_LENGTH + 1));
    expect(out.valid).toBe(false);
    expect(out.error).toBe('invalid-key');
    expect(captured).toHaveLength(0);
  });

  it('an empty key reports key-required', async () => {
    const { verifyKey } = await import('../server/src/jev');
    expect((await verifyKey('   ')).error).toBe('key-required');
  });
});

describe('429/529 follow the documented retry-with-backoff', () => {
  it('retries once and succeeds when the second attempt is accepted', async () => {
    const { rankRoutes } = await import('../server/src/jev');
    let calls = 0;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      calls++;
      JSON.parse(String(init.body));
      if (calls === 1) {
        return new Response(JSON.stringify({ detail: { message: 'slow down' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '0' },
        });
      }
      return new Response(JSON.stringify(choiceReply(JSON.parse(String(init.body))).json), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const out = await rankRoutes(ROUTES, { apiKey: 'k', timeoutMs: 5_000 });
    expect(calls, 'one retry after a 429').toBe(2);
    expect(out.degraded, 'the retried call succeeded, so nothing is degraded').toBe(false);
    expect(out.rankedIds[0]).toBe('route-0');
    expect(out.mode).toBe('jev');
  });

  it('gives up rather than retrying forever', async () => {
    const { rankRoutes } = await import('../server/src/jev');
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{"detail":{"message":"overloaded"}}', {
        status: 529,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      });
    }) as unknown as typeof fetch;
    const out = await rankRoutes(ROUTES, { apiKey: 'k', timeoutMs: 5_000 });
    expect(calls, 'at most one retry').toBe(2);
    expect(out.degraded, 'a still-failing call must degrade, not hang').toBe(true);
  });

  it('does NOT retry when there is no budget left for it', async () => {
    const { verifyKey } = await import('../server/src/jev');
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{"detail":{"message":"slow down"}}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '5' },
      });
    }) as unknown as typeof fetch;
    const started = Date.now();
    const out = await verifyKey('some-key', { timeoutMs: 100 });
    expect(calls, 'a retry that cannot fit the budget must be skipped').toBe(1);
    expect(out.error).toBe('rate-limited');
    expect(Date.now() - started, 'honouring a 5s Retry-After would blow the budget').toBeLessThan(2_000);
  });

  it('a late Retry-After cannot push the call past its deadline', async () => {
    const { rankRoutes } = await import('../server/src/jev');
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{"detail":{"message":"slow down"}}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '30' },
      });
    }) as unknown as typeof fetch;
    const started = Date.now();
    const out = await rankRoutes(ROUTES, { apiKey: 'k', timeoutMs: 300 });
    expect(calls).toBe(1);
    expect(out.degraded).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('GET /api/system/verify surfaces the classified error', () => {
  let base = '';
  let close: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const { app } = await import('../server/src/index');
    ({ base, close } = await startServer(app));
  });

  afterAll(async () => {
    await close?.();
  });

  /** Only intercepts TypeSafe; the harness's own localhost calls pass through. */
  function stubTypesafeOnly(handler: (body: Record<string, unknown>) => { status: number; json: unknown }): Captured[] {
    const captured: Captured[] = [];
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      if (!String(url).includes('api.typesafe.ai')) return REAL_FETCH(url as never, init as never);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      captured.push({ url: String(url), auth: null, body });
      const { status, json } = handler(body);
      return new Response(JSON.stringify(json), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return captured;
  }

  it('propagates status + detail for a rejected request (the 422 case)', async () => {
    stubTypesafeOnly(() => ({ status: 422, json: { detail: { message: 'questions must be a map' } } }));
    const { res, body } = await fetchJson(base, '/api/system/verify', {
      headers: { 'x-typesafe-key': 'probe-key' },
    });
    expect(res.status).toBe(200);
    const b = body as { valid: boolean; error: string; status: number; detail: string };
    expect(b.valid).toBe(false);
    expect(b.error).toBe('invalid-request');
    expect(b.status).toBe(422);
    expect(b.detail).toContain('questions must be a map');
    expect(JSON.stringify(body)).not.toContain('probe-key');
  });

  it('reports a 200 as valid', async () => {
    stubTypesafeOnly((body) => choiceReply(body));
    const { body } = await fetchJson(base, '/api/system/verify', {
      headers: { 'x-typesafe-key': 'probe-key' },
    });
    expect((body as { valid: boolean }).valid).toBe(true);
  });
});
