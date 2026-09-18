// Base-route guard: retry + exhaustion (fetchPlausibleBase from routes/route).
// fetchFn is ALWAYS stubbed here (no network).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fetchPlausibleBase } from '../server/src/routes/route';
import { AUSTIN, DALLAS, makeRoute } from './helpers';

const SAVED_FACTOR = process.env.ROUTE_MAX_FACTOR;
beforeEach(() => {
  delete process.env.ROUTE_MAX_FACTOR;
});
afterEach(() => {
  if (SAVED_FACTOR === undefined) delete process.env.ROUTE_MAX_FACTOR;
  else process.env.ROUTE_MAX_FACTOR = SAVED_FACTOR;
});

// Austin→Dallas ≈293km straight; default gate is 4x there (≈1170km).
const sane = () => ({ ...makeRoute('ok', AUSTIN, DALLAS, 11), distanceM: 300_000, durationS: 10_000 });
const garbage = (id: string) => ({
  ...makeRoute(id, AUSTIN, DALLAS, 11),
  distanceM: 2_258_000,
  durationS: 90_000,
});

describe('fetchPlausibleBase', () => {
  it('sane first try → no retry, one fetch call', async () => {
    let calls = 0;
    const out = await fetchPlausibleBase(AUSTIN, DALLAS, async () => {
      calls++;
      return [sane()];
    });
    expect(calls).toBe(1);
    expect(out.exhausted).toBe(false);
    expect(out.routes).toHaveLength(1);
    expect(out.routes[0].distanceM).toBe(300_000);
  });

  it('transient garbage → exactly one retry, then sane routes', async () => {
    let calls = 0;
    const out = await fetchPlausibleBase(AUSTIN, DALLAS, async () => {
      calls++;
      return calls === 1 ? [garbage('bad')] : [sane()];
    });
    expect(calls).toBe(2);
    expect(out.exhausted).toBe(false);
    expect(out.routes).toHaveLength(1);
    expect(out.routes[0].distanceM).toBe(300_000);
  });

  it('persistent garbage → exhausted, fetch called exactly twice (one retry only)', async () => {
    let calls = 0;
    const out = await fetchPlausibleBase(AUSTIN, DALLAS, async () => {
      calls++;
      return [garbage(`bad-${calls}`)];
    });
    expect(calls).toBe(2);
    expect(out.exhausted).toBe(true);
    expect(out.routes).toEqual([]);
  });

  it('OSRM throw propagates (caller maps to osrm-error 502)', async () => {
    await expect(
      fetchPlausibleBase(AUSTIN, DALLAS, async () => {
        throw new Error('routing-unavailable');
      }),
    ).rejects.toThrow();
  });

  it('empty OSRM response passes through without retry (legacy 200-empty path)', async () => {
    let calls = 0;
    const out = await fetchPlausibleBase(AUSTIN, DALLAS, async () => {
      calls++;
      return [];
    });
    expect(calls).toBe(1);
    expect(out.exhausted).toBe(false);
    expect(out.routes).toEqual([]);
  });
});
