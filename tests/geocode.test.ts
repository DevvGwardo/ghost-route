import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Place } from '../client/src/lib/geocode';

// lib/geocode.ts lands from the api agent in parallel. Type-only import is
// erased at runtime, and the value is loaded dynamically, so this file is
// correct either way: if the module is absent the suite skips (PENDING).
const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const HAS_GEOCODE = existsSync(path.resolve(TESTS_DIR, '../client/src/lib/geocode.ts'));

const REAL_FETCH = globalThis.fetch;
let searchPlaces: (query: string) => Promise<Place[]>;

beforeAll(async () => {
  if (HAS_GEOCODE) ({ searchPlaces } = await import('../client/src/lib/geocode'));
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  let calls = 0;
  const urls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    calls++;
    urls.push(String(url));
    return handler(String(url));
  }) as typeof fetch;
  return { count: () => calls, urls: () => [...urls] };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const isPhoton = (u: string) => u.includes('photon');
const isNominatim = (u: string) => u.includes('nominatim');

const PHOTON_FIXTURE = {
  features: [
    {
      properties: { name: 'Texas State Capitol', city: 'Austin', state: 'Texas', country: 'USA' },
      geometry: { coordinates: [-97.7431, 30.2672] },
    },
    {
      properties: { name: 'Zilker Park', country: 'USA' },
      geometry: { coordinates: [-97.7713, 30.2669] },
    },
    // Dropped: nameless feature.
    {
      properties: { city: 'Austin', state: 'Texas', country: 'USA' },
      geometry: { coordinates: [-97.7, 30.3] },
    },
    // Dropped: named but coords-less.
    {
      properties: { name: 'Nowhere', city: 'Austin', country: 'USA' },
      geometry: null,
    },
  ],
};

describe.skipIf(!HAS_GEOCODE)('geocode searchPlaces (photon → nominatim fallback)', () => {
  it('maps Photon features → Place[] (label, joined sublabel, [lon,lat]; drops bad rows)', async () => {
    const stub = stubFetch((u) => (isPhoton(u) ? json(PHOTON_FIXTURE) : json({}, 500)));
    const places = await searchPlaces('photon-map-probe-austin');
    expect(stub.count()).toBe(1);
    expect(stub.urls().some(isNominatim)).toBe(false);
    expect(places).toHaveLength(2);
    expect(places[0].label).toBe('Texas State Capitol');
    expect(places[0].sublabel).toContain('Austin');
    expect(places[0].sublabel).toContain('Texas');
    expect(places[0].sublabel).toContain('USA');
    expect(places[0].sublabel).not.toContain('undefined');
    expect(places[0].lat).toBe(30.2672);
    expect(places[0].lon).toBe(-97.7431);
    expect(places[1].label).toBe('Zilker Park');
    expect(places[1].lat).toBe(30.2669);
    expect(places[1].lon).toBe(-97.7713);
  });

  it('Photon 500 → Nominatim fallback (label=first segment, sublabel=next ≤3)', async () => {
    const stub = stubFetch((u) => {
      if (isPhoton(u)) return json({ error: 'upstream' }, 500);
      if (isNominatim(u))
        return json([
          {
            display_name: 'Capitol, Congress Ave, Austin, Travis County, Texas, USA',
            lat: '30.2746',
            lon: '-97.7403',
          },
        ]);
      throw new Error(`unexpected fetch: ${u}`);
    });
    const places = await searchPlaces('fallback-probe-capitol');
    expect(stub.urls().some(isPhoton)).toBe(true);
    expect(stub.urls().some(isNominatim)).toBe(true);
    expect(places).toHaveLength(1);
    expect(places[0].label).toBe('Capitol');
    expect(places[0].sublabel).toBe('Congress Ave, Austin, Travis County');
    expect(places[0].lat).toBe(30.2746);
    expect(places[0].lon).toBe(-97.7403);
  });

  // Photon transport failure still deserves the fallback: the two upstreams
  // fail independently, and only both-down resolves to [] (never throws).
  it('Photon throws → Nominatim fallback attempted and served', async () => {
    const stub = stubFetch((u) => {
      if (isPhoton(u)) throw new Error('network down');
      if (isNominatim(u))
        return json([
          {
            display_name: 'Capitol, Congress Ave, Austin, Travis County, Texas, USA',
            lat: '30.2746',
            lon: '-97.7403',
          },
        ]);
      throw new Error(`unexpected fetch: ${u}`);
    });
    const places = await searchPlaces('throw-fallback-probe');
    expect(stub.urls().some(isPhoton)).toBe(true);
    expect(stub.urls().some(isNominatim)).toBe(true);
    expect(places).toHaveLength(1);
    expect(places[0].label).toBe('Capitol');
  });

  it('both upstreams down → [] (never throws)', async () => {
    const stub = stubFetch((u) => {
      if (isPhoton(u)) throw new Error('network down');
      return json({}, 500);
    });
    await expect(searchPlaces('both-down-probe')).resolves.toEqual([]);
    expect(stub.urls().some(isPhoton)).toBe(true);
    expect(stub.urls().some(isNominatim)).toBe(true);
  });

  it('Photon valid-but-empty → Nominatim fallback (different index, different recall)', async () => {
    const stub = stubFetch((u) => {
      if (isPhoton(u)) return json({ features: [] });
      if (isNominatim(u))
        return json([{ display_name: 'Somewhere, Earth', lat: '0', lon: '0' }]);
      throw new Error(`unexpected fetch: ${u}`);
    });
    const places = await searchPlaces('empty-recall-probe');
    expect(places).toHaveLength(1);
    expect(places[0].label).toBe('Somewhere');
  });

  it('raw "lat,lon" → exact Place with ZERO fetch calls', async () => {
    const stub = stubFetch(() => json(PHOTON_FIXTURE));
    const places = await searchPlaces('42.7416,-82.9460');
    expect(stub.count()).toBe(0);
    expect(places).toEqual([{ label: '42.7416, -82.946', sublabel: 'Coordinates', lat: 42.7416, lon: -82.946 }]);
    const spaced = await searchPlaces('42.7416 -82.9460');
    expect(spaced).toHaveLength(1);
    expect(spaced[0].lat).toBe(42.7416);
    // Out-of-range pairs are text queries, not coords (network path taken).
    const bad = await searchPlaces('999,999');
    expect(stub.count()).toBeGreaterThan(0);
    expect(bad).toHaveLength(2);
  });

  it('Photon dup coords (shop+amenity tags) → deduped, first wins', async () => {
    const stub = stubFetch((u) =>
      isPhoton(u)
        ? json({
            features: [
              {
                properties: { name: 'Downtown Shop', city: 'Austin', country: 'USA' },
                geometry: { coordinates: [-97.7431, 30.2672] },
              },
              {
                properties: { name: 'Downtown Amenity', city: 'Austin', country: 'USA' },
                geometry: { coordinates: [-97.7431, 30.2672] },
              },
            ],
          })
        : json({}, 500),
    );
    const places = await searchPlaces('dedupe-probe');
    expect(stub.count()).toBe(1);
    expect(places).toHaveLength(1);
    expect(places[0].label).toBe('Downtown Shop');
  });

  it('empty/blank query → [] with ZERO fetch calls', async () => {
    const stub = stubFetch(() => json(PHOTON_FIXTURE));
    await expect(searchPlaces('')).resolves.toEqual([]);
    await expect(searchPlaces('   ')).resolves.toEqual([]);
    expect(stub.count()).toBe(0);
  });

  it('cache: same query twice → 1 fetch call', async () => {
    const stub = stubFetch((u) => (isPhoton(u) ? json(PHOTON_FIXTURE) : json({}, 500)));
    const q = 'cache-probe-zilker';
    const first = await searchPlaces(q);
    const second = await searchPlaces(q);
    expect(stub.count()).toBe(1);
    expect(second).toEqual(first);
  });

  it('cache key normalized: case/whitespace variants share one entry', async () => {
    const stub = stubFetch((u) => (isPhoton(u) ? json(PHOTON_FIXTURE) : json({}, 500)));
    const first = await searchPlaces('Cache Norm Probe');
    const second = await searchPlaces('cache norm probe');
    const third = await searchPlaces('  cache   norm   probe  ');
    expect(stub.count()).toBe(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});
