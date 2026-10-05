import { Eye, LoaderCircle, LocateFixed, RefreshCw, Volume2, VolumeX } from 'lucide-react';
import { fmtNavDist, type NavStep, type UpcomingCamera } from '../lib/navigate';
import { ManeuverIcon } from './TurnSteps';

// Presentational only: the GPS watch, step lock and off-route detection live
// in lib/useNavigation so the map and this banner share one source of truth.
// Layout follows phone nav apps: the next maneuver large at the top (glanceable
// at arm's length), a "Then" preview when two turns come close together, the
// camera alert as its own strip, and trip progress in a bar at the bottom
// (NavTripBar) where the exit control lives.
interface NavigateBannerProps {
  /** Live fix as [lat, lon]; null until the first fix arrives. */
  pos: [number, number] | null;
  geoError: string | null;
  arrived: boolean;
  /** The maneuver to announce next. */
  nextStep: NavStep | null;
  /** The maneuver after that, previewed when it follows closely. */
  followingStep?: NavStep | null;
  /** Meters remaining in the current step. */
  remainingM: number | null;
  /** Nearest camera ahead inside the alert window. */
  nextCam: UpcomingCamera | null;
  /** Confirmed off-route and recalculating. */
  rerouting: boolean;
  /** Whether the map is still tracking the fix (follow mode). */
  following: boolean;
  /** Whether spoken guidance is on. */
  voiceOn: boolean;
  /** Resume follow mode after the user panned the map away. */
  onRecenter: () => void;
  onToggleVoice: () => void;
}

/** "Turn left onto Main St" → { verb: "Turn left", road: "Main St" }. */
export function splitInstruction(text: string): { verb: string; road: string | null } {
  const m = /^(.*?)\s+(?:onto|on|toward|at)\s+(.+)$/i.exec(text);
  if (!m) return { verb: text, road: null };
  return { verb: m[1], road: m[2] };
}

const THEN_WITHIN_M = 250;

export default function NavigateBanner({
  pos,
  geoError,
  arrived,
  nextStep,
  followingStep = null,
  remainingM,
  nextCam,
  rerouting,
  following,
  voiceOn,
  onRecenter,
  onToggleVoice,
}: NavigateBannerProps) {
  const showCam = nextCam != null && !arrived && !rerouting;
  const live = Boolean(pos) && !geoError && !rerouting && !arrived && nextStep != null;
  const parts = nextStep ? splitInstruction(nextStep.instruction) : null;
  const thenStep =
    live &&
    followingStep &&
    nextStep &&
    nextStep.maneuverKind !== 'arrive' &&
    remainingM != null &&
    remainingM < 800 &&
    // Distance from the next maneuver to the one after it.
    (followingStep.coordinates.length > 0 && nextStep.coordinates.length > 0
      ? stepLenM(nextStep) < THEN_WITHIN_M
      : false)
      ? followingStep
      : null;

  return (
    <div className="gm-nav" role="status" aria-label="Navigation">
      <div className={`gm-nav-card${live ? ' live' : ''}${arrived ? ' arrived' : ''}`}>
        {live && parts && nextStep ? (
          <div className="gm-nav-row">
            <span className="gm-nav-icon" aria-hidden="true">
              <ManeuverIcon maneuverKind={nextStep.maneuverKind} size={40} />
            </span>
            <div className="gm-nav-main">
              {remainingM != null && remainingM > 0 && (
                <span className="gm-nav-dist gm-tabular">{fmtNavDist(remainingM)}</span>
              )}
              <span className="gm-nav-text" title={nextStep.instruction}>
                {parts.road ? (
                  <>
                    <span className="gm-nav-verb">{parts.verb} </span>
                    <span className="gm-nav-road">{parts.road}</span>
                  </>
                ) : (
                  <span className="gm-nav-road">{parts.verb}</span>
                )}
              </span>
              {/* Full sentence for screen readers and text search; the visual
                  split above keeps the road name dominant. */}
              <span className="gm-sr-only">{nextStep.instruction}</span>
            </div>
          </div>
        ) : (
          <div className="gm-nav-row">
            <div className="gm-nav-main">
              {geoError ? (
                <span className="gm-nav-text gm-nav-status">{geoError}</span>
              ) : !pos ? (
                <span className="gm-nav-text gm-nav-wait">
                  <LoaderCircle size={20} aria-hidden="true" className="gm-spin" />
                  Acquiring GPS…
                </span>
              ) : rerouting ? (
                <span className="gm-nav-text gm-nav-wait" role="alert">
                  <RefreshCw size={20} aria-hidden="true" className="gm-spin" />
                  Rerouting…
                </span>
              ) : (
                <span className="gm-nav-text gm-nav-status">Arrived</span>
              )}
            </div>
          </div>
        )}
        {thenStep && (
          <div className="gm-nav-then">
            <span>Then</span>
            <ManeuverIcon maneuverKind={thenStep.maneuverKind} size={18} />
          </div>
        )}
      </div>

      {showCam && nextCam && (
        <p className="gm-nav-cam" role="alert">
          <span className="gm-nav-cam-pulse" aria-hidden="true">
            <Eye size={16} />
          </span>
          <span className="gm-tabular">Flock camera in ~{fmtNavDist(nextCam.aheadM)}</span>
        </p>
      )}

      {/* Follow-mode + voice controls stay top-anchored (under the card), where
          the bottom trip bar can never cover them. */}
      <div className="gm-nav-tools">
        {pos && (
          <button
            type="button"
            className="gm-nav-voice"
            aria-label={voiceOn ? 'Mute voice guidance' : 'Unmute voice guidance'}
            aria-pressed={voiceOn}
            title={voiceOn ? 'Mute voice guidance' : 'Unmute voice guidance'}
            onClick={onToggleVoice}
          >
            {voiceOn ? <Volume2 size={20} /> : <VolumeX size={20} />}
          </button>
        )}
        {!following && pos && (
          <button
            type="button"
            className="gm-nav-recenter"
            aria-label="Resume following my location"
            title="Resume following my location"
            onClick={onRecenter}
          >
            <LocateFixed size={18} />
            <span>Re-center</span>
          </button>
        )}
      </div>
    </div>
  );
}

function stepLenM(step: NavStep): number {
  const c = step.coordinates;
  let sum = 0;
  for (let i = 1; i < c.length; i++) {
    const dLat = (c[i][0] - c[i - 1][0]) * 111_320;
    const dLon = (c[i][1] - c[i - 1][1]) * 111_320 * Math.cos((c[i][0] * Math.PI) / 180);
    sum += Math.hypot(dLat, dLon);
  }
  return sum;
}
