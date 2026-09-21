// Navigate-mode geometry helpers — pure functions, no DOM/geolocation.
import { describe, it, expect } from 'vitest';
import {
  fmtNavDist,
  havM,
  locateStep,
  nearestIndex,
  polyLen,
  upcomingCameras,
  type NavStep,
} from '../client/src/lib/navigate';

// Straight northbound line: 11 points, ~111m apart (0.001° lat).
function line(n = 11, lon = -97.7): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) pts.push([30.3 + i * 0.001, lon]);
  return pts;
}

function steps(): NavStep[] {
  const l = line();
  return [
    { coordinates: l.slice(0, 6), instruction: 'Head north', maneuverKind: 'depart' },
    { coordinates: l.slice(5), instruction: 'Turn right onto Main St', maneuverKind: 'right' },
  ];
}

describe('navigate helpers', () => {
  it('havM: 0.001° latitude ≈ 111m', () => {
    expect(havM([30.3, -97.7], [30.301, -97.7])).toBeCloseTo(111.2, 0);
  });

  it('nearestIndex finds the closest route point', () => {
    const l = line();
    expect(nearestIndex(l, [30.305, -97.7]).index).toBe(5);
    expect(nearestIndex(l, [30.3, -97.7]).index).toBe(0);
  });

  it('polyLen sums segment lengths', () => {
    expect(polyLen(line(), 0, 10)).toBeCloseTo(1112, -1);
    expect(polyLen(line(), 3, 3)).toBe(0);
  });

  it('locateStep locks the earliest step near the fix', () => {
    // On step 2's geometry → step 1, with remaining ≈ half the step.
    const loc = locateStep(steps(), [30.3075, -97.7], 0);
    expect(loc?.step).toBe(1);
    expect(loc!.remainingM).toBeGreaterThan(200);
    expect(loc!.remainingM).toBeLessThan(400);
  });

  it('locateStep returns null off-route (caller keeps the lock)', () => {
    expect(locateStep(steps(), [31.0, -97.0], 0)).toBeNull();
  });

  it('upcomingCameras: ahead inside window only', () => {
    const l = line();
    const ex = [
      { cameraId: 'behind', lat: 30.301, lon: -97.7, routeIdx: 1 },
      { cameraId: 'near', lat: 30.306, lon: -97.7, routeIdx: 6 },
      { cameraId: 'far', lat: 30.32, lon: -97.7, routeIdx: 20 },
    ];
    const l20 = line(21);
    const ex20 = ex.map((e) => ({ ...e }));
    const out = upcomingCameras(ex20, l20, 5, 500);
    expect(out.map((c) => c.cameraId)).toEqual(['near']);
    expect(out[0].aheadM).toBeCloseTo(111, 0);
    expect(l).toHaveLength(11);
  });

  it('fmtNavDist rounds to 10m under 1km', () => {
    expect(fmtNavDist(34)).toBe('30 m');
    expect(fmtNavDist(1500)).toBe('1.5 km');
  });
});
