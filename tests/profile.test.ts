// Travel profiles (spec P1-4): profile → OSRM path, cache-key separation, and
// the driving fallback when a backend has no graph for the requested profile.
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routePathFor, resolveRoutingBackend, __resetLimiters } from '../server/src/security';
import { fetchRoutesFor } from '../server/src/services/osrm';
import { startServer, fetchJson } from './helpers';

const dir = mkdtempSync(join(tmpdir(), 'gr-profile-'));
writeFileSync(join(dir, 'seed.json'), '[]');
process.env.CAMERA_DATA_FILE = join(dir, 'seed.json');
process.env.CAMERA_USER_FILE = join(dir, 'user.ndjson');

const realFetch = globalThis.fetch;
const savedBackend = process.env.ROUTING_BACKEND;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedBackend === undefined) delete process.env.ROUTING_BACKEND;
  else process.env.ROUTING_BACKEND = savedBackend;
});

beforeEach(() => {
  delete process.env.ROUTING_BACKEND;
  // This file fires >10 /api/route requests (the per-IP route limit); each
  // test starts from a clean bucket instead of asserting against a 429.
  __resetLimiters();
});

/** Minimal OSRM body: one route with a 2-point geometry and one step. */
function osrmBody() {
  return {
    routes: [
      {
        geometry: { coordinates: [[-97.7, 30.3], [-97.6, 30.4]] },
        distance: 1234,
        duration: 120,
        legs: [
          {
            steps: [
              {
                maneuver: { type: 'depart', modifier: 'north' },
                name: 'Main St',
                distance: 1234,
                duration: 120,
                geometry: { coordinates: [[-97.7, 30.3], [-97.6, 30.4]] },
              },
            ],
          },
        ],
      },
    ],
  };
}

function stubFetch(handler?: (url: string) => Response | null) {
  const urls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    urls.push(u);
    const custom = handler?.(u);
    if (custom) return custom;
    return { ok: true, status: 200, json: async () => osrmBody() } as unknown as Response;
  }) as unknown as typeof fetch;
  return urls;
}

describe('routePathFor', () => {
  it('maps demo profiles to their public OSRM segments', () => {
    expect(routePathFor('demo', 'driving')).toBe('/route/v1/driving');
    expect(routePathFor('demo', 'walking')).toBe('/route/v1/foot');
    expect(routePathFor('demo', 'cycling')).toBe('/route/v1/bike');
  });

  it('maps FOSSGIS profiles to their per-profile routers', () => {
    expect(routePathFor('fosssgis', 'driving')).toBe('/routed-car/route/v1/driving');
    expect(routePathFor('fosssgis', 'walking')).toBe('/routed-foot/route/v1/foot');
    expect(routePathFor('fosssgis', 'cycling')).toBe('/routed-bike/route/v1/bike');
  });

  it('falls back to driving for an unknown backend or profile', () => {
    expect(routePathFor('something-else', 'walking')).toBe('/route/v1/foot');
    expect(routePathFor('demo', 'hovercraft' as never)).toBe('/route/v1/driving');
  });

  it('resolveRoutingBackend keeps driving as the default path', () => {
    expect(resolveRoutingBackend({ ROUTING_BACKEND: 'demo' }).routePath).toBe('/route/v1/driving');
    expect(resolveRoutingBackend({ ROUTING_BACKEND: 'demo' }, 'walking').routePath).toBe(
      '/route/v1/foot',
    );
    expect(resolveRoutingBackend({ ROUTING_BACKEND: 'fosssgis' }, 'cycling').routePath).toBe(
      '/routed-bike/route/v1/bike',
    );
  });
});

describe('fetchRoutesFor', () => {
  it('requests the walking segment and reports the profile used', async () => {
    const urls = stubFetch();
    const out = await fetchRoutesFor({ lat: 30.3, lon: -97.7 }, { lat: 30.4, lon: -97.6 }, undefined, 'walking');
    expect(urls[0]).toContain('/route/v1/foot');
    expect(out.profile).toBe('walking');
    expect(out.degraded).toBe(false);
    expect(out.routes[0].distanceM).toBe(1234);
  });

  it('caches per profile: switching modes refetches, repeating one does not', async () => {
    const urls = stubFetch();
    const a = { lat: 31.1, lon: -98.1 };
    const b = { lat: 31.2, lon: -98.2 };
    await fetchRoutesFor(a, b, undefined, 'walking');
    await fetchRoutesFor(a, b, undefined, 'cycling');
    await fetchRoutesFor(a, b, undefined, 'walking'); // cache hit
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/route/v1/foot');
    expect(urls[1]).toContain('/route/v1/bike');
  });

  it('falls back to driving (and says so) when the profile is unsupported', async () => {
    const urls = stubFetch((u) =>
      u.includes('/foot')
        ? ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)
        : null,
    );
    const out = await fetchRoutesFor({ lat: 32.1, lon: -99.1 }, { lat: 32.2, lon: -99.2 }, undefined, 'walking');
    expect(urls[0]).toContain('/foot');
    expect(urls[1]).toContain('/driving');
    expect(out.profile).toBe('driving');
    expect(out.degraded).toBe(true);
    expect(out.routes.length).toBeGreaterThan(0);
  });

  it('propagates a driving failure without a second attempt', async () => {
    const urls = stubFetch(() => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response);
    await expect(
      fetchRoutesFor({ lat: 33.1, lon: -100.1 }, { lat: 33.2, lon: -100.2 }, undefined, 'driving'),
    ).rejects.toThrow('routing-unavailable');
    expect(urls).toHaveLength(1);
  });
});

let base = '';
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  const { app } = await import('../server/src/index');
  ({ base, close } = await startServer(app));
});

afterAll(async () => {
  await close?.();
});

const posting = (body: unknown) =>
  fetchJson(base, '/api/route', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('profile request validation', () => {
  const ORIGIN = { lat: 30.2672, lon: -97.7431 };
  const DEST = { lat: 30.35, lon: -97.7 };

  it('rejects an unknown profile with 400 before any routing happens', async () => {
    const { res, body } = await posting({ origin: ORIGIN, destination: DEST, profile: 'hovercraft' });
    expect(res.status).toBe(400);
    expect((body as { error: string }).error).toBe('profile-invalid');
  });

  it('accepts the three supported profiles (200 route or 502 if OSRM is down)', async () => {
    for (const profile of ['driving', 'walking', 'cycling'] as const) {
      const { res } = await posting({ origin: ORIGIN, destination: DEST, profile });
      expect([200, 502]).toContain(res.status);
    }
  }, 60_000);

  it('rejects a malformed cameraFilter with 400', async () => {
    for (const cameraFilter of [
      { verifiedOnly: 'yes' },
      { brands: 'Flock Safety' },
      { brands: [''] },
      { sources: [1, 2] },
      { maxDistM: -5 },
      { maxDistM: 99_999 },
      'nope',
    ]) {
      const { res, body } = await posting({ origin: ORIGIN, destination: DEST, cameraFilter });
      expect(res.status, `cameraFilter=${JSON.stringify(cameraFilter)}`).toBe(400);
      expect((body as { error: string }).error).toBe('cameraFilter-invalid');
    }
  });

  it('accepts a well-formed cameraFilter (200 route or 502 if OSRM is down)', async () => {
    const { res } = await posting({
      origin: ORIGIN,
      destination: DEST,
      cameraFilter: { verifiedOnly: true, brands: ['Flock Safety'], maxDistM: 80 },
    });
    expect([200, 502]).toContain(res.status);
  }, 60_000);
});

describe('GET /api/system/status (additive v1.2 fields)', () => {
  it('reports the verified split and the active routing backend', async () => {
    const { res, body } = await fetchJson(base, '/api/system/status');
    expect(res.status).toBe(200);
    const b = body as {
      cameraCount: number;
      cameraCounts?: { total: number; verified: number };
      routingBackend?: string;
      osrm: string;
    };
    expect(typeof b.cameraCount).toBe('number');
    expect(b.cameraCounts?.total).toBe(b.cameraCount);
    expect(b.cameraCounts?.verified).toBeLessThanOrEqual(b.cameraCount);
    expect(['demo', 'fosssgis', 'custom']).toContain(b.routingBackend);
  });
});
