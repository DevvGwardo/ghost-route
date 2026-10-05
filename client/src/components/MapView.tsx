import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString, MultiLineString } from 'geojson';
import type { BBox, Camera, LatLon, ScoredRoute } from '../../../shared/src/types';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Box, Mountain } from 'lucide-react';
import CameraLayer, { CAMERA_DOT_LAYER } from './CameraLayer';
import { nearestIndex } from '../lib/navigate';
import { exposureRuns, labelAnchors, pickDrawnRoutes } from '../lib/routeStyle';
import type { GeoFix } from '../lib/useGeoPosition';

// Contract-derived types (shared/src/types.ts is the single source of truth).
export type { BBox, LatLon };
export type MapCamera = Camera;
/** Narrow view of a scored route: drawable geometry + exposure summary. */
export type MapRoute = Pick<
  ScoredRoute,
  'id' | 'coordinates' | 'exposureCount' | 'isClean' | 'durationS' | 'exposures'
>;
export interface RecenterSignal extends LatLon {
  nonce: number;
}
export type FitPadding = { top: number; bottom: number; left: number; right: number };

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
  /** Tapping an alternative line or its label chip selects it. */
  onSelectRoute?: (id: string) => void;
  /**
   * Space taken by the floating panels (top card, bottom sheet, side panel),
   * read at fit time so a fitted route lands in the part of the map you see.
   */
  getFitPadding?: () => FitPadding;
  recenter: RecenterSignal | null;
  // --- navigation (all optional: absent outside a navigation session) ---
  /** True for the whole navigation session (drives the driving camera). */
  navigating?: boolean;
  /** Live puck (snapped fix + usable heading); drives follow mode. */
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
/** Driving view: tilted, looking ahead, puck in the lower part of the screen. */
const NAV_PITCH = 50;
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

// Route palette. Selected: blue fill on a darker blue edge inside a white
// halo, so it reads on light streets, dark parks and water alike.
// Alternatives: quiet slate, thinner, beneath. Camera zones: red over blue.
const ROUTE = {
  halo: '#ffffff',
  edge: '#0b57d0',
  fill: '#4285f4',
  altEdge: '#7f8c99',
  altFill: '#bfcbd8',
  zone: '#ea4335',
  zoneEdge: '#a50e0e',
};
// Zoom-scaled widths: hairlines at city zoom were the main reason routes
// looked weak; at street zoom they now read like a real nav app's.
const w = (z10: number, z14: number, z18: number) =>
  ['interpolate', ['exponential', 1.5], ['zoom'], 10, z10, 14, z14, 18, z18] as unknown as number;

// 45°, not 60°: at 60° a long north–south trip foreshortened to a third of
// the free map height (measured: 310 px of 900 on desktop).
const PITCH_3D = 45;
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

const ARROW_IMAGE = 'gr-route-arrow';

/** White chevron used as the direction-of-travel pattern on the route. */
function ensureArrowImage(map: maplibregl.Map) {
  if (map.hasImage(ARROW_IMAGE)) return;
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  // Points right (+x): symbol-placement 'line' aligns +x with the line.
  ctx.moveTo(11, 8);
  ctx.lineTo(21, 16);
  ctx.lineTo(11, 24);
  ctx.stroke();
  const img = ctx.getImageData(0, 0, size, size);
  map.addImage(ARROW_IMAGE, { width: size, height: size, data: new Uint8Array(img.data.buffer) }, { pixelRatio: 2 });
}

const lineFeature = (coords: [number, number][], props: Record<string, unknown> = {}): Feature<LineString> => ({
  type: 'Feature',
  properties: props,
  geometry: { type: 'LineString', coordinates: coords.map(([la, lo]) => [lo, la]) },
});

/** Layer ids of the alternative fills currently on the map (for hit-testing). */
function altFillLayers(map: maplibregl.Map): string[] {
  return (map.getStyle()?.layers ?? [])
    .map((l) => l.id)
    .filter((id) => id.startsWith('gr-route-') && id.endsWith('-altfill'));
}

const SEL_CAMS_SRC = 'gr-selcams';

// Route polylines. Only the selected route and the two best alternatives are
// drawn (pickDrawnRoutes); all of them stay in the sheet. Layers sit BELOW the
// camera dots so cameras on the route stay visible, with the selected route's
// exposed cameras re-drawn on top as emphasized markers.
// NOTE: `-driven` overlays (the traveled portion of the selected route) are
// owned by their own effect and deliberately survive this teardown —
// rebuilding every route layer on each GPS fix would be needlessly costly.
function syncRouteLayers(
  map: maplibregl.Map,
  routes: MapRoute[],
  selectedId: string | null,
  bufferMeters: number,
) {
  const style = map.getStyle();
  for (const l of [...(style?.layers ?? [])]) {
    if (
      (l.id.startsWith('gr-route-') && !l.id.endsWith('-driven')) ||
      l.id.startsWith(SEL_CAMS_SRC)
    ) {
      if (map.getLayer(l.id)) map.removeLayer(l.id);
    }
  }
  for (const id of Object.keys(style?.sources ?? {})) {
    if ((id.startsWith('gr-route-') && !id.endsWith('-driven')) || id === SEL_CAMS_SRC) {
      if (map.getSource(id)) map.removeSource(id);
    }
  }
  const { selected, alts } = pickDrawnRoutes(routes, selectedId);
  if (!selected) return;
  const before = map.getLayer(CAMERA_DOT_LAYER) ? CAMERA_DOT_LAYER : undefined;
  const layout = { 'line-join': 'round', 'line-cap': 'round' } as const;

  // Alternatives first (underneath), worst-ranked at the bottom.
  for (const r of [...alts].reverse()) {
    const srcId = `gr-route-${r.id}`;
    map.addSource(srcId, { type: 'geojson', data: lineFeature(r.coordinates, { routeId: r.id }) });
    map.addLayer(
      { id: `${srcId}-casing`, type: 'line', source: srcId, layout, paint: { 'line-color': ROUTE.altEdge, 'line-width': w(5, 9, 17) } },
      before,
    );
    map.addLayer(
      { id: `${srcId}-altfill`, type: 'line', source: srcId, layout, paint: { 'line-color': ROUTE.altFill, 'line-width': w(3, 6, 12) } },
      before,
    );
  }

  const srcId = `gr-route-${selected.id}`;
  map.addSource(srcId, { type: 'geojson', data: lineFeature(selected.coordinates, { routeId: selected.id }) });
  map.addLayer(
    { id: `${srcId}-halo`, type: 'line', source: srcId, layout, paint: { 'line-color': ROUTE.halo, 'line-width': w(9, 15, 26), 'line-opacity': 0.92 } },
    before,
  );
  map.addLayer(
    { id: `${srcId}-casing`, type: 'line', source: srcId, layout, paint: { 'line-color': ROUTE.edge, 'line-width': w(6, 10.5, 19) } },
    before,
  );
  map.addLayer(
    { id: `${srcId}-fill`, type: 'line', source: srcId, layout, paint: { 'line-color': ROUTE.fill, 'line-width': w(4, 7, 14) } },
    before,
  );

  // Camera zones: the stretches of the selected route inside the avoidance
  // buffer of a camera it is exposed to, painted red over the blue.
  const runs = exposureRuns(selected.coordinates, selected.exposures ?? [], Math.max(40, bufferMeters));
  if (runs.length > 0) {
    const zone: Feature<MultiLineString> = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiLineString', coordinates: runs.map((run) => run.map(([la, lo]) => [lo, la])) },
    };
    const zoneSrc = `gr-route-${selected.id}-zones`;
    map.addSource(zoneSrc, { type: 'geojson', data: zone });
    map.addLayer(
      { id: `${zoneSrc}-edge`, type: 'line', source: zoneSrc, layout, paint: { 'line-color': ROUTE.zoneEdge, 'line-width': w(6, 10.5, 19) } },
      before,
    );
    map.addLayer(
      { id: `${zoneSrc}-fill`, type: 'line', source: zoneSrc, layout, paint: { 'line-color': ROUTE.zone, 'line-width': w(4, 7, 14) } },
      before,
    );
  }

  // Direction-of-travel chevrons along the selected route.
  try {
    ensureArrowImage(map);
    map.addLayer(
      {
        id: `${srcId}-arrows`,
        type: 'symbol',
        source: srcId,
        minzoom: 12,
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 90,
          'icon-image': ARROW_IMAGE,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.55, 16, 0.85, 18, 1.1],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: { 'icon-opacity': 0.9 },
      },
      before,
    );
  } catch {
    /* arrows are decoration — never block the route */
  }

  // The selected route's exposed cameras, emphasized above everything.
  const cams = selected.exposures ?? [];
  if (cams.length > 0) {
    map.addSource(SEL_CAMS_SRC, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: cams.map((c) => ({
          type: 'Feature' as const,
          properties: { id: c.cameraId },
          geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] },
        })),
      },
    });
    map.addLayer({
      id: `${SEL_CAMS_SRC}-halo`,
      type: 'circle',
      source: SEL_CAMS_SRC,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 9, 15, 16],
        'circle-color': ROUTE.zone,
        'circle-opacity': 0.18,
      },
    });
    map.addLayer({
      id: `${SEL_CAMS_SRC}-dot`,
      type: 'circle',
      source: SEL_CAMS_SRC,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 15, 8],
        'circle-color': '#d93025',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 15, 3],
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
    const data: FeatureCollection = { type: 'FeatureCollection', features: [lineFeature(driven)] };
    // Sit just under the arrows/zones of the selected route, above its fill.
    const above = map.getLayer(`gr-route-${sel.id}-arrows`) ? `gr-route-${sel.id}-arrows` : undefined;
    const existing = map.getSource(srcId) as maplibregl.GeoJSONSource | undefined;
    if (existing && typeof existing.setData === 'function') {
      existing.setData(data);
      // Route layers are torn down and re-added on every plan change, which
      // would bury this overlay underneath them again.
      if (map.getLayer(srcId)) map.moveLayer(srcId, above);
      return;
    }
    map.addSource(srcId, { type: 'geojson', data });
    map.addLayer(
      {
        id: srcId,
        type: 'line',
        source: srcId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': DRIVEN_COLOR, 'line-width': w(4, 7, 14), 'line-opacity': 0.95 },
      },
      above,
    );
  } catch {
    /* the overlay must never break the map */
  }
}

// Maps whose style has fired 'load'. From then on the style can always take
// new sources/layers (Ghost Route never swaps styles).
const styleLoaded = new WeakSet<maplibregl.Map>();

/**
 * Run `fn` now if the style can take layer changes, else once it has loaded.
 * Not `isStyleLoaded()` alone: that is false while ANY source is still
 * loading (e.g. camera GeoJSON just set), and a bare guard on it silently
 * dropped layer updates in that window — the imminent-camera ring was the one
 * that showed it. Returns a canceller for effect cleanup.
 */
function whenStyleReady(map: maplibregl.Map, fn: () => void): () => void {
  if (styleLoaded.has(map) || map.isStyleLoaded()) {
    fn();
    return () => {};
  }
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  map.once('load', run);
  return () => {
    done = true;
    map.off('load', run);
  };
}

/**
 * Fit a polyline into the padded map area at a given pitch/bearing, by
 * measurement. `cameraForBounds` fits the bounding box's corners, which under
 * a tilt leaves the actual line far smaller than the space it has (a long
 * north–south trip filled a third of the free height at 60°). This jumps to
 * the candidate camera, projects the line, corrects zoom and center toward
 * the free rectangle twice, restores the old camera and returns the result —
 * all synchronously, so no intermediate frame is drawn.
 */
function fitLine(
  map: maplibregl.Map,
  coords: [number, number][],
  padding: FitPadding,
  pitch: number,
  bearing: number,
): { center: maplibregl.LngLat; zoom: number } | null {
  if (coords.length < 2) return null;
  const lons = coords.map(([, lo]) => lo);
  const lats = coords.map(([la]) => la);
  const cam = map.cameraForBounds(
    [
      [Math.min(...lons), Math.min(...lats)],
      [Math.max(...lons), Math.max(...lats)],
    ],
    { padding, pitch, bearing },
  );
  if (!cam || cam.zoom == null || !cam.center) return null;
  const saved = {
    center: map.getCenter(),
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
    padding: map.getPadding(),
  };
  const step = Math.max(1, Math.floor(coords.length / 200));
  const sample = coords.filter((_, i) => i % step === 0 || i === coords.length - 1);
  const el = map.getContainer();
  const free = {
    left: padding.left,
    top: padding.top,
    right: el.clientWidth - padding.right,
    bottom: el.clientHeight - padding.bottom,
  };
  let center = maplibregl.LngLat.convert(cam.center);
  let zoom = cam.zoom;
  try {
    map.jumpTo({ center, zoom, pitch, bearing, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    for (let k = 0; k < 2; k++) {
      const pts = sample.map(([la, lo]) => map.project([lo, la]));
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const w = Math.max(1, Math.max(...xs) - Math.min(...xs));
      const h = Math.max(1, Math.max(...ys) - Math.min(...ys));
      const scale = Math.min((free.right - free.left) / w, (free.bottom - free.top) / h);
      // Move the line's screen-center onto the free area's center, then zoom.
      const mid = map.unproject([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]);
      const target = map.unproject([(free.left + free.right) / 2, (free.top + free.bottom) / 2]);
      const c = map.getCenter();
      center = new maplibregl.LngLat(c.lng + (mid.lng - target.lng), c.lat + (mid.lat - target.lat));
      zoom = Math.min(18, map.getZoom() + Math.log2(scale) * 0.97);
      map.jumpTo({ center, zoom });
    }
  } finally {
    map.jumpTo(saved);
  }
  return { center, zoom };
}

function markerEl(kind: 'origin' | 'dest'): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `gm-marker ${kind}`;
  el.title = kind === 'origin' ? 'Origin' : 'Destination';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', kind === 'origin' ? 'Origin marker' : 'Destination marker');
  if (kind === 'dest') {
    const pin = document.createElement('div');
    pin.className = 'gm-pin';
    el.append(pin);
  }
  return el;
}

function fmtChipDur(s: number): string {
  const mins = Math.max(1, Math.round(s / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${m}`;
}

/** Driving zoom from speed: closer in town, further out on the highway. */
function navZoom(speedMps: number | null): number {
  if (speedMps == null) return 16.5;
  if (speedMps < 9) return 17;
  if (speedMps < 20) return 16;
  return 15;
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
    navigating = false,
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
  const chipMarkersRef = useRef<maplibregl.Marker[]>([]);
  const followRef = useRef(false);
  const phaseRef = useRef<'origin' | 'dest'>('origin');
  const recenterNonceRef = useRef(0);
  // Manual 3D/2D override sticks until a new route result arrives.
  const overrideRef = useRef(false);
  const prevRoutesRef = useRef(routes);
  const prevTargetKeyRef = useRef('');
  const prevFittedRoutesRef = useRef(routes);
  const prevPitchRef = useRef(0);
  const wasNavigatingRef = useRef(false);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const [is3D, setIs3D] = useState(false);
  // Bumped when the style finishes loading, so layer effects that bailed out
  // on a not-yet-loaded style (a deep link resolves before the tiles do) run
  // again instead of leaving the route undrawn.
  const [styleTick, setStyleTick] = useState(0);

  const onOriginRef = useRef(props.onOriginChange);
  const onDestRef = useRef(props.onDestinationChange);
  const onBoundsRef = useRef(props.onBoundsChange);
  const onFollowRef = useRef(props.onFollowUserChange);
  const onSelectRouteRef = useRef(props.onSelectRoute);
  const getFitPaddingRef = useRef(props.getFitPadding);
  useEffect(() => {
    onOriginRef.current = props.onOriginChange;
    onDestRef.current = props.onDestinationChange;
    onBoundsRef.current = props.onBoundsChange;
    onFollowRef.current = props.onFollowUserChange;
    onSelectRouteRef.current = props.onSelectRoute;
    getFitPaddingRef.current = props.getFitPadding;
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
      attributionControl: { compact: true },
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
      // Taps on map content are not endpoint picks: a camera dot opens its
      // popup (CameraLayer), an alternative route gets selected.
      try {
        const box: [maplibregl.PointLike, maplibregl.PointLike] = [
          [e.point.x - 8, e.point.y - 8],
          [e.point.x + 8, e.point.y + 8],
        ];
        // One query over cameras + alternative lines; the top-most feature
        // under the exact tap decides, the 8px box only catches near misses
        // on lines.
        // (Checking cameras first with the box swallowed taps on alternative
        // lines that merely passed within 8px of a camera.)
        const layers = [
          ...(m.getLayer(CAMERA_DOT_LAYER) ? [CAMERA_DOT_LAYER] : []),
          ...altFillLayers(m),
        ];
        if (layers.length > 0) {
          const alts = layers.filter((l) => l !== CAMERA_DOT_LAYER);
          const hit =
            m.queryRenderedFeatures(e.point, { layers })[0] ??
            // Near misses only for lines: CameraLayer's popup needs an exact
            // dot hit, so a near-miss camera tap must still pick a point.
            (alts.length > 0 ? m.queryRenderedFeatures(box, { layers: alts })[0] : undefined);
          if (hit) {
            const id = hit.properties?.routeId;
            if (hit.layer.id !== CAMERA_DOT_LAYER && typeof id === 'string') onSelectRouteRef.current?.(id);
            return; // camera taps open their popup (CameraLayer); never an endpoint
          }
        }
      } catch {
        /* hit-testing must never block picking */
      }
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
    // Pointer cursor over selectable alternatives.
    m.on('mousemove', (e: maplibregl.MapMouseEvent) => {
      try {
        const alts = altFillLayers(m);
        if (alts.length === 0) return;
        const over = m.queryRenderedFeatures(e.point, { layers: alts }).length > 0;
        const canvas = m.getCanvas();
        if (over) canvas.style.cursor = 'pointer';
        else if (canvas.style.cursor === 'pointer') canvas.style.cursor = '';
      } catch {
        /* cosmetic */
      }
    });
    m.on('moveend', scheduleBounds);
    // moveend covers most pan/zoom gestures, but a wheel-zoom that never
    // starts a "move" (or a programmatic zoom) may only fire zoomend —
    // funnel both into the same debounced emitter so every viewport,
    // from street to full-US, triggers a cameras fetch in App.
    m.on('zoomend', scheduleBounds);
    m.on('load', () => {
      styleLoaded.add(m);
      // Compact attribution opens expanded; on a phone that is a wide white
      // bar over the map. Start collapsed (the (i) button still expands it).
      if (!wideViewport()) {
        m.getContainer().querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show');
      }
      tryAddBuildings(m);
      scheduleBounds();
      setStyleTick((t) => t + 1);
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

  // --- navigation: user puck, follow mode, pan-to-pause, next turn ---

  // Live position puck — one marker updated in place, not one per fix. It
  // lies flat on the map and rotates with the heading, so the arrow points
  // along the road in the tilted driving view.
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
      el.innerHTML =
        '<svg class="gm-user-arrow" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M12 3 L19 20 L12 16 L5 20 Z" /></svg>';
      // Position BEFORE addTo: Marker._update dereferences this._lngLat, so
      // addTo() without setLngLat() throws (and takes the whole app down).
      userMarkerRef.current = new maplibregl.Marker({
        element: el,
        rotationAlignment: 'map',
        pitchAlignment: 'map',
      })
        .setLngLat([userPosition.lon, userPosition.lat])
        .addTo(map);
    }
    const marker = userMarkerRef.current;
    marker.setLngLat([userPosition.lon, userPosition.lat]);
    const hasHeading = userPosition.heading != null;
    marker.getElement().classList.toggle('has-heading', hasHeading);
    if (hasHeading) marker.setRotation(userPosition.heading as number);
  }, [map, userPosition]);

  // Follow mode. While navigating: the driving view — tilted, rotated to the
  // heading, zoomed by speed, with the puck pushed toward the bottom so most
  // of the screen shows the road ahead. Outside navigation it simply centers.
  useEffect(() => {
    if (!map || !followUser || !userPosition) return;
    const h = map.getContainer().clientHeight || 800;
    map.easeTo({
      center: [userPosition.lon, userPosition.lat],
      bearing: userPosition.heading ?? map.getBearing(),
      pitch: navigating ? NAV_PITCH : map.getPitch(),
      zoom: navigating ? navZoom(userPosition.speedMps) : Math.max(map.getZoom(), FOLLOW_ZOOM),
      padding: navigating ? { top: Math.round(h * 0.42), bottom: 0, left: 0, right: 0 } : undefined,
      duration: reducedMotion() ? 0 : 900,
      // Linear between ~1 Hz fixes: an ease-out stops and starts every second.
      easing: (t: number) => t,
    });
  }, [map, followUser, userPosition, navigating]);

  // Leaving navigation drops the look-ahead padding and the driving tilt so
  // the next route fit and the planning view behave as before.
  useEffect(() => {
    if (!map) return;
    if (navigating) {
      wasNavigatingRef.current = true;
      return;
    }
    if (!wasNavigatingRef.current) return;
    wasNavigatingRef.current = false;
    prevTargetKeyRef.current = ''; // refit the route on the way out
    // Padding is reset at once, not animated: the route refit that follows
    // interrupts any running ease, which left the look-ahead padding behind.
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    map.easeTo({
      pitch: is3D ? PITCH_3D : 0,
      bearing: is3D ? BEARING_3D : 0,
      duration: reducedMotion() ? 0 : 500,
    });
  }, [map, navigating, is3D]);

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
    return whenStyleReady(map, () => {
    try {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(srcId)) map.removeSource(srcId);
      const list = navCameras ?? [];
      if (list.length === 0) return;
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
          'circle-radius': 14,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': '#d93025',
          'circle-stroke-width': 3,
        },
      });
    } catch {
      /* the highlight must never break the map */
    }
    });
  }, [map, navCameras, styleTick]);

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
      // Pin tip sits on the point (anchor bottom), unlike the round markers.
      const d = new maplibregl.Marker({ element: markerEl('dest'), draggable: true, anchor: 'bottom' })
        .setLngLat([destination.lon, destination.lat])
        .addTo(map);
      d.on('dragend', () => {
        const ll = d.getLngLat();
        onDestRef.current({ lat: ll.lat, lon: ll.lng });
      });
      destMarkerRef.current = d;
    }
  }, [map, origin, destination]);

  // Route label chips ("19 min · 3 cams"), one per drawn route at a spot that
  // belongs to that route alone. Tapping an alternative's chip selects it.
  // Hidden while navigating: the driver needs the road, not a comparison.
  useEffect(() => {
    for (const mk of chipMarkersRef.current) mk.remove();
    chipMarkersRef.current = [];
    if (!map || navigating) return;
    const { selected, alts } = pickDrawnRoutes(routes, selectedId);
    if (!selected) return;
    const drawn = [selected, ...alts];
    const anchors = labelAnchors(drawn);
    // "fastest" tags one alternative: the quickest drawn route, when it is
    // quicker than the selected one (otherwise the tag says nothing).
    const quickest = drawn.reduce((m, r) => (r.durationS < m.durationS ? r : m), drawn[0]);
    for (const r of drawn) {
      const at = anchors.get(r.id);
      if (!at) continue;
      const isSel = r === selected;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `gm-route-chip${isSel ? ' sel' : ''}${r.exposureCount === 0 ? ' clean' : ''}`;
      el.dataset.routeId = r.id;
      const cams = r.exposureCount === 0 ? 'no cams' : `${r.exposureCount} cam${r.exposureCount === 1 ? '' : 's'}`;
      const dur = document.createElement('b');
      dur.textContent = fmtChipDur(r.durationS);
      const meta = document.createElement('span');
      meta.textContent = cams;
      el.append(dur, meta);
      if (!isSel && r === quickest && r.durationS < selected.durationS - 30) {
        const fast = document.createElement('span');
        fast.className = 'gm-route-chip-tag';
        fast.textContent = 'fastest';
        el.append(fast);
      }
      el.setAttribute(
        'aria-label',
        `${isSel ? 'Selected route' : 'Alternative route'}: ${fmtChipDur(r.durationS)}, ${cams}`,
      );
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!isSel) onSelectRouteRef.current?.(r.id);
      });
      const mk = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -6] })
        .setLngLat([at[1], at[0]])
        .addTo(map);
      chipMarkersRef.current.push(mk);
    }
    // Screen-space declutter: anchors are spread on the ground, but a tilted
    // or zoomed-out view can still stack two chips. Chips are in priority
    // order (selected first, then by rank); a chip that collides with a
    // higher-priority visible chip is hidden until the view changes.
    const declutter = () => {
      const shown: DOMRect[] = [];
      for (const mk of chipMarkersRef.current) {
        const el = mk.getElement();
        el.classList.remove('gm-chip-hidden');
        const r = el.getBoundingClientRect();
        const clash = shown.some((o) => r.left < o.right && o.left < r.right && r.top < o.bottom && o.top < r.bottom);
        if (clash) el.classList.add('gm-chip-hidden');
        else shown.push(r);
      }
    };
    const raf = requestAnimationFrame(declutter);
    map.on('moveend', declutter);
    return () => {
      cancelAnimationFrame(raf);
      map.off('moveend', declutter);
    };
  }, [map, routes, selectedId, navigating]);

  // Routes + 3D camera in one effect so the pitch tilt and the route
  // fit share a single camera animation (no fighting easeTo calls).
  useEffect(() => {
    if (!map) return;
    if (prevRoutesRef.current !== routes) {
      // New route results clear the manual override → auto 3D again.
      prevRoutesRef.current = routes;
      overrideRef.current = false;
    }

    const cancelSync = whenStyleReady(map, () => {
      try {
        syncRouteLayers(map, routes, selectedId, bufferMeters);
      } catch {
        /* layer sync must never break the map */
      }
    });

    // The driving camera owns the view while navigating: a reroute landing
    // must redraw the line, not yank the camera out to fit the whole trip.
    if (navigating) return cancelSync;

    const want3D = overrideRef.current ? is3D : routes.length > 0 && wideViewport();
    if (is3D !== want3D) setIs3D(want3D);
    const pitch = want3D ? PITCH_3D : 0;
    const bearing = want3D ? BEARING_3D : 0;
    const dur = reducedMotion() ? 0 : 800;

    if (routes.length > 0) {
      const sel = routes.find((r) => r.id === selectedId) ?? routes[0];
      if (sel.coordinates.length === 0) return cancelSync;
      const targetKey = `${sel.id}|${sel.coordinates.length}`;
      const isNewTarget =
        prevFittedRoutesRef.current !== routes || prevTargetKeyRef.current !== targetKey;
      prevFittedRoutesRef.current = routes;
      prevTargetKeyRef.current = targetKey;
      if (!isNewTarget && prevPitchRef.current === pitch) return cancelSync;
      // New target, or the 3D toggle moved: refit WITH the new pitch. Tilting
      // without refitting pushed the far end of the trip (and its pin) off a
      // phone screen — up to 8% of the route in the route-look matrix.
      prevPitchRef.current = pitch;
      // Fit into the map area the panels leave visible. Falls back to an even
      // 60px when the caller gives no layout (or the panels leave no room).
      let padding: FitPadding = { top: 60, bottom: 60, left: 60, right: 60 };
      try {
        const p = getFitPaddingRef.current?.();
        const c = map.getContainer();
        if (
          p &&
          c.clientWidth - p.left - p.right > 120 &&
          c.clientHeight - p.top - p.bottom > 120
        ) {
          padding = p;
        }
      } catch {
        /* layout read failed — keep the even padding */
      }
      let cam: { center: maplibregl.LngLat; zoom: number } | null = null;
      try {
        cam = fitLine(map, sel.coordinates, padding, pitch, bearing);
      } catch {
        cam = null; // measurement failed — still tilt, keep the view
      }
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
    return cancelSync;
  }, [map, routes, selectedId, is3D, bufferMeters, navigating, styleTick]);

  // Traveled/remaining split. Kept separate from the route-layer effect above
  // so a GPS fix only updates this overlay, not every route's geometry.
  useEffect(() => {
    if (!map) return;
    const sel = routes.find((r) => r.id === selectedId) ?? routes[0] ?? null;
    const traveledIdx =
      userPosition && sel && sel.coordinates.length > 1
        ? nearestIndex(sel.coordinates, [userPosition.lat, userPosition.lon]).index
        : -1;
    return whenStyleReady(map, () => syncDrivenOverlay(map, sel, traveledIdx));
  }, [map, routes, selectedId, userPosition]);

  return (
    <div className={`mapview${navigating ? ' navigating' : ''}`}>
      <div
        ref={containerRef}
        className="gr-map"
        role="application"
        aria-label="Privacy map. Click to set origin then destination. Alt-click restarts picking."
        title="Click: set origin, then destination. Alt-click: restart. Drag markers to adjust."
      />
      {!navigating && (
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
      )}
      {map && showCameras && (
        <CameraLayer
          map={map}
          cameras={cameras}
          bufferMeters={bufferMeters}
          dimmed={routes.length > 0}
        />
      )}
    </div>
  );
}
