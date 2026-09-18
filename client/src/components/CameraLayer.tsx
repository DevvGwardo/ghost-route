import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';

// Local minimal interface (do not import cross-agent files).
export interface CameraPoint {
  id: string;
  lat: number;
  lon: number;
  source?: string;
  address?: string;
  verified: boolean;
}

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

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function popupHtml(c: CameraPoint): string {
  const addr = c.address ? `<div>${esc(c.address)}</div>` : '';
  const source = c.source ? `<div class="gm-cam-meta">Source: ${esc(c.source)}</div>` : '';
  return (
    `<div class="gm-cam-popup">` +
    `<div class="gm-cam-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true"><path d="M16.75 12h3.632a1 1 0 0 1 .894 1.447l-2.416 4.667a1 1 0 0 1-.894.553H15.5"/><path d="m2 15 3.349-3.349a1 1 0 0 1 .707-.293H15.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H6.056a1 1 0 0 1-.707-.293L2 15Z"/><path d="M2 15v3a1 1 0 0 0 1 1h2"/><circle cx="8" cy="15" r="1.5"/></svg>` +
    `<span>Flock camera</span></div>${addr}${source}` +
    `<div class="gm-cam-meta">Verified: ${c.verified ? 'yes' : 'no'}</div></div>`
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

export default function CameraLayer({ map, cameras, bufferMeters }: CameraLayerProps) {
  const popupRef = useRef<maplibregl.Popup | null>(null);

  useEffect(() => {
    if (!map) return;
    let cancelled = false;

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
            source: props.source || undefined,
            verified: props.verified === 'yes',
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

    const apply = () => {
      if (cancelled || !map.isStyleLoaded()) return;
      cleanup();
      try {
        const buffers: FeatureCollection = {
          type: 'FeatureCollection',
          features: cameras.map((c) => ({
            type: 'Feature',
            properties: { id: c.id },
            geometry: { type: 'Polygon', coordinates: bufferPolygon(c.lat, c.lon, bufferMeters) },
          })),
        };
        map.addSource(BUF_SRC, { type: 'geojson', data: buffers });
        map.addLayer({
          id: BUF_FILL,
          type: 'fill',
          source: BUF_SRC,
          paint: { 'fill-color': '#d93025', 'fill-opacity': 0.06 },
        });
        map.addLayer({
          id: BUF_LINE,
          type: 'line',
          source: BUF_SRC,
          paint: { 'line-color': '#d93025', 'line-width': 1 },
        });
        const dots: FeatureCollection = {
          type: 'FeatureCollection',
          features: cameras.map((c) => ({
            type: 'Feature',
            properties: {
              id: c.id,
              address: c.address ?? '',
              source: c.source ?? '',
              verified: c.verified ? 'yes' : 'no',
            },
            geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
          })),
        };
        map.addSource(DOT_SRC, { type: 'geojson', data: dots });
        map.addLayer({
          id: DOT_LAYER,
          type: 'circle',
          source: DOT_SRC,
          paint: {
            'circle-radius': 5,
            'circle-color': '#d93025',
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1.5,
          },
        });
        map.on('click', DOT_LAYER, onDotClick);
        map.on('mouseenter', DOT_LAYER, onEnter);
        map.on('mouseleave', DOT_LAYER, onLeave);
      } catch {
        /* layer sync must never break the map */
      }
    };

    if (map.isStyleLoaded()) {
      apply();
    } else {
      map.once('load', apply);
    }
    return () => {
      cancelled = true;
      map.off('load', apply);
      cleanup();
    };
  }, [map, cameras, bufferMeters]);

  return null;
}
