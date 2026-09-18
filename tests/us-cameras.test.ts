import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, fetchJson } from './helpers';

let base = '';
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  const { app } = await import('../server/src/index');
  expect(app, 'server/src/index.ts must export `app`').toBeDefined();
  ({ base, close } = await startServer(app));
});

afterAll(async () => {
  await close?.();
});

// Continental-US bbox: minLon,minLat,maxLon,maxLat
const US_BBOX = '-125,25,-66,49';
// Open-ocean bbox (Gulf of Guinea): no seed cameras live here.
const OCEAN_BBOX = '0,0,1,1';

describe('us-cameras', () => {
  it('US-wide bbox returns 200 with a cameras array (no crash)', async () => {
    const { res, body } = await fetchJson(base, `/api/cameras?bbox=${US_BBOX}&limit=500`);
    expect(res.status).toBe(200);
    const cameras = (body as { cameras: unknown[] }).cameras;
    expect(Array.isArray(cameras)).toBe(true);
  });

  it('US-wide bbox result is a subset of the full seed', async () => {
    const us = await fetchJson(base, `/api/cameras?bbox=${US_BBOX}&limit=5000`);
    const world = await fetchJson(base, '/api/cameras?bbox=-180,-90,180,90&limit=5000');
    expect(us.res.status).toBe(200);
    expect(world.res.status).toBe(200);
    const usCams = (us.body as { cameras: Array<{ lat: number; lon: number }> }).cameras;
    const worldCams = (world.body as { cameras: unknown[] }).cameras;
    expect(usCams.length).toBeLessThanOrEqual(worldCams.length);
    expect(usCams.length).toBeGreaterThan(0); // Austin-only seed sits inside the US bbox
    for (const c of usCams) {
      expect(c.lon).toBeGreaterThanOrEqual(-125);
      expect(c.lon).toBeLessThanOrEqual(-66);
      expect(c.lat).toBeGreaterThanOrEqual(25);
      expect(c.lat).toBeLessThanOrEqual(49);
    }
  });

  it('bbox outside Austin (open ocean) returns []', async () => {
    const { res, body } = await fetchJson(base, `/api/cameras?bbox=${OCEAN_BBOX}&limit=500`);
    expect(res.status).toBe(200);
    expect((body as { cameras: unknown[] }).cameras).toEqual([]);
  });

  it.each([
    ['missing bbox', '/api/cameras'],
    ['empty bbox', '/api/cameras?bbox='],
    ['too few parts', '/api/cameras?bbox=-98,29,-96'],
    ['non-numeric', '/api/cameras?bbox=a,b,c,d'],
    ['min > max', '/api/cameras?bbox=-96,31,-98,29'],
    ['lat out of range', '/api/cameras?bbox=-98,29,-96,95'],
  ])('invalid bbox → 400 (%s)', async (_label, path) => {
    const { res } = await fetchJson(base, path);
    expect(res.status).toBe(400);
  });

  it('limit=999999 clamps instead of 500ing', async () => {
    const { res, body } = await fetchJson(base, `/api/cameras?bbox=${US_BBOX}&limit=999999`);
    expect(res.status).toBe(200);
    const cameras = (body as { cameras: unknown[] }).cameras;
    expect(Array.isArray(cameras)).toBe(true);
    expect(cameras.length).toBeLessThanOrEqual(5000); // route MAX_LIMIT
  });

  it.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['non-integer', '2.5'],
    ['non-numeric', 'abc'],
  ])('invalid limit → 400 (%s)', async (_label, limit) => {
    const { res } = await fetchJson(base, `/api/cameras?bbox=${US_BBOX}&limit=${limit}`);
    expect(res.status).toBe(400);
  });
});
