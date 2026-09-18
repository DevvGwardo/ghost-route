export interface Place {
  label: string;
  sublabel: string;
  lat: number;
  lon: number;
}

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 100;

const cache = new Map<string, { places: Place[]; exp: number }>();

function cacheGet(key: string): Place[] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    cache.delete(key);
    return null;
  }
  return hit.places;
}

function cacheSet(key: string, places: Place[]): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { places, exp: Date.now() + TTL_MS });
}

interface PhotonFeature {
  geometry?: { coordinates?: unknown };
  properties?: {
    name?: unknown;
    city?: unknown;
    county?: unknown;
    state?: unknown;
    country?: unknown;
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

// "42.7416,-82.9460" or "42.7416 -82.9460" → exact Place, no network.
// Returns null for anything that isn't two in-range numbers.
function parseCoords(key: string): Place | null {
  const m = /^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/.exec(key);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { label: `${lat}, ${lon}`, sublabel: 'Coordinates', lat, lon };
}

function parsePhoton(json: unknown): Place[] | null {
  if (typeof json !== 'object' || json === null) return null;
  const features = (json as { features?: unknown }).features;
  if (!Array.isArray(features)) return null;
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    const feat = f as PhotonFeature;
    const label = str(feat.properties?.name);
    const coords = feat.geometry?.coordinates;
    const lon = Array.isArray(coords) ? Number(coords[0]) : NaN;
    const lat = Array.isArray(coords) ? Number(coords[1]) : NaN;
    if (!label || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // Upstream sometimes returns the same place twice (e.g. shop + amenity
    // tags at identical coords). Dedupe keeps the first (best-ranked) row.
    const dup = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (seen.has(dup)) continue;
    seen.add(dup);
    const sublabel = [feat.properties?.city, feat.properties?.county, feat.properties?.state, feat.properties?.country]
      .map(str)
      .filter(Boolean)
      .join(', ');
    out.push({ label, sublabel, lat, lon });
  }
  return out;
}

interface NominatimRow {
  lat?: unknown;
  lon?: unknown;
  display_name?: unknown;
}

function parseNominatim(json: unknown): Place[] | null {
  if (!Array.isArray(json)) return null;
  const out: Place[] = [];
  for (const r of json) {
    const row = r as NominatimRow;
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    const name = str(row.display_name);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const parts = name.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) continue;
    out.push({ label: parts[0], sublabel: parts.slice(1, 4).join(', '), lat, lon });
  }
  return out;
}

async function fromPhoton(q: string): Promise<Place[] | null> {
  const res = await fetch(`https://photon.komoot.io/api?q=${encodeURIComponent(q)}&limit=5`);
  if (!res.ok) return null;
  try {
    return parsePhoton(await res.json());
  } catch {
    return null;
  }
}

async function fromNominatim(q: string): Promise<Place[]> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`,
    );
    if (!res.ok) return [];
    return parseNominatim(await res.json()) ?? [];
  } catch {
    return [];
  }
}

export async function searchPlaces(query: string): Promise<Place[]> {
  const raw = query.trim();
  if (!raw) return [];
  // Raw "lat,lon" input needs no geocoder: exact coords beat any index.
  // (Photon /api returns nothing for these; nothing calls /reverse.)
  const coords = parseCoords(raw);
  if (coords) return [coords];
  // Normalize so "Austin", "austin " and "Aus  tin" share one cache entry
  // (Photon is case/whitespace-insensitive).
  const key = raw.replace(/\s+/g, ' ').toLowerCase();
  const hit = cacheGet(key);
  if (hit) return hit;
  try {
    const primary = await fromPhoton(key);
    // Empty counts as miss too: a valid query with zero Photon hits still
    // deserves the Nominatim fallback (different index, different recall).
    if (primary !== null && primary.length > 0) {
      cacheSet(key, primary);
      return primary;
    }
  } catch {
    // Network-level Photon failure → fall through to Nominatim below.
  }
  const fallback = await fromNominatim(key); // never throws
  // Don't negative-cache misses: an empty result cached for 5 minutes would
  // delay recovery when the upstream recovers seconds later.
  if (fallback.length > 0) cacheSet(key, fallback);
  return fallback;
}
