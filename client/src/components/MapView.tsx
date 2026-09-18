import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Box, Mountain } from 'lucide-react';
import CameraLayer from './CameraLayer';

// Local minimal interfaces (do not import cross-agent files).
export interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}
export interface LatLon {
  lat: number;
  lon: number;
}
export interface MapCamera {
  id: string;
  lat: number;
  lon: number;
  source?: string;
  address?: string;
  verified: boolean;
}
export interface MapRoute {
  id: string;
  coordinates: [number, number][];
  exposureCount: number;
}
export interface RecenterSignal extends LatLon {
  nonce: number;
}

interface MapViewProps {
  origin: LatLon;
  destination: LatLon;
  onOriginChange: (p: LatLon) => void;
  onDestinationChange: (p: LatLon) => void;
  onBoundsChange: (b: BBox) => void;
  cameras: MapCamera[];
  showCameras: boolean;
  bufferMeters: number;
  routes: MapRoute[];
  selectedId: string | null;
  recenter: RecenterSignal | null;
}

const VOYAGER_STYLE = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';const AUSTIN_LON = -97.7465;
const AUSTIN_LAT = 30.2836;

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

function emitBounds(m: maplibregl.Map, fn: (b: BBox) => void) {
  const b = m.getBounds();
  fn({ minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() });
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
function syncRouteLayers(map: maplibregl.Map, routes: MapRoute[], selectedId: string | null) {
  const style = map.getStyle();
  for (const l of [...(style?.layers ?? [])]) {
    if (l.id.startsWith('gr-route-') && map.getLayer(l.id)) map.removeLayer(l.id);
  }
  for (const id of Object.keys(style?.sources ?? {})) {
    if (id.startsWith('gr-route-') && map.getSource(id)) map.removeSource(id);
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

function markerEl(kind: 'origin' | 'dest'): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `gm-marker ${kind}`;
  el.title = kind === 'origin' ? 'Origin' : 'Destination';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', kind === 'origin' ? 'Origin marker' : 'Destination marker');
  return el;
}

export default function MapView(props: MapViewProps) {
  const { origin, destination, cameras, showCameras, bufferMeters, routes, selectedId, recenter } =
    props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const originMarkerRef = useRef<maplibregl.Marker | null>(null);
  const destMarkerRef = useRef<maplibregl.Marker | null>(null);
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
  useEffect(() => {
    onOriginRef.current = props.onOriginChange;
    onDestRef.current = props.onDestinationChange;
    onBoundsRef.current = props.onBoundsChange;
  });

  // Init map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    // Self-hosted worker (client/public/gr-map-*): vite dev cannot resolve
    // maplibre's default worker URL (and the original filename collides with
    // the dep optimizer), which leaves tiles unrendered. Re-copy on upgrade.
    // NOTE: new files under public/ need a dev-server restart to be served.
    maplibregl.setWorkerUrl('/gr-map-worker.mjs');
    const m = new maplibregl.Map({
      container: containerRef.current,
      style: VOYAGER_STYLE,
      center: [AUSTIN_LON, AUSTIN_LAT],
      zoom: 13,
      pitch: 0,
      bearing: 0,
    });
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
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
    m.on('moveend', () => emitBounds(m, onBoundsRef.current));
    m.on('load', () => tryAddBuildings(m));
    tryAddBuildings(m);
    mapRef.current = m;
    setMap(m);
    emitBounds(m, onBoundsRef.current);
    return () => {
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

  // Origin / destination markers (draggable).
  useEffect(() => {
    if (!map) return;
    originMarkerRef.current?.remove();
    destMarkerRef.current?.remove();
    const o = new maplibregl.Marker({ element: markerEl('origin'), draggable: true })
      .setLngLat([origin.lon, origin.lat])
      .addTo(map);
    o.on('dragend', () => {
      const ll = o.getLngLat();
      onOriginRef.current({ lat: ll.lat, lon: ll.lng });
    });
    const d = new maplibregl.Marker({ element: markerEl('dest'), draggable: true })
      .setLngLat([destination.lon, destination.lat])
      .addTo(map);
    d.on('dragend', () => {
      const ll = d.getLngLat();
      onDestRef.current({ lat: ll.lat, lon: ll.lng });
    });
    originMarkerRef.current = o;
    destMarkerRef.current = d;
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
    const want3D = overrideRef.current ? is3D : routes.length > 0;
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
