export interface LatLon {
  lat: number;
  lon: number;
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
}

export interface RouteGeom {
  coordinates: [number, number][]; // [lat, lon] order
  distanceM: number;
  durationS: number;
}

export interface Exposure {
  cameraId: string;
  lat: number;
  lon: number;
  distM: number;
}

const EARTH_M = 6371000;

function assertLatLon(p: LatLon, what: string): void {
  if (
    typeof p !== "object" ||
    p === null ||
    !Number.isFinite((p as LatLon).lat) ||
    (p as LatLon).lat < -90 ||
    (p as LatLon).lat > 90 ||
    !Number.isFinite((p as LatLon).lon) ||
    (p as LatLon).lon < -180 ||
    (p as LatLon).lon > 180
  ) {
    throw new RangeError(`invalid coordinates for ${what}`);
  }
}

export function distM(a: LatLon, b: LatLon): number {
  assertLatLon(a, "a");
  assertLatLon(b, "b");
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h =
    s1 * s1 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      s2 *
      s2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(h));
}

// Equirectangular projection of segment endpoints relative to p, in meters.
function segDistM(
  p: LatLon,
  a: [number, number],
  b: [number, number],
): number {
  const kx = (Math.PI / 180) * EARTH_M * Math.cos((p.lat * Math.PI) / 180);
  const ky = (Math.PI / 180) * EARTH_M;
  const ax = (a[1] - p.lon) * kx;
  const ay = (a[0] - p.lat) * ky;
  const bx = (b[1] - p.lon) * kx;
  const by = (b[0] - p.lat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(cx, cy);
}

export function pointToPolylineDistM(
  p: LatLon,
  line: [number, number][],
): number {
  assertLatLon(p, "p");
  if (line.length === 0) return Infinity;
  if (line.length === 1)
    return distM(p, { lat: line[0][0], lon: line[0][1] });
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const d = segDistM(p, line[i], line[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

export function validateP(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(1, p));
}

/** Half-angle window used when a camera's `direction` is known. */
export const DEFAULT_DIR_TOLERANCE_DEG = 60;

export interface ExposureOpts {
  /**
   * When true (default), a camera with a known `direction` only counts as an
   * exposure when the route's travel heading where it passes nearest the
   * camera is within `toleranceDeg` of that direction. Cameras without a
   * known direction stay omnidirectional.
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
export function bearingDeg(a: [number, number], b: [number, number]): number {
  const lat1 = (a[0] * Math.PI) / 180;
  const lat2 = (b[0] * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Smallest absolute difference between two bearings, 0..180. */
export function angleDiffDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Index of the polyline segment nearest to p, or -1 when there is none. */
function nearestSegmentIndex(p: LatLon, line: [number, number][]): number {
  let best = Infinity;
  let bi = -1;
  for (let i = 0; i < line.length - 1; i++) {
    const d = segDistM(p, line[i], line[i + 1]);
    if (d < best) {
      best = d;
      bi = i;
    }
  }
  return bi;
}

/**
 * Travel heading (degrees, 0 = north, clockwise) of the polyline where it
 * passes nearest `camera`. Null when there is no usable segment (single point
 * or a degenerate segment) — callers then keep the camera omnidirectional.
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
  return bearingDeg(a, b);
}

/** True when this camera's known direction admits the route's travel heading. */
function directionAdmits(
  camera: Camera,
  coords: [number, number][],
  respect: boolean,
  toleranceDeg: number,
): boolean {
  if (!respect) return true;
  const dir = camera.direction;
  if (typeof dir !== 'number' || !Number.isFinite(dir)) return true;
  const heading = headingAtNearest(coords, { lat: camera.lat, lon: camera.lon });
  if (heading === null) return true;
  return angleDiffDeg(heading, dir) <= toleranceDeg;
}

export function exposurePForPoints(
  coords: [number, number][],
  cameras: Camera[],
  bufferM: number,
  opts?: ExposureOpts,
): { p: number; cameraIds: string[] } {
  const cameraIds: string[] = [];
  if (coords.length === 0 || cameras.length === 0 || !(bufferM > 0))
    return { p: 0, cameraIds };
  const respect = opts?.respectDirection ?? true;
  const toleranceDeg = clampToleranceDeg(opts?.toleranceDeg);
  const maxDistM = opts?.maxDistM;
  let prod = 1;
  for (const c of cameras) {
    const d = pointToPolylineDistM({ lat: c.lat, lon: c.lon }, coords);
    if (!(d <= bufferM)) continue;
    if (!withinMaxDist(d, maxDistM)) continue;
    if (!directionAdmits(c, coords, respect, toleranceDeg)) continue;
    const pCam = 0.95 * Math.max(0, 1 - d / bufferM);
    if (!(pCam > 0)) continue;
    cameraIds.push(c.id);
    prod *= 1 - pCam;
  }
  return { p: validateP(1 - prod), cameraIds };
}

export function scoreRoute(
  route: RouteGeom,
  cameras: Camera[],
  bufferM: number,
  opts?: ExposureOpts,
): { exposures: Exposure[]; exposureCount: number; score: number } {
  const respect = opts?.respectDirection ?? true;
  const toleranceDeg = clampToleranceDeg(opts?.toleranceDeg);
  const maxDistM = opts?.maxDistM;
  const exposures: Exposure[] = [];
  for (const c of cameras) {
    const d = pointToPolylineDistM(
      { lat: c.lat, lon: c.lon },
      route.coordinates,
    );
    if (!(d <= bufferM)) continue;
    if (!withinMaxDist(d, maxDistM)) continue;
    if (!directionAdmits(c, route.coordinates, respect, toleranceDeg)) continue;
    exposures.push({ cameraId: c.id, lat: c.lat, lon: c.lon, distM: d });
  }
  exposures.sort((x, y) => x.distM - y.distM);
  return {
    exposures,
    exposureCount: exposures.length,
    score: exposures.length * 10000 + route.distanceM,
  };
}

// Base-route sanity guard: OSRM occasionally returns garbage (e.g. a 2000km
// detour for a 60km trip near water/borders). Driving distance is rarely more
// than a few multiples of straight-line distance, so routes beyond the gate
// are dropped before scoring/search/ranking ever see them.
//
// The multiple is length-aware: short urban trips distort ratios (one-ways,
// cul-de-sacs), so they get a generous gate; long hauls get a tight one.
// ROUTE_MAX_FACTOR overrides with a fixed multiple when set.
function plausibilityFactor(straightM: number): number {
  const f = Number(process.env.ROUTE_MAX_FACTOR);
  if (Number.isFinite(f) && f > 0) return f;
  if (straightM < 10_000) return 8;
  if (straightM < 100_000) return 5;
  return 4;
}

// Returns the distance threshold used (5km floor keeps short trips safe).
export function plausibilityThresholdM(origin: LatLon, dest: LatLon): number {
  const straight = distM(origin, dest);
  return Math.max(plausibilityFactor(straight) * straight, 5000);
}

export function isPlausibleRoute(
  distanceM: number,
  origin: LatLon,
  dest: LatLon,
): boolean {
  return (
    typeof distanceM === "number" &&
    Number.isFinite(distanceM) &&
    distanceM >= 0 &&
    distanceM <= plausibilityThresholdM(origin, dest)
  );
}
