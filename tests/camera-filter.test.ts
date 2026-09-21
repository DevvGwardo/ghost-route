// Camera trust/brand/source filtering (spec P1-1).
//
// Two layers are covered:
//   1. Store-level semantics on a tiny in-memory seed (exact counts, incl. the
//      filter + decimation interaction — `total` must describe the FILTERED
//      set, not the whole bbox).
//   2. HTTP query plumbing against the real default store.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, fetchJson } from './helpers';
import { createMemoryStore, type Camera } from '../server/src/store';

const at = (lat: number, lon: number) => ({ lat, lon });

const SEED: Camera[] = [
  { id: 'cam-a', ...at(30.3, -97.7), source: 'deflock', verified: true, brand: 'Flock Safety' },
  { id: 'cam-b', ...at(30.301, -97.701), source: 'deflock', verified: false, brand: 'Motorola Solutions' },
  { id: 'cam-c', ...at(30.302, -97.702), source: 'user', verified: false },
];

const WORLD: [number, number, number, number] = [-98, 29, -96, 31];
const ids = (cams: Camera[]) => cams.map((c) => c.id).sort();

describe('store: camera filters', () => {
  it('no filter returns every camera in the bbox', () => {
    const store = createMemoryStore(SEED);
    const page = store.camerasInBboxPage(...WORLD, 500);
    expect(ids(page.cameras)).toEqual(['cam-a', 'cam-b', 'cam-c']);
    expect(page.total).toBe(3);
    expect(page.truncated).toBe(false);
  });

  it('verifiedOnly keeps only verified nodes', () => {
    const store = createMemoryStore(SEED);
    const page = store.camerasInBboxPage(...WORLD, 500, { verifiedOnly: true });
    expect(ids(page.cameras)).toEqual(['cam-a']);
    expect(page.total).toBe(1);
  });

  it('brand whitelist matches exact values, and multiple brands union', () => {
    const store = createMemoryStore(SEED);
    expect(ids(store.camerasInBboxPage(...WORLD, 500, { brands: ['Flock Safety'] }).cameras))
      .toEqual(['cam-a']);
    expect(
      ids(
        store.camerasInBboxPage(...WORLD, 500, {
          brands: ['Flock Safety', 'Motorola Solutions'],
        }).cameras,
      ),
    ).toEqual(['cam-a', 'cam-b']);
  });

  it('source whitelist matches exact values', () => {
    const store = createMemoryStore(SEED);
    expect(ids(store.camerasInBboxPage(...WORLD, 500, { sources: ['user'] }).cameras))
      .toEqual(['cam-c']);
  });

  it('empty filter arrays mean "no restriction", not "match nothing"', () => {
    const store = createMemoryStore(SEED);
    const page = store.camerasInBboxPage(...WORLD, 500, { brands: [], sources: [] });
    expect(page.cameras).toHaveLength(3);
  });

  it('filters apply BEFORE decimation: total describes the filtered set', () => {
    // 100 nodes in the bbox, only every other one verified.
    const big: Camera[] = Array.from({ length: 100 }, (_, i) => ({
      id: `cam-${String(i).padStart(3, '0')}`,
      lat: 30.3 + i * 0.0001,
      lon: -97.7 + i * 0.0001,
      source: 'deflock',
      verified: i % 2 === 0,
      brand: i % 2 === 0 ? 'Flock Safety' : 'Motorola Solutions',
    }));
    const store = createMemoryStore(big);
    const page = store.camerasInBboxPage(...WORLD, 5, { verifiedOnly: true });
    expect(page.total).toBe(50); // NOT 100
    expect(page.truncated).toBe(true);
    expect(page.cameras.length).toBeLessThanOrEqual(5);
    for (const c of page.cameras) expect(c.verified).toBe(true);
  });

  it('cameraCounts reports the verified split behind the total', () => {
    const store = createMemoryStore(SEED);
    expect(store.cameraCounts()).toEqual({ total: 3, verified: 1 });
  });

  it('deleting a camera removes it from filtered and unfiltered queries', () => {
    const store = createMemoryStore(SEED);
    expect(store.deleteCamera('cam-b')?.id).toBe('cam-b');
    expect(store.deleteCamera('cam-b')).toBeUndefined();
    expect(ids(store.camerasInBbox(...WORLD, 500))).toEqual(['cam-a', 'cam-c']);
    expect(store.cameraCounts()).toEqual({ total: 2, verified: 1 });
  });

  it('reports accumulate per reason and are rejected for unknown ids', () => {
    const store = createMemoryStore(SEED);
    expect(store.reportCamera('nope', 'gone')).toBeUndefined();
    expect(store.reportCamera('cam-a', 'gone')).toEqual({ reports: 1, reasons: { gone: 1 } });
    expect(store.reportCamera('cam-a', 'gone')).toEqual({ reports: 2, reasons: { gone: 2 } });
    expect(store.reportCamera('cam-a', 'not-a-camera')).toEqual({
      reports: 3,
      reasons: { gone: 2, 'not-a-camera': 1 },
    });
  });
});

let base = '';
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  const { app } = await import('../server/src/index');
  ({ base, close } = await startServer(app));
});

afterAll(async () => {
  await close?.();
});

const US_BBOX = '-125,25,-66,49';

describe('GET /api/cameras filters', () => {
  it('verifiedOnly=1 returns only verified cameras', async () => {
    const { res, body } = await fetchJson(
      base,
      `/api/cameras?bbox=${US_BBOX}&limit=500&verifiedOnly=1`,
    );
    expect(res.status).toBe(200);
    const cameras = (body as { cameras: Array<{ verified: boolean }> }).cameras;
    expect(cameras.length).toBeGreaterThan(0);
    for (const c of cameras) expect(c.verified).toBe(true);
  });

  it('filter total is <= the unfiltered total for the same bbox', async () => {
    const filtered = await fetchJson(
      base,
      `/api/cameras?bbox=${US_BBOX}&limit=5000&verifiedOnly=1`,
    );
    const all = await fetchJson(base, `/api/cameras?bbox=${US_BBOX}&limit=5000`);
    const ft = (filtered.body as { total: number }).total;
    const at = (all.body as { total: number }).total;
    expect(ft).toBeLessThanOrEqual(at);
    expect(ft).toBeGreaterThan(0);
  });

  it('brand= restricts to that exact brand', async () => {
    const { res, body } = await fetchJson(
      base,
      `/api/cameras?bbox=${US_BBOX}&limit=200&brand=Flock%20Safety`,
    );
    expect(res.status).toBe(200);
    const cameras = (body as { cameras: Array<{ brand?: string }> }).cameras;
    expect(cameras.length).toBeGreaterThan(0);
    for (const c of cameras) expect(c.brand).toBe('Flock Safety');
  });

  it('an unmatched source returns an empty list, not an error', async () => {
    const { res, body } = await fetchJson(
      base,
      `/api/cameras?bbox=${US_BBOX}&limit=200&source=not-a-real-source`,
    );
    expect(res.status).toBe(200);
    expect((body as { cameras: unknown[] }).cameras).toEqual([]);
    expect((body as { total: number }).total).toBe(0);
  });

  it('invalid verifiedOnly → 400', async () => {
    const { res } = await fetchJson(base, `/api/cameras?bbox=${US_BBOX}&verifiedOnly=maybe`);
    expect(res.status).toBe(400);
  });
});
