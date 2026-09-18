import { describe, it, expect, afterEach } from 'vitest';
import { rankRoutes } from '../server/src/jev';
import { AUSTIN, makeRoute } from './helpers';

// rankRoutes returns { rankedIds, verdicts: Record<id, {choice,confidence,fallbackUsed}>, mode }.
// Behavioral assertions below read confidence/fallbackUsed off the per-route
// verdicts, matching the GET /api/route contract (route.jev.*).

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

function routes() {
  const b = { lat: 30.35, lon: -97.7 };
  return [
    { ...makeRoute('r1', AUSTIN, b), exposureCount: 2, score: 50 },
    { ...makeRoute('r2', AUSTIN, b), exposureCount: 0, score: 10 },
    { ...makeRoute('r3', AUSTIN, b), exposureCount: 1, score: 30 },
  ];
}

describe('jev fake mode (no TYPESAFE_API_KEY)', () => {
  it('rankedIds cover all inputs; mode fake; verdict confidences in [0,1] with fallbackUsed boolean', async () => {
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.CONFIDENCE_THRESHOLD;
    const out = await rankRoutes(routes(), {});
    expect([...out.rankedIds].sort()).toEqual(['r1', 'r2', 'r3']);
    expect(out.mode).toBe('fake');
    for (const id of ['r1', 'r2', 'r3']) {
      const v = out.verdicts[id];
      expect(v, `verdict for ${id}`).toBeDefined();
      expect(v.confidence).toBeGreaterThanOrEqual(0);
      expect(v.confidence).toBeLessThanOrEqual(1);
      expect(typeof v.fallbackUsed).toBe('boolean');
    }
  });

  it('empty routes → empty ranking (no crash)', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const out = await rankRoutes([], {});
    expect(out.rankedIds).toEqual([]);
  });
});

describe('jev confidence gate (stubbed live call, no network)', () => {
  function stubLive(choice: string, confidence: number) {
    process.env.TYPESAFE_API_KEY = 'test-dummy-key';
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choice, confidence }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
  }

  it('CONFIDENCE_THRESHOLD=0.99 forces the fallback path (all fallbackUsed)', async () => {
    stubLive('r2', 0.5);
    process.env.CONFIDENCE_THRESHOLD = '0.99';
    const out = await rankRoutes(routes());
    expect([...out.rankedIds].sort()).toEqual(['r1', 'r2', 'r3']);
    for (const id of ['r1', 'r2', 'r3']) expect(out.verdicts[id].fallbackUsed).toBe(true);
  });

  it('low threshold accepts the live choice first with fallbackUsed=false', async () => {
    stubLive('r2', 0.5);
    const out = await rankRoutes(routes(), { threshold: 0.1 });
    expect(out.mode).toBe('jev');
    expect(out.rankedIds[0]).toBe('r2');
    expect([...out.rankedIds].sort()).toEqual(['r1', 'r2', 'r3']);
    for (const id of ['r1', 'r2', 'r3']) {
      expect(out.verdicts[id].fallbackUsed).toBe(false);
      expect(out.verdicts[id].choice).toBe('r2');
    }
  });
});
