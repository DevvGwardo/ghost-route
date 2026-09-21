// Direction-aware exposure (additive v1.2, gap G3).
//
// A camera with a known `direction` (compass bearing it points at) only counts
// as an exposure when the route's travel heading where it passes nearest the
// camera matches that bearing within a tolerance. Cameras without a direction
// stay omnidirectional, preserving the pre-v1.2 result exactly.
import { describe, it, expect } from 'vitest';
import {
  rankByExposure,
  headingAtNearest as avoidHeadingAtNearest,
  bearingDeg as avoidBearingDeg,
  angleDiffDeg as avoidAngleDiffDeg,
} from '../server/src/avoid';
import {
  exposurePForPoints,
  headingAtNearest,
  angleDiffDeg,
  scoreRoute,
} from '../server/src/services/scoring';
import { makeCamera, startServer, fetchJson, AUSTIN } from './helpers';

const DEST = { lat: 30.35, lon: -97.7 };
const BUFFER_M = 150;

/** Due-east line at a constant latitude: travel heading is 90°. */
function eastLine(n = 11): [number, number][] {
  const lat = 30.3;
  const lon0 = -97.75;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) pts.push([lat, lon0 + i * 0.005]);
  return pts;
}

/** Due-north line at a constant longitude: travel heading is 0°. */
function northLine(n = 11): [number, number][] {
  const lon = -97.75;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) pts.push([30.3 + i * 0.005, lon]);
  return pts;
}

/** East along the first half, then north: an L-shaped route. */
function bentLine(): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 5; i++) pts.push([30.3, -97.75 + i * 0.005]);
  for (let i = 1; i <= 5; i++) pts.push([30.3 + i * 0.005, -97.75 + 5 * 0.005]);
  return pts;
}

const eastRoute = (id = 'east') => ({
  id,
  coordinates: eastLine(),
  distanceM: 4800,
  durationS: 300,
});

const eastMidCamera = (dir?: number) => makeCamera('c-mid', 30.3, -97.725, dir);

describe('bearing helpers', () => {
  it('angleDiffDeg handles wrap-around and the 180° ceiling', () => {
    expect(angleDiffDeg(350, 10)).toBe(20);
    expect(angleDiffDeg(10, 350)).toBe(20);
    expect(angleDiffDeg(0, 180)).toBe(180);
    expect(angleDiffDeg(90, 270)).toBe(180);
    expect(angleDiffDeg(90, 90)).toBe(0);
  });

  it('headingAtNearest reads direction of travel, not the reverse bearing', () => {
    const east = eastLine();
    expect(headingAtNearest(east, { lat: 30.3, lon: -97.725 })).toBeCloseTo(90, 1);
    // Reversed polyline = travelling west.
    expect(headingAtNearest([...east].reverse(), { lat: 30.3, lon: -97.725 })).toBeCloseTo(270, 1);
    expect(headingAtNearest(northLine(), { lat: 30.32, lon: -97.75 })).toBeCloseTo(0, 1);
    // The L: a camera on the north leg must read ~0°, not ~90°.
    const bent = bentLine();
    const northLegPoint = bent[bent.length - 2];
    expect(headingAtNearest(bent, { lat: northLegPoint[0], lon: northLegPoint[1] })).toBeCloseTo(0, 0);
  });

  it('headingAtNearest is null without a usable segment', () => {
    expect(headingAtNearest([], { lat: 30.3, lon: -97.7 })).toBeNull();
    expect(headingAtNearest([[30.3, -97.7]], { lat: 30.3, lon: -97.7 })).toBeNull();
    // Degenerate (zero-length) segment.
    expect(
      headingAtNearest(
        [
          [30.3, -97.7],
          [30.3, -97.7],
        ],
        { lat: 30.3, lon: -97.7 },
      ),
    ).toBeNull();
  });

  it('avoid.ts mirrors the scoring helpers', () => {
    expect(avoidAngleDiffDeg(350, 10)).toBe(20);
    expect(avoidBearingDeg({ lat: 30.3, lon: -97.7 }, { lat: 30.3, lon: -97.6 })).toBeCloseTo(90, 1);
    expect(avoidHeadingAtNearest(eastLine(), { lat: 30.3, lon: -97.725 })).toBeCloseTo(90, 1);
  });
});

describe('rankByExposure: direction awareness (the routing path)', () => {
  it('a camera facing 270° does not count for an eastbound route by default', () => {
    const r = rankByExposure([eastRoute()], [eastMidCamera(270)], BUFFER_M);
    expect(r[0].exposureCount).toBe(0);
    expect(r[0].exposures).toEqual([]);
  });

  it('the same camera counts again with respectDirection:false', () => {
    const r = rankByExposure([eastRoute()], [eastMidCamera(270)], BUFFER_M, {
      respectDirection: false,
    });
    expect(r[0].exposureCount).toBe(1);
    expect(r[0].exposures[0].cameraId).toBe('c-mid');
  });

  it('a camera facing the direction of travel (90°) does count', () => {
    const r = rankByExposure([eastRoute()], [eastMidCamera(90)], BUFFER_M);
    expect(r[0].exposureCount).toBe(1);
  });

  it('within tolerance (±60°, inclusive) counts; beyond does not', () => {
    const within = rankByExposure([eastRoute()], [eastMidCamera(30)], BUFFER_M);
    expect(within[0].exposureCount).toBe(1); // 60° off, at the boundary
    const beyond = rankByExposure([eastRoute()], [eastMidCamera(20)], BUFFER_M);
    expect(beyond[0].exposureCount).toBe(0); // 70° off
  });

  it('a camera without a known direction always counts (legacy behavior)', () => {
    const r = rankByExposure([eastRoute()], [makeCamera('plain', 30.3, -97.725)], BUFFER_M);
    expect(r[0].exposureCount).toBe(1);
  });

  it('an unparsable direction falls back to omnidirectional', () => {
    const bad = { ...makeCamera('bad', 30.3, -97.725), direction: Number.NaN };
    const r = rankByExposure([eastRoute()], [bad], BUFFER_M);
    expect(r[0].exposureCount).toBe(1);
  });

  it('toleranceDeg widens/narrows the window', () => {
    const c = eastMidCamera(45); // 45° off an eastbound route
    expect(rankByExposure([eastRoute()], [c], BUFFER_M)[0].exposureCount).toBe(1);
    expect(
      rankByExposure([eastRoute()], [c], BUFFER_M, { toleranceDeg: 10 })[0].exposureCount,
    ).toBe(0);
    expect(
      rankByExposure([eastRoute()], [eastMidCamera(180)], BUFFER_M, { toleranceDeg: 95 })[0]
        .exposureCount,
    ).toBe(1); // 90° off, allowed at 95°
  });

  it('an out-of-buffer directional camera stays excluded in both modes', () => {
    const far = makeCamera('far', 30.35, -97.725, 90);
    expect(rankByExposure([eastRoute()], [far], BUFFER_M)[0].exposureCount).toBe(0);
    expect(
      rankByExposure([eastRoute()], [far], BUFFER_M, { respectDirection: false })[0].exposureCount,
    ).toBe(0);
  });

  it('picks the heading of the nearest segment on a bent route', () => {
    const bent = bentLine();
    const northLegEnd = bent[bent.length - 1];
    // Camera on the north leg, facing south (180°) — travel there is northbound.
    const cam = makeCamera('bent', northLegEnd[0], northLegEnd[1], 180);
    const route = { id: 'bent', coordinates: bent, distanceM: 5000, durationS: 400 };
    expect(rankByExposure([route], [cam], BUFFER_M)[0].exposureCount).toBe(0);
    expect(
      rankByExposure([route], [makeCamera('bent2', northLegEnd[0], northLegEnd[1], 0)], BUFFER_M)[0]
        .exposureCount,
    ).toBe(1);
  });
});

describe('exposurePForPoints: direction awareness (the step path)', () => {
  const line = eastLine();

  it('excludes a mismatched camera (p = 0, empty ids)', () => {
    const out = exposurePForPoints(line, [eastMidCamera(270)], BUFFER_M);
    expect(out.p).toBe(0);
    expect(out.cameraIds).toEqual([]);
  });

  it('includes a matched on-line camera at p ≈ 0.95', () => {
    const out = exposurePForPoints(line, [eastMidCamera(90)], BUFFER_M);
    expect(out.cameraIds).toContain('c-mid');
    expect(out.p).toBeGreaterThanOrEqual(0.94);
    expect(out.p).toBeLessThanOrEqual(0.96);
  });

  it('the false opt-out restores the omnidirectional count', () => {
    const out = exposurePForPoints(line, [eastMidCamera(270)], BUFFER_M, {
      respectDirection: false,
    });
    expect(out.cameraIds).toContain('c-mid');
    expect(out.p).toBeGreaterThan(0.9);
  });

  it('mixes directional and legacy cameras correctly', () => {
    const cams = [
      eastMidCamera(270), // facing the (wrong) way for eastbound travel
      makeCamera('plain', 30.3, -97.725), // no direction → counts
    ];
    const out = exposurePForPoints(line, cams, BUFFER_M);
    expect(out.cameraIds).toEqual(['plain']);
  });

  it('does not change the geometric fallback for directionless cameras', () => {
    const cams = [makeCamera('c1', 30.3, -97.725)];
    const def = exposurePForPoints(line, cams, BUFFER_M);
    const explicit = exposurePForPoints(line, cams, BUFFER_M, { respectDirection: true });
    expect(explicit).toEqual(def);
  });
});

describe('scoreRoute: direction awareness', () => {
  const route = {
    coordinates: eastLine(),
    distanceM: 4800,
    durationS: 300,
  };

  it('filters mismatched directional cameras but keeps the score formula', () => {
    const off = scoreRoute(route, [eastMidCamera(270)], BUFFER_M);
    expect(off.exposureCount).toBe(0);
    expect(off.exposures).toEqual([]);
    expect(off.score).toBe(route.distanceM);

    const on = scoreRoute(route, [eastMidCamera(90)], BUFFER_M);
    expect(on.exposureCount).toBe(1);
    expect(on.score).toBe(10000 + route.distanceM);
  });

  it('legacy mode counts everything', () => {
    const r = scoreRoute(route, [eastMidCamera(270)], BUFFER_M, { respectDirection: false });
    expect(r.exposureCount).toBe(1);
    expect(r.score).toBe(10000 + route.distanceM);
  });
});

describe('api: respectDirection request handling', () => {
  it('rejects a non-boolean respectDirection with 400 (before any routing)', async () => {
    const { app } = await import('../server/src/index');
    const { base, close } = await startServer(app);
    try {
      const { res, body } = await fetchJson(base, '/api/route', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ origin: AUSTIN, destination: DEST, respectDirection: 'yes' }),
      });
      expect(res.status).toBe(400);
      expect((body as { error: string }).error).toBe('respectDirection-invalid');
    } finally {
      await close();
    }
  }, 60_000);

  it('accepts respectDirection:false (200 route or 502 if OSRM unreachable)', async () => {
    const { app } = await import('../server/src/index');
    const { base, close } = await startServer(app);
    try {
      const { res } = await fetchJson(base, '/api/route', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          origin: AUSTIN,
          destination: DEST,
          avoidFlock: true,
          respectDirection: false,
        }),
      });
      expect([200, 502]).toContain(res.status);
    } finally {
      await close();
    }
  }, 60_000);
});
