import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, fetchJson, AUSTIN } from './helpers';

let base = '';
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  // Fails clearly here if server/src/index.ts does not export `app` yet.
  const { app } = await import('../server/src/index');
  expect(app, 'server/src/index.ts must export `app`').toBeDefined();
  ({ base, close } = await startServer(app));
});

afterAll(async () => {
  await close?.();
});

describe('api', () => {
  it('GET /api/health → ok:true with jev descriptor', async () => {
    const { res, body } = await fetchJson(base, '/api/health');
    expect(res.status).toBe(200);
    expect((body as { ok: boolean }).ok).toBe(true);
    expect((body as { jev: { mode: string; threshold: number } }).jev.mode).toMatch(/^(jev|fake)$/);
    expect(typeof (body as { jev: { threshold: number } }).jev.threshold).toBe('number');
  });

  it('GET /api/cameras?bbox=... returns a cameras array', async () => {
    const bbox = '-98,29,-96,31';
    const { res, body } = await fetchJson(base, `/api/cameras?bbox=${bbox}&limit=50`);
    expect(res.status).toBe(200);
    expect(Array.isArray((body as { cameras: unknown[] }).cameras)).toBe(true);
  });

  it('POST /api/cameras rejects {lat:999} with 400', async () => {
    const { res } = await fetchJson(base, '/api/cameras', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lat: 999, lon: -97.7 }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/route (Austin) → routes shape, or 502 if OSRM unreachable', async () => {
    const { res, body } = await fetchJson(base, '/api/route', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        origin: AUSTIN,
        destination: { lat: 30.35, lon: -97.7 },
        avoidFlock: true,
        bufferMeters: 150,
      }),
    });
    expect([200, 502]).toContain(res.status);
    if (res.status === 200) {
      const b = body as {
        routes: Array<{
          id: string;
          coordinates: unknown[];
          distanceM: number;
          durationS: number;
          exposureCount: number;
          score: number;
          jev: { choice: string; confidence: number; fallbackUsed: boolean };
        }>;
        rankedBy: string;
        jevMode: string;
      };
      expect(Array.isArray(b.routes)).toBe(true);
      expect(b.routes.length).toBeGreaterThan(0);
      const r = b.routes[0];
      expect(typeof r.id).toBe('string');
      expect(Array.isArray(r.coordinates)).toBe(true);
      expect(typeof r.distanceM).toBe('number');
      expect(typeof r.exposureCount).toBe('number');
      expect(typeof r.score).toBe('number');
      expect(typeof r.jev.confidence).toBe('number');
      expect(typeof r.jev.fallbackUsed).toBe('boolean');
      expect(['jev', 'heuristic']).toContain(b.rankedBy);
    } else {
      // 502: OSRM unreachable — must still be a shaped JSON error.
      expect(body).not.toBeNull();
    }
  }, 60_000);

  it('POST /api/route routes carry steps[], exposureP and jevExposure (or 502 if OSRM unreachable)', async () => {
    const { res, body } = await fetchJson(base, '/api/route', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        origin: AUSTIN,
        destination: { lat: 30.35, lon: -97.7 },
        avoidFlock: true,
        bufferMeters: 150,
      }),
    });
    expect([200, 502]).toContain(res.status);
    if (res.status === 200) {
      const b = body as {
        routes: Array<{
          id: string;
          steps?: unknown;
          exposureP?: unknown;
          jevExposure?: unknown;
        }>;
      };
      expect(Array.isArray(b.routes)).toBe(true);
      expect(b.routes.length).toBeGreaterThan(0);
      for (const r of b.routes) {
        expect(Array.isArray(r.steps), `route ${r.id} missing steps array (backend pending)`).toBe(true);
        for (const s of r.steps as Array<{ instruction: unknown; exposureP: unknown }>) {
          expect(typeof s.instruction, `route ${r.id} step missing instruction string`).toBe('string');
          expect(typeof s.exposureP, `route ${r.id} step missing exposureP number`).toBe('number');
          expect(s.exposureP as number).toBeGreaterThanOrEqual(0);
          expect(s.exposureP as number).toBeLessThanOrEqual(1);
        }
        expect(typeof r.exposureP, `route ${r.id} missing exposureP number (backend pending)`).toBe('number');
        expect(r.exposureP as number).toBeGreaterThanOrEqual(0);
        expect(r.exposureP as number).toBeLessThanOrEqual(1);
        const je = r.jevExposure as { p: unknown } | undefined;
        expect(je, `route ${r.id} missing jevExposure object (backend pending)`).toBeDefined();
        expect(typeof je?.p, `route ${r.id} jevExposure missing p number`).toBe('number');
        expect(je?.p as number).toBeGreaterThanOrEqual(0);
        expect(je?.p as number).toBeLessThanOrEqual(1);
      }
    }
  }, 60_000);
});
