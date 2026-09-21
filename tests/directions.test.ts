// Direction-instruction quality + step-geometry suite (ghost-route).
// FIXED-behavior contract for server/src/services/osrm:
//   buildInstruction: depart→Head (never Continue/Turn); merge/fork/end-of-road
//   WITHOUT modifier keep the type word; end-of-road WITH modifier→
//   "At end of road, turn…"; ramps→"Take the…"; "new name"→Continue;
//   roundabout→"Enter roundabout"; arrive keeps name/side; ref preferred over
//   name; destinations→"toward X" fallback.
//   buildSteps: geometry preferred over intersections; neg/NaN→0;
//   no duplicate-point fabrication.
// Primary coverage is end-to-end via fetchRoutes with stubbed OSRM JSON
// (no network; real OSRM step field names: ref, destinations, geometry).
// Direct buildInstruction/buildSteps unit tests activate once those exports
// land (backend parallel fix); NaN numerics are unit-only (NaN dies in JSON).
// Cache is dodged with unique dests.
import { describe, it, expect, afterEach } from 'vitest';
import { fetchRoutes } from '../server/src/services/osrm';
import * as osrm from '../server/src/services/osrm';
import { AUSTIN } from './helpers';

const units = osrm as unknown as {
  buildInstruction?: (type: string, modifier: string | undefined, name: string) => string;
  buildSteps?: (legs: { steps?: unknown[] }[]) => {
    instruction: string;
    maneuver: string;
    distanceM: number;
    durationS: number;
    coordinates: [number, number][];
  }[];
};
const HAS_UNITS = typeof units.buildInstruction === 'function' && typeof units.buildSteps === 'function';

const REAL_FETCH = globalThis.fetch;
let destSeq = 100;
const DEST = () => ({ lat: 30.3 + (destSeq++) * 0.013, lon: -97.7 });

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

function stubOsrmSteps(steps: unknown[]) {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        routes: [
          {
            geometry: { coordinates: [[-97.74, 30.26], [-97.75, 30.3]] },
            distance: 5000,
            duration: 600,
            legs: [{ steps }],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
}

const twoIntersections = (lon = -97.74, lat = 30.26) => [
  { location: [lon, lat] },
  { location: [lon - 0.001, lat + 0.001] },
];

async function firstSteps(steps: unknown[]) {
  stubOsrmSteps(steps);
  const routes = await fetchRoutes(AUSTIN, DEST());
  return routes[0].steps;
}

describe('instruction verbs (via fetchRoutes, stubbed OSRM)', () => {
  it('depart onto a named street says Head, not Continue/Turn', async () => {
    const [s] = await firstSteps([
      { maneuver: { type: 'depart' }, name: 'Congress Ave', distance: 100, duration: 10, intersections: twoIntersections() },
    ]);
    expect(s.instruction).toMatch(/^head/i);
    expect(s.instruction).not.toMatch(/continue|turn/i);
  });

  it('depart with a modifier keeps Head semantics (not "Turn")', async () => {
    const [s] = await firstSteps([
      { maneuver: { type: 'depart', modifier: 'left' }, name: 'Main St', distance: 100, duration: 10, intersections: twoIntersections() },
    ]);
    expect(s.instruction).toMatch(/head/i);
    expect(s.instruction).not.toMatch(/^turn/i);
  });

  it('merge without modifier keeps the type word', async () => {
    const [s] = await firstSteps([
      { maneuver: { type: 'merge' }, name: 'I-35 N', distance: 400, duration: 30, intersections: twoIntersections() },
    ]);
    expect(s.instruction).toMatch(/merge/i);
  });

  it('fork without modifier keeps the type word', async () => {
    const [s] = await firstSteps([
      { maneuver: { type: 'fork' }, name: 'Exit 234', distance: 200, duration: 15, intersections: twoIntersections() },
    ]);
    expect(s.instruction).toMatch(/fork/i);
  });

  it('end of road without modifier keeps the type word', async () => {
    const [s] = await firstSteps([
      { maneuver: { type: 'end of road' }, name: 'Lamar Blvd', distance: 50, duration: 8, intersections: twoIntersections() },
    ]);
    expect(s.instruction).toMatch(/end of road/i);
  });

  it('end of road with modifier reads "At end of road, turn…"', async () => {
    const [s] = await firstSteps([
      { maneuver: { type: 'end of road', modifier: 'left' }, name: 'Lamar Blvd', distance: 50, duration: 8, intersections: twoIntersections() },
    ]);
    expect(s.instruction).toMatch(/^at end of road, turn left/i);
    expect(s.instruction).toMatch(/lamar/i);
  });

  it('on-ramp reads "Take the…"', async () => {
    const [s] = await firstSteps([
      { maneuver: { type: 'on ramp', modifier: 'slight right' }, name: 'I-35 N', distance: 400, duration: 30, intersections: twoIntersections() },
    ]);
    expect(s.instruction).toMatch(/^take the/i);
    expect(s.instruction).toMatch(/i-35/i);
  });

  it('off-ramp reads "Take the…"', async () => {
    const [s] = await firstSteps([
      { maneuver: { type: 'off ramp', modifier: 'slight right' }, name: 'Exit 234', distance: 300, duration: 20, intersections: twoIntersections() },
    ]);
    expect(s.instruction).toMatch(/^take the/i);
  });

  it('"new name" reads as Continue onto the new name', async () => {
    const [s] = await firstSteps([
      { maneuver: { type: 'new name' }, name: 'Congress Ave', distance: 100, duration: 10, intersections: twoIntersections() },
    ]);
    expect(s.instruction).toMatch(/continue/i);
    expect(s.instruction).toMatch(/congress/i);
  });

  it('roundabout reads "Enter roundabout"', async () => {
    const [s] = await firstSteps([
      { maneuver: { type: 'roundabout', modifier: 'left' }, name: '', distance: 60, duration: 8, intersections: twoIntersections() },
    ]);
    expect(s.instruction).toMatch(/enter roundabout/i);
  });

  it('arrive keeps the street name', async () => {
    const [s] = await firstSteps([
      { maneuver: { type: 'arrive' }, name: 'Congress Ave', distance: 0, duration: 0, intersections: twoIntersections() },
    ]);
    expect(s.instruction).toMatch(/arrive/i);
    expect(s.instruction).toMatch(/congress/i);
  });

  it('arrive keeps the side', async () => {
    const [s] = await firstSteps([
      { maneuver: { type: 'arrive', modifier: 'right' }, name: 'Congress Ave', distance: 0, duration: 0, intersections: twoIntersections() },
    ]);
    expect(s.instruction).toMatch(/arrive/i);
    expect(s.instruction).toMatch(/right/i);
  });

  it('ref is preferred over name', async () => {
    const [s] = await firstSteps([
      { maneuver: { type: 'turn', modifier: 'left' }, ref: 'I-35', name: 'Frontage Rd', distance: 100, duration: 10, intersections: twoIntersections() },
    ]);
    expect(s.instruction).toMatch(/i-35/i);
    expect(s.instruction).not.toMatch(/frontage/i);
  });

  it('destinations fall back to "toward X"', async () => {
    const [s] = await firstSteps([
      { maneuver: { type: 'turn', modifier: 'right' }, name: '', destinations: 'Downtown, Airport', distance: 100, duration: 10, intersections: twoIntersections() },
    ]);
    expect(s.instruction).toMatch(/toward/i);
    expect(s.instruction).toMatch(/downtown/i);
  });

  it('step with no maneuver type has no leading-space gibberish', async () => {
    const [s] = await firstSteps([
      { maneuver: { modifier: 'left' }, name: '', distance: 10, duration: 2, intersections: twoIntersections() },
    ]);
    expect(s.instruction).toBe(s.instruction.trim());
    expect(s.instruction).toMatch(/^[A-Za-z]/);
  });
});

describe('step geometry / numeric sanity (via fetchRoutes, stubbed OSRM)', () => {
  it('step geometry is preferred over intersections', async () => {
    const [s] = await firstSteps([
      {
        maneuver: { type: 'turn', modifier: 'left' }, name: 'A', distance: 10, duration: 2,
        geometry: { coordinates: [[-97.74, 30.26], [-97.741, 30.261], [-97.742, 30.262]] },
        intersections: [{ location: [-97.0, 30.0] }, { location: [-97.001, 30.001] }],
      },
    ]);
    expect(s.coordinates).toEqual([[30.26, -97.74], [30.261, -97.741], [30.262, -97.742]]);
  });

  it('non-finite intersection locations never reach step coordinates', async () => {
    const steps = await firstSteps([
      { maneuver: { type: 'turn', modifier: 'left' }, name: 'A', distance: 10, duration: 2, intersections: twoIntersections() },
      { maneuver: { type: 'turn', modifier: 'right' }, name: 'B', distance: 10, duration: 2, intersections: [{ location: [NaN, NaN] }] },
    ]);
    for (const s of steps)
      for (const [lat, lon] of s.coordinates) {
        expect(Number.isFinite(lat)).toBe(true);
        expect(Number.isFinite(lon)).toBe(true);
      }
    expect(steps[1].coordinates).toEqual([]);
  });

  it('negative distance/duration are sanitized to 0', async () => {
    const [s] = await firstSteps([
      { maneuver: { type: 'turn', modifier: 'left' }, name: 'A', distance: -50, duration: -3, intersections: twoIntersections() },
    ]);
    expect(s.distanceM).toBe(0);
    expect(s.durationS).toBe(0);
  });

  it('geometry-less middle step is empty (no duplicate-point fabrication)', async () => {
    const steps = await firstSteps([
      { maneuver: { type: 'turn', modifier: 'left' }, name: 'A', distance: 10, duration: 2, intersections: twoIntersections() },
      { maneuver: { type: 'turn', modifier: 'right' }, name: 'B', distance: 10, duration: 2 },
    ]);
    expect(steps[1].coordinates).toEqual([]);
  });
});

describe('already-fine baselines (sanity, should stay green)', () => {
  it('plain turn renders "Turn left onto X"', async () => {
    const [s] = await firstSteps([
      { maneuver: { type: 'turn', modifier: 'left' }, name: 'Main St', distance: 10, duration: 2, intersections: twoIntersections() },
    ]);
    expect(s.instruction).toBe('Turn left onto Main St');
  });

  it('intersection [lon,lat] maps to step [lat,lon] order', async () => {
    const [s] = await firstSteps([
      { maneuver: { type: 'turn', modifier: 'left' }, name: 'A', distance: 10, duration: 2, intersections: twoIntersections(-97.74, 30.26) },
    ]);
    expect(s.coordinates[0]).toEqual([30.26, -97.74]);
  });
});

// Direct unit tests: active once buildInstruction/buildSteps are exported
// (backend parallel fix). Skipped until then; every rule above is ALSO
// covered end-to-end so nothing is verified by units alone — except NaN
// numerics, which cannot survive stub JSON and live only here.
describe.runIf(HAS_UNITS)('buildInstruction (direct unit)', () => {
  const bi = () => units.buildInstruction!;
  it('depart → Head', () => {
    expect(bi()('depart', undefined, 'Congress Ave')).toMatch(/^head/i);
  });
  it('depart + modifier stays Head, never Turn', () => {
    expect(bi()('depart', 'left', 'Main St')).toMatch(/head/i);
    expect(bi()('depart', 'left', 'Main St')).not.toMatch(/^turn/i);
  });
  it('merge/fork/end-of-road without modifier keep type word', () => {
    expect(bi()('merge', undefined, 'I-35 N')).toMatch(/merge/i);
    expect(bi()('fork', undefined, 'Exit 234')).toMatch(/fork/i);
    expect(bi()('end of road', undefined, 'Lamar Blvd')).toMatch(/end of road/i);
  });
  it('end-of-road + modifier → "At end of road, turn…"', () => {
    expect(bi()('end of road', 'left', 'Lamar Blvd')).toMatch(/^at end of road, turn left/i);
  });
  it('ramps → "Take the…"', () => {
    expect(bi()('on ramp', 'slight right', 'I-35 N')).toMatch(/^take the/i);
    expect(bi()('off ramp', 'slight right', 'Exit 234')).toMatch(/^take the/i);
  });
  it('"new name" → Continue', () => {
    expect(bi()('new name', undefined, 'Congress Ave')).toMatch(/continue/i);
  });
  it('roundabout → "Enter roundabout"', () => {
    expect(bi()('roundabout', 'left', '')).toMatch(/enter roundabout/i);
  });
  it('arrive keeps name and side', () => {
    const s = bi()('arrive', 'right', 'Congress Ave');
    expect(s).toMatch(/arrive/i);
    expect(s).toMatch(/congress/i);
    expect(s).toMatch(/right/i);
  });
});

describe.runIf(HAS_UNITS)('buildSteps (direct unit)', () => {
  const bs = () => units.buildSteps!;
  const inter = (lon: number, lat: number) => [{ location: [lon, lat] as [number, number] }];
  it('geometry preferred over intersections', () => {
    const [s] = bs()([{ steps: [{
      maneuver: { type: 'turn', modifier: 'left' }, name: 'A', distance: 10, duration: 2,
      geometry: { coordinates: [[-97.74, 30.26], [-97.741, 30.261]] },
      intersections: inter(-97.0, 30.0),
    }] }]);
    expect(s.coordinates).toEqual([[30.26, -97.74], [30.261, -97.741]]);
  });
  it('NaN distance/duration sanitize to 0 (unit-only: NaN dies in JSON)', () => {
    const [s] = bs()([{ steps: [{
      maneuver: { type: 'turn', modifier: 'left' }, name: 'A', distance: NaN, duration: NaN,
      intersections: inter(-97.74, 30.26),
    }] }]);
    expect(s.distanceM).toBe(0);
    expect(s.durationS).toBe(0);
  });
  it('negative distance/duration sanitize to 0', () => {
    const [s] = bs()([{ steps: [{
      maneuver: { type: 'turn', modifier: 'left' }, name: 'A', distance: -50, duration: -3,
      intersections: inter(-97.74, 30.26),
    }] }]);
    expect(s.distanceM).toBe(0);
    expect(s.durationS).toBe(0);
  });
  it('no duplicate-point fabrication for geometry-less steps', () => {
    const steps = bs()([{ steps: [
      { maneuver: { type: 'turn', modifier: 'left' }, name: 'A', distance: 10, duration: 2, intersections: inter(-97.74, 30.26) },
      { maneuver: { type: 'turn', modifier: 'right' }, name: 'B', distance: 10, duration: 2 },
    ] }]);
    expect(steps[1].coordinates).toEqual([]);
  });
  it('non-finite intersections filtered out', () => {
    const [s] = bs()([{ steps: [{
      maneuver: { type: 'turn', modifier: 'right' }, name: 'B', distance: 10, duration: 2,
      intersections: [{ location: [NaN, NaN] as unknown as [number, number] }],
    }] }]);
    expect(s.coordinates).toEqual([]);
  });
});
