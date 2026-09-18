import { describe, it, expect } from 'vitest';
import { rankByExposure, perpOffsetDetour, distM, minDistToPolyline } from '../server/src/avoid';
import { AUSTIN, makeCamera, makeRoute, straightCoords } from './helpers';

const DEST = { lat: 30.35, lon: -97.7 };
const BUFFER_M = 150;

function clusterFixtures() {
  const base = straightCoords(AUSTIN, DEST, 21);
  const mid = base[10];
  const cameras = [
    makeCamera('k1', mid[0] + 0.0002, mid[1]),
    makeCamera('k2', mid[0] - 0.0002, mid[1] + 0.0002),
  ];
  const through = { ...makeRoute('through', AUSTIN, DEST, 21), coordinates: base };
  // Clean detour: same endpoints shifted ~2.2km north (well outside 150m buffer).
  const shifted = base.map(([lat, lon]) => [lat + 0.02, lon] as [number, number]);
  const detour = { ...makeRoute('detour', AUSTIN, DEST, 21), coordinates: shifted };
  return { cameras, through, detour };
}

describe('avoid: rankByExposure', () => {
  it('route through a camera cluster ranks worse than a clean detour', () => {
    const { cameras, through, detour } = clusterFixtures();
    const ranked = rankByExposure([through, detour], cameras, BUFFER_M);
    expect(ranked).toHaveLength(2);
    const byId = Object.fromEntries(ranked.map((r) => [r.id, r]));
    expect(byId['through'].exposureCount).toBeGreaterThan(0);
    expect(byId['detour'].exposureCount).toBe(0);
    // Best (lowest exposure) first, exposed route last.
    expect(ranked[0].id).toBe('detour');
    expect(ranked[ranked.length - 1].id).toBe('through');
  });

  it('empty cameras → every route has exposureCount 0 (order preserved)', () => {
    const { through, detour } = clusterFixtures();
    const ranked = rankByExposure([through, detour], [], BUFFER_M);
    expect(ranked).toHaveLength(2);
    for (const r of ranked) expect(r.exposureCount).toBe(0);
  });

  it('empty routes → empty ranking (no crash)', () => {
    const { cameras } = clusterFixtures();
    expect(rankByExposure([], cameras, BUFFER_M)).toEqual([]);
  });
});

describe('avoid: perpOffsetDetour (via waypoint)', () => {
  it('returns a {lat,lon} waypoint ~offsetM off the base path', () => {
    const base = straightCoords(AUSTIN, DEST, 11);
    const via = perpOffsetDetour(AUSTIN, DEST, base, 500);
    expect(typeof via.lat).toBe('number');
    expect(typeof via.lon).toBe('number');
    // ~500m from the base midpoint…
    const mid = base[5];
    const dMid = distM(via, { lat: mid[0], lon: mid[1] });
    expect(dMid).toBeGreaterThan(400);
    expect(dMid).toBeLessThan(600);
    // …and ~500m off the whole polyline (a genuine detour, not on-path).
    const dLine = minDistToPolyline(via, base);
    expect(dLine).toBeGreaterThan(400);
    expect(dLine).toBeLessThan(600);
  });

  it('empty baseCoords → returns the origin (no crash)', () => {
    expect(perpOffsetDetour(AUSTIN, DEST, [], 500)).toEqual(AUSTIN);
  });
});
