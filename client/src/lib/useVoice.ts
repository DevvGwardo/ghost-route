// Navigation voice cues: one announcement per step, one per camera per plan,
// reroute + arrival interrupts. All bookkeeping lives in refs so the GPS
// re-render firehose never re-triggers speech; effects only speak on real
// state transitions (step lock advanced, new nearest camera, reroute start).
import { useEffect, useRef } from 'react';
import { browserSpeechBackend, createVoiceAnnouncer, type VoiceAnnouncer } from './voice';
import { fmtNavDist, type NavRouteInput, type NavStep, type UpcomingCamera } from './navigate';

export interface UseVoiceGuidanceOpts {
  /** Master switch — the banner toggle, persisted in prefs. */
  enabled: boolean;
  /** Route plan; an identity change (first plan, reroute landing) resets alerts. */
  route: NavRouteInput | null;
  arrived: boolean;
  rerouting: boolean;
  /** Stable between step locks — see useNavigation. */
  nextStep: NavStep | null;
  remainingM: number | null;
  /** Nearest camera ahead inside the alert window. */
  nextCam: UpcomingCamera | null;
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

export function useVoiceGuidance(opts: UseVoiceGuidanceOpts): void {
  const { enabled, route, arrived, rerouting, nextStep, remainingM, nextCam } = opts;
  const announcerRef = useRef<VoiceAnnouncer | null>(null);
  if (announcerRef.current === null) {
    announcerRef.current = createVoiceAnnouncer(browserSpeechBackend());
  }
  const lastStepRef = useRef<NavStep | null>(null);
  const alertedCamsRef = useRef<Set<string>>(new Set());
  const wasReroutingRef = useRef(false);
  const arrivedRef = useRef(false);

  // New plan: forget which steps/cameras were announced.
  useEffect(() => {
    lastStepRef.current = null;
    alertedCamsRef.current = new Set();
    arrivedRef.current = false;
  }, [route]);

  // Leaving navigation (or muting): stop any queued speech.
  useEffect(() => {
    if (!enabled) announcerRef.current?.cancel();
  }, [enabled]);

  // Maneuver: "In 400 m, turn left onto Main St" — once per step lock.
  useEffect(() => {
    if (!enabled || !nextStep) return;
    if (lastStepRef.current === nextStep) return;
    lastStepRef.current = nextStep;
    const dist = remainingM != null && remainingM > 0 ? `In ${fmtNavDist(remainingM)}, ` : '';
    announcerRef.current?.say(`${dist}${lowerFirst(nextStep.instruction)}`, { tag: 'step' });
  }, [enabled, nextStep, remainingM]);

  // Camera alert: once per camera per plan, at the nearest distance seen.
  useEffect(() => {
    if (!enabled || !nextCam || arrived) return;
    if (alertedCamsRef.current.has(nextCam.cameraId)) return;
    alertedCamsRef.current.add(nextCam.cameraId);
    announcerRef.current?.say(`Camera ahead in ${fmtNavDist(nextCam.aheadM)}`, {
      tag: `cam-${nextCam.cameraId}`,
    });
  }, [enabled, nextCam, arrived]);

  // Reroute: interrupts whatever is playing — this is the urgent one.
  useEffect(() => {
    if (!enabled) return;
    if (rerouting && !wasReroutingRef.current) {
      announcerRef.current?.say('Rerouting', { interrupt: true, tag: 'rerouting' });
    }
    wasReroutingRef.current = rerouting;
  }, [enabled, rerouting]);

  // Arrival: once, interrupting.
  useEffect(() => {
    if (!enabled || !arrived || arrivedRef.current) return;
    arrivedRef.current = true;
    announcerRef.current?.say('You have arrived', { interrupt: true });
  }, [enabled, arrived]);
}
