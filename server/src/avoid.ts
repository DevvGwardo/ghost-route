// Avoidance engine — core privacy logic (debug agent owns this file).
// Self-contained geometry (haversine + equirectangular point-to-segment);
// no imports so it builds even if services/scoring.ts does not exist yet.

export interface LatLon { lat: number; lon: number; }
export interface RouteInput {
  id: string;
  coordinates: [number, number][]; // [lat, lon]
  distanceM: number;
  durationS: number;
}
export interface Camera { id: string; lat: number; lon: number; }
export interface Exposure { cameraId: string; lat: number; lon: number; distM: number; }
export type RankedRoute = RouteInput & {
  exposures: Exposure[];
  exposureCount: number;
  score: number;
};

const EARTH_M = 6371000;
const DEG = Math.PI / 180;

export function distM(a: LatLon, b: LatLon): number {
  const s1 = Math.sin(((b.lat - a.lat) * DEG) / 2) ** 2;
  const s2 =
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(((b.lon - a.lon) * DEG) / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(Math.min(1, s1 + s2)));
}

/** Equirectangular projection of lat/lon to meters relative to ref. */
function toXY(p: LatLon, ref: LatLon): { x: number; y: number } {
  return {
    x: (p.lon - ref.lon) * DEG * EARTH_M * Math.cos(ref.lat * DEG),
    y: (p.lat - ref.lat) * DEG * EARTH_M,
  };
}

function pointSegDistM(p: LatLon, a: LatLon, b: LatLon): number {
  const ref = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
  const P = toXY(p, ref), A = toXY(a, ref), B = toXY(b, ref);
  const dx = B.x - A.x, dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(P.x - A.x, P.y - A.y);
  const t = Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2));
  return Math.hypot(P.x - (A.x + t * dx), P.y - (A.y + t * dy));
}

export function minDistToPolyline(p: LatLon, coords: [number, number][]): number {
  if (coords.length === 0) return Infinity;
  if (coords.length === 1) return distM(p, { lat: coords[0][0], lon: coords[0][1] });
  let best = Infinity;
  for (let i = 0; i + 1 < coords.length; i++) {
    const d = pointSegDistM(
      p,
      { lat: coords[i][0], lon: coords[i][1] },
      { lat: coords[i + 1][0], lon: coords[i + 1][1] },
    );
    if (d < best) best = d;
  }
  return best;
}

export function rankByExposure(
  routes: RouteInput[],
  cameras: Camera[],
  bufferMeters: number,
): RankedRoute[] {
  const ranked: RankedRoute[] = routes.map((r) => {
    const exposures: Exposure[] = [];
    for (const c of cameras) {
      const d = minDistToPolyline({ lat: c.lat, lon: c.lon }, r.coordinates);
      if (d <= bufferMeters) {
        exposures.push({ cameraId: c.id, lat: c.lat, lon: c.lon, distM: Math.round(d * 10) / 10 });
      }
    }
    return {
      ...r,
      exposures,
      exposureCount: exposures.length,
      score: exposures.length * 10000 + r.distanceM,
    };
  });
  ranked.sort((a, b) => a.exposureCount - b.exposureCount || a.distanceM - b.distanceM);
  return ranked;
}

export function perpOffsetDetour(
  _origin: LatLon,
  _dest: LatLon,
  baseCoords: [number, number][],
  offsetM: number,
): LatLon {
  if (baseCoords.length === 0) return { ..._origin };
  const mid = baseCoords[Math.floor(baseCoords.length / 2)];
  const midPt: LatLon = { lat: mid[0], lon: mid[1] };
  const first = baseCoords[0];
  const last = baseCoords[baseCoords.length - 1];
  const ref = midPt;
  const F = toXY({ lat: first[0], lon: first[1] }, ref);
  const L = toXY({ lat: last[0], lon: last[1] }, ref);
  let vx = L.x - F.x, vy = L.y - F.y;
  const len = Math.hypot(vx, vy);
  if (len === 0) {
    // Degenerate polyline: offset due north.
    return { lat: midPt.lat + offsetM / EARTH_M / DEG, lon: midPt.lon };
  }
  vx /= len; vy /= len;
  // Perpendicular unit (-vy, vx), scaled by signed offset.
  const ox = -vy * offsetM, oy = vx * offsetM;
  return {
    lat: midPt.lat + oy / EARTH_M / DEG,
    lon: midPt.lon + ox / (EARTH_M * DEG * Math.cos(midPt.lat * DEG)),
  };
}

const DETOUR_OFFSET_M = 1000;

export async function buildDetours(
  origin: LatLon,
  dest: LatLon,
  baseRoutes: RouteInput[],
  fetchRoutes: (o: LatLon, d: LatLon, via?: LatLon) => Promise<RouteInput[]>,
): Promise<RouteInput[]> {
  if (baseRoutes.length === 0) return [];
  const best = [...baseRoutes].sort((a, b) => a.distanceM - b.distanceM)[0];
  const out: RouteInput[] = [];
  for (const sign of [1, -1]) {
    try {
      const via = perpOffsetDetour(origin, dest, best.coordinates, sign * DETOUR_OFFSET_M);
      const extra = await fetchRoutes(origin, dest, via);
      for (const r of extra ?? []) {
        if (out.length < 2) out.push(r);
      }
      if (out.length >= 2) break;
    } catch {
      // Swallow fetch errors → caller re-scores whatever it has.
    }
  }
  return out.slice(0, 2);
}
