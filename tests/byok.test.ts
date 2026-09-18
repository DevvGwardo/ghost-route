import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { rankRoutes, estimateExposure } from '../server/src/jev';
import { AUSTIN, makeRoute, startServer, fetchJson } from './helpers';

// BYOK key precedence — offline-safe. Never hits the real TypeSafe API:
// every live-call path stubs globalThis.fetch (or selective-stubs it for
// the API-level test so localhost HTTP still works). Fails clearly until
// the backend lands resolveKey + apiKey opts in server/src/jev.ts.

const SAVED_KEY = process.env.TYPESAFE_API_KEY;
const SAVED_THRESHOLD = process.env.CONFIDENCE_THRESHOLD;
const REAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  if (SAVED_KEY === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = SAVED_KEY;
  if (SAVED_THRESHOLD === undefined) delete process.env.CONFIDENCE_THRESHOLD;
  else process.env.CONFIDENCE_THRESHOLD = SAVED_THRESHOLD;
});

async function resolveKeyFn(): Promise<(provided?: unknown) => string> {
  const mod = await import('../server/src/jev');
  const fn = (mod as Record<string, unknown>).resolveKey;
  expect(
    fn,
    'resolveKey not implemented yet (backend pending: export function resolveKey(provided?: string): string — trim, empty→env, >200 chars ignored, else env or "")',
  ).toBeTypeOf('function');
  return fn as (provided?: unknown) => string;
}

function testRoutes() {
  const b = { lat: 30.35, lon: -97.7 };
  return [
    { ...makeRoute('r1', AUSTIN, b), exposureCount: 2, score: 50 },
    { ...makeRoute('r2', AUSTIN, b), exposureCount: 0, score: 10 },
    { ...makeRoute('r3', AUSTIN, b), exposureCount: 1, score: 30 },
  ];
}

describe('byok resolveKey precedence (no network)', () => {
  it("provided '  abc  ' wins over env (trimmed)", async () => {
    const resolveKey = await resolveKeyFn();
    process.env.TYPESAFE_API_KEY = 'env-key';
    expect(resolveKey('  abc  ')).toBe('abc');
  });

  it('empty/whitespace provided falls back to env', async () => {
    const resolveKey = await resolveKeyFn();
    process.env.TYPESAFE_API_KEY = 'env-key';
    expect(resolveKey('')).toBe('env-key');
    expect(resolveKey('   ')).toBe('env-key');
    expect(resolveKey(undefined)).toBe('env-key');
  });

  it('>200-char provided is ignored (falls back to env, or "" without env)', async () => {
    const resolveKey = await resolveKeyFn();
    const long = 'x'.repeat(201);
    process.env.TYPESAFE_API_KEY = 'env-key';
    expect(resolveKey(long)).toBe('env-key');
    delete process.env.TYPESAFE_API_KEY;
    expect(resolveKey(long)).toBe('');
  });

  it("no provided + no env → ''", async () => {
    const resolveKey = await resolveKeyFn();
    delete process.env.TYPESAFE_API_KEY;
    expect(resolveKey(undefined)).toBe('');
  });
});

describe('byok rankRoutes via apiKey param (stubbed fetch, no network)', () => {
  it('stubbed high-confidence choice ranks that id first, fallbackUsed:false, mode jev', async () => {
    delete process.env.TYPESAFE_API_KEY;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choice: 'r2', confidence: 0.95 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const out = await rankRoutes(testRoutes(), { apiKey: 'dummy-key' } as any);
    expect(out.mode, 'expected mode jev once apiKey param lands (backend pending)').toBe('jev');
    expect(out.rankedIds[0]).toBe('r2');
    for (const id of ['r1', 'r2', 'r3'])
      expect(out.verdicts[id].fallbackUsed, `verdict ${id} should be live`).toBe(false);
  });

  it('rejecting fetch with apiKey set → all fallbackUsed:true, no throw', async () => {
    delete process.env.TYPESAFE_API_KEY;
    globalThis.fetch = async () => {
      throw new Error('offline-simulated');
    };
    const out = await rankRoutes(testRoutes(), { apiKey: 'dummy-key' } as any);
    expect([...out.rankedIds].sort()).toEqual(['r1', 'r2', 'r3']);
    for (const id of ['r1', 'r2', 'r3'])
      expect(out.verdicts[id].fallbackUsed, `verdict ${id}`).toBe(true);
  });
});

describe('byok estimateExposure via apiKey param (stubbed fetch, no network)', () => {
  const expRoutes = [
    { id: 'r1', exposurePGeo: 0.2, exposureCount: 1, distanceM: 10000 },
    { id: 'r2', exposurePGeo: 0.8, exposureCount: 0, distanceM: 9000 },
  ];

  it("stubbed valid p_yes → source 'jev-noul', p parsed", async () => {
    delete process.env.TYPESAFE_API_KEY;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ answers: [{ p_yes: 0.8 }, { p_yes: 0.2 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const out = await estimateExposure(expRoutes, { apiKey: 'dummy-key' } as any);
    expect(out['r1'].source, 'expected jev-noul once apiKey param lands (backend pending)').toBe(
      'jev-noul',
    );
    expect(out['r1'].fallbackUsed).toBe(false);
    expect(out['r1'].p).toBeCloseTo(0.8, 5);
    expect(out['r2'].source).toBe('jev-noul');
    expect(out['r2'].p).toBeCloseTo(0.2, 5);
  });

  it('rejecting fetch → geometric fallback per id', async () => {
    delete process.env.TYPESAFE_API_KEY;
    globalThis.fetch = async () => {
      throw new Error('offline-simulated');
    };
    const out = await estimateExposure(expRoutes, { apiKey: 'dummy-key' } as any);
    for (const r of expRoutes) {
      expect(out[r.id].source).toBe('geometric');
      expect(out[r.id].fallbackUsed).toBe(true);
      expect(out[r.id].p).toBeCloseTo(r.exposurePGeo, 10);
    }
  });
});

describe('byok API-level header precedence (offline-safe for Jev)', () => {
  let base = '';
  let close: (() => Promise<void>) | null = null;
  const DUMMY = 'dummy-key-for-precedence-test';

  beforeAll(async () => {
    const { app } = await import('../server/src/index');
    expect(app, 'server/src/index.ts must export `app`').toBeDefined();
    ({ base, close } = await startServer(app));
  });

  afterAll(async () => {
    await close?.();
    globalThis.fetch = REAL_FETCH;
  });

  it('POST /api/route with x-typesafe-key → 200 (or 502 if OSRM down); IF 200: jevMode jev + all fallbackUsed + no key leak', async () => {
    delete process.env.TYPESAFE_API_KEY;
    // Block only the live Jev host; localhost + OSRM pass through to real fetch.
    const real = REAL_FETCH;
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      if (String(url).includes('api.typesafe.ai')) throw new Error('offline-simulated');
      return real(url as string, init as RequestInit);
    }) as typeof fetch;
    let res: Response;
    let body: unknown;
    try {
      ({ res, body } = await fetchJson(base, '/api/route', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-typesafe-key': DUMMY },
        body: JSON.stringify({
          origin: AUSTIN,
          destination: { lat: 30.35, lon: -97.7 },
          avoidFlock: true,
          bufferMeters: 150,
        }),
      }));
    } finally {
      globalThis.fetch = real;
    }
    expect([200, 502]).toContain(res!.status);
    // Response must never echo the key, on either status path.
    expect(JSON.stringify(body)).not.toContain(DUMMY);
    if (res!.status === 200) {
      const b = body as {
        routes: Array<{ jev: { fallbackUsed: boolean } }>;
        jevMode: string;
      };
      expect(b.jevMode, 'header key should activate live mode (backend pending)').toBe('jev');
      expect(b.routes.length).toBeGreaterThan(0);
      for (const r of b.routes) expect(r.jev.fallbackUsed).toBe(true);
    }
  }, 60_000);
});
