import { describe, it, expect, afterEach } from 'vitest';
import { AUSTIN, makeCamera, straightCoords } from './helpers';

// Behavioral cover for the NEW exposure-probability + steps logic.
// Each test fails clearly (not cryptically) until the backend lands:
//   scoring.exposurePForPoints(coords, cameras, bufferM) -> { p, cameraIds }
//   jev.estimateExposure(routes, opts?) -> Record<id, { p, confidence, fallbackUsed, source }>

type Coords = [number, number][];
type Cam = { id: string; lat: number; lon: number };
type ExposurePOut = { p: number; cameraIds: string[] };

async function exposurePForPointsFn(): Promise<
  (coords: Coords, cameras: Cam[], bufferM: number) => ExposurePOut
> {
  const mod = await import('../server/src/services/scoring');
  const fn = (mod as Record<string, unknown>).exposurePForPoints;
  expect(fn, 'exposurePForPoints not implemented yet (backend pending)').toBeTypeOf(
    'function',
  );
  return fn as (
    coords: Coords,
    cameras: Cam[],
    bufferM: number,
  ) => ExposurePOut;
}

async function estimateExposureFn(): Promise<
  (
    routes: { id: string; exposurePGeo: number }[],
    opts?: unknown,
  ) => Promise<
    Record<
      string,
      { p: number; confidence: number; fallbackUsed: boolean; source: string }
    >
  >
> {
  const mod = await import('../server/src/jev');
  const fn = (mod as Record<string, unknown>).estimateExposure;
  expect(fn, 'estimateExposure not implemented yet (backend pending)').toBeTypeOf(
    'function',
  );
  return fn as (
    routes: { id: string; exposurePGeo: number }[],
    opts?: unknown,
  ) => Promise<
    Record<
      string,
      { p: number; confidence: number; fallbackUsed: boolean; source: string }
    >
  >;
}

const DEST = { lat: 30.35, lon: -97.7 };
const BUFFER_M = 150;

describe('exposurePForPoints', () => {
  it('empty cameras → p=0, cameraIds=[]', async () => {
    const fn = await exposurePForPointsFn();
    const out = fn(straightCoords(AUSTIN, DEST, 11), [], BUFFER_M);
    expect(out.p).toBe(0);
    expect(out.cameraIds).toEqual([]);
  });

  it('camera exactly on the line → p≈0.95 and id listed', async () => {
    const fn = await exposurePForPointsFn();
    const line = straightCoords(AUSTIN, DEST, 11);
    const mid = line[5];
    const out = fn(line, [makeCamera('c1', mid[0], mid[1])], BUFFER_M);
    expect(out.cameraIds).toContain('c1');
    expect(out.p).toBeGreaterThanOrEqual(0.94);
    expect(out.p).toBeLessThanOrEqual(0.96);
  });

  it('camera beyond the buffer → excluded, p=0', async () => {
    const fn = await exposurePForPointsFn();
    const line = straightCoords(AUSTIN, DEST, 11);
    const out = fn(
      line,
      [makeCamera('far', AUSTIN.lat + 5, AUSTIN.lon + 5)],
      BUFFER_M,
    );
    expect(out.cameraIds).not.toContain('far');
    expect(out.p).toBe(0);
  });

  it('two cameras combine as 1-(1-p1)(1-p2) within 0.01', async () => {
    const fn = await exposurePForPointsFn();
    const line = straightCoords(AUSTIN, DEST, 11);
    const mid = line[5];
    const c1 = makeCamera('c1', mid[0], mid[1]);
    const c2 = makeCamera('c2', mid[0], mid[1] + 0.001); // ~95m east, inside buffer
    const p1 = fn(line, [c1], BUFFER_M).p;
    const p2 = fn(line, [c2], BUFFER_M).p;
    const both = fn(line, [c1, c2], BUFFER_M).p;
    const expected = 1 - (1 - p1) * (1 - p2);
    expect(Math.abs(both - expected)).toBeLessThan(0.01);
    expect(both).toBeGreaterThanOrEqual(Math.max(p1, p2));
  });

  it('p always in [0,1], incl. degenerate empty coords → p=0', async () => {
    const fn = await exposurePForPointsFn();
    const line = straightCoords(AUSTIN, DEST, 11);
    const mid = line[5];
    const outs = [
      fn([], [makeCamera('c1', AUSTIN.lat, AUSTIN.lon)], BUFFER_M),
      fn(line, [], BUFFER_M),
      fn(line, [makeCamera('c1', mid[0], mid[1])], BUFFER_M),
      fn(
        line,
        [
          makeCamera('c1', mid[0], mid[1]),
          makeCamera('far', AUSTIN.lat + 5, AUSTIN.lon + 5),
        ],
        BUFFER_M,
      ),
    ];
    expect(outs[0].p).toBe(0);
    for (const o of outs) {
      expect(o.p).toBeGreaterThanOrEqual(0);
      expect(o.p).toBeLessThanOrEqual(1);
    }
  });
});

describe('estimateExposure (no TYPESAFE_API_KEY → geometric fallback)', () => {
  const SAVED_KEY = process.env.TYPESAFE_API_KEY;
  afterEach(() => {
    if (SAVED_KEY === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = SAVED_KEY;
  });

  it('every route gets fallbackUsed:true, source:geometric, p===exposurePGeo, confidence in [0,1]', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const fn = await estimateExposureFn();
    const routes = [
      { id: 'r1', exposurePGeo: 0.2 },
      { id: 'r2', exposurePGeo: 0.8 },
    ];
    const out = await fn(routes);
    for (const r of routes) {
      const e = out[r.id];
      expect(e, `estimateExposure entry for ${r.id}`).toBeDefined();
      expect(e.fallbackUsed).toBe(true);
      expect(e.source).toBe('geometric');
      expect(e.p).toBeCloseTo(r.exposurePGeo, 10);
      expect(e.confidence).toBeGreaterThanOrEqual(0);
      expect(e.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('empty routes → empty record (no crash)', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const fn = await estimateExposureFn();
    expect(await fn([])).toEqual({});
  });
});
