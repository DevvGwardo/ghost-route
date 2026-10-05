// One shared geolocation watch for the whole app.
//
// The navigation banner and the map must act on the SAME fix, so the watch
// lives here instead of inside a component. The DOM-free core
// (`geoFixFromPosition`, `startGeoWatch`) is exported so the behavior can be
// tested in the node test environment with a fake geolocation provider.
import { useEffect, useState } from 'react';

/** A normalized GPS fix. `null` = the device did not report that field. */
export interface GeoFix {
  lat: number;
  lon: number;
  /** Compass heading in degrees (0 = north) when the device reports it. */
  heading: number | null;
  speedMps: number | null;
  accuracyM: number | null;
  timestamp: number;
}

/** The subset of `navigator.geolocation` we use (injectable for tests). */
export type GeoProvider = Pick<Geolocation, 'watchPosition' | 'clearWatch'>;

export interface GeoWatchOpts {
  enableHighAccuracy?: boolean;
  maximumAge?: number;
  timeout?: number;
}

export const GEO_WATCH_OPTS: GeoWatchOpts = {
  enableHighAccuracy: true,
  maximumAge: 5000,
  timeout: 15000,
};

function numOrNull(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Normalize a browser position into a GeoFix. Pure. */
export function geoFixFromPosition(pos: GeolocationPosition): GeoFix {
  return {
    lat: pos.coords.latitude,
    lon: pos.coords.longitude,
    heading: numOrNull(pos.coords.heading),
    speedMps: numOrNull(pos.coords.speed),
    accuracyM: numOrNull(pos.coords.accuracy),
    timestamp: typeof pos.timestamp === 'number' ? pos.timestamp : Date.now(),
  };
}

/**
 * Start a watch against any provider. Returns an idempotent disposer that
 * clears the watch and silences any late callback from the stream.
 */
export function startGeoWatch(
  provider: GeoProvider,
  onFix: (fix: GeoFix) => void,
  onError: (message: string) => void,
  opts: GeoWatchOpts = GEO_WATCH_OPTS,
): () => void {
  let active = true;
  const id = provider.watchPosition(
    (pos) => {
      if (active) onFix(geoFixFromPosition(pos));
    },
    () => {
      if (active) onError('Could not get your location.');
    },
    opts,
  );
  return () => {
    active = false;
    provider.clearWatch(id);
  };
}

/**
 * The browser geolocation provider, or null when unavailable. Exported so the
 * availability check is testable against a stubbed `navigator`.
 */
export function getGeoProvider(): GeoProvider | null {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return null;
  return navigator.geolocation;
}

export interface GeoPositionState {
  fix: GeoFix | null;
  error: string | null;
}

/**
 * Shared GPS watch. `enabled=false` stops the watch and clears the fix, so a
 * finished navigation session leaves no background location stream running.
 */
export function useGeoPosition(enabled: boolean): GeoPositionState {
  const [fix, setFix] = useState<GeoFix | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setFix(null);
      setError(null);
      return;
    }
    // Phones opening the dev server over the LAN (http://192.168…) get a
    // silent permission denial: browsers only expose GPS to secure contexts.
    // Say so instead of waiting forever on "Acquiring GPS…".
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      setError('Live location needs HTTPS. Open Ghost Route over https:// to navigate.');
      return;
    }
    const provider = getGeoProvider();
    if (!provider) {
      setError('Geolocation is not available in this browser.');
      return;
    }
    return startGeoWatch(
      provider,
      (f) => {
        setFix(f);
        setError(null);
      },
      (m) => setError(m),
    );
  }, [enabled]);

  return { fix, error };
}
