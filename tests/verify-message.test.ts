// The wording of the key-check result.
//
// Regression guard for a real report: clicking Test said "Could not reach
// TypeSafe. Try again." while TypeSafe was reachable and had actually rejected
// a malformed request with a 422. Every failure class must name itself, and
// only a genuine network failure may say the service was unreachable.
import { describe, it, expect } from 'vitest';
import { verifyMessage } from '../client/src/lib/verifyMessage';
import type { VerifyKeyResponse } from '../shared/src/types';

const msg = (out: Partial<VerifyKeyResponse>): string =>
  verifyMessage({ mode: 'jev', valid: false, ...out } as VerifyKeyResponse);

const UNREACHABLE_TEXT = /could not reach typesafe/i;

describe('verifyMessage names the real cause', () => {
  it('401/403 → key rejected, not a connectivity problem', () => {
    const text = msg({ error: 'unauthorized', status: 401 });
    expect(text).toMatch(/key rejected/i);
    expect(text).toContain('401');
    expect(text, 'auth is not a network failure').not.toMatch(UNREACHABLE_TEXT);
  });

  it('404/403 makes the same point (TypeSafe uses both)', () => {
    expect(msg({ error: 'unauthorized', status: 403 })).toMatch(/key rejected/i);
  });

  it('422 → says Ghost Route is at fault, so nobody re-pastes a good key', () => {
    const text = msg({
      error: 'invalid-request',
      status: 422,
      detail: '{"detail":{"message":"questions must be a map"}}',
    });
    expect(text).toMatch(/rejected the request/i);
    expect(text).toContain('422');
    expect(text, 'the upstream reason must be visible for a real bug report').toContain(
      'questions must be a map',
    );
    expect(text, 'must not blame the network').not.toMatch(UNREACHABLE_TEXT);
  });

  it('429 → rate limited, retryable', () => {
    const text = msg({ error: 'rate-limited', status: 429 });
    expect(text).toMatch(/rate-limiting/i);
    expect(text).toMatch(/try again shortly/i);
    expect(text).not.toMatch(UNREACHABLE_TEXT);
  });

  it('5xx → upstream error with the status', () => {
    const text = msg({ error: 'upstream-error', status: 529 });
    expect(text).toMatch(/returned an error/i);
    expect(text).toContain('529');
    expect(text).not.toMatch(UNREACHABLE_TEXT);
  });

  it('timeout → slow, NOT unreachable, and says the key was not rejected', () => {
    const text = msg({ error: 'timeout' });
    expect(text).toMatch(/did not answer in time/i);
    expect(text, 'the important reassurance: nothing is wrong with the key').toMatch(
      /not rejected/i,
    );
    expect(text).not.toMatch(UNREACHABLE_TEXT);
  });

  it('network failure → the only case that says unreachable', () => {
    expect(msg({ error: 'unreachable' })).toMatch(UNREACHABLE_TEXT);
  });

  it('blank key → asks for one', () => {
    expect(msg({ error: 'key-required' })).toMatch(/paste a key first/i);
  });

  it('over-long key → explains it cannot be used, with the limit', () => {
    const text = msg({ error: 'invalid-key', detail: 'key must be 1-4096 characters' });
    expect(text).toMatch(/cannot be used/i);
    expect(text).toContain('4096');
  });

  it('an unrecognised error still reports the status rather than guessing', () => {
    const text = msg({ error: 'something-new', status: 418 });
    expect(text).toContain('418');
    expect(text).toMatch(/could not verify/i);
  });

  it('never claims unreachable for a failure that carried an HTTP status', () => {
    // The whole bug in one assertion: a status means something did answer.
    for (const [error, status] of [
      ['unauthorized', 401],
      ['invalid-request', 422],
      ['rate-limited', 429],
      ['upstream-error', 500],
      ['upstream-error', 529],
    ] as const) {
      expect(msg({ error, status }), `${error}/${status}`).not.toMatch(UNREACHABLE_TEXT);
    }
  });
});
