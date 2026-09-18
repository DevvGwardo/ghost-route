export interface LatLon {
  lat: number;
  lon: number;
}

export interface Camera {
  id: string;
  lat: number;
  lon: number;
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

export function exposurePForPoints(
  coords: [number, number][],
  cameras: Camera[],
  bufferM: number,
): { p: number; cameraIds: string[] } {
  const cameraIds: string[] = [];
  if (coords.length === 0 || cameras.length === 0 || !(bufferM > 0))
    return { p: 0, cameraIds };
  let prod = 1;
  for (const c of cameras) {
    const d = pointToPolylineDistM({ lat: c.lat, lon: c.lon }, coords);
    if (!(d <= bufferM)) continue;
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
): { exposures: Exposure[]; exposureCount: number; score: number } {
  const exposures: Exposure[] = [];
  for (const c of cameras) {
    const d = pointToPolylineDistM(
      { lat: c.lat, lon: c.lon },
      route.coordinates,
    );
    if (d <= bufferM)
      exposures.push({ cameraId: c.id, lat: c.lat, lon: c.lon, distM: d });
  }
  exposures.sort((x, y) => x.distM - y.distM);
  return {
    exposures,
    exposureCount: exposures.length,
    score: exposures.length * 10000 + route.distanceM,
  };
}
