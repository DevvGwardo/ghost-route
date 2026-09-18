import { useEffect, useRef, useState } from 'react';
import KeySettings from './KeySettings';
import {
  ArrowLeft,
  ArrowUpDown,
  Bike,
  Car,
  ChevronDown,
  ChevronUp,
  Circle,
  Footprints,
  MapPin,
  Navigation,
  SlidersHorizontal,
  TrainFront,
  X,
} from 'lucide-react';

export interface LatLon {
  lat: number;
  lon: number;
}

interface Suggestion {
  lat: number;
  lon: number;
  label: string;
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
}

async function geocodeList(query: string, signal: AbortSignal): Promise<Suggestion[]> {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`,
    { headers: { Accept: 'application/json' }, signal },
  );
  if (!res.ok) throw new Error('Geocode request failed');
  const list = (await res.json()) as NominatimResult[];
  return list.map((r) => ({
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    label: r.display_name,
  }));
}

interface PlaceFieldProps {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  icon: React.ReactNode;
  coordsLabel: string;
  onTextChange: (v: string) => void;
  onPick: (p: LatLon, label: string) => void;
}

function PlaceField({ id, label, value, placeholder, icon, coordsLabel, onTextChange, onPick }: PlaceFieldProps) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [highlight, setHighlight] = useState(-1);
  const abortRef = useRef<AbortController | null>(null);

  // Debounced autocomplete dropdown.
  useEffect(() => {
    const q = value.trim();
    if (q.length < 3) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const t = window.setTimeout(() => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      void geocodeList(q, ctrl.signal)
        .then((list) => {
          setSuggestions(list);
          setHighlight(-1);
          setOpen(list.length > 0);
        })
        .catch(() => {
          /* aborted or offline — typing still works, Enter retries */
        });
    }, 350);
    return () => window.clearTimeout(t);
  }, [value]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function pick(s: Suggestion) {
    onPick({ lat: s.lat, lon: s.lon }, s.label);
    setOpen(false);
    setSuggestions([]);
  }

  // Enter with no highlighted suggestion: resolve top result immediately.
  async function commit() {
    const q = value.trim();
    if (!q) return;
    if (highlight >= 0 && suggestions[highlight]) {
      pick(suggestions[highlight]);
      return;
    }
    if (suggestions.length > 0) {
      pick(suggestions[0]);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const list = await geocodeList(q, ctrl.signal);
      if (list.length === 0) return;
      pick(list[0]);
    } catch {
      /* leave text as-is on failure */
    }
  }

  return (
    <div className="gm-field">
      <span className="gm-field-icon" aria-hidden="true">
        {icon}
      </span>
      <label htmlFor={id} className="gm-sr-only">
        {label}
      </label>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-suggest`}
        aria-activedescendant={highlight >= 0 ? `${id}-opt-${highlight}` : undefined}
        aria-label={`${label}. ${coordsLabel}`}
        value={value}
        onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && suggestions.length > 0) {
            e.preventDefault();
            setOpen(true);
            setHighlight((h) => (h + 1) % suggestions.length);
          } else if (e.key === 'ArrowUp' && suggestions.length > 0) {
            e.preventDefault();
            setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            void commit();
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        onBlur={() => {
          // Delay so option mousedown fires first.
          window.setTimeout(() => setOpen(false), 120);
        }}
        placeholder={placeholder}
        autoComplete="off"
      />
      {value && (
        <button
          type="button"
          className="gm-field-clear"
          aria-label={`Clear ${label}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onTextChange('')}
        >
          <X size={16} />
        </button>
      )}
      {open && suggestions.length > 0 && (
        <ul className="gm-suggest" id={`${id}-suggest`} role="listbox" aria-label={`${label} suggestions`}>
          {suggestions.map((s, i) => (
            <li key={`${s.lat},${s.lon},${i}`} id={`${id}-opt-${i}`} role="option" aria-selected={i === highlight}>
              <button
                type="button"
                className={i === highlight ? 'active' : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
              >
                <span className="gm-suggest-icon" aria-hidden="true">
                  <MapPin size={16} />
                </span>
                <span className="gm-suggest-label" title={s.label}>
                  {s.label}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface DirectionsCardProps {
  origin: LatLon;
  destination: LatLon;
  originLabel: string;
  destinationLabel: string;
  onOriginText: (v: string) => void;
  onDestinationText: (v: string) => void;
  onOriginPick: (p: LatLon, label: string) => void;
  onDestinationPick: (p: LatLon, label: string) => void;
  onSwap: () => void;
  onBack: () => void;
  avoidFlock: boolean;
  onAvoidFlockChange: (v: boolean) => void;
  bufferMeters: number;
  onBufferMetersChange: (v: number) => void;
  onFind: () => void;
  loading: boolean;
  error: string | null;
  typesafeKey: string;
  onKeyChange: (key: string) => void;
}

function fmtCoord(p: LatLon): string {
  return `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
}

export default function DirectionsCard(props: DirectionsCardProps) {
  const {
    origin,
    destination,
    originLabel,
    destinationLabel,
    onOriginText,
    onDestinationText,
    onOriginPick,
    onDestinationPick,
    onSwap,
    onBack,
    avoidFlock,
    onAvoidFlockChange,
    bufferMeters,
    onBufferMetersChange,
    onFind,
    loading,
    error,
    typesafeKey,
    onKeyChange,
  } = props;
  const [optionsOpen, setOptionsOpen] = useState(false);

  return (
    <div>
      <div className="gm-directions-row">
        <button type="button" className="gm-back-btn" aria-label="Back" onClick={onBack}>
          <ArrowLeft size={22} />
        </button>
        <div className="gm-fields">
          <PlaceField
            id="gr-origin"
            label="Origin"
            value={originLabel}
            placeholder="Choose starting point"
            icon={<Circle size={14} />}
            coordsLabel={`Currently ${fmtCoord(origin)}`}
            onTextChange={onOriginText}
            onPick={onOriginPick}
          />
          <PlaceField
            id="gr-destination"
            label="Destination"
            value={destinationLabel}
            placeholder="Choose destination"
            icon={<MapPin size={16} />}
            coordsLabel={`Currently ${fmtCoord(destination)}`}
            onTextChange={onDestinationText}
            onPick={onDestinationPick}
          />
        </div>
        <button
          type="button"
          className="gm-swap-btn"
          aria-label="Swap origin and destination"
          onClick={onSwap}
        >
          <ArrowUpDown size={20} />
        </button>
      </div>

      <div className="gm-modes" role="tablist" aria-label="Transport mode">
        <button type="button" role="tab" aria-selected="true" className="gm-mode" title="Driving">
          <Car size={20} />
        </button>
        <button
          type="button"
          role="tab"
          aria-selected="false"
          aria-disabled="true"
          disabled
          className="gm-mode disabled"
          title="Driving only in this build"
        >
          <Footprints size={20} />
        </button>
        <button
          type="button"
          role="tab"
          aria-selected="false"
          aria-disabled="true"
          disabled
          className="gm-mode disabled"
          title="Driving only in this build"
        >
          <Bike size={20} />
        </button>
        <button
          type="button"
          role="tab"
          aria-selected="false"
          aria-disabled="true"
          disabled
          className="gm-mode disabled"
          title="Driving only in this build"
        >
          <TrainFront size={20} />
        </button>
      </div>

      <button
        type="button"
        className="gm-options-toggle"
        aria-expanded={optionsOpen}
        aria-controls="gr-route-options"
        onClick={() => setOptionsOpen((v) => !v)}
      >
        <SlidersHorizontal size={16} />
        Route options
        <span className="chev" aria-hidden="true">
          {optionsOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </span>
      </button>
      {optionsOpen && (
        <div className="gm-options" id="gr-route-options">
          <label className="gm-toggle-row" htmlFor="gr-avoid">
            <input
              id="gr-avoid"
              type="checkbox"
              checked={avoidFlock}
              onChange={(e) => onAvoidFlockChange(e.target.checked)}
            />
            Avoid Flock cameras
          </label>
          <label className="gm-slider-row" htmlFor="gr-buffer">
            Buffer radius
            <input
              id="gr-buffer"
              type="range"
              min={50}
              max={500}
              step={10}
              value={bufferMeters}
              onChange={(e) => onBufferMetersChange(Number(e.target.value))}
            />
            <output>{bufferMeters} m</output>
          </label>
          <KeySettings typesafeKey={typesafeKey} onKeyChange={onKeyChange} />
        </div>
      )}

      <button type="button" className="gm-find-btn" onClick={onFind} disabled={loading}>
        <Navigation size={18} />
        {loading ? 'Finding…' : 'Find clean route'}
      </button>
      {error && (
        <p className="gm-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
