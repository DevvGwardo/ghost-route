import { ChevronDown, ChevronUp, KeyRound, Navigation, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import TurnSteps, { type RouteStep } from './TurnSteps';

interface SheetJev {
  choice: string;
  confidence: number;
  fallbackUsed: boolean;
}

export interface SheetJevExposure {
  p: number;
  confidence: number;
  fallbackUsed: boolean;
  source: string;
}

export interface SheetRoute {
  id: string;
  distanceM: number;
  durationS: number;
  exposureCount: number;
  jev: SheetJev;
  steps?: RouteStep[];
  exposureP?: number;
  jevExposure?: SheetJevExposure;
}

interface RouteSheetProps {
  routes: SheetRoute[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  expanded: boolean;
  onToggle: () => void;
  rankedBy: string | null;
  jevMode: string | null;
  jevLive?: boolean;
  onFind: () => void;
}

function fmtKm(m: number): string {
  return `${(m / 1000).toFixed(1)} km`;
}

function fmtDur(s: number): string {
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')} min`;
}

function seenRisk(route: SheetRoute): { p: number; caption: string; fallback: boolean } | null {
  const p = route.jevExposure?.p ?? route.exposureP;
  if (p == null || !Number.isFinite(p)) return null;
  const source = route.jevExposure?.source ?? (route.exposureP != null ? 'geometric' : '');
  const caption =
    source === 'geometric' ? 'geometric estimate' : 'JEV estimate';
  return { p, caption, fallback: route.jevExposure?.fallbackUsed ?? false };
}

function riskTone(p: number): 'low' | 'mid' | 'high' {
  if (p < 0.1) return 'low';
  if (p <= 0.4) return 'mid';
  return 'high';
}

function SeenRiskRow({ route }: { route: SheetRoute }) {
  const risk = seenRisk(route);
  if (!risk) return null;
  const tone = riskTone(risk.p);
  const Icon = tone === 'low' ? ShieldCheck : ShieldAlert;
  return (
    <div className={`gm-seen-risk ${tone}`} role="status" aria-label={`Seen risk ${Math.round(risk.p * 100)} percent, ${risk.caption}${risk.fallback ? ', fallback used' : ''}`}>
      <Icon size={20} aria-hidden="true" />
      <span className="gm-seen-pct gm-tabular">{Math.round(risk.p * 100)}%</span>
      <span className="gm-seen-meta">
        <span className="gm-seen-label">Seen risk</span>
        <span className="gm-seen-cap">
          {risk.caption}
          {risk.fallback ? ' · fallback' : ''}
        </span>
      </span>
    </div>
  );
}

function SeenRiskCompact({ route }: { route: SheetRoute }) {
  const risk = seenRisk(route);
  if (!risk) return null;
  const tone = riskTone(risk.p);
  const Icon = tone === 'low' ? ShieldCheck : ShieldAlert;
  return (
    <span className={`gm-seen-compact ${tone}`} aria-label={`Seen risk ${Math.round(risk.p * 100)} percent`}>
      <Icon size={14} aria-hidden="true" />
      <span className="gm-tabular">{Math.round(risk.p * 100)}%</span>
    </span>
  );
}
function ExposureBadge({ count }: { count: number }) {
  if (count === 0) {
    return (
      <span className="gm-badge clean">
        <ShieldCheck size={14} />
        No cameras
      </span>
    );
  }
  return (
    <span className="gm-badge exposed">
      <TriangleAlert size={14} />{count} camera{count === 1 ? '' : 's'}
    </span>
  );
}

function JevChip({ jev }: { jev: SheetJev }) {
  return (
    <span className="gm-jevs" title={`Jev choice ${jev.choice}`}>
      {Math.round(jev.confidence * 100)}%
    </span>
  );
}

function JevLiveChip({ live }: { live: boolean }) {
  return (
    <span
      className={`gm-jev-live ${live ? 'live' : 'heur'}`}
      role="status"
      aria-label={live ? 'JEV live scoring' : 'Heuristic scoring'}
    >
      <KeyRound size={14} aria-hidden="true" />
      {live ? 'JEV live' : 'heuristic'}
    </span>
  );
}

export default function RouteSheet(props: RouteSheetProps) {
  const { routes, selectedId, onSelect, loading, expanded, onToggle, rankedBy, jevMode, jevLive = false, onFind } =
    props;
  const best = routes.find((r) => r.id === selectedId) ?? routes[0] ?? null;

  return (
    <section className="gm-sheet" aria-label="Routes">
      <button
        type="button"
        className="gm-sheet-handle"
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse route list' : 'Expand route list'}
        onClick={onToggle}
      >
        <span className="chev" aria-hidden="true">
          {expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </span>
      </button>
      <div className="gm-sheet-body">
        {loading && (
          <ul className="gm-skeleton-list" aria-label="Loading routes">
            {[0, 1, 2].map((i) => (
              <li key={i} className="gm-skeleton-card" aria-hidden="true">
                <div className="gm-skeleton-line w60" />
                <div className="gm-skeleton-line w90" />
              </li>
            ))}
          </ul>
        )}

        {!loading && routes.length === 0 && (
          <div className="gm-empty">
            <p>No routes yet — pick an origin and destination.</p>
            <button type="button" className="gm-empty-btn" onClick={onFind}>
              <Navigation size={16} />
              Find clean route
            </button>
          </div>
        )}

        {!loading && best && !expanded && (
          <button type="button" className="gm-peek" onClick={onToggle} aria-label="Show all routes">
            <span className="gm-peek-main">
              <span className="gm-duration">{fmtDur(best.durationS)}</span>
              <span className="gm-subline">
                {fmtKm(best.distanceM)}
                {best.exposureCount === 0
                  ? ' · no exposures'
                  : ` · ${best.exposureCount} exposure${best.exposureCount === 1 ? '' : 's'}`}
              </span>
            </span>
            <span className="gm-peek-badges">
              <JevLiveChip live={jevLive} />
              <ExposureBadge count={best.exposureCount} />
              <SeenRiskCompact route={best} />
              <JevChip jev={best.jev} />
              {best.jev.fallbackUsed && <span className="gm-fallback">fallback</span>}
            </span>
          </button>
        )}

        {!loading && best && expanded && (
          <div>
            <div className="gm-sheet-status">
              <JevLiveChip live={jevLive} />
            </div>
            {rankedBy && (
              <p className="gm-sheet-meta">
                Ranked by {rankedBy}
                {jevMode ? ` (${jevMode})` : ''}
              </p>
            )}
            <ol className="gm-route-list">
              {routes.map((r, i) => {
                const clean = r.exposureCount === 0;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      className={`gm-route-card ${clean ? 'clean' : 'exposed'}${r.id === selectedId ? ' selected' : ''}`}
                      aria-pressed={r.id === selectedId}
                      aria-label={`Route ${i + 1}, ${fmtDur(r.durationS)}, ${fmtKm(r.distanceM)}, ${r.exposureCount === 0 ? 'no camera exposures' : `${r.exposureCount} exposures`}`}
                      onClick={() => onSelect(r.id)}
                    >
                      <span className="gm-card-main">
                        <span className="gm-duration">{fmtDur(r.durationS)}</span>
                        <span className="gm-subline">
                          {fmtKm(r.distanceM)} · via route {i + 1}
                        </span>
                      </span>
                      <span className="gm-card-badges">
                        <ExposureBadge count={r.exposureCount} />
                        <JevChip jev={r.jev} />
                        {r.jev.fallbackUsed && <span className="gm-fallback">fallback</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <div className="gm-selected-detail">
              <SeenRiskRow route={best} />
              <TurnSteps steps={best.steps} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
