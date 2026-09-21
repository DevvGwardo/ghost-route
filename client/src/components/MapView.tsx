import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { BBox, Camera, LatLon, ScoredRoute } from '../../../shared/src/types';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Box, Mountain } from 'lucide-react';
import CameraLayer from './CameraLayer';
import { nearestIndex } from '../lib/navigate';
import type { GeoFix } from '../lib/useGeoPosition';

// Contract-derived types (shared/src/types.ts is the single source of truth).
export type { BBox, LatLon };
export type MapCamera = Camera;
/** Narrow view of a scored route: drawable geometry + exposure summary. */
export type MapRoute = Pick<
  ScoredRoute,
  'id' | 'coordinates' | 'exposureCount' | 'isClean'
>;
export interface RecenterSignal extends LatLon {
  nonce: number;
}

interface MapViewProps {
  origin: LatLon | null;
  destination: LatLon | null;
  onOriginChange: (p: LatLon) => void;
  onDestinationChange: (p: LatLon) => void;
  onBoundsChange: (b: BBox) => void;
  cameras: MapCamera[];
  showCameras: boolean;
  bufferMeters: number;
  routes: MapRoute[];
  selectedId: string | null;
  recenter: RecenterSignal | null;
  // --- navigation (all optional: absent outside a navigation session) ---
  /** Live GPS fix; renders the user dot and drives follow mode. */
  userPosition?: GeoFix | null;
  /** While true the camera tracks the fix (bearing = heading). */
  followUser?: boolean;
  /**
   * Called with `false` when the user pans away from follow mode. Resuming is
   * handled by the navigation banner's control (see NavigateBanner), which
   * cannot be occluded by the bottom sheet.
   */
  onFollowUserChange?: (following: boolean) => void;
  /** Upcoming maneuver position, marked with a chevron. */
  nextManeuver?: LatLon | null;
  /** Cameras ahead inside the alert window, ring-highlighted. */
  navCameras?: LatLon[];
}

const FOLLOW_ZOOM = 16;
const DRIVEN_COLOR = '#bdc1c6';

const VOYAGER_STYLE = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
const AUSTIN_LON = -97.7465;
const AUSTIN_LAT = 30.2836;

const VIEWPORT_STORAGE = 'ghostroute.viewport';

function savedViewport(): { lon: number; lat: number; zoom: number } | null {
  try {
    const raw = localStorage.getItem(VIEWPORT_STORAGE);
    if (!raw) return null;
    const v = JSON.parse(raw) as { lon?: unknown; lat?: unknown; zoom?: unknown };
    if (
      typeof v.lon !== 'number' || !Number.isFinite(v.lon) || v.lon < -180 || v.lon > 180 ||
      typeof v.lat !== 'number' || !Number.isFinite(v.lat) || v.lat < -85 || v.lat > 85 ||
      typeof v.zoom !== 'number' || !Number.isFinite(v.zoom) || v.zoom < 0 || v.zoom > 22
    ) {
      return null;
    }
    return { lon: v.lon, lat: v.lat, zoom: v.zoom };
  } catch {
    return null;
  }
}

const SELECTED_BLUE = '#1a73e8';
const ALT_GRAY = '#9aa0a6';

const PITCH_3D = 60;
const BEARING_3D = -15;

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// Auto-3D tilt only on wide viewports: pitched 3D with extruded buildings
// costs mobile GPUs and shrinks the readable map on small screens.
// The manual 3D toggle always works regardless of viewport.
function wideViewport(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(min-width: 700px)').matches
  );
}

function emitBounds(m: maplibregl.Map, fn: (b: BBox) => void) {
  const b = m.getBounds();
  // Normalize so world/US zoom-outs still produce a server-valid bbox:
  // maplibre can report lng beyond ±180 when zoomed far out, which the
  // cameras endpoint treats as empty. Clamp + keep min < max.
  const clampLon = (v: number) => Math.min(180, Math.max(-180, v));
  const clampLat = (v: number) => Math.min(85, Math.max(-85, v));
  const w = clampLon(b.getWest());
  const e = clampLon(b.getEast());
  const s = clampLat(b.getSouth());
  const n = clampLat(b.getNorth());
  fn({
    minLon: Math.min(w, e),
    minLat: Math.min(s, n),
    maxLon: Math.max(w, e),
    maxLat: Math.max(s, n),
  });
}

// Subtle 3D buildings when the Voyager style exposes a building source.
// Never throws: a missing source leaves the flat map untouched.
function tryAddBuildings(map: maplibregl.Map) {
  try {
    if (!map.isStyleLoaded()) return;
    if (!map.getSource('carto') || map.getLayer('gr-buildings-3d')) return;
    const firstSymbol = map
      .getStyle()
      ?.layers?.find((l: maplibregl.LayerSpecification) => l.type === 'symbol')?.id;
    map.addLayer(
      {
        id: 'gr-buildings-3d',
        type: 'fill-extrusion',
        source: 'carto',
        'source-layer': 'building',
        minzoom: 14,
        paint: {
          'fill-extrusion-color': '#d4d7db',
          'fill-extrusion-height': [
            'coalesce',
            ['get', 'render_height'],
            ['get', 'height'],
            12,
          ],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.7,
        },
      } as maplibregl.FillExtrusionLayerSpecification,
      firstSymbol,
    );
  } catch {
    /* missing source or schema drift — keep the flat map */
  }
}

// Route polylines, Google-Maps style: white casing + colored fill.
// Selected = blue, alternatives = gray. Selected layers added last (on top).
// NOTE: `-driven` overlays (the traveled portion of the selected route) are
// owned by their own effect and deliberately survive this teardown —
// rebuilding every route layer on each GPS fix would be needlessly costly.
function syncRouteLayers(map: maplibregl.Map, routes: MapRoute[], selectedId: string | null) {
  const style = map.getStyle();
  for (const l of [...(style?.layers ?? [])]) {
    if (l.id.startsWith('gr-route-') && !l.id.endsWith('-driven') && map.getLayer(l.id)) {
      map.removeLayer(l.id);
    }
  }
  for (const id of Object.keys(style?.sources ?? {})) {
    if (id.startsWith('gr-route-') && !id.endsWith('-driven') && map.getSource(id)) {
      map.removeSource(id);
    }
  }
  const ordered = [...routes].sort((a, b) =>
    a.id === selectedId ? 1 : b.id === selectedId ? -1 : 0,
  );
  for (const r of ordered) {
    if (r.coordinates.length < 2) continue;
    const isSel = r.id === selectedId;
    const data: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: r.coordinates.map(([la, lo]) => [lo, la]),
          },
        },
      ],
    };
    const srcId = `gr-route-${r.id}`;
    map.addSource(srcId, { type: 'geojson', data });
    const layout = { 'line-join': 'round', 'line-cap': 'round' } as const;
    map.addLayer({
      id: `${srcId}-casing`,
      type: 'line',
      source: srcId,
      layout,
      paint: { 'line-color': '#ffffff', 'line-width': isSel ? 9 : 7, 'line-opacity': 0.95 },
    });
    map.addLayer({
      id: `${srcId}-fill`,
      type: 'line',
      source: srcId,
      layout,
      paint: {
        'line-color': isSel ? SELECTED_BLUE : ALT_GRAY,
        'line-width': isSel ? 5 : 4,
        'line-opacity': selectedId && !isSel ? 0.75 : 1,
      },
    });
  }
}

/**
 * Traveled-portion overlay for the selected route: a muted line over the
 * already-driven part, so the remaining blue line reads as the live
 * instruction. Uses `setData` on the existing source so per-fix updates do not
 * tear down and re-upload the whole route geometry.
 */
function syncDrivenOverlay(
  map: maplibregl.Map,
  sel: MapRoute | null,
  traveledIdx: number,
) {
  const srcId = sel ? `gr-route-${sel.id}-driven` : null;
  try {
    const style = map.getStyle();
    // Drop overlays that no longer belong to the selected route.
    for (const l of [...(style?.layers ?? [])]) {
      if (l.id.endsWith('-driven') && l.id !== srcId && map.getLayer(l.id)) map.removeLayer(l.id);
    }
    for (const id of Object.keys(style?.sources ?? {})) {
      if (id.endsWith('-driven') && id !== srcId && map.getSource(id)) map.removeSource(id);
    }
    if (!srcId || !sel) return;
    const driven = traveledIdx > 0 ? sel.coordinates.slice(0, traveledIdx + 1) : [];
    if (driven.length < 2) {
      if (map.getLayer(srcId)) map.removeLayer(srcId);
      if (map.getSource(srcId)) map.removeSource(srcId);
      return;
    }
    const data: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: driven.map(([la, lo]) => [lo, la]),
          },
        },
      ],
    };
    const existing = map.getSource(srcId) as maplibregl.GeoJSONSource | undefined;
    if (existing && typeof existing.setData === 'function') {
      existing.setData(data);
      // Route layers are torn down and re-added on every plan change, which
      // would bury this overlay underneath them again.
      if (map.getLayer(srcId)) map.moveLayer(srcId);
      return;
    }
    map.addSource(srcId, { type: 'geojson', data });
    map.addLayer({
      id: srcId,
      type: 'line',
      source: srcId,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': DRIVEN_COLOR, 'line-width': 5, 'line-opacity': 0.9 },
    });
  } catch {
    /* the overlay must never break the map */
  }
}

function markerEl(kind: 'origin' | 'dest'): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `gm-marker ${kind}`;
  el.title = kind === 'origin' ? 'Origin' : 'Destination';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', kind === 'origin' ? 'Origin marker' : 'Destination marker');
  return el;
}

export default function MapView(props: MapViewProps) {
  const {
    origin,
    destination,
    cameras,
    showCameras,
    bufferMeters,
    routes,
    selectedId,
    recenter,
    userPosition = null,
    followUser = false,
    nextManeuver = null,
    navCameras,
  } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const originMarkerRef = useRef<maplibregl.Marker | null>(null);
  const destMarkerRef = useRef<maplibregl.Marker | null>(null);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const nextMarkerRef = useRef<maplibregl.Marker | null>(null);
  const followRef = useRef(false);
  const phaseRef = useRef<'origin' | 'dest'>('origin');
  const recenterNonceRef = useRef(0);
  // Manual 3D/2D override sticks until a new route result arrives.
  const overrideRef = useRef(false);
  const prevRoutesRef = useRef(routes);
  const prevTargetKeyRef = useRef('');
  const prevFittedRoutesRef = useRef(routes);
  const prevPitchRef = useRef(0);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [is3D, setIs3D] = useState(false);

  const onOriginRef = useRef(props.onOriginChange);
  const onDestRef = useRef(props.onDestinationChange);
  const onBoundsRef = useRef(props.onBoundsChange);
  const onFollowRef = useRef(props.onFollowUserChange);
  useEffect(() => {
    onOriginRef.current = props.onOriginChange;
    onDestRef.current = props.onDestinationChange;
    onBoundsRef.current = props.onBoundsChange;
    onFollowRef.current = props.onFollowUserChange;
  });
  useEffect(() => {
    followRef.current = followUser;
  }, [followUser]);

  // Init map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    // Self-hosted worker (client/public/gr-map-*): vite dev cannot resolve
    // maplibre's default worker URL (and the original filename collides with
    // the dep optimizer), which leaves tiles unrendered. Re-copy on upgrade.
    // NOTE: new files under public/ need a dev-server restart to be served.
    maplibregl.setWorkerUrl('/gr-map-worker.mjs');
    const start = savedViewport();
    const m = new maplibregl.Map({
      container: containerRef.current,
      style: VOYAGER_STYLE,
      center: start ? [start.lon, start.lat] : [AUSTIN_LON, AUSTIN_LAT],
      zoom: start ? start.zoom : 13,
      pitch: 0,
      bearing: 0,
    });
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    // Debounced bounds emission: rapid pan/zoom gestures settle into one
    // onBoundsChange call, and the timer id doubles as stale suppression —
    // only the latest viewport's bbox is ever emitted.
    let boundsTimer: number | undefined;
    const scheduleBounds = () => {
      window.clearTimeout(boundsTimer);
      boundsTimer = window.setTimeout(() => {
        try {
          emitBounds(m, onBoundsRef.current);
        } catch {
          /* bounds read must never break the map */
        }
        // Remember viewport for next visit (best-effort, private mode safe).
        try {
          const c = m.getCenter();
          localStorage.setItem(
            VIEWPORT_STORAGE,
            JSON.stringify({ lon: c.lng, lat: c.lat, zoom: m.getZoom() }),
          );
        } catch {
          /* storage must never break the map */
        }
      }, 200);
    };
    m.on('click', (e: maplibregl.MapMouseEvent) => {
      const p = { lat: e.lngLat.lat, lon: e.lngLat.lng };
      if ((e.originalEvent as MouseEvent).altKey) {
        // Alt-click restarts picking from here.
        onOriginRef.current(p);
        phaseRef.current = 'dest';
        return;
      }
      if (phaseRef.current === 'origin') {
        onOriginRef.current(p);
        phaseRef.current = 'dest';
      } else {
        onDestRef.current(p);
      }
    });
    m.on('moveend', scheduleBounds);
    // moveend covers most pan/zoom gestures, but a wheel-zoom that never
    // starts a "move" (or a programmatic zoom) may only fire zoomend —
    // funnel both into the same debounced emitter so every viewport,
    // from street to full-US, triggers a cameras fetch in App.
    m.on('zoomend', scheduleBounds);
    m.on('load', () => {
      tryAddBuildings(m);
      scheduleBounds();
    });
    tryAddBuildings(m);
    mapRef.current = m;
    setMap(m);
    // Dev-only observable handle: the map's camera state lives inside WebGL, so
    // without this the follow/heading wiring cannot be inspected or asserted
    // from the browser. Stripped from production builds (DEV is inlined false).
    if (import.meta.env.DEV) {
      (window as unknown as { __grMap?: maplibregl.Map }).__grMap = m;
    }
    emitBounds(m, onBoundsRef.current);
    return () => {
      window.clearTimeout(boundsTimer);
      m.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Imperative pan (geolocate FAB).
  useEffect(() => {
    if (!map || !recenter || recenter.nonce === recenterNonceRef.current) return;
    recenterNonceRef.current = recenter.nonce;
    map.flyTo({
      center: [recenter.lon, recenter.lat],
      zoom: Math.max(map.getZoom(), 14),
      duration: reducedMotion() ? 0 : 400,
    });
  }, [map, recenter]);

  // --- navigation: user dot, follow mode, pan-to-pause, next turn ---

  // Live position dot — one marker updated in place, not one per fix.
  useEffect(() => {
    if (!map || !userPosition) {
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      return;
    }
    if (!userMarkerRef.current) {
      const el = document.createElement('div');
      el.className = 'gm-user-dot';
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', 'Your location');
      // Position BEFORE addTo: Marker._update dereferences this._lngLat, so
      // addTo() without setLngLat() throws (and takes the whole app down).
      userMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([userPosition.lon, userPosition.lat])
        .addTo(map);
    }
    userMarkerRef.current.setLngLat([userPosition.lon, userPosition.lat]);
  }, [map, userPosition]);

  // Follow mode: keep the fix centered, rotate to heading, preserve pitch.
  useEffect(() => {
    if (!map || !followUser || !userPosition) return;
    map.easeTo({
      center: [userPosition.lon, userPosition.lat],
      bearing: userPosition.heading ?? map.getBearing(),
      pitch: map.getPitch(),
      zoom: Math.max(map.getZoom(), FOLLOW_ZOOM),
      duration: reducedMotion() ? 0 : 600,
    });
  }, [map, followUser, userPosition]);

  // Panning/rotating by hand pauses follow; the recenter control resumes it.
  // Only drag/rotate count — programmatic easeTo and zoom changes must not
  // cancel follow mode.
  useEffect(() => {
    if (!map) return;
    // Only REAL gestures may pause follow. MapLibre fires `rotatestart` for
    // programmatic bearing changes too — including our own follow easeTo — and
    // those events carry no `originalEvent`. Without this guard follow mode
    // cancels itself on its very first fix.
    const pause = (e: { originalEvent?: unknown }) => {
      if (!e?.originalEvent) return;
      if (followRef.current) onFollowRef.current?.(false);
    };
    map.on('dragstart', pause);
    map.on('rotatestart', pause);
    return () => {
      map.off('dragstart', pause);
      map.off('rotatestart', pause);
    };
  }, [map]);

  // Next-maneuver chevron at the upcoming turn.
  useEffect(() => {
    if (!map) return;
    nextMarkerRef.current?.remove();
    nextMarkerRef.current = null;
    if (!nextManeuver) return;
    const el = document.createElement('div');
    el.className = 'gm-next-turn';
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', 'Next maneuver');
    nextMarkerRef.current = new maplibregl.Marker({ element: el })
      .setLngLat([nextManeuver.lon, nextManeuver.lat])
      .addTo(map);
  }, [map, nextManeuver]);

  // Cameras ahead (inside the alert window) get a highlight ring, so the
  // driver sees what is imminent rather than every camera in the bbox.
  useEffect(() => {
    if (!map) return;
    const srcId = 'gr-nav-cams';
    const layerId = `${srcId}-ring`;
    try {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(srcId)) map.removeSource(srcId);
      const list = navCameras ?? [];
      if (list.length === 0 || !map.isStyleLoaded()) return;
      map.addSource(srcId, {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: list.map((c) => ({
            type: 'Feature' as const,
            properties: {},
            geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] },
          })),
        },
      });
      map.addLayer({
        id: layerId,
        type: 'circle',
        source: srcId,
        paint: {
          'circle-radius': 11,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': '#d93025',
          'circle-stroke-width': 3,
        },
      });
    } catch {
      /* the highlight must never break the map */
    }
  }, [map, navCameras]);

  // Origin / destination markers (draggable). Absent until the user picks.
  useEffect(() => {
    if (!map) return;
    originMarkerRef.current?.remove();
    destMarkerRef.current?.remove();
    if (origin) {
      const o = new maplibregl.Marker({ element: markerEl('origin'), draggable: true })
        .setLngLat([origin.lon, origin.lat])
        .addTo(map);
      o.on('dragend', () => {
        const ll = o.getLngLat();
        onOriginRef.current({ lat: ll.lat, lon: ll.lng });
      });
      originMarkerRef.current = o;
    }
    if (destination) {
      const d = new maplibregl.Marker({ element: markerEl('dest'), draggable: true })
        .setLngLat([destination.lon, destination.lat])
        .addTo(map);
      d.on('dragend', () => {
        const ll = d.getLngLat();
        onDestRef.current({ lat: ll.lat, lon: ll.lng });
      });
      destMarkerRef.current = d;
    }
  }, [map, origin, destination]);

  // Routes + 3D camera in one effect so the pitch tilt and the route
  // fit share a single camera animation (no fighting easeTo calls).
  useEffect(() => {
    if (!map) return;
    if (prevRoutesRef.current !== routes) {
      // New route results clear the manual override → auto 3D again.
      prevRoutesRef.current = routes;
      overrideRef.current = false;
    }
    const want3D = overrideRef.current ? is3D : routes.length > 0 && wideViewport();
    if (is3D !== want3D) setIs3D(want3D);
    const pitch = want3D ? PITCH_3D : 0;
    const bearing = want3D ? BEARING_3D : 0;
    const dur = reducedMotion() ? 0 : 800;

    if (map.isStyleLoaded()) {
      try {
        syncRouteLayers(map, routes, selectedId);
      } catch {
        /* layer sync must never break the map */
      }
    }

    if (routes.length > 0) {
      const sel = routes.find((r) => r.id === selectedId) ?? routes[0];
      const lons = sel.coordinates.map(([, lo]) => lo);
      const lats = sel.coordinates.map(([la]) => la);
      if (lons.length === 0) return;
      const targetKey = `${sel.id}|${sel.coordinates.length}`;
      const isNewTarget =
        prevFittedRoutesRef.current !== routes || prevTargetKeyRef.current !== targetKey;
      prevFittedRoutesRef.current = routes;
      prevTargetKeyRef.current = targetKey;
      if (!isNewTarget) {
        // Selection/routes unchanged — only the 3D toggle moved.
        if (prevPitchRef.current !== pitch) {
          prevPitchRef.current = pitch;
          map.easeTo({ pitch, bearing, duration: dur });
        }
        return;
      }
      prevPitchRef.current = pitch;
      const cam = map.cameraForBounds(
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        { padding: 60 },
      );
      if (cam) {
        map.easeTo({ center: cam.center, zoom: cam.zoom, pitch, bearing, duration: dur });
      } else {
        map.easeTo({ pitch, bearing, duration: dur });
      }
    } else {
      prevTargetKeyRef.current = '';
      prevFittedRoutesRef.current = routes;
      if (prevPitchRef.current !== pitch) {
        prevPitchRef.current = pitch;
        map.easeTo({ pitch, bearing, duration: dur });
      }
    }
  }, [map, routes, selectedId, is3D]);

  // Traveled/remaining split. Kept separate from the route-layer effect above
  // so a GPS fix only updates this overlay, not every route's geometry.
  useEffect(() => {
    if (!map || !map.isStyleLoaded()) return;
    const sel = routes.find((r) => r.id === selectedId) ?? routes[0] ?? null;
    const traveledIdx =
      userPosition && sel && sel.coordinates.length > 1
        ? nearestIndex(sel.coordinates, [userPosition.lat, userPosition.lon]).index
        : -1;
    syncDrivenOverlay(map, sel, traveledIdx);
  }, [map, routes, selectedId, userPosition]);

  return (
    <div className="mapview">
      <div
        ref={containerRef}
        className="gr-map"
        role="application"
        aria-label="Privacy map. Click to set origin then destination. Alt-click restarts picking."
        title="Click: set origin, then destination. Alt-click: restart. Drag markers to adjust."
      />
      <button
        type="button"
        className="gm-3d-toggle"
        aria-pressed={is3D}
        aria-label={is3D ? 'Switch to 2D map' : 'Switch to 3D map'}
        title={is3D ? 'Switch to 2D map' : 'Switch to 3D map'}
        onClick={() => {
          overrideRef.current = true;
          setIs3D((v) => !v);
        }}
      >
        {is3D ? <Box size={20} /> : <Mountain size={20} />}
      </button>
      {map && showCameras && (
        <CameraLayer map={map} cameras={cameras} bufferMeters={bufferMeters} />
      )}
    </div>
  );
}
