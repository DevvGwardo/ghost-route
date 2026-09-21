// Shareable route links (spec P1-2).
//
// A route is a URL you can bookmark or message to someone. Everything needed
// to reproduce the plan lives in the hash, so the server never has to store
// anyone's origin/destination (the privacy posture stays intact).
//
// Pure and DOM-free: no window access, so it is directly unit-testable.
import type { LatLon, TravelProfile } from '../../../shared/src/types';

/** Route options that are worth carrying in a link. */
export interface RouteLinkOptions {
  avoidFlock: boolean;
  bufferMeters: number;
  profile: TravelProfile;
  respectDirection: boolean;
  verifiedOnly: boolean;
  brands: string[];
}

export interface RouteLink {
  origin: LatLon;
  destination: LatLon;
  options: Partial<RouteLinkOptions>;
}

export const DEFAULT_LINK_OPTIONS: RouteLinkOptions = {
  avoidFlock: true,
  bufferMeters: 150,
  profile: 'driving',
  respectDirection: true,
  verifiedOnly: false,
  brands: [],
};

const PROFILES: TravelProfile[] = ['driving', 'walking', 'cycling'];
const BUFFER_MIN = 50;
const BUFFER_MAX = 5000;
/** 5 decimals ≈ 1m: enough to reproduce a route without a wall of digits. */
const COORD_DECIMALS = 5;

export function isLatLon(v: unknown): v is LatLon {
  if (typeof v !== 'object' || v === null) return false;
  const { lat, lon } = v as { lat?: unknown; lon?: unknown };
  return (
    typeof lat === 'number' &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    typeof lon === 'number' &&
    Number.isFinite(lon) &&
    lon >= -180 &&
    lon <= 180
  );
}

function trimNum(n: number, decimals: number): string {
  return Number(n.toFixed(decimals)).toString();
}

const fmtCoord = (p: LatLon): string =>
  `${trimNum(p.lat, COORD_DECIMALS)},${trimNum(p.lon, COORD_DECIMALS)}`;

function parseCoord(v: string | undefined): LatLon | null {
  if (typeof v !== 'string') return null;
  const [latRaw, lonRaw, ...rest] = v.split(',');
  if (rest.length > 0 || latRaw === undefined || lonRaw === undefined) return null;
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  const point = { lat, lon };
  return isLatLon(point) ? point : null;
}

/**
 * Serialize a route into a `#...` hash. Only non-default options are written,
 * so the common link stays short and readable.
 */
export function encodeRouteHash(link: RouteLink): string {
  const o = { ...DEFAULT_LINK_OPTIONS, ...link.options };
  const parts = [`r=${fmtCoord(link.origin)}~${fmtCoord(link.destination)}`];
  parts.push(`avoid=${o.avoidFlock ? 1 : 0}`);
  parts.push(`buf=${Math.round(o.bufferMeters)}`);
  parts.push(`prof=${o.profile}`);
  if (!o.respectDirection) parts.push('dir=0');
  if (o.verifiedOnly) parts.push('vd=1');
  if (o.brands.length > 0) {
    parts.push(`brands=${o.brands.map((b) => encodeURIComponent(b)).join('|')}`);
  }
  return `#${parts.join('&')}`;
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return fallback;
}

/** Accepts `#...` or a bare `...` query-ish string. Null when unusable. */
export function decodeRouteHash(hash: string | null | undefined): RouteLink | null {
  if (typeof hash !== 'string') return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;

  const fields = new Map<string, string>();
  for (const chunk of raw.split('&')) {
    if (!chunk) continue;
    const eq = chunk.indexOf('=');
    if (eq <= 0) continue;
    fields.set(chunk.slice(0, eq), chunk.slice(eq + 1));
  }

  const pair = fields.get('r');
  if (!pair) return null;
  const [originRaw, destinationRaw, ...extra] = pair.split('~');
  if (extra.length > 0) return null;
  const origin = parseCoord(originRaw);
  const destination = parseCoord(destinationRaw);
  // A half-specified route is not a route: degrade to the empty state.
  if (!origin || !destination) return null;

  const options: Partial<RouteLinkOptions> = {};
  const avoid = fields.get('avoid');
  if (avoid !== undefined) options.avoidFlock = parseBool(avoid, DEFAULT_LINK_OPTIONS.avoidFlock);

  const buf = Number(fields.get('buf'));
  if (fields.has('buf') && Number.isFinite(buf) && buf > 0) {
    options.bufferMeters = Math.min(BUFFER_MAX, Math.max(BUFFER_MIN, Math.round(buf)));
  }

  const profile = fields.get('prof');
  if (profile !== undefined) {
    if (!PROFILES.includes(profile as TravelProfile)) return null;
    options.profile = profile as TravelProfile;
  }

  const dir = fields.get('dir');
  if (dir !== undefined) options.respectDirection = parseBool(dir, true);

  const vd = fields.get('vd');
  if (vd !== undefined) options.verifiedOnly = parseBool(vd, false);

  const brands = fields.get('brands');
  if (brands !== undefined) {
    const list: string[] = [];
    for (const b of brands.split('|')) {
      try {
        const decoded = decodeURIComponent(b).trim();
        if (decoded && decoded.length <= 100) list.push(decoded);
      } catch {
        // Malformed escape → skip that entry, keep the rest.
      }
    }
    if (list.length > 0) options.brands = list;
  }

  return { origin, destination, options };
}

/** True when the hash carries anything route-shaped (used at boot). */
export function hasRouteHash(hash: string | null | undefined): boolean {
  if (typeof hash !== 'string') return false;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  return raw.split('&').some((c) => c.startsWith('r='));
}
