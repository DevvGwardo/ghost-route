// Browser-side memory: preferences, recent trips, saved places (spec P1-3).
//
// All personal state lives in the browser — nothing about a user's origin or
// destination is ever stored server-side (see PROJECT_BRIEF privacy posture).
//
// Storage is injected as a narrow interface so this module stays DOM-free and
// unit-testable, and every read/write is wrapped: Safari private mode and
// quota errors must never break the app.
import type { LatLon, TravelProfile } from '../../../shared/src/types';
import { DEFAULT_LINK_OPTIONS } from './deeplink';

export interface PrefsStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const PREFS_KEY = 'ghostroute.prefs';
export const RECENT_KEY = 'ghostroute.recent';
export const SAVED_KEY = 'ghostroute.saved';

export const MAX_RECENTS = 10;
export const MAX_SAVED = 50;

export interface Place {
  label: string;
  lat: number;
  lon: number;
}

export interface RecentTrip {
  origin: Place;
  destination: Place;
  at: number;
}

export interface Prefs {
  avoidFlock: boolean;
  bufferMeters: number;
  profile: TravelProfile;
  respectDirection: boolean;
  verifiedOnly: boolean;
  brands: string[];
  /** Voice guidance during navigation (banner toggle). Opt-in, opt-outable. */
  voice: boolean;
}

export const DEFAULT_PREFS: Prefs = { ...DEFAULT_LINK_OPTIONS, voice: false };

const BUFFER_MIN = 50;
const BUFFER_MAX = 5000;
const PROFILES: TravelProfile[] = ['driving', 'walking', 'cycling'];

/** The real localStorage, or null when unavailable (SSR, private mode). */
export function defaultStore(): PrefsStore | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    // Touch it: some private modes throw only on access.
    void localStorage.length;
    return localStorage;
  } catch {
    return null;
  }
}

function readRaw(store: PrefsStore | null, key: string): unknown {
  if (!store) return null;
  try {
    const text = store.getItem(key);
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeRaw(store: PrefsStore | null, key: string, value: unknown): boolean {
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function isFiniteNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function isPlace(v: unknown): v is Place {
  const p = v as Partial<Place> | null;
  return (
    typeof p?.label === 'string' &&
    p.label.length > 0 &&
    p.label.length <= 300 &&
    isFiniteNum(p?.lat) &&
    isFiniteNum(p?.lon) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lon) <= 180
  );
}

function clampBuffer(v: unknown): number | null {
  if (!isFiniteNum(v) || v <= 0) return null;
  return Math.min(BUFFER_MAX, Math.max(BUFFER_MIN, Math.round(v)));
}

function coercePrefs(raw: unknown): Partial<Prefs> {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<Prefs> = {};
  if (typeof r.avoidFlock === 'boolean') out.avoidFlock = r.avoidFlock;
  if (typeof r.respectDirection === 'boolean') out.respectDirection = r.respectDirection;
  if (typeof r.verifiedOnly === 'boolean') out.verifiedOnly = r.verifiedOnly;
  if (typeof r.voice === 'boolean') out.voice = r.voice;
  const buf = clampBuffer(r.bufferMeters);
  if (buf !== null) out.bufferMeters = buf;
  if (typeof r.profile === 'string' && PROFILES.includes(r.profile as TravelProfile)) {
    out.profile = r.profile as TravelProfile;
  }
  if (Array.isArray(r.brands)) {
    out.brands = r.brands
      .filter((b): b is string => typeof b === 'string' && b.length > 0 && b.length <= 100)
      .slice(0, 20);
  }
  return out;
}

/** Stored preferences merged over the defaults. Never throws. */
export function loadPrefs(store: PrefsStore | null = defaultStore()): Prefs {
  return { ...DEFAULT_PREFS, ...coercePrefs(readRaw(store, PREFS_KEY)) };
}

export function savePrefs(prefs: Prefs, store: PrefsStore | null = defaultStore()): boolean {
  return writeRaw(store, PREFS_KEY, coercePrefs(prefs));
}

export function loadRecents(store: PrefsStore | null = defaultStore()): RecentTrip[] {
  const raw = readRaw(store, RECENT_KEY);
  if (!Array.isArray(raw)) return [];
  const out: RecentTrip[] = [];
  for (const entry of raw) {
    const e = entry as Partial<RecentTrip> | null;
    if (!e || !isPlace(e.origin) || !isPlace(e.destination)) continue;
    out.push({
      origin: e.origin,
      destination: e.destination,
      at: isFiniteNum(e.at) ? e.at : 0,
    });
    if (out.length >= MAX_RECENTS) break;
  }
  return out;
}

const placeKey = (p: Place): string =>
  `${p.label.toLowerCase()}|${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;

/**
 * Records a trip, newest first, de-duplicated by route (same origin AND
 * destination) so repeating a daily drive doesn't flood the list.
 */
export function addRecent(
  trip: Omit<RecentTrip, 'at'> & { at?: number },
  store: PrefsStore | null = defaultStore(),
): RecentTrip[] {
  const at = isFiniteNum(trip.at) ? trip.at : Date.now();
  const next: RecentTrip[] = [
    { origin: trip.origin, destination: trip.destination, at },
    ...loadRecents(store).filter(
      (t) => !(placeKey(t.origin) === placeKey(trip.origin) && placeKey(t.destination) === placeKey(trip.destination)),
    ),
  ].slice(0, MAX_RECENTS);
  writeRaw(store, RECENT_KEY, next);
  return next;
}

export function clearRecents(store: PrefsStore | null = defaultStore()): void {
  try {
    store?.removeItem(RECENT_KEY);
  } catch {
    /* nothing to clear */
  }
}

export function loadSaved(store: PrefsStore | null = defaultStore()): Place[] {
  const raw = readRaw(store, SAVED_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPlace).slice(0, MAX_SAVED);
}

export function isSaved(place: Place, store: PrefsStore | null = defaultStore()): boolean {
  const key = placeKey(place);
  return loadSaved(store).some((p) => placeKey(p) === key);
}

/** Star/unstar a place. Returns the new saved list. */
export function toggleSaved(
  place: Place,
  store: PrefsStore | null = defaultStore(),
): Place[] {
  const key = placeKey(place);
  const current = loadSaved(store);
  const without = current.filter((p) => placeKey(p) !== key);
  // Label-only match too: re-starring the same place from a different
  // coordinate string should not create a duplicate row.
  const next = without.length === current.length ? [place, ...current] : without;
  const capped = next.slice(0, MAX_SAVED);
  writeRaw(store, SAVED_KEY, capped);
  return capped;
}

/** A tiny in-memory store for tests and for browsers with storage disabled. */
export function createMemoryStore(seed: Record<string, string> = {}): PrefsStore {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

/** Convenience: the current trip's endpoints as Places, when labelled. */
export function toPlace(label: string, point: LatLon): Place {
  return { label, lat: point.lat, lon: point.lon };
}
