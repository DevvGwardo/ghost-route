// Routing backend resolution + primary/fallback fetch (services/osrm).
// Upstream fetch is ALWAYS stubbed here (no network).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveRoutingBackend } from '../server/src/security';
import { fetchRoutes } from '../server/src/services/osrm';
import { AUSTIN } from './helpers';

const REAL_FETCH = globalThis.fetch;
const SAVED_ENV = { ...process.env };
const DEST = (i: number) => ({ lat: 30.3 + i * 0.01, lon: -97.7 });

beforeEach(() => {
  delete process.env.ROUTING_BACKEND;
  delete process.env.OSRM_BASE;
  delete process.env.ALLOW_LOCAL_ROUTING;
  delete process.env.ROUTING_TIMEOUT_MS;
});
afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  for (const k of ['ROUTING_BACKEND', 'OSRM_BASE', 'ALLOW_LOCAL_ROUTING', 'ROUTING_TIMEOUT_MS']) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

function osrmOk(distanceM = 5000) {
  return new Response(
    JSON.stringify({
      routes: [
        {
          geometry: { coordinates: [[-97.74, 30.26], [-97.75, 30.3]] },
          distance: distanceM,
          duration: 600,
          legs: [{ steps: [] }],
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('resolveRoutingBackend', () => {
  it('defaults to demo with no env', () => {
    expect(resolveRoutingBackend()).toEqual({
      name: 'demo',
      origin: 'https://router.project-osrm.org',
    });
  });

  it('unknown preset fails safe to demo', () => {
    process.env.ROUTING_BACKEND = 'nonsense';
    expect(resolveRoutingBackend().name).toBe('demo');
  });

  it('fosssgis preset', () => {
    process.env.ROUTING_BACKEND = 'fosssgis';
    expect(resolveRoutingBackend()).toEqual({
      name: 'fosssgis',
      origin: 'https://routing.openstreetmap.de',
    });
  });

  it('custom with valid https base (path/query stripped)', () => {
    process.env.ROUTING_BACKEND = 'custom';
    process.env.OSRM_BASE = 'https://routes.example.com/prefix?token=x';
    expect(resolveRoutingBackend()).toEqual({ name: 'custom', origin: 'https://routes.example.com' });
  });

  it.each([['missing base'], ['garbage', '::://'], ['plain http', 'http://routes.example.com'], [
    'credentials',
    'https://user:pass@routes.example.com',
  ], ['metadata IP', 'https://169.254.169.254/x']])(
    'custom with %s falls back to demo',
    (_label, base) => {
      process.env.ROUTING_BACKEND = 'custom';
      if (base !== undefined) process.env.OSRM_BASE = base;
      expect(resolveRoutingBackend().name).toBe('demo');
    },
  );

  it.each([['127.0.0.1'], ['localhost'], ['0.0.0.0'], ['[::1]'], ['[::]']])(
    'loopback %s needs ALLOW_LOCAL_ROUTING=1',
    (host) => {
      process.env.ROUTING_BACKEND = 'custom';
      process.env.OSRM_BASE = `http://${host}:5000`;
      expect(resolveRoutingBackend().name).toBe('demo');
      process.env.ALLOW_LOCAL_ROUTING = '1';
      expect(resolveRoutingBackend().name).toBe('custom');
    },
  );
});

describe('fetchRoutes backend fallback', () => {
  function stubFetch(handler: (url: string) => Response | null) {
    const seen: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      seen.push(u);
      const r = handler(u);
      if (r) return r;
      return new Response('down', { status: 500 });
    }) as typeof fetch;
    return seen;
  }

  it('fosssgis primary down → demo serves (both hosts hit)', async () => {
    process.env.ROUTING_BACKEND = 'fosssgis';
    const seen = stubFetch((u) =>
      u.includes('routing.openstreetmap.de') ? null : u.includes('router.project-osrm.org') ? osrmOk() : null,
    );
    const routes = await fetchRoutes(AUSTIN, DEST(1));
    expect(routes).toHaveLength(1);
    expect(routes[0].distanceM).toBe(5000);
    expect(seen.some((u) => u.includes('routing.openstreetmap.de'))).toBe(true);
    expect(seen.some((u) => u.includes('router.project-osrm.org'))).toBe(true);
  });

  it('demo primary down → throws (no chained fallback)', async () => {
    const seen = stubFetch(() => null);
    await expect(fetchRoutes(AUSTIN, DEST(2))).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('healthy custom primary → demo never hit', async () => {
    process.env.ROUTING_BACKEND = 'custom';
    process.env.OSRM_BASE = 'https://routes.example.com';
    const seen = stubFetch((u) => (u.includes('routes.example.com') ? osrmOk(7000) : null));
    const routes = await fetchRoutes(AUSTIN, DEST(3));
    expect(routes[0].distanceM).toBe(7000);
    expect(seen.every((u) => u.includes('routes.example.com'))).toBe(true);
  });
});
