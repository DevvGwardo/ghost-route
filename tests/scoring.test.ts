import { describe, it, expect } from 'vitest';
import { distM, pointToPolylineDistM, scoreRoute } from '../server/src/services/scoring';
import { AUSTIN, DALLAS, makeCamera, straightCoords } from './helpers';

describe('scoring: distM (haversine)', () => {
  it('Austin→Dallas ≈ 293km ±5km', () => {
    const m = distM(AUSTIN, DALLAS);
    expect(typeof m).toBe('number');
    expect(m).toBeGreaterThan(288_000);
    expect(m).toBeLessThan(298_000);
  });

  it('same point is 0 and symmetric', () => {
    expect(distM(AUSTIN, AUSTIN)).toBe(0);
    expect(distM(AUSTIN, DALLAS)).toBeCloseTo(distM(DALLAS, AUSTIN), 6);
  });

  it('invalid coords throw (out-of-range, NaN, null)', () => {
    expect(() => distM({ lat: 999, lon: 0 }, DALLAS)).toThrow();
    expect(() => distM({ lat: 30, lon: 999 }, DALLAS)).toThrow();
    expect(() => distM({ lat: NaN, lon: -97 }, DALLAS)).toThrow();
    expect(() => distM(null as never, DALLAS)).toThrow();
    expect(() => distM(AUSTIN, undefined as never)).toThrow();
  });
});

describe('scoring: pointToPolylineDistM', () => {
  it('point exactly on the line ≈ 0m', () => {
    const line = straightCoords(AUSTIN, DALLAS, 11);
    const mid = line[5];
    expect(pointToPolylineDistM({ lat: mid[0], lon: mid[1] }, line)).toBeLessThan(1);
  });

  it('far point is far (2° diagonal offset ≈ 280km from the line)', () => {
    const line = straightCoords(AUSTIN, DALLAS, 11);
    const d = pointToPolylineDistM({ lat: AUSTIN.lat + 2, lon: AUSTIN.lon - 2 }, line);
    expect(d).toBeGreaterThan(200_000);
  });

  it('single-point line degrades to point distance (≈0 at that point)', () => {
    const pt: [number, number] = [AUSTIN.lat, AUSTIN.lon];
    expect(pointToPolylineDistM({ lat: pt[0], lon: pt[1] }, [pt])).toBeLessThan(1);
  });

  it('invalid point coords throw', () => {
    const line = straightCoords(AUSTIN, DALLAS, 5);
    expect(() => pointToPolylineDistM({ lat: 999, lon: 0 }, line)).toThrow();
    expect(() => pointToPolylineDistM({ lat: NaN, lon: 0 }, line)).toThrow();
  });
});

describe('scoring: scoreRoute', () => {
  const base = { coordinates: straightCoords(AUSTIN, DALLAS, 11), distanceM: 293_000, durationS: 10_000 };

  it('empty cameras → exposureCount 0, empty exposures, numeric score', () => {
    const r = scoreRoute(base, [], 150);
    expect(r.exposureCount).toBe(0);
    expect(r.exposures).toEqual([]);
    expect(typeof r.score).toBe('number');
  });

  it('camera sitting on the path is exposed within 150m buffer', () => {
    const line = straightCoords(AUSTIN, { lat: 30.3, lon: -97.7 }, 11);
    const mid = line[5];
    const cams = [makeCamera('c1', mid[0], mid[1])];
    const r = scoreRoute({ coordinates: line, distanceM: 5000, durationS: 600 }, cams, 150);
    expect(r.exposureCount).toBeGreaterThan(0);
    expect(r.exposures.length).toBe(r.exposureCount);
    expect(r.exposures[0].cameraId).toBe('c1');
    expect(r.exposures[0].distM).toBeLessThanOrEqual(150);
  });

  it('distant camera is not exposed', () => {
    const line = straightCoords(AUSTIN, { lat: 30.3, lon: -97.7 }, 11);
    const cams = [makeCamera('far', AUSTIN.lat + 5, AUSTIN.lon + 5)];
    const r = scoreRoute({ coordinates: line, distanceM: 5000, durationS: 600 }, cams, 150);
    expect(r.exposureCount).toBe(0);
  });
});
