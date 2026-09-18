export interface LatLon {
  lat: number;
  lon: number;
}

export interface RouteStep {
  instruction: string;
  maneuver: string;
  distanceM: number;
  durationS: number;
  coordinates: [number, number][]; // [lat, lon] order
}

export interface RouteGeom {
  coordinates: [number, number][]; // [lat, lon] order
  distanceM: number;
  durationS: number;
  steps: RouteStep[];
}

import { resolveRoutingBackend } from "../security.js";
import { get as cacheGet, set as cacheSet } from "../cache.js";

function timeoutMs(): number {
  const v = Number(process.env.ROUTING_TIMEOUT_MS);
  if (!Number.isFinite(v)) return 8000;
  return Math.min(30_000, Math.max(1000, Math.floor(v)));
}

function routingCacheTtlMs(): number {
  const v = Number(process.env.ROUTING_CACHE_TTL_MS);
  if (!Number.isFinite(v)) return 60_000;
  return Math.min(600_000, Math.max(10_000, Math.floor(v)));
}

function key(backend: string, o: LatLon, d: LatLon): string {
  return `${backend}|${o.lat},${o.lon}>${d.lat},${d.lon}:steps=1`;
}

function cap(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function buildInstruction(
  type: string,
  modifier: string | undefined,
  name: string,
): string {
  if (type === "arrive") return "Arrive at destination";
  const onto = name ? ` onto ${name}` : "";
  if (modifier) return `${cap(type === "turn" || type === "depart" ? "turn" : type)} ${modifier}${onto}`;
  return name ? `Continue${onto}` : "Continue";
}

interface RawStep {
  maneuver?: { type?: string; modifier?: string };
  name?: string;
  distance?: number;
  duration?: number;
  geometry?: { coordinates?: [number, number][] };
  intersections?: { location?: [number, number] }[];
}

function buildSteps(legs: { steps?: RawStep[] }[] | undefined): RouteStep[] {
  const steps: RouteStep[] = [];
  let prevLast: [number, number] | undefined;
  const raw: RawStep[] = (legs ?? []).flatMap((l) => l.steps ?? []);
  for (const s of raw) {
    const type = s.maneuver?.type ?? "";
    const modifier = s.maneuver?.modifier;
    const name = s.name ?? "";
    let coords: [number, number][] = (s.intersections ?? [])
      .map((i) => i.location)
      .filter(
        (loc): loc is [number, number] =>
          Array.isArray(loc) && loc.length >= 2,
      )
      .map(([lon, lat]): [number, number] => [lat, lon]);
    if (coords.length < 2) {
      const g = s.geometry?.coordinates ?? [];
      if (g.length > 0)
        coords = g.map(([lon, lat]): [number, number] => [lat, lon]);
    }
    if (coords.length === 0 && prevLast) coords = [prevLast];
    if (coords.length > 0) prevLast = coords[coords.length - 1];
    steps.push({
      instruction: buildInstruction(type, modifier, name),
      maneuver: modifier ? `${type} ${modifier}` : type,
      distanceM: s.distance ?? 0,
      durationS: s.duration ?? 0,
      coordinates: coords,
    });
  }
  // Post-pass: a leading step with no geometry borrows the next step's first
  // point so every step carries ≥1 coordinate whenever the route has any.
  if (steps.length > 0 && steps[0].coordinates.length === 0) {
    const donor = steps.find((s) => s.coordinates.length > 0);
    if (donor) steps[0].coordinates = [donor.coordinates[0]];
  }
  return steps;
}

export async function fetchRoutes(
  origin: LatLon,
  dest: LatLon,
  via?: LatLon,
): Promise<RouteGeom[]> {
  const primary = resolveRoutingBackend();
  const k = key(primary.name, origin, dest) + (via ? `~${via.lat},${via.lon}` : "");
  const hit = cacheGet<RouteGeom[]>(k);
  if (hit) return hit;

  try {
    const out = await attempt(primary.origin, origin, dest, via);
    cacheSet(k, out, routingCacheTtlMs());
    return out;
  } catch (e) {
    // One passive fallback to the demo backend when a custom/alt primary
    // is down. Never chains further; demo failure throws through.
    if (primary.name === "demo") throw e;
    const demo = resolveRoutingBackend({ ...process.env, ROUTING_BACKEND: "demo" });
    const out = await attempt(demo.origin, origin, dest, via);
    cacheSet(k, out, routingCacheTtlMs());
    return out;
  }
}

async function attempt(
  base: string,
  origin: LatLon,
  dest: LatLon,
  via?: LatLon,
): Promise<RouteGeom[]> {
  const viaPart = via ? `;${via.lon},${via.lat}` : "";
  const url =
    `${base}/route/v1/driving/${origin.lon},${origin.lat}${viaPart};${dest.lon},${dest.lat}` +
    `?overview=full&geometries=geojson&alternatives=3&steps=true`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs());
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error("routing-unavailable");
    const data = (await res.json()) as {
      routes?: {
        geometry?: { coordinates?: [number, number][] };
        distance?: number;
        duration?: number;
        legs?: { steps?: RawStep[] }[];
      }[];
    };
    if (!data.routes || data.routes.length === 0)
      throw new Error("routing-unavailable");
    const out: RouteGeom[] = data.routes.map((r) => ({
      coordinates: (r.geometry?.coordinates ?? []).map(
        ([lon, lat]): [number, number] => [lat, lon],
      ),
      distanceM: r.distance ?? 0,
      durationS: r.duration ?? 0,
      steps: buildSteps(r.legs),
    }));
    return out;
  } catch {
    throw new Error("routing-unavailable");
  } finally {
    clearTimeout(t);
  }
}
