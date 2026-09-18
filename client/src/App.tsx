import { useCallback, useEffect, useRef, useState } from 'react';
import { Layers, LocateFixed } from 'lucide-react';
import MapView, { type BBox, type RecenterSignal } from './components/MapView';
import DirectionsCard from './components/DirectionsCard';
import RouteSheet from './components/RouteSheet';
import { ApiError, getCameras, postRoute } from './lib/api';
import { TYPESAFE_KEY_STORAGE } from './components/KeySettings';
import './app.css';

// Local minimal copies of the brief's shapes (api agent owns lib/api.ts + shared/types.ts).
export interface LatLon {
  lat: number;
  lon: number;
}
export interface Camera {
  id: string;
  lat: number;
  lon: number;
  source: string;
  address?: string;
  verified: boolean;
}
export interface RouteExposure {
  cameraId: string;
  lat: number;
  lon: number;
  distM: number;
}
export interface RankedRoute {
  id: string;
  coordinates: [number, number][];
  distanceM: number;
  durationS: number;
  exposures: RouteExposure[];
  exposureCount: number;
  score: number;
  jev: { choice: string; confidence: number; fallbackUsed: boolean };
  steps?: {
    index: number;
    instruction: string;
    maneuver?: string;
    distanceM: number;
    durationS?: number;
    exposureP?: number;
    cameraIds?: string[];
  }[];
  exposureP?: number;
  jevExposure?: { p: number; confidence: number; fallbackUsed: boolean; source: string };
}

const DEFAULT_ORIGIN: LatLon = { lat: 30.2672, lon: -97.7431 };
const DEFAULT_DEST: LatLon = { lat: 30.3, lon: -97.75 };

export default function App() {
  const [origin, setOrigin] = useState<LatLon>(DEFAULT_ORIGIN);
  const [destination, setDestination] = useState<LatLon>(DEFAULT_DEST);
  const [originLabel, setOriginLabel] = useState('Downtown Austin, TX');
  const [destinationLabel, setDestinationLabel] = useState('North Austin, TX');
  const [avoidFlock, setAvoidFlock] = useState(true);
  const [bufferMeters, setBufferMeters] = useState(150);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [showCameras, setShowCameras] = useState(true);
  const [routes, setRoutes] = useState<RankedRoute[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rankedBy, setRankedBy] = useState<string | null>(null);
  const [jevMode, setJevMode] = useState<string | null>(null);
  const [typesafeKey, setTypesafeKey] = useState<string>(() => {
    try {
      return localStorage.getItem(TYPESAFE_KEY_STORAGE) ?? '';
    } catch {
      return '';
    }
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [recenter, setRecenter] = useState<RecenterSignal | null>(null);
  const [geoNotice, setGeoNotice] = useState<string | null>(null);
  const camDebounceRef = useRef<number | undefined>(undefined);

  const handleBoundsChange = useCallback((bbox: BBox) => {
    window.clearTimeout(camDebounceRef.current);
    camDebounceRef.current = window.setTimeout(async () => {
      try {
        const res = await getCameras({
          minLon: bbox.minLon,
          minLat: bbox.minLat,
          maxLon: bbox.maxLon,
          maxLat: bbox.maxLat,
        });
        setCameras(res.cameras);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load cameras');
      }
    }, 400);
  }, []);

  useEffect(() => () => window.clearTimeout(camDebounceRef.current), []);

  const handleKeyChange = useCallback((key: string) => {
    setTypesafeKey(key);
    try {
      if (key) localStorage.setItem(TYPESAFE_KEY_STORAGE, key);
      else localStorage.removeItem(TYPESAFE_KEY_STORAGE);
    } catch {
      /* private mode — key still applies for this session */
    }
  }, []);

  const findRoute = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const key = typesafeKey.trim();
      const res = await postRoute(
        { origin, destination, avoidFlock, bufferMeters },
        key ? { typesafeKey: key } : undefined,
      );
      setRoutes(res.routes);
      setRankedBy(res.rankedBy);
      setJevMode(res.jevMode);
      setSelectedId(res.routes.length > 0 ? res.routes[0].id : null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) {
        setError('Too many requests — wait a moment, then try again.');
      } else {
        setError(e instanceof Error ? e.message : 'Route request failed');
      }
    } finally {
      setLoading(false);
    }
  }, [origin, destination, avoidFlock, bufferMeters, typesafeKey]);

  // Auto-refetch (debounced) when origin/destination change — never on
  // slider/toggle drags (effect deps are only the endpoints). The ref always
  // points at the latest findRoute so option changes apply on manual search.
  const findRouteRef = useRef(findRoute);
  useEffect(() => {
    findRouteRef.current = findRoute;
  });
  useEffect(() => {
    const t = window.setTimeout(() => {
      void findRouteRef.current();
    }, 800);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, destination]);

  const swapEndpoints = useCallback(() => {
    setOrigin(destination);
    setDestination(origin);
    setOriginLabel(destinationLabel);
    setDestinationLabel(originLabel);
  }, [origin, destination, originLabel, destinationLabel]);

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

  const jevLive = typesafeKey.trim().length > 0 || jevMode === 'jev';

  return (
    <div className="gm-root">
      <main className="gm-map">
        <MapView
          origin={origin}
          destination={destination}
          onOriginChange={setOrigin}
          onDestinationChange={setDestination}
          onBoundsChange={handleBoundsChange}
          cameras={cameras}
          showCameras={showCameras}
          bufferMeters={bufferMeters}
          routes={routes}
          selectedId={selectedId}
          recenter={recenter}
        />
      </main>

      <header className="gm-topcard" aria-label="Directions">
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
          onFind={findRoute}
          loading={loading}
          error={error}
          typesafeKey={typesafeKey}
          onKeyChange={handleKeyChange}
        />
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
        onFind={findRoute}
      />
    </div>
  );
}
