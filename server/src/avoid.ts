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
export interface Camera {
  id: string;
  lat: number;
  lon: number;
  /**
   * OSM convention: compass bearing the camera points at (0 = north,
   * clockwise). Absent/unknown = omnidirectional (always counts).
   */
  direction?: number;
  /** Additional compass bearings watched (multi-headed cameras). */
  directions?: number[];
}
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

/** Half-angle window used when a camera's `direction` is known. */
export const DEFAULT_DIR_TOLERANCE_DEG = 60;

export interface ExposureOpts {
  /**
   * When true (default), a camera with known bearings (`direction` and/or
   * `directions`) only counts when the route's travel heading where it
   * passes nearest is within `toleranceDeg` of any of them. Cameras without
   * bearings always count (current behavior preserved).
   */
  respectDirection?: boolean;
  /** Half-angle window in degrees. Default 60, clamped to 0..180. */
  toleranceDeg?: number;
  /**
   * Additive v1.2: ignore cameras farther than this from the route, even when
   * they are inside the buffer. Absent = no ceiling.
   */
  maxDistM?: number;
}

/** True when `d` satisfies the optional hard distance ceiling. */
function withinMaxDist(d: number, maxDistM?: number): boolean {
  if (typeof maxDistM !== 'number' || !Number.isFinite(maxDistM) || maxDistM <= 0) return true;
  return d <= maxDistM;
}

function clampToleranceDeg(v?: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_DIR_TOLERANCE_DEG;
  return Math.min(180, Math.max(0, v));
}

/** Initial great-circle bearing a → b in degrees (0 = north, clockwise). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Smallest absolute difference between two bearings, 0..180. */
export function angleDiffDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Index of the polyline segment nearest to p, or -1 when there is none. */
function nearestSegmentIndex(p: LatLon, coords: [number, number][]): number {
  let best = Infinity;
  let bi = -1;
  for (let i = 0; i + 1 < coords.length; i++) {
    const d = pointSegDistM(
      p,
      { lat: coords[i][0], lon: coords[i][1] },
      { lat: coords[i + 1][0], lon: coords[i + 1][1] },
    );
    if (d < best) {
      best = d;
      bi = i;
    }
  }
  return bi;
}

/**
 * Travel heading (degrees, 0 = north, clockwise) of the polyline where it
 * passes nearest `camera`. Null when no usable segment exists — callers then
 * keep the camera omnidirectional.
 */
export function headingAtNearest(
  coords: [number, number][],
  camera: LatLon,
): number | null {
  if (coords.length < 2) return null;
  const i = nearestSegmentIndex(camera, coords);
  if (i < 0) return null;
  const a = coords[i];
  const b = coords[i + 1];
  if (a[0] === b[0] && a[1] === b[1]) return null;
  return bearingDeg({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
}

/** All compass bearings this camera watches; empty = omnidirectional. */
function knownBearings(camera: Camera): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const add = (v: unknown): void => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    const b = ((v % 360) + 360) % 360;
    if (!seen.has(b)) {
      seen.add(b);
      out.push(b);
    }
  };
  add(camera.direction);
  if (Array.isArray(camera.directions)) for (const v of camera.directions) add(v);
  return out;
}

/** True when this camera's known bearings admit the route's travel heading. */
function directionAdmits(
  camera: Camera,
  coords: [number, number][],
  respect: boolean,
  toleranceDeg: number,
): boolean {
  if (!respect) return true;
  const bearings = knownBearings(camera);
  if (bearings.length === 0) return true;
  const heading = headingAtNearest(coords, { lat: camera.lat, lon: camera.lon });
  if (heading === null) return true;
  return bearings.some((b) => angleDiffDeg(heading, b) <= toleranceDeg);
}

export function rankByExposure(
  routes: RouteInput[],
  cameras: Camera[],
  bufferMeters: number,
  opts?: ExposureOpts,
): RankedRoute[] {
  const respect = opts?.respectDirection ?? true;
  const toleranceDeg = clampToleranceDeg(opts?.toleranceDeg);
  const maxDistM = opts?.maxDistM;
  const ranked: RankedRoute[] = routes.map((r) => {
    const exposures: Exposure[] = [];
    for (const c of cameras) {
      const d = minDistToPolyline({ lat: c.lat, lon: c.lon }, r.coordinates);
      if (!(d <= bufferMeters)) continue;
      if (!withinMaxDist(d, maxDistM)) continue;
      if (!directionAdmits(c, r.coordinates, respect, toleranceDeg)) continue;
      exposures.push({ cameraId: c.id, lat: c.lat, lon: c.lon, distM: Math.round(d * 10) / 10 });
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
