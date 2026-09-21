// Navigation follow mode (gap G1): off-route detection and the shared
// geolocation watch. Both are DOM-free, so they run in the node environment.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createOffRouteTracker,
  distToRoute,
  OFF_ROUTE_FIXES,
  OFF_ROUTE_M,
} from '../client/src/lib/navigate';
import {
  GEO_WATCH_OPTS,
  geoFixFromPosition,
  getGeoProvider,
  startGeoWatch,
  type GeoFix,
  type GeoProvider,
} from '../client/src/lib/useGeoPosition';

// Northbound segment at lon -97.7. At lat 30.3, 0.001° lon ≈ 96m.
const LINE: [number, number][] = [
  [30.3, -97.7],
  [30.31, -97.7],
];

function makePosition(
  lat: number,
  lon: number,
  over: Partial<GeolocationCoordinates> = {},
  timestamp = 1234,
): GeolocationPosition {
  return {
    coords: {
      latitude: lat,
      longitude: lon,
      accuracy: 8,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      ...over,
    } as GeolocationCoordinates,
    timestamp,
  } as GeolocationPosition;
}

/** Fake geolocation provider that captures the watch callbacks. */
function fakeProvider() {
  let onFix: ((p: GeolocationPosition) => void) | null = null;
  let onErr: ((e: unknown) => void) | null = null;
  const cleared: number[] = [];
  const watchCalls: { id: number; opts?: PositionOptions }[] = [];
  let nextId = 1;
  const provider: GeoProvider = {
    watchPosition: ((f: (p: GeolocationPosition) => void, e?: unknown, o?: PositionOptions) => {
      onFix = f;
      onErr = (e as (err: unknown) => void) ?? null;
      const id = nextId++;
      watchCalls.push({ id, opts: o });
      return id;
    }) as unknown as Geolocation['watchPosition'],
    clearWatch: ((id: number) => {
      cleared.push(id);
    }) as Geolocation['clearWatch'],
  };
  return {
    provider,
    cleared,
    watchCalls,
    fire: (p: GeolocationPosition) => onFix?.(p),
    fail: () => onErr?.(new Error('denied')),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('distToRoute', () => {
  it('is ~0 for a point on the polyline and >80m for a parallel street', () => {
    expect(distToRoute(LINE, [30.305, -97.7])).toBeLessThan(1);
    const off = distToRoute(LINE, [30.305, -97.699]);
    expect(off).toBeGreaterThan(OFF_ROUTE_M);
    expect(off).toBeLessThan(120);
  });

  it('is infinite for an empty route (never a false off-route)', () => {
    expect(distToRoute([], [30.3, -97.7])).toBe(Infinity);
  });
});

describe('createOffRouteTracker', () => {
  it('needs consecutive misses before declaring off-route', () => {
    const t = createOffRouteTracker();
    expect(OFF_ROUTE_FIXES).toBe(3);
    expect(t.update(200).offRoute).toBe(false);
    expect(t.update(200).offRoute).toBe(false);
    expect(t.update(200).offRoute).toBe(true);
  });

  it('a single good fix resets the counter (GPS hiccups never reroute)', () => {
    const t = createOffRouteTracker();
    t.update(200);
    t.update(200);
    expect(t.update(5).misses).toBe(0); // back on route
    expect(t.update(200).offRoute).toBe(false);
    expect(t.update(200).offRoute).toBe(false);
    expect(t.update(200).offRoute).toBe(true);
  });

  it('stays off-route while misses keep accumulating', () => {
    const t = createOffRouteTracker();
    for (let i = 0; i < 3; i++) t.update(500);
    expect(t.update(500).offRoute).toBe(true);
    expect(t.update(500).misses).toBe(5);
  });

  it('treats the threshold as inclusive', () => {
    const t = createOffRouteTracker({ maxM: 80, consecutive: 1 });
    expect(t.update(80).offRoute).toBe(false);
    expect(t.update(80.1).offRoute).toBe(true);
  });

  it('honors custom maxM and consecutive', () => {
    const t = createOffRouteTracker({ maxM: 40, consecutive: 2 });
    expect(t.update(50).offRoute).toBe(false);
    expect(t.update(50).offRoute).toBe(true);
  });

  it('ignores non-finite distances (degenerate geometry)', () => {
    const t = createOffRouteTracker({ consecutive: 1 });
    expect(t.update(Number.POSITIVE_INFINITY).offRoute).toBe(false);
    expect(t.update(Number.NaN).offRoute).toBe(false);
    expect(t.misses).toBe(0);
  });

  it('reset() clears accumulated misses', () => {
    const t = createOffRouteTracker();
    t.update(300);
    t.update(300);
    t.reset();
    expect(t.misses).toBe(0);
    expect(t.update(300).offRoute).toBe(false);
  });

  it('expresses the default 80m off-route window', () => {
    const t = createOffRouteTracker({ consecutive: 1 });
    expect(OFF_ROUTE_M).toBe(80);
    expect(t.update(79).offRoute).toBe(false);
    expect(t.update(81).offRoute).toBe(true);
  });
});

describe('geoFixFromPosition', () => {
  it('normalizes a full position', () => {
    const fix = geoFixFromPosition(
      makePosition(30.3, -97.7, { heading: 91.5, speed: 12.25, accuracy: 4 }, 999),
    );
    expect(fix).toEqual({
      lat: 30.3,
      lon: -97.7,
      heading: 91.5,
      speedMps: 12.25,
      accuracyM: 4,
      timestamp: 999,
    });
  });

  it('maps unavailable heading/speed to null (browsers report NaN or null)', () => {
    const fix = geoFixFromPosition(
      makePosition(30.3, -97.7, { heading: Number.NaN, speed: null as unknown as number }),
    );
    expect(fix.heading).toBeNull();
    expect(fix.speedMps).toBeNull();
  });

  it('falls back to Date.now() when the timestamp is missing', () => {
    const before = Date.now();
    // Some providers omit `timestamp` entirely.
    const pos = { coords: makePosition(30.3, -97.7).coords } as GeolocationPosition;
    const fix = geoFixFromPosition(pos);
    expect(fix.timestamp).toBeGreaterThanOrEqual(before);
  });
});

describe('startGeoWatch (mocked geolocation provider)', () => {
  it('watches with high-accuracy options and streams normalized fixes', () => {
    const fake = fakeProvider();
    const fixes: GeoFix[] = [];
    startGeoWatch(fake.provider, (f) => fixes.push(f), () => {});
    expect(fake.watchCalls).toHaveLength(1);
    expect(fake.watchCalls[0].opts).toEqual(GEO_WATCH_OPTS);
    expect(GEO_WATCH_OPTS.enableHighAccuracy).toBe(true);

    fake.fire(makePosition(30.3, -97.7, { heading: 180 }));
    expect(fixes).toHaveLength(1);
    expect(fixes[0].lat).toBe(30.3);
    expect(fixes[0].heading).toBe(180);
  });

  it('disposer clears the exact watch id and is idempotent', () => {
    const fake = fakeProvider();
    const dispose = startGeoWatch(fake.provider, () => {}, () => {});
    dispose();
    dispose();
    expect(fake.cleared).toEqual([1, 1]);
  });

  it('drops late fixes that arrive after disposal', () => {
    const fake = fakeProvider();
    const fixes: GeoFix[] = [];
    const dispose = startGeoWatch(fake.provider, (f) => fixes.push(f), () => {});
    dispose();
    fake.fire(makePosition(30.3, -97.7));
    expect(fixes).toEqual([]);
  });

  it('surfaces a permission/position failure as a message, and silences it after disposal', () => {
    const fake = fakeProvider();
    const errors: string[] = [];
    const dispose = startGeoWatch(fake.provider, () => {}, (m) => errors.push(m));
    fake.fail();
    expect(errors).toEqual(['Could not get your location.']);
    dispose();
    fake.fail();
    expect(errors).toHaveLength(1);
  });
});

describe('getGeoProvider (mocked navigator.geolocation)', () => {
  it('returns the live navigator.geolocation when present', () => {
    const fakeGeo = { watchPosition: () => 7, clearWatch: () => {} };
    vi.stubGlobal('navigator', { geolocation: fakeGeo });
    expect(getGeoProvider()).toBe(fakeGeo);
  });

  it('returns null when geolocation is unavailable or absent', () => {
    vi.stubGlobal('navigator', {});
    expect(getGeoProvider()).toBeNull();
    vi.stubGlobal('navigator', undefined);
    expect(getGeoProvider()).toBeNull();
  });
});
