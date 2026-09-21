import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import type { Camera } from '../../../shared/src/types';

// Contract-derived: the layer renders exactly what the API returns.
export type CameraPoint = Camera;

interface CameraLayerProps {
  map: maplibregl.Map | null;
  cameras: CameraPoint[];
  bufferMeters: number;
}

const BUF_SRC = 'gr-cam-buffers';
const DOT_SRC = 'gr-cam-dots';
const BUF_FILL = 'gr-cam-buffer-fill';
const BUF_LINE = 'gr-cam-buffer-line';
const DOT_LAYER = 'gr-cam-dots';

// Cap on rendered markers: zoomed-out/US viewports can return hundreds of
// cameras (App fetches with a server limit). Rendering is capped so the map
// never overloads; the overflow count surfaces in the "+N more — zoom in"
// notice below.
export const MAX_RENDERED_CAMERAS = 1000;
// Buffer polygons are the expensive layer (49-vertex polygon per camera).
// Above this count only dots render; buffers reappear once zoomed in.
const MAX_BUFFERED_CAMERAS = 250;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Unverified (crowd-sourced) nodes render in amber and say so in plain words:
// a user submission must never look as authoritative as the verified dataset.
const VERIFIED_COLOR = '#d93025';
const UNVERIFIED_COLOR = '#b06000';

function popupHtml(c: CameraPoint): string {
  const addr = c.address ? `<div>${esc(c.address)}</div>` : '';
  const source = c.source ? `<div class="gm-cam-meta">Source: ${esc(c.source)}</div>` : '';
  const brand = esc(c.brand || 'ALPR');
  const verification = c.verified
    ? `<div class="gm-cam-meta">Verified record</div>`
    : `<div class="gm-cam-meta gm-cam-unverified">Unverified — user submitted</div>`;
  return (
    `<div class="gm-cam-popup">` +
    `<div class="gm-cam-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true"><path d="M16.75 12h3.632a1 1 0 0 1 .894 1.447l-2.416 4.667a1 1 0 0 1-.894.553H15.5"/><path d="m2 15 3.349-3.349a1 1 0 0 1 .707-.293H15.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H6.056a1 1 0 0 1-.707-.293L2 15Z"/><path d="M2 15v3a1 1 0 0 0 1 1h2"/><circle cx="8" cy="15" r="1.5"/></svg>` +
    `<span>${brand} camera</span></div>${addr}${source}${verification}</div>`
  );
}

// True-meter buffer circle as a GeoJSON polygon (maplibre circle
// layers are pixel-sized, so geometry carries the radius instead).
function bufferPolygon(lat: number, lon: number, radiusM: number, steps = 48): number[][][] {
  const R = 6378137;
  const latR = (lat * Math.PI) / 180;
  const lonR = (lon * Math.PI) / 180;
  const d = radiusM / R;
  const ring: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const br = (2 * Math.PI * i) / steps;
    const pLat = Math.asin(
      Math.sin(latR) * Math.cos(d) + Math.cos(latR) * Math.sin(d) * Math.cos(br),
    );
    const pLon =
      lonR +
      Math.atan2(
        Math.sin(br) * Math.sin(d) * Math.cos(latR),
        Math.cos(d) - Math.sin(latR) * Math.sin(pLat),
      );
    ring.push([(pLon * 180) / Math.PI, (pLat * 180) / Math.PI]);
  }
  return [ring];
}

// Slice first so every viewport — street or full-US — renders a bounded
// set; the overflow count surfaces in the "+N more" notice below.
function visibleCameras(cameras: CameraPoint[]): CameraPoint[] {
  return cameras.slice(0, MAX_RENDERED_CAMERAS);
}

const BUF_FILL_PAINT = { 'fill-color': '#d93025', 'fill-opacity': 0.06 };
const BUF_LINE_PAINT = { 'line-color': '#d93025', 'line-width': 1 };

function buffersFc(visible: CameraPoint[], bufferMeters: number): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: visible.map((c) => ({
      type: 'Feature',
      properties: { id: c.id },
      geometry: { type: 'Polygon', coordinates: bufferPolygon(c.lat, c.lon, bufferMeters) },
    })),
  };
}

function dotsFc(visible: CameraPoint[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: visible.map((c) => ({
      type: 'Feature',
      properties: {
        id: c.id,
        address: c.address ?? '',
        source: c.source ?? '',
        verified: c.verified ? 'yes' : 'no',
        brand: c.brand ?? '',
      },
      geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
    })),
  };
}

export default function CameraLayer({ map, cameras, bufferMeters }: CameraLayerProps) {
  const popupRef = useRef<maplibregl.Popup | null>(null);

  // Latest inputs for the lifecycle effect below, which installs the sources
  // once per map. Data updates then flow through setData into the existing
  // sources — a full teardown/rebuild on every bbox fetch made the markers
  // flicker during pitched (3D) pans.
  const dataRef = useRef({ cameras, bufferMeters });
  dataRef.current = { cameras, bufferMeters };

  // Layer lifecycle: sources, layers, and interaction handlers exist for the
  // whole life of the map instance.
  useEffect(() => {
    if (!map) return;

    const onDotClick = (e: maplibregl.MapLayerMouseEvent) => {
      const props = (e.features?.[0]?.properties ?? {}) as Record<string, string>;
      popupRef.current?.remove();
      popupRef.current = new maplibregl.Popup({ closeButton: true, offset: 12 })
        .setLngLat(e.lngLat)
        .setHTML(
          popupHtml({
            id: props.id ?? '',
            lat: e.lngLat.lat,
            lon: e.lngLat.lng,
            address: props.address || undefined,
            source: props.source ?? '',
            verified: props.verified === 'yes',
            brand: props.brand || undefined,
          }),
        )
        .addTo(map);
    };
    const onEnter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = '';
    };

    const install = () => {
      try {
        const { cameras: cams, bufferMeters: meters } = dataRef.current;
        const visible = visibleCameras(cams);
        if (visible.length <= MAX_BUFFERED_CAMERAS) {
          map.addSource(BUF_SRC, { type: 'geojson', data: buffersFc(visible, meters) });
          map.addLayer({
            id: BUF_FILL,
            type: 'fill',
            source: BUF_SRC,
            paint: BUF_FILL_PAINT,
          });
          map.addLayer({
            id: BUF_LINE,
            type: 'line',
            source: BUF_SRC,
            paint: BUF_LINE_PAINT,
          });
        }
        map.addSource(DOT_SRC, { type: 'geojson', data: dotsFc(visible) });
        map.addLayer({
          id: DOT_LAYER,
          type: 'circle',
          source: DOT_SRC,
          paint: {
            // Small + translucent when zoomed out (dense metros read as
            // texture, not a red blob); full size/opacity up close.
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 10, 4, 13, 6],
            'circle-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.55, 12, 0.95],
            'circle-color': [
              'match',
              ['get', 'verified'],
              'yes',
              VERIFIED_COLOR,
              UNVERIFIED_COLOR,
            ],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5, 0, 10, 1.5],
          },
        });
        map.on('click', DOT_LAYER, onDotClick);
        map.on('mouseenter', DOT_LAYER, onEnter);
        map.on('mouseleave', DOT_LAYER, onLeave);
      } catch {
        /* layer sync must never break the map */
      }
    };

    const cleanup = () => {
      popupRef.current?.remove();
      popupRef.current = null;
      try {
        map.off('click', DOT_LAYER, onDotClick);
        map.off('mouseenter', DOT_LAYER, onEnter);
        map.off('mouseleave', DOT_LAYER, onLeave);
        for (const l of [DOT_LAYER, BUF_LINE, BUF_FILL]) {
          if (map.getLayer(l)) map.removeLayer(l);
        }
        for (const s of [DOT_SRC, BUF_SRC]) {
          if (map.getSource(s)) map.removeSource(s);
        }
      } catch {
        /* teardown must never throw */
      }
    };

    if (map.isStyleLoaded()) install();
    else map.once('load', install);
    return () => {
      map.off('load', install);
      cleanup();
    };
  }, [map]);

  // Data sync: push the current cameras into the existing sources in place.
  useEffect(() => {
    if (!map || !map.isStyleLoaded()) return;
    try {
      const visible = visibleCameras(cameras);
      const dotSrc = map.getSource(DOT_SRC) as maplibregl.GeoJSONSource | undefined;
      if (!dotSrc) return; // lifecycle effect installs with the latest data
      dotSrc.setData(dotsFc(visible));
      const showBuffers = visible.length <= MAX_BUFFERED_CAMERAS;
      const bufSrc = map.getSource(BUF_SRC) as maplibregl.GeoJSONSource | undefined;
      if (showBuffers && bufSrc) {
        bufSrc.setData(buffersFc(visible, bufferMeters));
      } else if (showBuffers && !bufSrc) {
        // Zoomed in after installing buffer-free: add buffers under the dots.
        map.addSource(BUF_SRC, { type: 'geojson', data: buffersFc(visible, bufferMeters) });
        map.addLayer({ id: BUF_FILL, type: 'fill', source: BUF_SRC, paint: BUF_FILL_PAINT }, DOT_LAYER);
        map.addLayer({ id: BUF_LINE, type: 'line', source: BUF_SRC, paint: BUF_LINE_PAINT }, DOT_LAYER);
      } else if (!showBuffers && bufSrc) {
        for (const l of [BUF_LINE, BUF_FILL]) {
          if (map.getLayer(l)) map.removeLayer(l);
        }
        map.removeSource(BUF_SRC);
      }
    } catch {
      /* data sync must never break the map */
    }
  }, [map, cameras, bufferMeters]);

  const hidden = Math.max(0, cameras.length - MAX_RENDERED_CAMERAS);
  if (hidden <= 0) return null;
  // Inline styles (no css file change): small status pill over the map.
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${hidden} more cameras outside the render cap. Zoom in to see them.`}
      title="Zoom in to render the remaining cameras"
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 12,
        transform: 'translateX(-50%)',
        zIndex: 5,
        background: 'rgba(32,33,36,0.92)',
        color: '#fff',
        fontSize: 12,
        lineHeight: '16px',
        padding: '6px 12px',
        borderRadius: 16,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      +{hidden} more — zoom in
    </div>
  );
}
