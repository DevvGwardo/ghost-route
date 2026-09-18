// repro-avoid.mjs — node-builtins-only demo of the avoidance engine.
// Mirrors server/src/avoid.ts geometry (haversine + point-to-segment) inline
// so it runs with plain `node` (no TS build needed).
//
// Scenario: straight base route E along the equator passes 3 cameras sitting
// ON the line; a perpendicular-offset detour (+800 m) clears all of them.

const EARTH_M = 6371000;
const DEG = Math.PI / 180;

function distM(a, b) {
  const s1 = Math.sin(((b.lat - a.lat) * DEG) / 2) ** 2;
  const s2 =
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(((b.lon - a.lon) * DEG) / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(Math.min(1, s1 + s2)));
}

function toXY(p, ref) {
  return {
    x: (p.lon - ref.lon) * DEG * EARTH_M * Math.cos(ref.lat * DEG),
    y: (p.lat - ref.lat) * DEG * EARTH_M,
  };
}

function pointSegDistM(p, a, b) {
  const ref = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
  const P = toXY(p, ref), A = toXY(a, ref), B = toXY(b, ref);
  const dx = B.x - A.x, dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(P.x - A.x, P.y - A.y);
  const t = Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2));
  return Math.hypot(P.x - (A.x + t * dx), P.y - (A.y + t * dy));
}

function minDistToPolyline(p, coords) {
  let best = Infinity;
  for (let i = 0; i + 1 < coords.length; i++) {
    const d = pointSegDistM(p, { lat: coords[i][0], lon: coords[i][1] },
      { lat: coords[i + 1][0], lon: coords[i + 1][1] });
    if (d < best) best = d;
  }
  return best;
}

function countExposures(coords, cameras, bufferM) {
  return cameras.filter((c) => minDistToPolyline(c, coords) <= bufferM).length;
}

// --- Synthetic scenario -------------------------------------------------
const BUFFER_M = 150;
// Base route: straight shot east along lat 0, lon 0 → 0.02 (~2224 m).
const base = [];
for (let i = 0; i <= 20; i++) base.push([0, i * 0.001]);
// 3 cameras exactly on the line.
const cameras = [
  { id: 'cam-1', lat: 0, lon: 0.005 },
  { id: 'cam-2', lat: 0, lon: 0.010 },
  { id: 'cam-3', lat: 0, lon: 0.015 },
];
// Detour: midpoint pushed +800 m north (≈0.00719°), routed via that waypoint.
const OFF_DEG = 800 / EARTH_M / DEG;
const detour = [];
for (let i = 0; i <= 10; i++) detour.push([OFF_DEG * (i / 10), i * 0.001]);
for (let i = 1; i <= 10; i++) detour.push([OFF_DEG * (1 - i / 10), 0.01 + i * 0.001]);

const baseExp = countExposures(base, cameras, BUFFER_M);
const detourExp = countExposures(detour, cameras, BUFFER_M);

console.log(`buffer=${BUFFER_M}m cameras=${cameras.length}`);
console.log(`base route:   exposures=${baseExp}`);
console.log(`detour route: exposures=${detourExp}`);

if (baseExp !== 3) {
  console.error(`FAIL: expected base exposures=3, got ${baseExp}`);
  process.exit(1);
}
if (detourExp >= baseExp) {
  console.error(`FAIL: detour (${detourExp}) did not beat base (${baseExp})`);
  process.exit(1);
}
console.log(`OK: detour wins ${baseExp} → ${detourExp}`);
