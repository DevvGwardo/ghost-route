// Clean-route search wall-clock budget (spec P2-1, `cleanSearch.aborted`).
//
// A bounded partial answer must beat an unbounded wait: past the deadline the
// search stops, returns what it has, and says so instead of pretending the
// area has no clean route.
import { describe, it, expect } from 'vitest';
import { searchCleanRoute } from '../server/src/cleanroute';
import { rankByExposure } from '../server/src/avoid';
import { makeCamera, straightCoords } from './helpers';

const A = { lat: 30.26, lon: -97.74 };
const B = { lat: 30.36, lon: -97.64 };
const COORDS = straightCoords(A, B, 11);
const MID = COORDS[5];
const CAMERAS = [
  makeCamera('c1', MID[0], MID[1]),
  makeCamera('c2', MID[0], MID[1] + 0.0005),
  makeCamera('c3', MID[0], MID[1] - 0.0005),
];

function blockedBase() {
  const [scored] = rankByExposure(
    [{ id: 'route-0', coordinates: COORDS, distanceM: 4000, durationS: 600 }],
    CAMERAS,
    150,
  );
  return [{ ...scored, steps: [{ coordinates: COORDS }] }];
}

/** Records calls and always answers with nothing new (fast, offline). */
function recordingFetch() {
  const calls: Array<{ o: unknown; d: unknown; v?: unknown }> = [];
  const fn = async (o: unknown, d: unknown, v?: unknown) => {
    calls.push({ o, d, v });
    return [];
  };
  return { calls, fn: fn as never };
}

describe('searchCleanRoute deadline', () => {
  it('returns immediately (not aborted) when the base route is already clean', async () => {
    const { calls, fn } = recordingFetch();
    const clean = [
      {
        id: 'route-0',
        coordinates: COORDS,
        distanceM: 4000,
        durationS: 600,
        exposures: [],
        exposureCount: 0,
        score: 4000,
      },
    ];
    const out = await searchCleanRoute(A, B, clean as never, CAMERAS, 150, fn, undefined, {
      deadlineMs: Date.now() - 10_000,
    });
    expect(out.aborted).toBe(false);
    expect(out.cleanFound).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('an already-expired deadline stops before the first via round', async () => {
    const { calls, fn } = recordingFetch();
    const out = await searchCleanRoute(A, B, blockedBase() as never, CAMERAS, 150, fn, undefined, {
      deadlineMs: Date.now() - 1,
    });
    expect(out.aborted).toBe(true);
    expect(out.rounds).toBe(0);
    expect(out.osrmCalls).toBe(0);
    expect(calls).toHaveLength(0);
    // Partial results are still returned — the base set is never dropped.
    expect(out.routes.length).toBeGreaterThan(0);
    expect(out.routes[0].exposureCount).toBeGreaterThan(0);
  });

  it('a generous deadline runs the search normally and does not report aborted', async () => {
    const { calls, fn } = recordingFetch();
    const out = await searchCleanRoute(A, B, blockedBase() as never, CAMERAS, 150, fn, undefined, {
      deadlineMs: Date.now() + 60_000,
    });
    expect(calls.length).toBeGreaterThan(0); // both vias were attempted
    expect(out.rounds).toBeGreaterThan(0);
    expect(out.aborted).toBe(false);
  });

  it('omitting the deadline preserves the unbounded (pre-v1.2) behavior', async () => {
    const { calls, fn } = recordingFetch();
    const out = await searchCleanRoute(A, B, blockedBase() as never, CAMERAS, 150, fn);
    expect(calls.length).toBeGreaterThan(0);
    expect(out.aborted).toBe(false);
  });
});
