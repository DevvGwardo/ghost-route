import { Flag, X } from 'lucide-react';

// Bottom bar while navigating: time left (large), distance left and arrival
// clock time, plus the exit control. Replaces the route sheet for the whole
// session, so nothing covers the road ahead.
interface NavTripBarProps {
  remainingS: number | null;
  remainingM: number | null;
  arrived: boolean;
  /** Fixed clock for tests/screenshots; defaults to the real clock. */
  now?: number;
  onExit: () => void;
}

export function fmtRemaining(s: number): string {
  const mins = Math.max(0, Math.round(s / 60));
  if (mins < 1) return '<1 min';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

function fmtKm(m: number): string {
  if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

export function fmtClock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function NavTripBar({ remainingS, remainingM, arrived, now, onExit }: NavTripBarProps) {
  const t = now ?? Date.now();
  return (
    <section className="gm-tripbar" aria-label="Trip progress">
      <button
        type="button"
        className="gm-tripbar-exit"
        aria-label="Stop navigation"
        title="Stop navigation"
        onClick={onExit}
      >
        <X size={22} />
      </button>
      {arrived ? (
        <div className="gm-tripbar-main">
          <span className="gm-tripbar-time arrived">
            <Flag size={20} aria-hidden="true" /> You have arrived
          </span>
        </div>
      ) : (
        <div className="gm-tripbar-main" role="status" aria-live="off">
          <span className="gm-tripbar-time gm-tabular">
            {remainingS != null ? fmtRemaining(remainingS) : '—'}
          </span>
          <span className="gm-tripbar-meta gm-tabular">
            {remainingM != null ? fmtKm(remainingM) : '—'}
            {remainingS != null && <> · arrive {fmtClock(t + remainingS * 1000)}</>}
          </span>
        </div>
      )}
      {arrived && (
        <button type="button" className="gm-tripbar-done" onClick={onExit}>
          Done
        </button>
      )}
    </section>
  );
}
