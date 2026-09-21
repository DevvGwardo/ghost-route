// Iterative clean-route search: perpendicular via-waypoint escapes from the
// most-exposed step, widening the radius each round. Pure geometric re-scoring
// via rankByExposure — no Jev calls inside the loop (latency).
import {
  rankByExposure,
  minDistToPolyline,
  type Camera,
  type ExposureOpts,
  type LatLon,
  type RankedRoute,
  type RouteInput,
} from './avoid.js';

export interface CleanStep {
  coordinates: [number, number][];
  cameraIds?: string[];
  exposureP?: number;
  // Mirrors OSRM RouteStep extras carried through rankByExposure's spread.
  roadName?: string;
  maneuverKind?: string;
}

export type ScoredRoute = RankedRoute & { steps?: CleanStep[] };

export type FetchRoutes = (
  origin: LatLon,
  destination: LatLon,
  via?: LatLon,
) => Promise<
  Array<{
    coordinates: [number, number][];
    distanceM: number;
    durationS: number;
    steps?: unknown;
  }>
>;

export interface CleanRouteResult {
  routes: RankedRoute[];
  attempts: number;
  osrmCalls: number;
  cleanFound: boolean;
  rounds: number;
  /**
   * Additive v1.2 (spec P2-1): true when the search stopped at the caller's
   * `deadlineMs` instead of running out of rounds. Partial results are still
   * returned — a bounded answer beats an unbounded wait.
   */
  aborted: boolean;
}

/** Wall-clock ceiling for the search, computed by the caller (route budget). */
export interface CleanSearchDeadline {
  deadlineMs: number;
}

const ROUND_RADII_M = [500, 1000, 2000];
const MAX_ROUNDS_DEFAULT = 3;
const MAX_ROUNDS_CAP = 5;
const DETOUR_FACTOR = 1.5;
const VIA_TIMEOUT_DEFAULT_MS = 4000;

function numEnv(name: string, def: number, min: number, max: number): number {
  const v = Number(process.env[name]);
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/** Slow/dead OSRM via leg resolves as a skip — the round keeps the other side. */
function withViaTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error("via-timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

const EARTH_M = 6371000;
const DEG = Math.PI / 180;

/** Haversine distance between two [lat, lon] points, in meters. */
function havM(a: [number, number], b: [number, number]): number {
  const dLat = (b[0] - a[0]) * DEG;
  const dLon = (b[1] - a[1]) * DEG;
  const s1 = Math.sin(dLat / 2) ** 2;
  const s2 =
    Math.cos(a[0] * DEG) * Math.cos(b[0] * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(Math.min(1, s1 + s2)));
}

function polyLenM(coords: [number, number][], from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += havM(coords[i], coords[i + 1]);
  return sum;
}

/** Full polyline length in meters (exported for step-metric scaling). */
export function routeLenM(coords: [number, number][]): number {
  return polyLenM(coords, 0, Math.max(0, coords.length - 1));
}

// OSRM via routes sometimes contain an out-and-back spur: the via point
// snaps to a dead-end (driveway, side road), so OSRM drives off the main
// road to the via and back on the same line. On the map this renders as a
// Y-branch stub. Detect loops where the path wanders far but ends near its
// start (path >> endpoint distance) and splice the excursion out, keeping
// one copy of the junction point. Returns the cleaned polyline plus the
// removed spur length in meters (for distance/duration adjustment).
export function stripBacktrackSpur(coords: [number, number][]): {
  coordinates: [number, number][];
  removedM: number;
} {
  const out = [...coords];
  let removedM = 0;
  let changed = true;
  while (changed) {
    changed = false;
    const n = out.length;
    for (let i = 0; i < n; i++) {
      for (let j = Math.min(n - 1, i + 12); j > i + 1; j--) {
        // Never collapse the whole route into its endpoints.
        if (i === 0 && j === n - 1) continue;
        const endDist = havM(out[i], out[j]);
        if (endDist > 25) continue;
        const path = polyLenM(out, i, j);
        // Excursion only: the driven path must dwarf the endpoint gap
        // (a normal curve has path ~= endpoint distance) and be non-trivial.
        if (path < 3 * endDist || path < 50) continue;
        removedM += path - endDist;
        out.splice(i + 1, j - i);
        changed = true;
        break;
      }
      if (changed) break;
    }
  }
  if (out.length < 2) return { coordinates: [...coords], removedM: 0 };
  return { coordinates: out, removedM };
}

/** Perpendicular offset from a step polyline's midpoint (sign sets the side). */
function stepPerpOffset(coords: [number, number][], offsetM: number): LatLon {
  const mid = coords[Math.floor(coords.length / 2)];
  const midPt: LatLon = { lat: mid[0], lon: mid[1] };
  const first = coords[0];
  const last = coords[coords.length - 1];
  const cosLat = Math.cos(midPt.lat * DEG);
  const fx = (first[1] - midPt.lon) * DEG * EARTH_M * cosLat;
  const fy = (first[0] - midPt.lat) * DEG * EARTH_M;
  const lx = (last[1] - midPt.lon) * DEG * EARTH_M * cosLat;
  const ly = (last[0] - midPt.lat) * DEG * EARTH_M;
  let vx = lx - fx;
  let vy = ly - fy;
  const len = Math.hypot(vx, vy);
  if (len === 0) return { lat: midPt.lat + offsetM / EARTH_M / DEG, lon: midPt.lon };
  vx /= len;
  vy /= len;
  return {
    lat: midPt.lat + (vx * offsetM) / EARTH_M / DEG,
    lon: midPt.lon + (-vy * offsetM) / (EARTH_M * DEG * cosLat),
  };
}

function asCleanSteps(steps: unknown): CleanStep[] | undefined {
  if (!Array.isArray(steps)) return undefined;
  const out: CleanStep[] = [];
  for (const s of steps) {
    if (typeof s !== 'object' || s === null) continue;
    const coords = (s as { coordinates?: unknown }).coordinates;
    if (!Array.isArray(coords) || coords.length === 0) continue;
    const cams = (s as { cameraIds?: unknown }).cameraIds;
    const p = (s as { exposureP?: unknown }).exposureP;
    // Via-spur cleanup so per-step exposure never scores the dead-end stub.
    const stripped = stripBacktrackSpur(coords as [number, number][]);
    out.push({
      coordinates: stripped.coordinates,
      ...(Array.isArray(cams) ? { cameraIds: cams as string[] } : {}),
      ...(typeof p === 'number' ? { exposureP: p } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Worst step = most cameras: enriched cameraIds first, else nearest-step vote. */
function worstStepCoords(best: ScoredRoute): [number, number][] | null {
  const steps = (best.steps ?? []).filter((s) => s.coordinates.length > 0);
  if (steps.length === 0) return best.coordinates.length > 0 ? best.coordinates : null;
  if (steps.some((s) => (s.cameraIds?.length ?? 0) > 0)) {
    let worst = steps[0];
    for (const s of steps) {
      if ((s.cameraIds?.length ?? 0) > (worst.cameraIds?.length ?? 0)) worst = s;
    }
    return worst.coordinates;
  }
  const counts = new Array<number>(steps.length).fill(0);
  for (const e of best.exposures ?? []) {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < steps.length; i++) {
      const d = minDistToPolyline({ lat: e.lat, lon: e.lon }, steps[i].coordinates);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    counts[bi] += 1;
  }
  let bi = 0;
  for (let i = 1; i < counts.length; i++) if (counts[i] > counts[bi]) bi = i;
  return steps[bi].coordinates;
}

function compare(a: RankedRoute, b: RankedRoute): number {
  return a.exposureCount - b.exposureCount || a.distanceM - b.distanceM;
}

export async function searchCleanRoute(
  origin: LatLon,
  destination: LatLon,
  baseScored: ScoredRoute[],
  cameras: Camera[],
  bufferMeters: number,
  fetchRoutes: FetchRoutes,
  // Direction-aware scoring must match the base scoring, or a "clean" detour
  // would be judged by different rules than the routes it competes with.
  opts?: ExposureOpts,
  deadline?: CleanSearchDeadline,
): Promise<CleanRouteResult> {
  let attempts = 0;
  let osrmCalls = 0;
  let rounds = 0;
  let aborted = false;
  const routes: ScoredRoute[] = [...baseScored].sort(compare);
  const done = (): CleanRouteResult => ({
    routes,
    attempts,
    osrmCalls,
    cleanFound: routes.some((r) => r.exposureCount === 0),
    rounds,
    aborted,
  });
  const remainingMs = (): number =>
    deadline ? deadline.deadlineMs - Date.now() : Number.POSITIVE_INFINITY;
  if (routes.length === 0 || routes[0].exposureCount === 0) return done();

  const baseDist = Math.min(...routes.map((r) => r.distanceM));
  const budget = baseDist > 0 ? baseDist * DETOUR_FACTOR : Infinity;
  // Env-tunable (self-hosters with private OSRM can afford more rounds).
  const maxRounds = numEnv("CLEAN_MAX_ROUNDS", MAX_ROUNDS_DEFAULT, 0, MAX_ROUNDS_CAP);
  const viaTimeoutMs = numEnv("CLEAN_VIA_TIMEOUT_MS", VIA_TIMEOUT_DEFAULT_MS, 500, 8000);
  let detourId = 0;

  type Fetched = Awaited<ReturnType<FetchRoutes>>;
  for (let round = 0; round < maxRounds; round++) {
    // Out of wall clock: keep whatever we already have (the caller surfaces
    // `aborted` rather than pretending the search found nothing).
    if (remainingMs() <= 0) {
      aborted = true;
      break;
    }
    const focus = worstStepCoords(routes[0]);
    if (!focus || focus.length === 0) break;
    const radius = ROUND_RADII_M[Math.min(round, ROUND_RADII_M.length - 1)];
    const vias = [stepPerpOffset(focus, radius), stepPerpOffset(focus, -radius)];
    rounds += 1;
    const roundTimeoutMs = Math.max(
      250,
      Math.min(viaTimeoutMs, remainingMs() || viaTimeoutMs),
    );
    const settled: Array<{ ok: boolean; val: Fetched }> = await Promise.all(
      vias.map((via) =>
        withViaTimeout(fetchRoutes(origin, destination, via), roundTimeoutMs).then(
          (val): { ok: boolean; val: Fetched } => ({ ok: true, val }),
          (): { ok: boolean; val: Fetched } => ({ ok: false, val: [] }),
        ),
      ),
    );
    osrmCalls += vias.length;
    const newcomers: Array<RouteInput & { steps?: unknown }> = [];
    const stepsById = new Map<string, CleanStep[]>();
    const fullSteps = new Set<string>();
    for (const s of settled) {
      if (!s.ok) continue;
      for (const raw of s.val) {
        if (!Array.isArray(raw.coordinates) || raw.coordinates.length === 0) continue;
        const id = `clean-r${rounds}-${detourId++}`;
        // Via-spur repair: OSRM drives out-and-back when the via snaps to a
        // dead-end. Splice the stub so the map shows one clean line, and
        // discount the spur length from distance/duration (pro-rata).
        const spur = stripBacktrackSpur(raw.coordinates);
        const rawDist = Number(raw.distanceM) || 0;
        const rawDur = Number(raw.durationS) || 0;
        const fixedDist =
          spur.removedM > 0 && rawDist > 0
            ? Math.max(0, rawDist - spur.removedM)
            : rawDist;
        const fixedDur =
          spur.removedM > 0 && rawDist > 0
            ? (rawDur * fixedDist) / rawDist
            : rawDur;
        const base: RouteInput = {
          id,
          coordinates: spur.coordinates,
          distanceM: fixedDist,
          durationS: fixedDur,
        };
        // Same spur repair inside per-step geometries (turn-by-turn geometry
        // and per-step distances must match the rendered line).
        let fixedSteps: unknown = raw.steps;
        if (Array.isArray(raw.steps)) {
          fixedSteps = (raw.steps as Array<Record<string, unknown>>).map((s) => {
            const sc = s?.coordinates;
            if (!s || typeof s !== 'object' || !Array.isArray(sc) || sc.length === 0)
              return s;
            const stripped = stripBacktrackSpur(sc as [number, number][]);
            if (!(stripped.removedM > 0)) return s;
            const stepLen = routeLenM(sc as [number, number][]);
            const scale = stepLen > 0 ? Math.max(0, (stepLen - stripped.removedM) / stepLen) : 1;
            return {
              ...s,
              coordinates: stripped.coordinates,
              ...(typeof s.distanceM === 'number'
                ? { distanceM: (s.distanceM as number) * scale }
                : {}),
              ...(typeof s.durationS === 'number'
                ? { durationS: (s.durationS as number) * scale }
                : {}),
            };
          });
        }
        // Carry full OSRM steps through scoring so turn-by-turn survives;
        // rankByExposure spreads extras onto its output.
        newcomers.push(
          fixedSteps !== undefined ? { ...base, steps: fixedSteps } : base,
        );
        if (fixedSteps !== undefined) fullSteps.add(id);
        const cs = asCleanSteps(fixedSteps);
        if (cs) stepsById.set(id, cs);
      }
    }
    if (newcomers.length === 0) break;
    const scored = rankByExposure(newcomers, cameras, bufferMeters, opts);
    attempts += scored.length;
    const within = scored.filter((r) => r.distanceM <= budget);
    if (within.length === 0) break;
    for (const r of within) {
      const cs = stepsById.get(r.id);
      routes.push(cs && !fullSteps.has(r.id) ? { ...r, steps: cs } : r);
    }
    routes.sort(compare);
    if (routes[0].exposureCount === 0) break;
  }
  return done();
}
