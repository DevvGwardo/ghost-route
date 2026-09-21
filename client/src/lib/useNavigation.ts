// Navigation session state: one GPS feed, current step, remaining distance,
// imminent cameras, and confirmed off-route detection.
//
// This lives outside the banner so the map and the banner drive off the SAME
// fix and the SAME step lock (previously the banner owned both, and the map
// could not follow the driver or mark the next turn).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ARRIVED_M,
  createOffRouteTracker,
  distToRoute,
  locateStep,
  nearestIndex,
  upcomingCameras,
  type NavRouteInput,
  type NavStep,
  type UpcomingCamera,
} from './navigate';
import { useGeoPosition, type GeoFix } from './useGeoPosition';
import type { LatLon } from '../../../shared/src/types';

export interface NavigationState {
  fix: GeoFix | null;
  geoError: string | null;
  /** Index of the step the driver is currently on. */
  locked: number;
  /** Meters remaining in the current step (null until the first lock). */
  remainingM: number | null;
  arrived: boolean;
  /** Nearest route-point index — drives the traveled/remaining split. */
  userIdx: number;
  /** The maneuver to announce next (null once arrived). */
  nextStep: NavStep | null;
  /** Position of the upcoming maneuver, for the map chevron. */
  nextManeuver: LatLon | null;
  /** Cameras ahead inside the alert window, nearest first. */
  upcoming: UpcomingCamera[];
  /** Same cameras as positions, for the map highlight ring. */
  navCameras: LatLon[];
  /** True once the driver has been consistently off the planned route. */
  offRoute: boolean;
}

export interface UseNavigationOpts {
  route: NavRouteInput | null;
  enabled: boolean;
  /**
   * Fired when the driver is CONFIRMED off-route. The caller owns the reroute
   * (and its cooldown) — this hook only reports the condition.
   */
  onOffRoute?: (fix: GeoFix) => void;
}

export function useNavigation({ route, enabled, onOffRoute }: UseNavigationOpts): NavigationState {
  const { fix, error: geoError } = useGeoPosition(enabled);
  const [locked, setLocked] = useState(0);
  const [remainingM, setRemainingM] = useState<number | null>(null);
  const [offRoute, setOffRoute] = useState(false);
  const lockedRef = useRef(0);
  const trackerRef = useRef(createOffRouteTracker());
  const onOffRouteRef = useRef(onOffRoute);
  useEffect(() => {
    onOffRouteRef.current = onOffRoute;
  });

  // A new route object (first plan, or a reroute landing) restarts guidance.
  useEffect(() => {
    lockedRef.current = 0;
    setLocked(0);
    setRemainingM(null);
    setOffRoute(false);
    trackerRef.current.reset();
  }, [route]);

  // Exposure → route index is a property of the route: compute once.
  const exposuresIdx = useMemo(() => {
    if (!route) return [];
    return route.exposures.map((e) => ({
      ...e,
      routeIdx: nearestIndex(route.coordinates, [e.lat, e.lon]).index,
    }));
  }, [route]);

  useEffect(() => {
    if (!route || !fix) return;
    const p: [number, number] = [fix.lat, fix.lon];
    const loc = locateStep(route.steps, p, lockedRef.current);
    if (loc) {
      lockedRef.current = loc.step;
      setLocked(loc.step);
      setRemainingM(loc.remainingM);
    }
    // Off-route is distance-based (more robust than a null locateStep, which
    // also goes null at the start of a leg before GPS settles).
    const st = trackerRef.current.update(distToRoute(route.coordinates, p));
    setOffRoute(st.offRoute);
    if (st.offRoute) onOffRouteRef.current?.(fix);
  }, [route, fix]);

  const userIdx = useMemo(
    () => (route && fix ? nearestIndex(route.coordinates, [fix.lat, fix.lon]).index : 0),
    [route, fix],
  );

  const lastIdx = route ? route.steps.length - 1 : 0;
  const arrived = Boolean(
    route && locked >= lastIdx && remainingM != null && remainingM <= ARRIVED_M,
  );

  const nextStep = useMemo(() => {
    if (!route || arrived) return null;
    return route.steps[Math.min(locked + 1, lastIdx)] ?? null;
  }, [route, arrived, locked, lastIdx]);

  const nextManeuver = useMemo<LatLon | null>(() => {
    const c = nextStep?.coordinates?.[0];
    return c ? { lat: c[0], lon: c[1] } : null;
  }, [nextStep]);

  const upcoming = useMemo<UpcomingCamera[]>(() => {
    if (!route) return [];
    return upcomingCameras(exposuresIdx, route.coordinates, userIdx);
  }, [route, exposuresIdx, userIdx]);

  const navCameras = useMemo<LatLon[]>(() => {
    if (!route) return [];
    const byId = new Map(route.exposures.map((e) => [e.cameraId, e]));
    const out: LatLon[] = [];
    for (const u of upcoming) {
      const e = byId.get(u.cameraId);
      if (e) out.push({ lat: e.lat, lon: e.lon });
    }
    return out;
  }, [route, upcoming]);

  return {
    fix,
    geoError,
    locked,
    remainingM,
    arrived,
    userIdx,
    nextStep,
    nextManeuver,
    upcoming,
    navCameras,
    offRoute,
  };
}
