export interface LatLon {
  lat: number;
  lon: number;
}

export type ManeuverKind =
  | "left"
  | "right"
  | "straight"
  | "roundabout"
  | "depart"
  | "arrive"
  | "uturn"
  | "merge"
  | "exit"
  | "other";

export interface RouteStep {
  instruction: string;
  maneuver: string;
  distanceM: number;
  durationS: number;
  coordinates: [number, number][]; // [lat, lon] order
  roadName?: string;
  maneuverKind?: ManeuverKind;
}

export interface RouteGeom {
  coordinates: [number, number][]; // [lat, lon] order
  distanceM: number;
  durationS: number;
  steps: RouteStep[];
}

import { resolveRoutingBackend, type TravelProfile } from "../security.js";
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

/** Cache key MUST include the profile: the same endpoints differ per mode. */
function key(
  backend: string,
  o: LatLon,
  d: LatLon,
  via: LatLon | undefined,
  profile: TravelProfile,
): string {
  return `${backend}|${profile}|${o.lat},${o.lon}>${d.lat},${d.lon}:steps=1${
    via ? `~${via.lat},${via.lon}` : ""
  }`;
}

function cap(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function num(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

export function buildInstruction(
  type: string,
  modifier: string | undefined,
  name: string,
  ref?: string,
  destinations?: string,
): string {
  const target = ref || name;
  const suffix = target
    ? ` onto ${target}`
    : destinations
      ? ` toward ${destinations}`
      : "";
  if (type === "arrive") {
    let out = "Arrive at destination";
    if (target) out += ` onto ${target}`;
    if (modifier === "left" || modifier === "right") out += ` on the ${modifier}`;
    return out;
  }
  if (type === "depart") {
    if (modifier) return `Head ${modifier}${suffix}`;
    return `Head${suffix}`;
  }
  if (
    type === "roundabout" ||
    type === "rotary" ||
    type === "exit roundabout" ||
    type === "exit rotary" ||
    type === "roundabout turn"
  ) {
    return `Enter roundabout${suffix}`;
  }
  if (type === "on ramp" || type === "off ramp") {
    return `Take the ${type}${modifier ? ` ${modifier}` : ""}${suffix}`;
  }
  if (type === "end of road") {
    if (modifier) return `At end of road, turn ${modifier}${suffix}`;
    return `End of road${suffix}`;
  }
  if (type === "merge" || type === "fork") {
    if (modifier) return `${cap(type)} ${modifier}${suffix}`;
    return `${cap(type)}${suffix}`;
  }
  const t = type === "new name" ? "continue" : type;
  const word = t === "" ? "Continue" : t === "turn" ? "Turn" : cap(t);
  if (modifier) return `${word} ${modifier}${suffix}`;
  return `Continue${suffix}`;
}

interface RawStep {
  maneuver?: { type?: string; modifier?: string };
  name?: string;
  ref?: string;
  destinations?: string;
  distance?: number;
  duration?: number;
  geometry?: { coordinates?: [number, number][] };
  intersections?: { location?: [number, number] }[];
}

// Stable kind for client icon matching (free-string maneuver is fragile
// against OSRM wording). Returns undefined only when type+modifier are
// both empty — caller omits the field rather than synthesizing.
export function toManeuverKind(type: string, modifier?: string): ManeuverKind | undefined {
  if (type === "arrive") return "arrive";
  if (type === "depart") return "depart";
  if (/(roundabout|rotary)/.test(type)) return "roundabout";
  if (type === "merge" || type === "fork") return "merge";
  if (/ramp/.test(type) || type.startsWith("exit")) return "exit";
  const m = modifier ?? "";
  if (/u-?turn/.test(m)) return "uturn";
  if (/left/.test(m)) return "left";
  if (/right/.test(m)) return "right";
  if (type !== "" || m !== "") return "straight";
  return undefined;
}

export function buildSteps(legs: { steps?: RawStep[] }[] | undefined): RouteStep[] {
  const steps: RouteStep[] = [];
  const raw: RawStep[] = (legs ?? []).flatMap((l) => l.steps ?? []);
  for (const s of raw) {
    const type = s.maneuver?.type ?? "";
    const modifier = s.maneuver?.modifier;
    const name = s.name ?? "";
    let coords: [number, number][] = (s.geometry?.coordinates ?? [])
      .filter(
        (loc): loc is [number, number] =>
          Array.isArray(loc) &&
          loc.length >= 2 &&
          Number.isFinite(loc[0]) &&
          Number.isFinite(loc[1]),
      )
      .map(([lon, lat]): [number, number] => [lat, lon]);
    if (coords.length === 0) {
      coords = (s.intersections ?? [])
        .map((i) => i.location)
        .filter(
          (loc): loc is [number, number] =>
            Array.isArray(loc) &&
            loc.length >= 2 &&
            Number.isFinite(loc[0]) &&
            Number.isFinite(loc[1]),
        )
        .map(([lon, lat]): [number, number] => [lat, lon]);
    }
    const roadName = s.ref || name || undefined;
    const maneuverKind = toManeuverKind(type, modifier);
    steps.push({
      instruction: buildInstruction(type, modifier, name, s.ref, s.destinations),
      maneuver: modifier ? `${type} ${modifier}` : type,
      distanceM: num(s.distance),
      durationS: num(s.duration),
      coordinates: coords,
      ...(roadName ? { roadName } : {}),
      ...(maneuverKind ? { maneuverKind } : {}),
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

/** Driving-profile fetch. Kept for callers that predate travel profiles. */
export async function fetchRoutes(
  origin: LatLon,
  dest: LatLon,
  via?: LatLon,
): Promise<RouteGeom[]> {
  return fetchProfile(origin, dest, via, "driving");
}

export interface RoutingAttempt {
  routes: RouteGeom[];
  /** Profile that actually produced these routes. */
  profile: TravelProfile;
  /** True when a non-driving profile was requested but driving was used. */
  degraded: boolean;
}

/**
 * Profile-aware fetch (additive v1.2). A backend that does not serve the
 * requested profile (the public demo instance has no cycling graph, some
 * self-hosted OSRM builds are car-only) falls back to driving rather than
 * failing: the caller reports `degraded` so the UI can say so explicitly.
 */
export async function fetchRoutesFor(
  origin: LatLon,
  dest: LatLon,
  via?: LatLon,
  profile: TravelProfile = "driving",
): Promise<RoutingAttempt> {
  if (profile === "driving") {
    return { routes: await fetchProfile(origin, dest, via, "driving"), profile: "driving", degraded: false };
  }
  try {
    return { routes: await fetchProfile(origin, dest, via, profile), profile, degraded: false };
  } catch {
    return {
      routes: await fetchProfile(origin, dest, via, "driving"),
      profile: "driving",
      degraded: true,
    };
  }
}

async function fetchProfile(
  origin: LatLon,
  dest: LatLon,
  via: LatLon | undefined,
  profile: TravelProfile,
): Promise<RouteGeom[]> {
  const primary = resolveRoutingBackend(process.env, profile);
  const k = key(primary.name, origin, dest, via, profile);
  const hit = cacheGet<RouteGeom[]>(k);
  if (hit) return hit;

  try {
    const out = await attempt(primary.origin, primary.routePath, origin, dest, via);
    cacheSet(k, out, routingCacheTtlMs());
    return out;
  } catch (e) {
    // One passive fallback to the demo backend when a custom/alt primary
    // is down. Never chains further; demo failure throws through.
    if (primary.name === "demo") throw e;
    const demo = resolveRoutingBackend({ ...process.env, ROUTING_BACKEND: "demo" }, profile);
    const out = await attempt(demo.origin, demo.routePath, origin, dest, via);
    cacheSet(k, out, routingCacheTtlMs());
    return out;
  }
}

async function attempt(
  base: string,
  routePath: string,
  origin: LatLon,
  dest: LatLon,
  via?: LatLon,
): Promise<RouteGeom[]> {
  const viaPart = via ? `;${via.lon},${via.lat}` : "";
  const url =
    `${base}${routePath}/${origin.lon},${origin.lat}${viaPart};${dest.lon},${dest.lat}` +
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
      distanceM: num(r.distance),
      durationS: num(r.duration),
      steps: buildSteps(r.legs),
    }));
    return out;
  } catch {
    throw new Error("routing-unavailable");
  } finally {
    clearTimeout(t);
  }
}
