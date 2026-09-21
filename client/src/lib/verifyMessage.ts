import type { VerifyKeyResponse } from '../../../shared/src/types';

/**
 * Turn a `/api/system/verify` result into something a person can act on.
 *
 * This is the fix for a real report: the user pasted a key, hit Test, and was
 * told "Could not reach TypeSafe. Try again." TypeSafe was perfectly
 * reachable — the request body was malformed, so TypeSafe answered 422, and
 * every non-401/403 was reported as a network failure. Chasing a connection
 * problem that doesn't exist is worse than a vague message, so each failure
 * class now names itself.
 *
 * Pure on purpose: no React, no fetch — so every branch is unit-testable.
 */
export function verifyMessage(out: VerifyKeyResponse): string {
  const status = typeof out.status === 'number' ? ` (HTTP ${out.status})` : '';
  const detail = out.detail ? ` — ${out.detail}` : '';
  switch (out.error) {
    case 'unauthorized':
      // 401/403 is auth, which is about the key itself, not connectivity.
      return `Key rejected${status}. Check the key at typesafe.ai.`;
    case 'invalid-key':
      return `That key cannot be used${detail}. Paste it exactly as issued.`;
    case 'key-required':
      return 'Paste a key first, then Test.';
    case 'invalid-request':
      // Reachable, but TypeSafe refused the request body — a bug on our side.
      return `TypeSafe rejected the request${status}${detail}. This is a Ghost Route issue, not your key.`;
    case 'rate-limited':
      return `TypeSafe is rate-limiting this key${status}. Try again shortly.`;
    case 'upstream-error':
      return `TypeSafe returned an error${status}${detail}. Try again.`;
    case 'timeout':
      // Reachable but slow: explicitly NOT "unreachable" — the key was never
      // rejected, so retrying is the right advice.
      return 'TypeSafe did not answer in time. Your key was not rejected — try Test again.';
    case 'unreachable':
      return 'Could not reach TypeSafe. Check your connection and try again.';
    default:
      // Never guess: an unrecognised failure still reports what we do know.
      return `Could not verify the key${status}. Try again.`;
  }
}
