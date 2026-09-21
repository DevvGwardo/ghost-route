import { useState } from 'react';
import {
  ChevronDown,
  CornerUpLeft,
  CornerUpRight,
  Eye,
  Flag,
  LogOut,
  MapPin,
  MoveUp,
  Navigation,
  RotateCcw,
  RotateCw,
  Ship,
  Split,
} from 'lucide-react';
import type { RouteStep as ContractRouteStep } from '../../../shared/src/types';

// Derived from the shared contract: renaming/removing a step field upstream
// breaks compilation here rather than drifting silently.
export type ManeuverKind = NonNullable<ContractRouteStep['maneuverKind']>;
export type RouteStep = ContractRouteStep;

export function ManeuverIcon({ maneuver, maneuverKind }: { maneuver?: string; maneuverKind?: string }) {
  const kind = (maneuverKind ?? '').toLowerCase().trim();
  if (kind) {
    if (kind === 'roundabout' || kind === 'rotary' || kind === 'circle')
      return <RotateCw size={18} aria-hidden="true" />;
    if (kind === 'arrive' || kind === 'finish' || kind === 'destination')
      return <Flag size={18} aria-hidden="true" />;
    if (kind === 'depart' || kind === 'start') return <Navigation size={18} aria-hidden="true" />;
    if (kind === 'uturn' || kind === 'u-turn' || kind === 'u_turn')
      return <RotateCcw size={18} aria-hidden="true" />;
    if (kind === 'exit' || kind === 'off-ramp' || kind === 'offramp')
      return <LogOut size={18} aria-hidden="true" />;
    if (kind === 'ferry' || kind === 'boat') return <Ship size={18} aria-hidden="true" />;
    if (kind === 'merge' || kind === 'fork') return <Split size={18} aria-hidden="true" />;
    if (kind === 'left') return <CornerUpLeft size={18} aria-hidden="true" />;
    if (kind === 'right') return <CornerUpRight size={18} aria-hidden="true" />;
    if (kind === 'keep' || kind === 'straight' || kind === 'continue')
      return <MoveUp size={18} aria-hidden="true" />;
    if (kind === 'pin' || kind === 'stop') return <MapPin size={18} aria-hidden="true" />;
    return <Navigation size={18} aria-hidden="true" />;
  }
  const m = (maneuver ?? '').toLowerCase();
  if (m.includes('roundabout') || m.includes('rotary') || m.includes('circle'))
    return <RotateCw size={18} aria-hidden="true" />;
  if (m.includes('arriv') || m.includes('destination') || m.includes('finish'))
    return <Flag size={18} aria-hidden="true" />;
  if (m.includes('depart') || m.includes('start')) return <Navigation size={18} aria-hidden="true" />;
  if (m.includes('u-turn') || m.includes('u turn') || m.includes('uturn'))
    return <RotateCcw size={18} aria-hidden="true" />;
  if (m.includes('exit') || m.includes('off-ramp') || m.includes('off ramp'))
    return <LogOut size={18} aria-hidden="true" />;
  if (m.includes('ferry') || m.includes('boat')) return <Ship size={18} aria-hidden="true" />;
  if (m.includes('merge') || m.includes('fork')) return <Split size={18} aria-hidden="true" />;
  if (m.includes('left')) return <CornerUpLeft size={18} aria-hidden="true" />;
  if (m.includes('right')) return <CornerUpRight size={18} aria-hidden="true" />;
  if (
    m.includes('straight') ||
    m.includes('continue') ||
    m.includes('ahead') ||
    m.includes('keep')
  )
    return <MoveUp size={18} aria-hidden="true" />;
  if (m.includes('pin') || m.includes('stop')) return <MapPin size={18} aria-hidden="true" />;
  return <Navigation size={18} aria-hidden="true" />;
}

function fmtStepDist(m: number): string {
  if (!Number.isFinite(m) || m < 0) return '';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function fmtDur(s?: number): string {
  if (s == null || !Number.isFinite(s) || s <= 0) return '';
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const mm = String(mins % 60).padStart(2, '0');
  return `${h} h ${mm} min`;
}

function StepExposure({ p, cameraIds }: { p?: number; cameraIds?: string[] }) {
  if (p == null || !Number.isFinite(p) || p <= 0.005) return null;
  const pct = Math.round(p * 100);
  const n = cameraIds?.length ?? 0;
  return (
    <span
      className="gm-step-chip"
      title={n > 0 ? (cameraIds as string[]).join(', ') : undefined}
      aria-label={
        n > 0
          ? `Step exposure ${pct} percent, ${n} cameras`
          : `Step exposure ${pct} percent`
      }
    >
      <Eye size={13} aria-hidden="true" />
      <span className="gm-tabular">
        {pct}%{n > 0 ? ` · ${n} cam${n === 1 ? '' : 's'}` : ''}
      </span>
    </span>
  );
}

export default function TurnSteps({ steps }: { steps?: RouteStep[] }) {
  const [open, setOpen] = useState(() => (steps?.length ?? 0) <= 8);
  if (!steps || steps.length === 0) return null;
  const count = steps.length;

  return (
    <div className="gm-steps">
      <button
        type="button"
        className="gm-steps-toggle"
        aria-expanded={open}
        aria-controls="gr-turn-steps"
        aria-label={open ? `Hide turn-by-turn steps, ${count} steps` : `Show turn-by-turn steps, ${count} steps`}
        onClick={() => setOpen((v) => !v)}
      >
        Steps · {count}
        <span className="chev" aria-hidden="true">
          <ChevronDown size={16} className={open ? 'gm-chev-open' : undefined} />
        </span>
      </button>
      {open && (
        // Static rows for now — no map wiring. Future: tapping a step
        // highlights it on the map / moves the camera.
        <ol className="gm-steps-list" id="gr-turn-steps" aria-label="Turn-by-turn directions">
          {steps.map((s, i) => {
            const dist = fmtStepDist(s.distanceM);
            const dur = fmtDur(s.durationS);
            const sub = dur ? (dist ? `${dist} · ${dur}` : dur) : dist;
            return (
              <li key={s.index ?? i} className="gm-step-row">
                <span className="gm-step-icon" aria-hidden="true">
                  <ManeuverIcon maneuver={s.maneuver} maneuverKind={s.maneuverKind} />
                </span>
                <span className="gm-step-main">
                  <span className="gm-step-text" title={s.instruction}>
                    {s.instruction}
                  </span>
                  {sub ? <span className="gm-step-sub gm-tabular">{sub}</span> : null}
                </span>
                <StepExposure p={s.exposureP} cameraIds={s.cameraIds} />
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
