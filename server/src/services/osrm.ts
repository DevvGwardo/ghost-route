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

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60_000;

const cache = new Map<string, { val: RouteGeom[]; exp: number }>();

function key(o: LatLon, d: LatLon): string {
  return `${o.lat},${o.lon}>${d.lat},${d.lon}:steps=1`;
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
  const k = key(origin, dest) + (via ? `~${via.lat},${via.lon}` : "");
  const hit = cache.get(k);
  if (hit && hit.exp > Date.now()) return hit.val;

  const viaPart = via ? `;${via.lon},${via.lat}` : "";
  const url =
    `${OSRM_BASE}/${origin.lon},${origin.lat}${viaPart};${dest.lon},${dest.lat}` +
    `?overview=full&geometries=geojson&alternatives=3&steps=true`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
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
    cache.set(k, { val: out, exp: Date.now() + CACHE_TTL_MS });
    return out;
  } catch {
    throw new Error("routing-unavailable");
  } finally {
    clearTimeout(t);
  }
}
