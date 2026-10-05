// Navigation session state: one GPS feed, current step, remaining distance,
// imminent cameras, and confirmed off-route detection.
//
// This lives outside the banner so the map and the banner drive off the SAME
// fix and the SAME step lock (previously the banner owned both, and the map
// could not follow the driver or mark the next turn).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ARRIVED_M,
  SNAP_M,
  bearingDeg,
  createOffRouteTracker,
  cumulativeM,
  distToRoute,
  havM,
  locateStep,
  nearestIndex,
  projectOnRoute,
  remainingSeconds,
  routeBearingAt,
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
  /**
   * What the map should draw and follow: the fix snapped onto the road when
   * close to it, with a usable heading even when the device reports none.
   */
  puck: GeoFix | null;
  /** The maneuver after `nextStep` (for a "Then …" preview). */
  followingStep: NavStep | null;
  /** Meters left to the destination along the route (null before a fix). */
  remainingRouteM: number | null;
  /** Estimated seconds left, scaled from the route's own duration. */
  remainingS: number | null;
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

  // Snapping + heading. Device heading wins when the phone reports one;
  // otherwise the road's own direction at the snapped point (on-route), then
  // the direction of travel between fixes (off-route), then the last value.
  const cum = useMemo(() => (route ? cumulativeM(route.coordinates) : []), [route]);
  const prevFixRef = useRef<GeoFix | null>(null);
  const headingRef = useRef<number | null>(null);
  useEffect(() => {
    prevFixRef.current = null;
    headingRef.current = null;
  }, [route]);
  const projection = useMemo(
    () => (route && fix ? projectOnRoute(route.coordinates, [fix.lat, fix.lon], cum) : null),
    [route, fix, cum],
  );
  const puck = useMemo<GeoFix | null>(() => {
    if (!fix) return null;
    const onRoute = projection != null && projection.distM <= SNAP_M;
    let heading: number | null = fix.heading;
    if (heading == null && onRoute && route) heading = routeBearingAt(route.coordinates, projection);
    if (heading == null) {
      const prev = prevFixRef.current;
      if (prev && havM([prev.lat, prev.lon], [fix.lat, fix.lon]) >= 5) {
        heading = bearingDeg([prev.lat, prev.lon], [fix.lat, fix.lon]);
      }
    }
    if (heading == null) heading = headingRef.current;
    const [lat, lon] = onRoute ? projection.point : [fix.lat, fix.lon];
    return { ...fix, lat, lon, heading };
  }, [fix, projection, route]);
  useEffect(() => {
    if (!fix) return;
    if (puck?.heading != null) headingRef.current = puck.heading;
    const prev = prevFixRef.current;
    if (!prev || havM([prev.lat, prev.lon], [fix.lat, fix.lon]) >= 5) prevFixRef.current = fix;
  }, [fix, puck]);

  const remainingRouteM = useMemo(() => {
    if (!projection || cum.length === 0) return null;
    return Math.max(0, cum[cum.length - 1] - projection.alongM);
  }, [projection, cum]);
  const remainingS = useMemo(() => {
    if (remainingRouteM == null || !route) return null;
    const totalM = route.distanceM && route.distanceM > 0 ? route.distanceM : cum[cum.length - 1] ?? 0;
    // No server duration (old fixtures): assume ~40 km/h urban driving.
    const totalS = route.durationS && route.durationS > 0 ? route.durationS : totalM / 11;
    return remainingSeconds(remainingRouteM, totalM, totalS);
  }, [remainingRouteM, route, cum]);

  const lastIdx = route ? route.steps.length - 1 : 0;
  // Two ways to arrive: the step lock reaches the final step (the original
  // rule), or the snapped fix is within ARRIVED_M of the route's end. The
  // second matters because OSRM's final "arrive" step is zero-length: the
  // step before it stays inside STEP_LOCK_M at the destination and wins the
  // lock, so the first rule alone never fired on real routes.
  const arrived = Boolean(
    route &&
      ((locked >= lastIdx && remainingM != null && remainingM <= ARRIVED_M) ||
        (remainingRouteM != null &&
          remainingRouteM <= ARRIVED_M &&
          projection != null &&
          projection.distM <= SNAP_M)),
  );

  const userIdx = useMemo(
    () => (route && fix ? nearestIndex(route.coordinates, [fix.lat, fix.lon]).index : 0),
    [route, fix],
  );


  const nextStep = useMemo(() => {
    if (!route || arrived) return null;
    return route.steps[Math.min(locked + 1, lastIdx)] ?? null;
  }, [route, arrived, locked, lastIdx]);

  const followingStep = useMemo(() => {
    if (!route || arrived) return null;
    const i = locked + 2;
    return i <= lastIdx ? route.steps[i] ?? null : null;
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
    puck,
    followingStep,
    remainingRouteM,
    remainingS,
  };
}
