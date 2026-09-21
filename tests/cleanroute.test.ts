// Iterative clean-route search — behavioral contract tests.
// Backend owns server/src/cleanroute.ts:
//   searchCleanRoute(origin, destination, baseScored, cameras, bufferMeters, fetchRoutes)
//   → { routes, attempts, osrmCalls, cleanFound, rounds }
// fetchRoutes is ALWAYS stubbed here (no network). fetchRoutes(o, d, via?) → RouteInput[].
import { describe, it, expect } from 'vitest';
import { searchCleanRoute, stripBacktrackSpur } from '../server/src/cleanroute';
import { AUSTIN, makeCamera, makeRoute, straightCoords, startServer, fetchJson } from './helpers';

const DEST = { lat: 30.35, lon: -97.7 };
const BUFFER_M = 150;
const BASE_DIST_M = 10_000;

// Cameras sitting on the straight AUSTIN→DEST corridor midpoint.
function corridorCameras() {
  const mid = straightCoords(AUSTIN, DEST, 21)[10];
  return [
    makeCamera('k1', mid[0] + 0.0002, mid[1]),
    makeCamera('k2', mid[0] - 0.0002, mid[1] + 0.0002),
  ];
}

function exposedBase() {
  return [{ ...makeRoute('base', AUSTIN, DEST, 21), exposureCount: 2, score: 2 * 10_000 + BASE_DIST_M }];
}

describe('searchCleanRoute', () => {
  it('all-clean input → cleanFound true, osrmCalls 0 (no extra fetch)', async () => {
    let calls = 0;
    const fetchRoutes = async () => {
      calls++;
      return [];
    };
    const clean = [{ ...makeRoute('clean', AUSTIN, DEST, 21), exposureCount: 0, score: BASE_DIST_M }];
    const r = await searchCleanRoute(AUSTIN, DEST, clean, corridorCameras(), BUFFER_M, fetchRoutes);
    expect(r.cleanFound).toBe(true);
    expect(r.osrmCalls).toBe(0);
    expect(calls).toBe(0);
    expect(r.routes[0].exposureCount).toBe(0);
  });

  it('blocked corridor with a bypass → cleanFound true, osrmCalls ≤6, winner exposure 0', async () => {
    let calls = 0;
    const fetchRoutes = async (o: any, d: any, via?: any) => {
      calls++;
      if (!via) return [{ ...makeRoute('refetch', o, d, 21) }];
      const coords = straightCoords(o, d, 21).map(([lat, lon]) => [lat + 0.02, lon] as [number, number]);
      return [{ ...makeRoute(`via-${calls}`, o, d, 21), coordinates: coords, distanceM: 11_000, durationS: 990 }];
    };
    const r = await searchCleanRoute(AUSTIN, DEST, exposedBase(), corridorCameras(), BUFFER_M, fetchRoutes);
    expect(r.cleanFound).toBe(true);
    expect(r.osrmCalls).toBeLessThanOrEqual(6);
    expect(r.routes[0].exposureCount).toBe(0);
  });

  it('fully blanketed area → cleanFound false, ranked best-first, osrmCalls capped, no throw', async () => {
    let calls = 0;
    const mid = straightCoords(AUSTIN, DEST, 21)[10];
    // Blanket: cameras on the corridor AND on every plausible offset line.
    const cameras = [...corridorCameras()];
    for (const off of [0.005, -0.005, 0.01, -0.01, 0.02, -0.02, 0.03, -0.03]) {
      cameras.push(makeCamera(`b${off}`, mid[0] + off, mid[1]));
    }
    // Every via still exposed: stub always returns the straight (exposed) line.
    const fetchRoutes = async (o: any, d: any) => {
      calls++;
      return [{ ...makeRoute(`try-${calls}`, o, d, 21) }];
    };
    const r = await searchCleanRoute(AUSTIN, DEST, exposedBase(), cameras, BUFFER_M, fetchRoutes);
    expect(r.cleanFound).toBe(false);
    expect(r.osrmCalls).toBeLessThanOrEqual(6);
    expect(r.routes.length).toBeGreaterThan(0);
    for (let i = 1; i < r.routes.length; i++) {
      expect(r.routes[i].exposureCount).toBeGreaterThanOrEqual(r.routes[i - 1].exposureCount);
    }
  });

  it('detour cap: via route >1.5x base distance is rejected even if clean', async () => {
    const fetchRoutes = async (o: any, d: any, via?: any) => {
      if (!via) return [{ ...makeRoute('refetch', o, d, 21) }];
      const coords = straightCoords(o, d, 21).map(([lat, lon]) => [lat + 0.02, lon] as [number, number]);
      // Clean but 2x base distance → over the 1.5x cap.
      return [{ ...makeRoute('far-clean', o, d, 21), coordinates: coords, distanceM: 2 * BASE_DIST_M, durationS: 1800 }];
    };
    const r = await searchCleanRoute(AUSTIN, DEST, exposedBase(), corridorCameras(), BUFFER_M, fetchRoutes);
    expect(r.cleanFound).toBe(false);
    for (const route of r.routes) {
      expect(route.distanceM).toBeLessThanOrEqual(1.5 * BASE_DIST_M);
    }
  });

  it('CLEAN_MAX_ROUNDS=0 → no extra fetch, best-effort kept', async () => {
    const saved = process.env.CLEAN_MAX_ROUNDS;
    process.env.CLEAN_MAX_ROUNDS = '0';
    try {
      let calls = 0;
      const fetchRoutes = async () => {
        calls++;
        return [];
      };
      const r = await searchCleanRoute(AUSTIN, DEST, exposedBase(), corridorCameras(), BUFFER_M, fetchRoutes);
      expect(calls).toBe(0);
      expect(r.osrmCalls).toBe(0);
      expect(r.rounds).toBe(0);
      expect(r.cleanFound).toBe(false);
      expect(r.routes.length).toBeGreaterThan(0);
    } finally {
      if (saved === undefined) delete process.env.CLEAN_MAX_ROUNDS;
      else process.env.CLEAN_MAX_ROUNDS = saved;
    }
  });

  it('hanging via fetch → timeout skip, search completes instead of hanging', async () => {
    const saved = process.env.CLEAN_VIA_TIMEOUT_MS;
    process.env.CLEAN_VIA_TIMEOUT_MS = '50';
    try {
      let calls = 0;
      const fetchRoutes = async (o: any, d: any, via?: any) => {
        if (!via) return [{ ...makeRoute('refetch', o, d, 21) }];
        calls++;
        return new Promise<never>(() => {});
      };
      const t = Date.now();
      const r = await searchCleanRoute(AUSTIN, DEST, exposedBase(), corridorCameras(), BUFFER_M, fetchRoutes);
      expect(Date.now() - t).toBeLessThan(10_000);
      expect(calls).toBeGreaterThan(0);
      expect(r.cleanFound).toBe(false);
      expect(r.routes.length).toBeGreaterThan(0);
    } finally {
      if (saved === undefined) delete process.env.CLEAN_VIA_TIMEOUT_MS;
      else process.env.CLEAN_VIA_TIMEOUT_MS = saved;
    }
  });

  it('via route with out-and-back spur → spur spliced, distance discounted', async () => {
    // Synthetic OSRM via artifact: straight line with a dead-end excursion
    // (p5 → tip → p5) like a via snapped off-road. Must render as one line.
    const line = straightCoords(AUSTIN, DEST, 11);
    const tip: [number, number] = [line[5][0] + 0.005, line[5][1]];
    const spurred: [number, number][] = [...line.slice(0, 6), tip, ...line.slice(5)];
    expect(spurred).toHaveLength(13);
    const fetchRoutes = async (o: any, d: any, via?: any) => {
      if (!via) return [{ ...makeRoute('refetch', o, d, 11) }];
      return [{ ...makeRoute('spur', o, d, 13), coordinates: spurred, distanceM: 11_000, durationS: 990 }];
    };
    const r = await searchCleanRoute(AUSTIN, DEST, exposedBase(), [], BUFFER_M, fetchRoutes);
    const fixed = r.routes.find((x) => x.id.startsWith('clean-'));
    expect(fixed).toBeDefined();
    expect(fixed!.coordinates).toHaveLength(11);
    expect(fixed!.distanceM).toBeLessThan(11_000);
  });
});

describe('stripBacktrackSpur', () => {
  it('straight line passes through untouched', () => {
    const line = straightCoords(AUSTIN, DEST, 21);
    const out = stripBacktrackSpur(line);
    expect(out.coordinates).toHaveLength(21);
    expect(out.removedM).toBe(0);
  });

  it('exact retrace is spliced out', () => {
    const line = straightCoords(AUSTIN, DEST, 11);
    const tip: [number, number] = [line[5][0] + 0.005, line[5][1]];
    const spurred: [number, number][] = [...line.slice(0, 6), tip, ...line.slice(5)];
    const out = stripBacktrackSpur(spurred);
    expect(out.coordinates).toHaveLength(11);
    expect(out.removedM).toBeGreaterThan(500);
  });
});

describe('api: clean-search shape', () => {
  it('POST /api/route carries isClean per route + cleanSearch object when avoidFlock=true (or 502)', async () => {
    const { app } = await import('../server/src/index');
    const { base, close } = await startServer(app);
    try {
      const { res, body } = await fetchJson(base, '/api/route', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ origin: AUSTIN, destination: DEST, avoidFlock: true, bufferMeters: BUFFER_M }),
      });
      expect([200, 502]).toContain(res.status);
      if (res.status === 200) {
        const b = body as { routes: Array<{ id: string; isClean: unknown }>; cleanSearch: unknown };
        expect(Array.isArray(b.routes)).toBe(true);
        for (const r of b.routes) {
          expect(typeof r.isClean, `route ${r.id} missing isClean boolean`).toBe('boolean');
        }
        expect(typeof b.cleanSearch, 'missing cleanSearch object').toBe('object');
        expect(b.cleanSearch).not.toBeNull();
      }
    } finally {
      await close();
    }
  }, 60_000);
});
