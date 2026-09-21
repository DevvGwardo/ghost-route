import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layers, LocateFixed } from 'lucide-react';
import MapView, { type RecenterSignal } from './components/MapView';
import DirectionsCard from './components/DirectionsCard';
import NavigateBanner from './components/NavigateBanner';
import RouteSheet, { type CleanSearch } from './components/RouteSheet';
import { ApiError, getCameras, getHealth, getSystemStatus, isAbortError, postRoute } from './lib/api';
import { createRequestGuard, type RequestGuard } from './lib/requestGuard';
import { useNavigation } from './lib/useNavigation';
import { useVoiceGuidance } from './lib/useVoice';
import type { NavRouteInput } from './lib/navigate';
import type { GeoFix } from './lib/useGeoPosition';
import { TYPESAFE_KEY_STORAGE, type KeyValid } from './components/KeySettings';
// Deep links + browser-side memory (recents, saved places, preferences).
import { decodeRouteHash, encodeRouteHash, type RouteLinkOptions } from './lib/deeplink';
import {
  addRecent,
  loadPrefs,
  loadRecents,
  loadSaved,
  savePrefs,
  toggleSaved,
  type Place,
  type RecentTrip,
} from './lib/prefs';
// Contract types come from the shared module only — no hand-copied shapes.
import type { BBox, Camera, LatLon, ScoredRoute, TravelProfile } from '../../shared/src/types';
import './app.css';

// At most one off-route reroute per window: a bad GPS stretch (or a tunnel)
// must not hammer the routing backend. Consecutive FAILED reroutes back off
// (up to the max) so a dead backend costs one attempt per doubling, while a
// successful reroute resets the wait.
const REROUTE_COOLDOWN_MS = 15_000;
const REROUTE_BACKOFF_MAX_MS = 120_000;

const coordLabel = (p: LatLon): string => `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;

/** Unique by label + rounded coords, first occurrence wins. */
function dedupePlaces(list: Place[]): Place[] {
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const p of list) {
    const key = `${p.label.toLowerCase()}|${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export default function App() {
  // Boot state: a shared link wins over stored preferences, and both are
  // resolved once so later renders never re-read storage.
  const [boot] = useState(() => ({
    link: decodeRouteHash(typeof window === 'undefined' ? null : window.location.hash),
    prefs: loadPrefs(),
  }));
  const bootOptions = { ...boot.prefs, ...(boot.link?.options ?? {}) };

  const [origin, setOrigin] = useState<LatLon | null>(boot.link?.origin ?? null);
  const [destination, setDestination] = useState<LatLon | null>(boot.link?.destination ?? null);
  const [originLabel, setOriginLabel] = useState(
    boot.link ? coordLabel(boot.link.origin) : '',
  );
  const [destinationLabel, setDestinationLabel] = useState(
    boot.link ? coordLabel(boot.link.destination) : '',
  );
  const [avoidFlock, setAvoidFlock] = useState(bootOptions.avoidFlock);
  const [bufferMeters, setBufferMeters] = useState(bootOptions.bufferMeters);
  const [profile, setProfile] = useState<TravelProfile>(bootOptions.profile);
  const [respectDirection, setRespectDirection] = useState(bootOptions.respectDirection);
  const [verifiedOnly, setVerifiedOnly] = useState(bootOptions.verifiedOnly);
  const [brands, setBrands] = useState<string[]>(bootOptions.brands);
  const [voiceOn, setVoiceOn] = useState(boot.prefs.voice);
  const [recents, setRecents] = useState<RecentTrip[]>(() => loadRecents());
  const [savedPlaces, setSavedPlaces] = useState<Place[]>(() => loadSaved());
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [degradedDismissed, setDegradedDismissed] = useState(false);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [showCameras, setShowCameras] = useState(true);
  const [routes, setRoutes] = useState<ScoredRoute[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rankedBy, setRankedBy] = useState<string | null>(null);
  const [jevMode, setJevMode] = useState<string | null>(null);
  const [cleanSearch, setCleanSearch] = useState<CleanSearch | null>(null);
  const [typesafeKey, setTypesafeKey] = useState<string>(() => {
    try {
      return localStorage.getItem(TYPESAFE_KEY_STORAGE) ?? '';
    } catch {
      return '';
    }
  });
  const [keyValid, setKeyValid] = useState<KeyValid>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [recenter, setRecenter] = useState<RecenterSignal | null>(null);
  const [geoNotice, setGeoNotice] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const [followUser, setFollowUser] = useState(true);
  const [rerouting, setRerouting] = useState(false);
  const camDebounceRef = useRef<number | undefined>(undefined);
  const camAbortRef = useRef<AbortController | null>(null);
  // Supersession guard for route requests (monotonic seq + AbortController).
  const routeGuardRef = useRef<RequestGuard | null>(null);
  const lastRerouteRef = useRef(0);
  const rerouteBackoffRef = useRef(REROUTE_COOLDOWN_MS);

  const handleBoundsChange = useCallback((bbox: BBox) => {
    window.clearTimeout(camDebounceRef.current);
    // Cancel the previous bbox fetch too — the newest viewport is the only
    // one whose markers should land, even if an older request is slower.
    camAbortRef.current?.abort();
    const ctrl = new AbortController();
    camAbortRef.current = ctrl;
    camDebounceRef.current = window.setTimeout(async () => {
      try {
        const res = await getCameras(
          {
            minLon: bbox.minLon,
            minLat: bbox.minLat,
            maxLon: bbox.maxLon,
            maxLat: bbox.maxLat,
          },
          500,
          { signal: ctrl.signal },
        );
        if (ctrl.signal.aborted) return;
        setCameras(res.cameras);
      } catch (e) {
        if (isAbortError(e)) return; // superseded viewport — not an error
        setError(e instanceof Error ? e.message : 'Failed to load cameras');
      }
    }, 400);
  }, []);

  // Unmount: stop pending timers and every in-flight request.
  useEffect(
    () => () => {
      window.clearTimeout(camDebounceRef.current);
      camAbortRef.current?.abort();
      routeGuardRef.current?.abort();
    },
    [],
  );

  const handleKeyChange = useCallback((key: string) => {
    setTypesafeKey(key);
    try {
      if (key) localStorage.setItem(TYPESAFE_KEY_STORAGE, key);
      else localStorage.removeItem(TYPESAFE_KEY_STORAGE);
    } catch {
      /* private mode — key still applies for this session */
    }
  }, []);

  // Preferences persist across reloads (debounced so dragging the buffer
  // slider doesn't write on every frame). Storage failures are swallowed.
  useEffect(() => {
    const t = window.setTimeout(() => {
      savePrefs({ avoidFlock, bufferMeters, profile, respectDirection, verifiedOnly, brands, voice: voiceOn });
    }, 300);
    return () => window.clearTimeout(t);
  }, [avoidFlock, bufferMeters, profile, respectDirection, verifiedOnly, brands, voiceOn]);

  // Brand chips come from the cameras actually in view — no hardcoded list.
  const brandOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of cameras) {
      if (typeof c.brand !== 'string' || !c.brand) continue;
      counts.set(c.brand, (counts.get(c.brand) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([brand]) => brand);
  }, [cameras]);

  const originSuggestions = useMemo(
    () => dedupePlaces([...recents.map((r) => r.origin), ...savedPlaces]).slice(0, 5),
    [recents, savedPlaces],
  );
  const destinationSuggestions = useMemo(
    () => dedupePlaces([...recents.map((r) => r.destination), ...savedPlaces]).slice(0, 5),
    [recents, savedPlaces],
  );

  const handleToggleSave = useCallback((p: Place) => {
    setSavedPlaces(toggleSaved(p));
  }, []);

  // The option set that defines "this route" — used for both the URL hash and
  // the share payload, so the two can never drift apart.
  const linkOptions = useMemo<RouteLinkOptions>(
    () => ({ avoidFlock, bufferMeters, profile, respectDirection, verifiedOnly, brands }),
    [avoidFlock, bufferMeters, profile, respectDirection, verifiedOnly, brands],
  );

  // Degraded-mode notices (spec P2-3): self-hosters and keyless demos should
  // see WHY ranking/backends are limited instead of guessing.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const messages: string[] = [];
      try {
        const health = await getHealth();
        if (health.jev?.mode === 'fake') {
          messages.push('Heuristic ranking — add a JEV key for AI scoring');
        }
      } catch {
        /* unreachable server: the route request surfaces the real error */
      }
      try {
        const status = await getSystemStatus();
        if (status.routingBackend === 'demo') {
          messages.push('Public demo routing server — self-host OSRM for production');
        }
      } catch {
        /* status is informational only */
      }
      if (alive && messages.length > 0) setDegraded(messages.join(' · '));
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!shareNotice) return;
    const t = window.setTimeout(() => setShareNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [shareNotice]);

  // Core request, always from an EXPLICIT origin so an off-route reroute can
  // re-plan from the driver's live fix WITHOUT touching the planned
  // origin/destination (changing those would exit navigation).
  // Resolves true when a response was applied to the UI; false when the
  // request was superseded, aborted, or failed (drives reroute backoff).
  const requestRoutes = useCallback(
    async (from: LatLon, opts?: { record?: boolean }): Promise<boolean> => {
      if (!destination) return false;
      const guard = (routeGuardRef.current ??= createRequestGuard());
      // Supersede anything in flight: this call owns the UI from here on.
      const ticket = guard.begin();
      setLoading(true);
      setError(null);
      try {
        const key = typesafeKey.trim();
        const filter = {
          ...(verifiedOnly ? { verifiedOnly: true } : {}),
          ...(brands.length > 0 ? { brands } : {}),
        };
        const res = await postRoute(
          {
            origin: from,
            destination,
            avoidFlock,
            bufferMeters,
            respectDirection,
            profile,
            ...(Object.keys(filter).length > 0 ? { cameraFilter: filter } : {}),
          },
          { ...(key ? { typesafeKey: key } : {}), signal: ticket.signal },
        );
        if (!guard.isCurrent(ticket)) return false; // a newer request won the race
        setRoutes(res.routes);
        setRankedBy(res.rankedBy);
        setJevMode(res.jevMode);
        setCleanSearch(res.cleanSearch ?? null);
        setSelectedId(res.routes.length > 0 ? res.routes[0].id : null);
        // Server proved the key works — mark live even without explicit Test.
        if (res.rankedBy === 'jev' && res.jevMode === 'jev') setKeyValid(true);
        if (res.profileFallback) {
          setGeoNotice(`No ${profile} graph on this server — showing driving directions.`);
        }
        if (opts?.record) {
          // Remember the trip and make the current route a shareable link.
          // Only planned requests record: an off-route reroute starts from a
          // live GPS fix, which is not where the user asked to start.
          setRecents(
            addRecent({
              origin: { label: originLabel || coordLabel(from), lat: from.lat, lon: from.lon },
              destination: {
                label: destinationLabel || coordLabel(destination),
                lat: destination.lat,
                lon: destination.lon,
              },
            }),
          );
          try {
            window.history.replaceState(
              null,
              '',
              encodeRouteHash({ origin: from, destination, options: linkOptions }),
            );
          } catch {
            /* history unavailable (sandboxed iframe) — link still copyable */
          }
        }
        return true;
      } catch (e) {
        // An abort means a newer request superseded this one on purpose.
        if (isAbortError(e) || !guard.isCurrent(ticket)) return false;
        if (e instanceof ApiError && e.status === 429) {
          setError('Too many requests — wait a moment, then try again.');
        } else if (
          e instanceof ApiError &&
          e.status === 502 &&
          typeof e.body === 'object' &&
          e.body !== null &&
          (e.body as { reason?: unknown }).reason === 'implausible-routes'
        ) {
          setError('No sensible route found — try nearby points.');
        } else {
          setError(e instanceof Error ? e.message : 'Route request failed');
        }
      } finally {
        // Only the current request may clear the spinner — a stale one that
        // lost the race must not hide the newer request's loading state.
        if (guard.isCurrent(ticket)) setLoading(false);
      }
      return false;
    },
    [
      destination,
      destinationLabel,
      originLabel,
      avoidFlock,
      bufferMeters,
      profile,
      respectDirection,
      verifiedOnly,
      brands,
      typesafeKey,
      linkOptions,
    ],
  );

  const findRoute = useCallback(async () => {
    if (!origin) return;
    await requestRoutes(origin, { record: true });
  }, [origin, requestRoutes]);

  // Off-route recovery: re-plan from the live fix to the same destination.
  // The cooldown caps recovery attempts when GPS stays unreliable, and
  // consecutive failures escalate that wait — a dead backend costs one
  // attempt per doubling instead of one every 15 s forever.
  const handleOffRoute = useCallback(
    async (fix: GeoFix) => {
      const now = Date.now();
      if (now - lastRerouteRef.current < rerouteBackoffRef.current) return;
      lastRerouteRef.current = now;
      setRerouting(true);
      try {
        const ok = await requestRoutes({ lat: fix.lat, lon: fix.lon });
        rerouteBackoffRef.current = ok
          ? REROUTE_COOLDOWN_MS
          : Math.min(REROUTE_BACKOFF_MAX_MS, rerouteBackoffRef.current * 2);
      } finally {
        setRerouting(false);
      }
    },
    [requestRoutes],
  );

  // Auto-refetch (debounced) when origin/destination change — never on
  // slider/toggle drags (effect deps are only the endpoints). The ref always
  // points at the latest findRoute so option changes apply on manual search.
  const findRouteRef = useRef(findRoute);
  useEffect(() => {
    findRouteRef.current = findRoute;
  });
  useEffect(() => {
    if (!origin || !destination) return;
    // The endpoints just changed, so an in-flight request was planned for the
    // OLD endpoints and must never land. Invalidate it now: during the
    // debounce below there is no replacement request yet, so without this a
    // stale response could still write a route for the previous origin.
    routeGuardRef.current?.invalidate();
    const t = window.setTimeout(() => {
      void findRouteRef.current();
    }, 800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, destination]);

  // Map click/drag sets coords with no place label — mirror the coords into
  // the label so the search box never shows a stale place name.
  const handleOriginChange = useCallback((p: LatLon) => {
    setOrigin(p);
    setOriginLabel(`${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`);
  }, []);
  const handleDestinationChange = useCallback((p: LatLon) => {
    setDestination(p);
    setDestinationLabel(`${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`);
  }, []);

  const swapEndpoints = useCallback(() => {
    setOrigin(destination);
    setDestination(origin);
    setOriginLabel(destinationLabel);
    setDestinationLabel(originLabel);
  }, [origin, destination, originLabel, destinationLabel]);

  // Share the current route: native share sheet first, clipboard second, and
  // as a last resort show the URL so it can still be copied by hand.
  const shareRoute = useCallback(async () => {
    if (!origin || !destination) return;
    const url = `${window.location.origin}${window.location.pathname}${encodeRouteHash({
      origin,
      destination,
      options: linkOptions,
    })}`;
    try {
      if (typeof navigator.share === 'function') {
        // Race the share sheet: an environment where it neither resolves nor
        // rejects (no user-visible picker, headless) would otherwise leave the
        // click with no feedback at all. Time out and use the clipboard.
        const outcome = await Promise.race([
          navigator.share({ url }).then(
            () => 'shared' as const,
            () => 'failed' as const,
          ),
          new Promise<'timeout'>((resolve) => {
            window.setTimeout(() => resolve('timeout'), 2500);
          }),
        ]);
        if (outcome === 'shared') {
          setShareNotice('Route shared.');
          return;
        }
      }
    } catch {
      /* unsupported or cancelled — fall through to the clipboard */
    }
    try {
      await navigator.clipboard.writeText(url);
      setShareNotice('Link copied to clipboard.');
    } catch {
      setShareNotice(url);
    }
  }, [origin, destination, linkOptions]);

  const locateMe = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setGeoNotice('Geolocation is not available in this browser.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        setOrigin(p);
        setOriginLabel('Current location');
        setRecenter({ ...p, nonce: Date.now() });
      },
      () => setGeoNotice('Could not get your location.'),
      { timeout: 8000 },
    );
  }, []);

  useEffect(() => {
    if (!geoNotice) return;
    const t = window.setTimeout(() => setGeoNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [geoNotice]);

  // Leaving navigation whenever the endpoints change — the route is stale.
  useEffect(() => {
    setNavigating(false);
    setFollowUser(true);
    setRerouting(false);
    lastRerouteRef.current = 0;
    rerouteBackoffRef.current = REROUTE_COOLDOWN_MS;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, destination]);

  const startNavigation = useCallback(() => {
    setFollowUser(true);
    lastRerouteRef.current = 0;
    rerouteBackoffRef.current = REROUTE_COOLDOWN_MS;
    setRerouting(false);
    setNavigating(true);
  }, []);
  const stopNavigation = useCallback(() => {
    setNavigating(false);
    setFollowUser(true);
    setRerouting(false);
  }, []);

  const jevLive = jevMode === 'jev' && (keyValid === true || rankedBy === 'jev');

  const bestRoute = routes.find((r) => r.id === selectedId) ?? routes[0] ?? null;
  const canNavigate = Boolean(
    bestRoute?.coordinates?.length &&
      bestRoute?.coordinates.length >= 2 &&
      bestRoute?.steps?.some((s) => (s.coordinates?.length ?? 0) > 0),
  );

  // Stable identity while the plan is unchanged: useNavigation restarts
  // guidance whenever this object changes, and a reroute is exactly that.
  const navRoute = useMemo<NavRouteInput | null>(() => {
    if (!navigating || !bestRoute) return null;
    return {
      coordinates: bestRoute.coordinates,
      steps: (bestRoute.steps ?? []).map((s) => ({
        coordinates: s.coordinates ?? [],
        instruction: s.instruction,
        ...(s.maneuverKind ? { maneuverKind: s.maneuverKind } : {}),
      })),
      exposures: bestRoute.exposures,
    };
  }, [navigating, bestRoute]);

  // One GPS watch, one step lock, shared by the banner and the map.
  const nav = useNavigation({
    route: navRoute,
    enabled: navigating,
    onOffRoute: handleOffRoute,
  });

  // Spoken guidance (maneuvers, camera alerts, reroute/arrival) — opt-in
  // via the banner speaker toggle, persisted with the other prefs.
  useVoiceGuidance({
    enabled: voiceOn && navigating,
    route: navRoute,
    arrived: nav.arrived,
    rerouting,
    nextStep: nav.nextStep,
    remainingM: nav.remainingM,
    nextCam: nav.upcoming[0] ?? null,
  });

  return (
    <div className={`gm-root${sheetExpanded ? ' gm-sheet-open' : ''}`}>
      <main className="gm-map">
        <MapView
          origin={origin}
          destination={destination}
          onOriginChange={handleOriginChange}
          onDestinationChange={handleDestinationChange}
          onBoundsChange={handleBoundsChange}
          cameras={cameras}
          showCameras={showCameras}
          bufferMeters={bufferMeters}
          routes={routes}
          selectedId={selectedId}
          recenter={recenter}
          userPosition={nav.fix}
          followUser={followUser}
          onFollowUserChange={setFollowUser}
          nextManeuver={nav.nextManeuver}
          navCameras={nav.navCameras}
        />
      </main>

      <header className="gm-topcard" aria-label="Directions">
        {/* In the card's own flow, not an overlay: an absolutely positioned
            notice sat UNDER the sheet, so its Dismiss click fell through to
            the sheet — which started navigation instead of dismissing.
            Hidden while navigating so it never pushes the maneuver banner
            down or crowds the driver. */}
        {degraded && !degradedDismissed && !navRoute && (
          <div className="gm-degraded" role="status">
            <span>{degraded}</span>
            <button
              type="button"
              className="gm-degraded-x"
              aria-label="Dismiss notice"
              onClick={() => setDegradedDismissed(true)}
            >
              Dismiss
            </button>
          </div>
        )}
        {navRoute ? (
          <NavigateBanner
            pos={nav.fix ? [nav.fix.lat, nav.fix.lon] : null}
            geoError={nav.geoError}
            arrived={nav.arrived}
            nextStep={nav.nextStep}
            remainingM={nav.remainingM}
            nextCam={nav.upcoming[0] ?? null}
            rerouting={rerouting}
            following={followUser}
            voiceOn={voiceOn}
            onRecenter={() => setFollowUser(true)}
            onToggleVoice={() => setVoiceOn((v) => !v)}
            onExit={stopNavigation}
          />
        ) : (
          <DirectionsCard
          origin={origin}
          destination={destination}
          originLabel={originLabel}
          destinationLabel={destinationLabel}
          onOriginText={setOriginLabel}
          onDestinationText={setDestinationLabel}
          onOriginPick={(p, label) => {
            setOrigin(p);
            setOriginLabel(label);
          }}
          onDestinationPick={(p, label) => {
            setDestination(p);
            setDestinationLabel(label);
          }}
          onSwap={swapEndpoints}
          onBack={() => setSheetExpanded(false)}
          avoidFlock={avoidFlock}
          onAvoidFlockChange={setAvoidFlock}
          bufferMeters={bufferMeters}
          onBufferMetersChange={setBufferMeters}
          profile={profile}
          onProfileChange={setProfile}
          respectDirection={respectDirection}
          onRespectDirectionChange={setRespectDirection}
          verifiedOnly={verifiedOnly}
          onVerifiedOnlyChange={setVerifiedOnly}
          brandOptions={brandOptions}
          brands={brands}
          onBrandsChange={setBrands}
          originSuggestions={originSuggestions}
          destinationSuggestions={destinationSuggestions}
          savedPlaces={savedPlaces}
          onToggleSave={handleToggleSave}
          onFind={findRoute}
          loading={loading}
          error={error}
          typesafeKey={typesafeKey}
          onKeyChange={handleKeyChange}
          keyValid={keyValid}
          onKeyValidChange={setKeyValid}
        />
        )}
      </header>

      <div className="gm-fabs">
        <button
          type="button"
          className="gm-fab"
          aria-label="Use my location as origin"
          title="Use my location as origin"
          onClick={locateMe}
        >
          <LocateFixed size={20} />
        </button>
        <button
          type="button"
          className="gm-fab"
          aria-label={showCameras ? 'Hide Flock cameras' : 'Show Flock cameras'}
          title={showCameras ? 'Hide Flock cameras' : 'Show Flock cameras'}
          aria-pressed={showCameras}
          onClick={() => setShowCameras((v) => !v)}
        >
          <Layers size={20} />
        </button>
      </div>

      {geoNotice && (
        <p className="gm-toast" role="status">
          {geoNotice}
        </p>
      )}

      <RouteSheet
        routes={routes}
        selectedId={selectedId}
        onSelect={setSelectedId}
        loading={loading}
        expanded={sheetExpanded}
        onToggle={() => setSheetExpanded((v) => !v)}
        rankedBy={rankedBy}
        jevMode={jevMode}
        jevLive={jevLive}
        cleanSearch={cleanSearch}
        onFind={findRoute}
        navigating={navigating}
        canNavigate={canNavigate}
        onToggleNavigate={navigating ? stopNavigation : startNavigation}
        onShare={shareRoute}
        shareNotice={shareNotice}
      />

    </div>
  );
}
