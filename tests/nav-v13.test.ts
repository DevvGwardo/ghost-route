// v1.3 navigation + route-look helpers — pure functions, no DOM.
// Snapping, road bearing, time left (live guidance on phones that report no
// heading), which routes get drawn, camera zones, label anchors, reverse
// geocode labels, and the depart/arrive wording fix.
import { describe, it, expect } from 'vitest';
import {
  bearingDeg,
  bearingDelta,
  cumulativeM,
  havM,
  projectOnRoute,
  remainingSeconds,
  routeBearingAt,
} from '../client/src/lib/navigate';
import { densify, exposureRuns, labelAnchors, pickDrawnRoutes } from '../client/src/lib/routeStyle';
import { labelFromNominatimReverse } from '../client/src/lib/geocode';
import { splitInstruction } from '../client/src/components/NavigateBanner';
import { buildInstruction } from '../server/src/services/osrm';

// North 1.1 km, then east 1 km: an L.
const L: [number, number][] = [
  [30.3, -97.7],
  [30.305, -97.7],
  [30.31, -97.7],
  [30.31, -97.695],
  [30.31, -97.6896],
];

describe('projectOnRoute', () => {
  it('snaps a point beside the road onto the segment, between vertices', () => {
    const p = projectOnRoute(L, [30.3025, -97.6999])!;
    expect(p.segIdx).toBe(0);
    expect(p.t).toBeGreaterThan(0.4);
    expect(p.t).toBeLessThan(0.6);
    expect(p.point[1]).toBeCloseTo(-97.7, 6);
    expect(p.distM).toBeGreaterThan(5);
    expect(p.distM).toBeLessThan(15);
    expect(p.alongM).toBeCloseTo(havM(L[0], [30.3025, -97.7]), -1);
  });
  it('alongM at the last vertex equals the route length', () => {
    const cum = cumulativeM(L);
    const p = projectOnRoute(L, L[L.length - 1], cum)!;
    expect(p.alongM).toBeCloseTo(cum[cum.length - 1], 3);
  });
  it('empty geometry → null; single point → that point', () => {
    expect(projectOnRoute([], [30, -97])).toBeNull();
    expect(projectOnRoute([[30, -97]], [30, -97])!.distM).toBe(0);
  });
});

describe('routeBearingAt (heading when the phone reports none)', () => {
  it('reads north on the first leg and east on the second', () => {
    const north = routeBearingAt(L, projectOnRoute(L, [30.302, -97.7])!)!;
    const east = routeBearingAt(L, projectOnRoute(L, [30.31, -97.693])!)!;
    expect(Math.abs(bearingDelta(0, north))).toBeLessThan(2);
    expect(Math.abs(bearingDelta(90, east))).toBeLessThan(2);
  });
  it('looks ahead past a vertex just before a corner', () => {
    // 5 m before the corner, a 25 m look-ahead already bends toward east.
    const nearCorner = projectOnRoute(L, [30.30996, -97.7])!;
    const b = routeBearingAt(L, nearCorner, 25)!;
    expect(b).toBeGreaterThan(30);
    expect(b).toBeLessThan(90);
  });
  it('at the end of the route keeps the last segment direction', () => {
    const end = projectOnRoute(L, L[L.length - 1])!;
    expect(Math.abs(bearingDelta(90, routeBearingAt(L, end)!))).toBeLessThan(2);
  });
});

describe('bearings + time', () => {
  it('bearingDeg cardinal directions', () => {
    expect(bearingDeg([30, -97], [30.01, -97])).toBeCloseTo(0, 0);
    expect(bearingDeg([30, -97], [30, -96.99])).toBeCloseTo(90, 0);
    expect(bearingDeg([30, -97], [29.99, -97])).toBeCloseTo(180, 0);
  });
  it('bearingDelta wraps through north', () => {
    expect(bearingDelta(350, 10)).toBe(20);
    expect(bearingDelta(10, 350)).toBe(-20);
    expect(bearingDelta(0, 180)).toBe(180);
  });
  it('remainingSeconds scales the route duration by distance left, clamped', () => {
    expect(remainingSeconds(500, 1000, 120)).toBe(60);
    expect(remainingSeconds(2000, 1000, 120)).toBe(120);
    expect(remainingSeconds(-5, 1000, 120)).toBe(0);
    expect(remainingSeconds(500, 0, 120)).toBe(0);
  });
});

describe('pickDrawnRoutes', () => {
  const r = (id: string) => ({ id, coordinates: L });
  it('selected + the two best-ranked alternatives, never more', () => {
    const { selected, alts } = pickDrawnRoutes([r('a'), r('b'), r('c'), r('d'), r('e')], 'c');
    expect(selected!.id).toBe('c');
    expect(alts.map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('unknown selection falls back to the top route; unusable geometry is skipped', () => {
    const { selected, alts } = pickDrawnRoutes([{ id: 'x', coordinates: [[30, -97]] }, r('a'), r('b')], 'zzz');
    expect(selected!.id).toBe('a');
    expect(alts.map((x) => x.id)).toEqual(['b']);
  });
});

describe('exposureRuns (camera zones on the selected route)', () => {
  it('one run per camera, about 2× the radius long, on a sparse 2-vertex segment', () => {
    const seg: [number, number][] = [[30.3, -97.7], [30.31, -97.7]]; // 1.1 km, no inner vertices
    const runs = exposureRuns(seg, [{ lat: 30.305, lon: -97.6995 }], 150);
    expect(runs).toHaveLength(1);
    const len = cumulativeM(runs[0]).at(-1)!;
    expect(len).toBeGreaterThan(220);
    expect(len).toBeLessThan(310);
  });
  it('no cameras, or a camera out of reach → no zones', () => {
    expect(exposureRuns(L, [], 150)).toEqual([]);
    expect(exposureRuns(L, [{ lat: 31, lon: -97 }], 150)).toEqual([]);
  });
  it('densify keeps endpoints and caps spacing', () => {
    const d = densify([[30.3, -97.7], [30.31, -97.7]], 20);
    expect(d[0]).toEqual([30.3, -97.7]);
    expect(d.at(-1)).toEqual([30.31, -97.7]);
    for (let i = 1; i < d.length; i++) expect(havM(d[i - 1], d[i])).toBeLessThanOrEqual(20.01);
  });
});

describe('labelAnchors', () => {
  it('a lone route is labelled at its middle', () => {
    const a = labelAnchors([{ id: 'a', coordinates: [[30.3, -97.7], [30.31, -97.7]] }]).get('a')!;
    expect(a[0]).toBeCloseTo(30.305, 2);
  });
  it('routes sharing a road are labelled where they diverge', () => {
    // Shared trunk north, then one goes east and one goes west.
    const trunk: [number, number][] = [[30.3, -97.7], [30.31, -97.7]];
    const east = { id: 'e', coordinates: [...trunk, [30.31, -97.69]] as [number, number][] };
    const west = { id: 'w', coordinates: [...trunk, [30.31, -97.71]] as [number, number][] };
    const anchors = labelAnchors([east, west]);
    expect(anchors.get('e')![1]).toBeGreaterThan(-97.7);
    expect(anchors.get('w')![1]).toBeLessThan(-97.7);
  });
});

describe('labelFromNominatimReverse', () => {
  it('house number + road + city', () => {
    expect(
      labelFromNominatimReverse({ address: { house_number: '1100', road: 'Congress Avenue', city: 'Austin' } }),
    ).toBe('1100 Congress Avenue, Austin');
  });
  it('a named place keeps its name with the road', () => {
    expect(
      labelFromNominatimReverse({ name: "Perla's", address: { road: 'West Gibson Street', city: 'Austin' } }),
    ).toBe("Perla's, West Gibson Street, Austin");
  });
  it('falls back to the first display_name part; junk → null', () => {
    expect(labelFromNominatimReverse({ display_name: 'Lady Bird Lake, Austin, Texas' })).toBe('Lady Bird Lake');
    expect(labelFromNominatimReverse(null)).toBeNull();
    expect(labelFromNominatimReverse({})).toBeNull();
  });
});

describe('maneuver card text', () => {
  it('splits verb from road so the road name can dominate', () => {
    expect(splitInstruction('Turn left onto North Interstate 35')).toEqual({ verb: 'Turn left', road: 'North Interstate 35' });
    expect(splitInstruction('Head north on Rainey Street')).toEqual({ verb: 'Head north', road: 'Rainey Street' });
    expect(splitInstruction('Arrive at destination')).toEqual({ verb: 'Arrive', road: 'destination' });
    expect(splitInstruction('Continue')).toEqual({ verb: 'Continue', road: null });
  });
});

describe('depart/arrive wording (OSRM)', () => {
  it('depart uses the compass bearing, not the relative modifier', () => {
    expect(buildInstruction('depart', 'left', 'Rainey Street', undefined, undefined, 10)).toBe('Head north on Rainey Street');
    expect(buildInstruction('depart', 'right', 'Main St', undefined, undefined, 268)).toBe('Head west on Main St');
  });
  it('depart without a bearing still reads as Head', () => {
    expect(buildInstruction('depart', undefined, 'Main St')).toBe('Head on Main St');
  });
  it('arrive names the street and the side, without "onto"', () => {
    expect(buildInstruction('arrive', 'right', 'Curve Street')).toBe('Arrive at Curve Street, destination on the right');
    expect(buildInstruction('arrive', undefined, '')).toBe('Arrive at destination');
  });
});
