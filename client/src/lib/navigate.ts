// Pure navigation helpers (no DOM): locate the user on a route,
// distance-to-next-turn, and upcoming camera alerts. All geometry uses
// [lat, lon] pairs, matching the API contract.
import type { Exposure, RouteStep } from '../../../shared/src/types';

// Derived from the shared contract so contract renames break compilation
// here instead of drifting silently. `coordinates` is required because the
// caller only ever builds steps for navigation from real geometry.
export type NavStep = {
  coordinates: [number, number][];
  instruction: RouteStep['instruction'];
  maneuverKind?: RouteStep['maneuverKind'];
};

export type NavExposure = Pick<Exposure, 'cameraId' | 'lat' | 'lon'>;

/** Minimal route shape navigation needs (a subset of a scored route). */
export interface NavRouteInput {
  coordinates: [number, number][];
  steps: NavStep[];
  exposures: NavExposure[];
}

const EARTH_M = 6371000;
const DEG = Math.PI / 180;

/** Lock-on radius: a step counts as reached when the fix is this close. */
export const STEP_LOCK_M = 60;
/** Camera alerts only fire inside this lookahead window. */
export const CAMERA_ALERT_M = 500;
/** Distance from the route beyond which a fix counts as a miss (meters). */
export const OFF_ROUTE_M = 80;
/**
 * Consecutive misses before the route is declared lost — one bad fix must
 * never trigger a reroute.
 */
export const OFF_ROUTE_FIXES = 3;
/** Arrival radius for the final step. */
export const ARRIVED_M = 40;

export function havM(a: [number, number], b: [number, number]): number {
  const dLat = (b[0] - a[0]) * DEG;
  const dLon = (b[1] - a[1]) * DEG;
  const s1 = Math.sin(dLat / 2) ** 2;
  const s2 =
    Math.cos(a[0] * DEG) * Math.cos(b[0] * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(Math.min(1, s1 + s2)));
}

/** Equirectangular point-to-segment distance, meters. */
function segDistM(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const refLat = (a[0] + b[0]) / 2;
  const refLon = (a[1] + b[1]) / 2;
  const kx = DEG * EARTH_M * Math.cos(refLat * DEG);
  const ky = DEG * EARTH_M;
  const ax = (a[1] - refLon) * kx;
  const ay = (a[0] - refLat) * ky;
  const bx = (b[1] - refLon) * kx;
  const by = (b[0] - refLat) * ky;
  const px = (p[1] - refLon) * kx;
  const py = (p[0] - refLat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function minDistToPolyline(p: [number, number], coords: [number, number][]): number {
  if (coords.length === 0) return Infinity;
  if (coords.length === 1) return havM(p, coords[0]);
  let best = Infinity;
  for (let i = 0; i + 1 < coords.length; i++) {
    const d = segDistM(p, coords[i], coords[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

/** Polyline length between point indices (inclusive of both ends). */
export function polyLen(
  coords: [number, number][],
  fromIdx: number,
  toIdx: number,
): number {
  const a = Math.max(0, Math.min(fromIdx, toIdx));
  const b = Math.min(coords.length - 1, Math.max(fromIdx, toIdx));
  let sum = 0;
  for (let i = a; i < b; i++) sum += havM(coords[i], coords[i + 1]);
  return sum;
}

/** Nearest route point index to p (nearer endpoint of nearest segment). */
export function nearestIndex(
  coords: [number, number][],
  p: [number, number],
): { index: number; distM: number } {
  if (coords.length === 0) return { index: 0, distM: Infinity };
  if (coords.length === 1) return { index: 0, distM: havM(p, coords[0]) };
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i + 1 < coords.length; i++) {
    const d = segDistM(p, coords[i], coords[i + 1]);
    if (d < bd) {
      bd = d;
      bi = havM(p, coords[i]) <= havM(p, coords[i + 1]) ? i : i + 1;
    }
  }
  return { index: bi, distM: bd };
}

/**
 * Current step = earliest step at/after `locked` within STEP_LOCK_M of the
 * fix. Returns remaining meters from the fix to the end of that step.
 * Null when off-route (caller keeps the previous lock — progress never
 * moves backwards on GPS noise).
 */
export function locateStep(
  steps: NavStep[],
  p: [number, number],
  locked: number,
): { step: number; remainingM: number } | null {
  const start = Math.max(0, Math.min(locked, steps.length - 1));
  for (let j = start; j < steps.length; j++) {
    const coords = steps[j].coordinates;
    if (!Array.isArray(coords) || coords.length === 0) continue;
    if (minDistToPolyline(p, coords) > STEP_LOCK_M) continue;
    const near = nearestIndex(coords, p);
    return { step: j, remainingM: polyLen(coords, near.index, coords.length - 1) };
  }
  return null;
}

export interface UpcomingCamera {
  cameraId: string;
  aheadM: number;
}

/**
 * Exposures ahead of the user along the route, inside the alert window,
 * nearest first. Each exposure carries its precomputed route index.
 */
export function upcomingCameras(
  exposures: Array<NavExposure & { routeIdx: number }>,
  routeCoords: [number, number][],
  userIdx: number,
  withinM: number = CAMERA_ALERT_M,
): UpcomingCamera[] {
  const out: UpcomingCamera[] = [];
  for (const e of exposures) {
    if (!(e.routeIdx > userIdx)) continue;
    const aheadM = polyLen(routeCoords, userIdx, e.routeIdx);
    if (aheadM <= withinM) out.push({ cameraId: e.cameraId, aheadM });
  }
  out.sort((a, b) => a.aheadM - b.aheadM);
  return out;
}

export function fmtNavDist(m: number): string {
  if (!Number.isFinite(m) || m < 0) return '';
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/** Distance from p to the route polyline, in meters. */
export function distToRoute(coords: [number, number][], p: [number, number]): number {
  return minDistToPolyline(p, coords);
}

export interface OffRouteTracker {
  /** Feed one fix's distance to the route; returns the running verdict. */
  update(distM: number): { offRoute: boolean; misses: number };
  reset(): void;
  readonly misses: number;
}

/**
 * Consecutive-miss off-route tracker. A fix farther than `maxM` from the route
 * is a miss; `consecutive` misses in a row declare the driver off-route. Any
 * on-route fix resets the counter, so a single GPS hiccup (or a tunnel) never
 * triggers a reroute. Non-finite distances (empty geometry) are ignored.
 */
export function createOffRouteTracker(opts?: {
  maxM?: number;
  consecutive?: number;
}): OffRouteTracker {
  const maxM = typeof opts?.maxM === 'number' && opts.maxM > 0 ? opts.maxM : OFF_ROUTE_M;
  const consecutive = Math.max(1, Math.floor(opts?.consecutive ?? OFF_ROUTE_FIXES));
  let misses = 0;
  return {
    update(distM: number) {
      if (Number.isFinite(distM)) {
        if (distM <= maxM) misses = 0;
        else misses += 1;
      }
      return { offRoute: misses >= consecutive, misses };
    },
    reset() {
      misses = 0;
    },
    get misses() {
      return misses;
    },
  };
}
