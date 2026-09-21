import { Eye, LoaderCircle, LocateFixed, OctagonAlert, RefreshCw, Volume2, VolumeX, X } from 'lucide-react';
import { fmtNavDist, type NavStep, type UpcomingCamera } from '../lib/navigate';
import { ManeuverIcon } from './TurnSteps';

// Presentational only: the GPS watch, step lock and off-route detection live
// in lib/useNavigation so the map and this banner share one source of truth.
interface NavigateBannerProps {
  /** Live fix as [lat, lon]; null until the first fix arrives. */
  pos: [number, number] | null;
  geoError: string | null;
  arrived: boolean;
  /** The maneuver to announce next. */
  nextStep: NavStep | null;
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
  onExit: () => void;
}

export default function NavigateBanner({
  pos,
  geoError,
  arrived,
  nextStep,
  remainingM,
  nextCam,
  rerouting,
  following,
  voiceOn,
  onRecenter,
  onToggleVoice,
  onExit,
}: NavigateBannerProps) {
  const showCam = nextCam != null && !arrived && !rerouting;

  return (
    <div className="gm-nav" role="status" aria-label="Navigation">
      <div className="gm-nav-row">
        <button
          type="button"
          className="gm-back-btn"
          aria-label="Stop navigation"
          title="Stop navigation"
          onClick={onExit}
        >
          <X size={22} />
        </button>
        <div className="gm-nav-main">
          {geoError ? (
            <span className="gm-nav-text">{geoError}</span>
          ) : !pos ? (
            <span className="gm-nav-text gm-nav-wait">
              <LoaderCircle size={18} aria-hidden="true" />
              Acquiring GPS…
            </span>
          ) : rerouting ? (
            <span className="gm-nav-text gm-nav-wait" role="alert">
              <RefreshCw size={18} aria-hidden="true" />
              Rerouting…
            </span>
          ) : arrived || !nextStep ? (
            <span className="gm-nav-text">Arrived</span>
          ) : (
            <>
              <span className="gm-nav-icon" aria-hidden="true">
                <ManeuverIcon maneuverKind={nextStep.maneuverKind} />
              </span>
              <span className="gm-nav-text" title={nextStep.instruction}>
                {remainingM != null && remainingM > 0 ? (
                  <>
                    In {fmtNavDist(remainingM)},{' '}
                    {nextStep.instruction.charAt(0).toLowerCase() +
                      nextStep.instruction.slice(1)}
                  </>
                ) : (
                  nextStep.instruction
                )}
              </span>
            </>
          )}
        </div>
        {/* Follow-mode + voice controls live in the banner (top-anchored)
            because a map-positioned control lands in the vertical band the
            bottom sheet occupies, which made it unclickable with the sheet
            open. */}
        {!following && pos && (
          <button
            type="button"
            className="gm-nav-recenter"
            aria-label="Resume following my location"
            title="Resume following my location"
            onClick={onRecenter}
          >
            <LocateFixed size={20} />
          </button>
        )}
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
      </div>
      {showCam && nextCam && (
        <p className="gm-nav-cam" role="alert">
          <Eye size={14} aria-hidden="true" />
          <OctagonAlert size={14} aria-hidden="true" />
          <span className="gm-tabular">Flock camera in ~{fmtNavDist(nextCam.aheadM)}</span>
        </p>
      )}
    </div>
  );
}
