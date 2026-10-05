// Keeps the screen on while navigating. Phones dim and lock after ~30 s
// without touch, which ends GPS updates and hides the next turn mid-drive.
// The browser drops the lock whenever the page is hidden, so it is
// re-requested when the page becomes visible again.
import { useEffect } from 'react';

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
}
interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof navigator === 'undefined') return;
    const wl = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
    if (!wl || typeof wl.request !== 'function') return; // unsupported: no-op
    let sentinel: WakeLockSentinelLike | null = null;
    let alive = true;
    const acquire = () => {
      if (!alive || document.visibilityState !== 'visible') return;
      if (sentinel && !sentinel.released) return;
      wl.request('screen').then(
        (s) => {
          if (alive) sentinel = s;
          else void s.release().catch(() => {});
        },
        () => {
          /* denied (battery saver, no user gesture) — navigation still works */
        },
      );
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', acquire);
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => {});
    };
  }, [enabled]);
}
