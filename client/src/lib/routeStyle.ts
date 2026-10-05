// Pure geometry behind the route drawing (no DOM, no maplibre): which routes
// get drawn, where along the selected route the camera zones are, and where
// each route's label chip sits so chips never stack on shared roads.
// All coordinates are [lat, lon], matching the API contract.
import { havM } from './navigate';

/** At most this many alternatives are drawn next to the selected route. */
export const MAX_DRAWN_ALTS = 2;

export interface DrawableRoute {
  id: string;
  coordinates: [number, number][];
}

/**
 * Selected route plus the best-ranked alternatives (routes arrive ranked).
 * Seven overlapping gray lines read as noise; the full list stays in the sheet.
 */
export function pickDrawnRoutes<R extends DrawableRoute>(
  routes: R[],
  selectedId: string | null,
  maxAlts = MAX_DRAWN_ALTS,
): { selected: R | null; alts: R[] } {
  const usable = routes.filter((r) => r.coordinates.length >= 2);
  const selected = usable.find((r) => r.id === selectedId) ?? usable[0] ?? null;
  const alts = usable.filter((r) => r !== selected).slice(0, Math.max(0, maxAlts));
  return { selected, alts };
}

/** Insert points so no segment is longer than `stepM` (keeps originals). */
export function densify(coords: [number, number][], stepM = 20): [number, number][] {
  if (coords.length < 2) return coords.slice();
  const out: [number, number][] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const d = havM(a, b);
    const n = Math.floor(d / stepM);
    for (let k = 1; k <= n; k++) {
      const t = (k * stepM) / d;
      if (t >= 1) break;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    out.push(b);
  }
  return out;
}

/**
 * Stretches of the route inside `radiusM` of any exposed camera, as polylines.
 * These are the "you are seen here" zones painted over the selected route.
 */
export function exposureRuns(
  coords: [number, number][],
  cameras: Array<{ lat: number; lon: number }>,
  radiusM: number,
): [number, number][][] {
  if (coords.length < 2 || cameras.length === 0 || !(radiusM > 0)) return [];
  const pts = densify(coords, Math.max(5, Math.min(20, radiusM / 4)));
  const cams = cameras.map((c) => [c.lat, c.lon] as [number, number]);
  const runs: [number, number][][] = [];
  let cur: [number, number][] | null = null;
  for (const p of pts) {
    let inside = false;
    for (const c of cams) {
      if (havM(p, c) <= radiusM) {
        inside = true;
        break;
      }
    }
    if (inside) {
      if (!cur) cur = [];
      cur.push(p);
    } else if (cur) {
      if (cur.length >= 2) runs.push(cur);
      cur = null;
    }
  }
  if (cur && cur.length >= 2) runs.push(cur);
  return runs;
}

function sample(coords: [number, number][], n: number): [number, number][] {
  if (coords.length <= n) return coords.slice();
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) out.push(coords[Math.round((i * (coords.length - 1)) / (n - 1))]);
  return out;
}

/**
 * One label anchor per route: the point in the middle 60% of the route that
 * is farthest from every other drawn route and from labels already placed.
 * Routes that share a highway still get chips on the part that is their own.
 */
export function labelAnchors(routes: DrawableRoute[]): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  const samples = new Map(routes.map((r) => [r.id, sample(densify(r.coordinates, 50), 240)]));
  const placed: [number, number][] = [];
  for (const r of routes) {
    const own = samples.get(r.id) ?? [];
    if (own.length === 0) continue;
    const lo = Math.floor(own.length * 0.2);
    const hi = Math.max(lo + 1, Math.ceil(own.length * 0.8));
    const candidates = own.slice(lo, hi);
    const others: [number, number][] = [];
    for (const o of routes) if (o.id !== r.id) others.push(...(samples.get(o.id) ?? []));
    let best = candidates[Math.floor(candidates.length / 2)];
    let bestScore = -1;
    for (const c of candidates) {
      let d = Infinity;
      for (const o of others) {
        const m = havM(c, o);
        if (m < d) d = m;
      }
      for (const p of placed) {
        const m = havM(c, p) * 0.5; // labels repel too, at half weight
        if (m < d) d = m;
      }
      // Nothing to avoid (a lone route): keep the midpoint.
      if (Number.isFinite(d) && d > bestScore) {
        bestScore = d;
        best = c;
      }
    }
    out.set(r.id, best);
    placed.push(best);
  }
  return out;
}
