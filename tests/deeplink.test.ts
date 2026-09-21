// Shareable route links (spec P1-2). Pure round-trip + degradation tests.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LINK_OPTIONS,
  decodeRouteHash,
  encodeRouteHash,
  hasRouteHash,
} from '../client/src/lib/deeplink';

const AUSTIN = { lat: 30.2672, lon: -97.7431 };
const DEST = { lat: 30.35, lon: -97.7 };

const link = (options: Partial<typeof DEFAULT_LINK_OPTIONS> = {}) => ({
  origin: AUSTIN,
  destination: DEST,
  options,
});

describe('encodeRouteHash', () => {
  it('writes only the non-default options', () => {
    const hash = encodeRouteHash(link());
    expect(hash).toContain('avoid=1');
    expect(hash).toContain('buf=150');
    expect(hash).toContain('prof=driving');
    expect(hash).not.toContain('dir=0');
    expect(hash).not.toContain('vd=1');
    expect(hash).not.toContain('brands=');
  });

  it('records overrides', () => {
    const hash = encodeRouteHash(
      link({ avoidFlock: false, bufferMeters: 300, profile: 'cycling', respectDirection: false, verifiedOnly: true, brands: ['Flock Safety'] }),
    );
    expect(hash).toContain('avoid=0');
    expect(hash).toContain('buf=300');
    expect(hash).toContain('prof=cycling');
    expect(hash).toContain('dir=0');
    expect(hash).toContain('vd=1');
    expect(hash).toContain('brands=Flock%20Safety');
  });

  it('trims float noise out of coordinates', () => {
    const hash = encodeRouteHash(link());
    expect(hash).toContain('r=30.2672,-97.7431~30.35,-97.7');
    expect(hash).not.toContain('30.26720000000000');
  });
});

describe('decodeRouteHash', () => {
  it('round-trips through encode without losing anything', () => {
    const original = link({
      avoidFlock: false,
      bufferMeters: 275,
      profile: 'walking',
      respectDirection: false,
      verifiedOnly: true,
      brands: ['Flock Safety', 'Motorola Solutions'],
    });
    const decoded = decodeRouteHash(encodeRouteHash(original));
    expect(decoded).not.toBeNull();
    expect(decoded?.origin).toEqual(AUSTIN);
    expect(decoded?.destination).toEqual(DEST);
    expect(decoded?.options).toEqual(original.options);
  });

  it('re-encoding a decoded link is stable (bookmark/edit/bookmark)', () => {
    const hash = encodeRouteHash(link({ profile: 'cycling', verifiedOnly: true }));
    const decoded = decodeRouteHash(hash)!;
    expect(encodeRouteHash(decoded)).toBe(hash);
  });

  it('accepts a bare hash body with no leading #', () => {
    expect(decodeRouteHash('r=30.2672,-97.7431~30.35,-97.7')?.origin).toEqual(AUSTIN);
  });

  it.each([
    ['empty string', ''],
    ['hash only', '#'],
    ['null', null],
    ['undefined', undefined],
    ['no route field', '#avoid=1&buf=150'],
    ['origin only', '#r=30.2672,-97.7431'],
    ['unparseable destination', '#r=30.2672,-97.7431~oops'],
    ['lat out of range', '#r=99,-97.7431~30.35,-97.7'],
    ['lon out of range', '#r=30.2672,-197.7431~30.35,-97.7'],
    ['extra coordinate', '#r=30.2672,-97.7431~30.35,-97.7~1,1'],
    ['unknown profile', '#r=30.2672,-97.7431~30.35,-97.7&prof=hovercraft'],
  ])('degrades to null (%s)', (_label, hash) => {
    expect(decodeRouteHash(hash)).toBeNull();
  });

  it('clamps an out-of-range buffer instead of rejecting the link', () => {
    expect(decodeRouteHash('#r=30.2672,-97.7431~30.35,-97.7&buf=5')?.options.bufferMeters).toBe(50);
    expect(decodeRouteHash('#r=30.2672,-97.7431~30.35,-97.7&buf=99999')?.options.bufferMeters).toBe(5000);
  });

  it('ignores a non-numeric buffer and keeps the default', () => {
    const decoded = decodeRouteHash('#r=30.2672,-97.7431~30.35,-97.7&buf=abc');
    expect(decoded?.options.bufferMeters).toBeUndefined();
  });

  it('survives a malformed brand escape without dropping the route', () => {
    const decoded = decodeRouteHash('#r=30.2672,-97.7431~30.35,-97.7&brands=%E0%A4%A|Axis');
    expect(decoded).not.toBeNull();
    expect(decoded?.options.brands).toEqual(['Axis']);
  });

  it('treats unsigned flags as their defaults', () => {
    const decoded = decodeRouteHash('#r=30.2672,-97.7431~30.35,-97.7&avoid=maybe');
    expect(decoded?.options.avoidFlock).toBe(true);
  });
});

describe('hasRouteHash', () => {
  it('detects a route-shaped hash', () => {
    expect(hasRouteHash('#r=30.2,-97.7~30.3,-97.6')).toBe(true);
    expect(hasRouteHash('#avoid=1')).toBe(false);
    expect(hasRouteHash('')).toBe(false);
    expect(hasRouteHash(null)).toBe(false);
  });
});
