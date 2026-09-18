import { useState } from 'react';
import {
  ChevronDown,
  CornerUpLeft,
  CornerUpRight,
  Eye,
  Flag,
  MapPin,
  MoveUp,
  Navigation,
  RotateCw,
} from 'lucide-react';

export interface RouteStep {
  index: number;
  instruction: string;
  maneuver?: string;
  distanceM: number;
  durationS?: number;
  exposureP?: number;
  cameraIds?: string[];
}

function ManeuverIcon({ maneuver }: { maneuver?: string }) {
  const m = (maneuver ?? '').toLowerCase();
  if (m.includes('roundabout') || m.includes('rotary') || m.includes('circle'))
    return <RotateCw size={18} aria-hidden="true" />;
  if (m.includes('arriv') || m.includes('destination') || m.includes('finish'))
    return <Flag size={18} aria-hidden="true" />;
  if (m.includes('depart') || m.includes('start')) return <Navigation size={18} aria-hidden="true" />;
  if (m.includes('left')) return <CornerUpLeft size={18} aria-hidden="true" />;
  if (m.includes('right')) return <CornerUpRight size={18} aria-hidden="true" />;
  if (m.includes('straight') || m.includes('continue') || m.includes('ahead') || m.includes('up'))
    return <MoveUp size={18} aria-hidden="true" />;
  if (m.includes('pin') || m.includes('stop')) return <MapPin size={18} aria-hidden="true" />;
  return <Navigation size={18} aria-hidden="true" />;
}

function fmtStepDist(m: number): string {
  if (!Number.isFinite(m) || m < 0) return '';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function StepExposure({ p }: { p?: number }) {
  if (p == null || !Number.isFinite(p) || p <= 0.005) {
    return (
      <span className="gm-step-clear" aria-label="No camera exposure on this step">
        clear
      </span>
    );
  }
  return (
    <span className="gm-step-chip" aria-label={`Step exposure ${Math.round(p * 100)} percent`}>
      <Eye size={13} aria-hidden="true" />
      <span className="gm-tabular">{Math.round(p * 100)}%</span>
    </span>
  );
}

export default function TurnSteps({ steps }: { steps?: RouteStep[] }) {
  const [open, setOpen] = useState(false);
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
          {steps.map((s, i) => (
            <li key={s.index ?? i} className="gm-step-row">
              <span className="gm-step-icon" aria-hidden="true">
                <ManeuverIcon maneuver={s.maneuver} />
              </span>
              <span className="gm-step-main">
                <span className="gm-step-text" title={s.instruction}>
                  {s.instruction}
                </span>
                <span className="gm-step-sub gm-tabular">{fmtStepDist(s.distanceM)}</span>
              </span>
              <StepExposure p={s.exposureP} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
