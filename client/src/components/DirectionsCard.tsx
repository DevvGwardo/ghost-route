import { useEffect, useRef, useState } from 'react';
import KeySettings, { type KeyValid } from './KeySettings';
import { searchPlaces } from '../lib/geocode';
import type { LatLon, TravelProfile } from '../../../shared/src/types';
import {
  ArrowLeft,
  ArrowUpDown,
  Bike,
  Car,
  ChevronDown,
  ChevronUp,
  Circle,
  Clock,
  Footprints,
  MapPin,
  Navigation,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  X,
} from 'lucide-react';

export type { LatLon };

/**
 * Structural suggestion shape. Kept minimal on purpose so BOTH geocoder
 * results (which carry a sublabel) and locally stored places (which do not)
 * satisfy it without conversion.
 */
export interface Suggestion {
  label: string;
  lat: number;
  lon: number;
  sublabel?: string;
}

function fullLabel(s: Suggestion): string {
  return s.sublabel ? `${s.label}, ${s.sublabel}` : s.label;
}

interface PlaceFieldProps {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  icon: React.ReactNode;
  coordsLabel: string;
  /** Shown on focus while the field is empty (recents / saved places). */
  emptySuggestions?: Suggestion[];
  /** Resolved coordinates for the field, when there are any. */
  current?: LatLon | null;
  saved?: boolean;
  onToggleSave?: (p: Suggestion) => void;
  onTextChange: (v: string) => void;
  onPick: (p: LatLon, label: string) => void;
}

function PlaceField({
  id,
  label,
  value,
  placeholder,
  icon,
  coordsLabel,
  emptySuggestions = [],
  current = null,
  saved = false,
  onToggleSave,
  onTextChange,
  onPick,
}: PlaceFieldProps) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [highlight, setHighlight] = useState(-1);
  const seqRef = useRef(0);

  const empty = value.trim().length === 0;
  // With no query typed, offer recents rather than nothing at all.
  const shown: Suggestion[] = empty ? emptySuggestions : suggestions;

  // Only one field's dropdown open at a time: each field announces focus,
  // others close. (Prevents origin + destination lists stacking on each other.)
  useEffect(() => {
    const closeOthers = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) setOpen(false);
    };
    window.addEventListener('gr-suggest-open', closeOthers);
    return () => window.removeEventListener('gr-suggest-open', closeOthers);
  }, [id]);

  // Debounced autocomplete dropdown. searchPlaces() never throws and takes
  // no AbortSignal, so stale responses are dropped via sequence guard.
  useEffect(() => {
    const q = value.trim();
    if (q.length < 3) {
      setSuggestions([]);
      if (q.length > 0) setOpen(false);
      setHighlight(-1);
      return;
    }
    const t = window.setTimeout(() => {
      const seq = ++seqRef.current;
      void searchPlaces(q).then((list) => {
        if (seqRef.current !== seq) return; // stale — newer query in flight
        setSuggestions(list);
        setHighlight(-1);
        setOpen(list.length > 0);
      });
    }, 350);
    return () => window.clearTimeout(t);
  }, [value]);

  function pick(s: Suggestion) {
    onPick({ lat: s.lat, lon: s.lon }, s.sublabel ? fullLabel(s) : s.label);
    setOpen(false);
    setSuggestions([]);
  }

  // Enter with no highlighted suggestion: resolve top result immediately.
  async function commit() {
    const q = value.trim();
    if (!q) {
      if (shown.length > 0) pick(shown[0]);
      return;
    }
    if (highlight >= 0 && shown[highlight]) {
      pick(shown[highlight]);
      return;
    }
    if (suggestions.length > 0) {
      pick(suggestions[0]);
      return;
    }
    const seq = ++seqRef.current;
    const list = await searchPlaces(q);
    if (seqRef.current !== seq || list.length === 0) return;
    pick(list[0]);
  }

  return (
    <div className="gm-field">
      <div className="gm-field-row">
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
            if (e.key === 'ArrowDown' && shown.length > 0) {
              e.preventDefault();
              setOpen(true);
              setHighlight((h) => (h + 1) % shown.length);
            } else if (e.key === 'ArrowUp' && shown.length > 0) {
              e.preventDefault();
              setHighlight((h) => (h - 1 + shown.length) % shown.length);
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
          onFocus={() => {
            window.dispatchEvent(new CustomEvent('gr-suggest-open', { detail: id }));
            if (shown.length > 0) setOpen(true);
          }}
          placeholder={placeholder}
          autoComplete="off"
        />
        {current && onToggleSave && (
          <button
            type="button"
            className={`gm-field-star${saved ? ' on' : ''}`}
            aria-label={saved ? `Remove ${label} from saved places` : `Save ${label} as a place`}
            aria-pressed={saved}
            title={saved ? 'Remove from saved places' : 'Save this place'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() =>
              onToggleSave({
                label: value.trim() || `${current.lat.toFixed(4)}, ${current.lon.toFixed(4)}`,
                lat: current.lat,
                lon: current.lon,
              })
            }
          >
            <Star size={16} aria-hidden="true" />
          </button>
        )}
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
      </div>
      {open && shown.length > 0 && (
        <ul className="gm-suggest" id={`${id}-suggest`} role="listbox" aria-label={`${label} suggestions`}>
          {shown.map((s, i) => (
            <li key={`${s.lat},${s.lon},${i}`} id={`${id}-opt-${i}`} role="option" aria-selected={i === highlight}>
              <button
                type="button"
                className={i === highlight ? 'active' : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
              >
                <span className="gm-suggest-icon" aria-hidden="true">
                  {empty ? <Clock size={16} /> : <MapPin size={16} />}
                </span>
                <span className="gm-suggest-text" title={fullLabel(s)}>
                  <span className="gm-suggest-label">{s.label}</span>
                  {s.sublabel && (
                    <span className="gm-suggest-sub">{s.sublabel}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const PROFILES: Array<{ id: TravelProfile; label: string; icon: React.ReactNode }> = [
  { id: 'driving', label: 'Drive', icon: <Car size={14} /> },
  { id: 'walking', label: 'Walk', icon: <Footprints size={14} /> },
  { id: 'cycling', label: 'Bike', icon: <Bike size={14} /> },
];

export interface DirectionsCardProps {
  origin: LatLon | null;
  destination: LatLon | null;
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
  profile: TravelProfile;
  onProfileChange: (p: TravelProfile) => void;
  respectDirection: boolean;
  onRespectDirectionChange: (v: boolean) => void;
  verifiedOnly: boolean;
  onVerifiedOnlyChange: (v: boolean) => void;
  /** Brand chips derived from the cameras currently in view. */
  brandOptions: string[];
  brands: string[];
  onBrandsChange: (b: string[]) => void;
  /** Recent/saved places offered while a field is empty. */
  originSuggestions: Suggestion[];
  destinationSuggestions: Suggestion[];
  savedPlaces: Suggestion[];
  onToggleSave: (p: Suggestion) => void;
  onFind: () => void;
  loading: boolean;
  error: string | null;
  typesafeKey: string;
  onKeyChange: (key: string) => void;
  keyValid: KeyValid;
  onKeyValidChange: (v: KeyValid) => void;
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
    profile,
    onProfileChange,
    respectDirection,
    onRespectDirectionChange,
    verifiedOnly,
    onVerifiedOnlyChange,
    brandOptions,
    brands,
    onBrandsChange,
    originSuggestions,
    destinationSuggestions,
    savedPlaces,
    onToggleSave,
    onFind,
    loading,
    error,
    typesafeKey,
    onKeyChange,
    keyValid,
    onKeyValidChange,
  } = props;
  const [optionsOpen, setOptionsOpen] = useState(false);

  const isSaved = (label: string, point: LatLon | null): boolean =>
    point !== null &&
    savedPlaces.some(
      (p) =>
        p.label === label ||
        (Math.abs(p.lat - point.lat) < 1e-4 && Math.abs(p.lon - point.lon) < 1e-4),
    );

  const toggleBrand = (brand: string) => {
    onBrandsChange(
      brands.includes(brand) ? brands.filter((b) => b !== brand) : [...brands, brand],
    );
  };

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
            coordsLabel={origin ? `Currently ${fmtCoord(origin)}` : 'Not set yet'}
            emptySuggestions={originSuggestions}
            current={origin}
            saved={isSaved(originLabel, origin)}
            onToggleSave={onToggleSave}
            onTextChange={onOriginText}
            onPick={onOriginPick}
          />
          <PlaceField
            id="gr-destination"
            label="Destination"
            value={destinationLabel}
            placeholder="Choose destination"
            icon={<MapPin size={16} />}
            coordsLabel={destination ? `Currently ${fmtCoord(destination)}` : 'Not set yet'}
            emptySuggestions={destinationSuggestions}
            current={destination}
            saved={isSaved(destinationLabel, destination)}
            onToggleSave={onToggleSave}
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

      <div className="gm-profile-row" role="group" aria-label="Travel mode">
        {PROFILES.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`gm-profile-btn${profile === p.id ? ' on' : ''}`}
            aria-pressed={profile === p.id}
            onClick={() => onProfileChange(p.id)}
          >
            {p.icon}
            {p.label}
          </button>
        ))}
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
              max={5000}
              step={50}
              value={bufferMeters}
              onChange={(e) => onBufferMetersChange(Number(e.target.value))}
            />
            <output>{bufferMeters} m</output>
          </label>
          <label className="gm-toggle-row" htmlFor="gr-dir">
            <input
              id="gr-dir"
              type="checkbox"
              checked={respectDirection}
              onChange={(e) => onRespectDirectionChange(e.target.checked)}
            />
            Only count cameras facing the route
          </label>
          <label className="gm-toggle-row" htmlFor="gr-verified">
            <input
              id="gr-verified"
              type="checkbox"
              checked={verifiedOnly}
              onChange={(e) => onVerifiedOnlyChange(e.target.checked)}
            />
            Verified cameras only
          </label>
          <p className="gm-options-hint">
            Off by default: every camera counts, including user-submitted ones.
          </p>
          {brandOptions.length > 0 && (
            <div className="gm-brand-row" role="group" aria-label="Camera brands to count">
              <span className="gm-brand-label">
                <ShieldCheck size={14} aria-hidden="true" /> Brands
              </span>
              <div className="gm-chips">
                {brandOptions.map((b) => (
                  <button
                    key={b}
                    type="button"
                    className={`gm-chip${brands.includes(b) ? ' on' : ''}`}
                    aria-pressed={brands.includes(b)}
                    onClick={() => toggleBrand(b)}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>
          )}
          <KeySettings
            typesafeKey={typesafeKey}
            onKeyChange={onKeyChange}
            keyValid={keyValid}
            onKeyValidChange={onKeyValidChange}
          />
        </div>
      )}

      <button
        type="button"
        className="gm-find-btn"
        onClick={onFind}
        disabled={loading || !origin || !destination}
        aria-busy={loading || undefined}
      >
        <Navigation size={18} aria-hidden="true" />
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
