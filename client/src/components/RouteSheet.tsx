import { ChevronDown, ChevronUp, KeyRound, Navigation, Share2, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import TurnSteps from './TurnSteps';
import type { RouteResponse, ScoredRoute } from '../../../shared/src/types';

// All contract-derived: the sheet renders exactly what /api/route returns.
export type SheetJev = ScoredRoute['jev'];
export type SheetJevExposure = ScoredRoute['jevExposure'];
export type SheetRoute = ScoredRoute;
/** Clean-search summary as returned in the response envelope. */
export type CleanSearch = NonNullable<RouteResponse['cleanSearch']>;

function fmtDetour(ratio?: number | null): string | null {
  if (ratio == null || !Number.isFinite(ratio) || ratio <= 0) return null;
  const pct = Math.round((ratio - 1) * 100);
  if (pct <= 0) return 'no extra distance';
  return `+${pct}% longer`;
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
  cleanSearch?: CleanSearch | null;
  onFind: () => void;
  navigating?: boolean;
  canNavigate?: boolean;
  onToggleNavigate?: () => void;
  /** Copies/shares a deep link for the current route. */
  onShare?: () => void;
  shareNotice?: string | null;
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

function fmtTimeDiff(s: number, fastest: number): string {
  if (!(s > fastest)) return 'fastest';
  const mins = Math.round((s - fastest) / 60);
  return mins <= 0 ? 'fastest' : `+${mins} min`;
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
  if (jev.fallbackUsed) {
    return (
      <span className="gm-jevs muted" title="Heuristic score — add a Jev key for AI ranking">
        heur
      </span>
    );
  }
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

function fmtTradeoffExtra(t: NonNullable<SheetJev['tradeoff']>): string | null {
  const parts: string[] = [];
  if (t.savedExposures > 0) parts.push(`avoids ${t.savedExposures} cam${t.savedExposures === 1 ? '' : 's'}`);
  if (t.extraSeconds > 0) {
    const m = Math.round(t.extraSeconds / 60);
    parts.push(m <= 0 ? `+<1 min` : `+${m} min`);
  }
  if (t.extraMeters > 0) parts.push(`+${(t.extraMeters / 1000).toFixed(1)} km`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function JevWhy({ route, live }: { route: SheetRoute; live: boolean }) {
  const { jev, jevExposure } = route;
  const tradeoff = jev.tradeoff ? fmtTradeoffExtra(jev.tradeoff) : null;
  const highRisk = (route.steps ?? []).filter((s) => (s.exposureP ?? 0) > 0.1).length;
  if (!jev.rationale && !tradeoff && jevExposure == null) return null;
  return (
    <div className="gm-jev-why" role="status" aria-label={`Why this route: ${jev.rationale ?? ''}`}>
      <div className="gm-jev-why-head">
        <KeyRound size={14} aria-hidden="true" />
        <span>{live ? 'JEV pick' : 'Heuristic pick'} · {Math.round(jev.confidence * 100)}% conf</span>
        {jev.fallbackUsed && <span className="gm-fallback">fallback</span>}
      </div>
      {jev.rationale && <p className="gm-jev-why-text">{jev.rationale}</p>}
      <div className="gm-jev-why-meta">
        {tradeoff && <span className="gm-jevs">{tradeoff}</span>}
        {jevExposure && (
          <span className="gm-jevs" title={`Exposure estimate source: ${jevExposure.source}`}>
            seen {Math.round(jevExposure.p * 100)}% · {jevExposure.source === 'geometric' ? 'geom' : 'JEV'}
            {typeof jevExposure.confidence === 'number' ? ` · ${Math.round(jevExposure.confidence * 100)}%` : ''}
          </span>
        )}
        {highRisk > 0 && <span className="gm-fallback">{highRisk} risky turn{highRisk === 1 ? '' : 's'}</span>}
      </div>
    </div>
  );
}

function CleanBanner({ search, total }: { search: CleanSearch; total: number }) {
  // "Avoidance is off" must never read as "no clean route exists": the search
  // did not run at all, and the server says so explicitly.
  if (search.skipped === 'avoid-disabled') {
    return (
      <div className="gm-clean-banner muted" role="status">
        <ShieldAlert size={16} aria-hidden="true" />
        <span className="gm-clean-title">Camera avoidance is off</span>
        <span className="gm-clean-meta">exposure shown, not avoided</span>
      </div>
    );
  }
  if (search.cleanFound) {
    const meta: string[] = [];
    const detour = fmtDetour(search.detourRatio);
    if (detour) meta.push(detour);
    if (search.osrmCalls != null) meta.push(`${search.osrmCalls} checks`);
    if (search.aborted) meta.push('search cut short by time budget');
    return (
      <div className="gm-clean-banner found" role="status">
        <ShieldCheck size={16} aria-hidden="true" />
        <span className="gm-clean-title">Camera-free route found</span>
        {meta.length > 0 && <span className="gm-clean-meta">{meta.join(' · ')}</span>}
      </div>
    );
  }
  return (
    <div className="gm-clean-banner miss" role="status">
      <ShieldAlert size={16} aria-hidden="true" />
      <span className="gm-clean-title">
        {search.aborted
          ? `Search cut short by time budget${total > 0 ? ` — best of ${total} below` : ''}`
          : `No camera-free route${total > 0 ? ` — best of ${total} below` : ''}`}
      </span>
    </div>
  );
}

function CompareTable({ routes, selectedId }: { routes: SheetRoute[]; selectedId: string | null }) {
  if (routes.length < 2) return null;
  return (
    <div className="gm-compare" aria-label="Route comparison">
      <table>
        <thead>
          <tr>
            <th scope="col">Route</th>
            <th scope="col">Time</th>
            <th scope="col">Cams</th>
            <th scope="col">Seen</th>
            <th scope="col">JEV</th>
          </tr>
        </thead>
        <tbody>
          {routes.map((r, i) => (
            <tr key={r.id} aria-current={r.id === selectedId ? 'true' : undefined} className={r.id === selectedId ? 'sel' : undefined}>
              <td className="gm-tabular">R{i + 1}</td>
              <td className="gm-tabular">{fmtDur(r.durationS)}</td>
              <td className="gm-tabular">{r.exposureCount}</td>
              <td className="gm-tabular">{r.jevExposure ? `${Math.round(r.jevExposure.p * 100)}%` : r.exposureP != null ? `${Math.round(r.exposureP * 100)}%` : '—'}</td>
              <td className="gm-tabular">{Math.round(r.jev.confidence * 100)}%{r.jev.fallbackUsed ? '†' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="gm-sheet-meta">† fallback · Seen = observed-by-≥1-camera probability</p>
    </div>
  );
}

export default function RouteSheet(props: RouteSheetProps) {
  const { routes, selectedId, onSelect, loading, expanded, onToggle, rankedBy, jevMode, jevLive = false, cleanSearch = null, onFind, navigating = false, canNavigate = false, onToggleNavigate, onShare, shareNotice = null } =
    props;
  const best = routes.find((r) => r.id === selectedId) ?? routes[0] ?? null;
  const fastest = routes.reduce((m, r) => Math.min(m, r.durationS), Infinity);

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
          <>
            <p className="gm-sheet-meta" role="status">
              Searching for a zero-exposure route…
            </p>
            <ul className="gm-skeleton-list" aria-label="Loading routes">
            {[0, 1, 2].map((i) => (
              <li key={i} className="gm-skeleton-card" aria-hidden="true">
                <div className="gm-skeleton-line w60" />
                <div className="gm-skeleton-line w90" />
              </li>
            ))}
          </ul>
          </>
        )}

        {!loading && cleanSearch && <CleanBanner search={cleanSearch} total={routes.length} />}

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
              <ExposureBadge count={best.exposureCount} />
              <SeenRiskCompact route={best} />
              <JevChip jev={best.jev} />
            </span>
          </button>
        )}

        {!loading && best && expanded && (
          <div>
            <div className="gm-sheet-status">
              <JevLiveChip live={jevLive} />
            </div>
            {rankedBy === 'jev' ? (
              <p className="gm-sheet-meta">Ranked by Jev AI</p>
            ) : jevMode === 'jev' ? (
              <p className="gm-sheet-meta">Ranked by fewest cameras · Jev was uncertain this time</p>
            ) : (
              <p className="gm-sheet-meta">Ranked by fewest cameras · add a Jev key for AI ranking</p>
            )}
            <ol className="gm-route-list">
              {routes.map((r, i) => {
                // Trust the server-derived flag — never recompute it here.
                const clean = r.isClean === true;
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
                          {fmtKm(r.distanceM)} · {fmtTimeDiff(r.durationS, fastest)}
                        </span>
                      </span>
                      <span className="gm-card-badges">
                        <ExposureBadge count={r.exposureCount} />
                        <SeenRiskCompact route={r} />
                        <JevChip jev={r.jev} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <div className="gm-selected-detail">
              <SeenRiskRow route={best} />
              <JevWhy route={best} live={jevLive} />
              <div className="gm-detail-actions">
                {onToggleNavigate && (
                  <button
                    type="button"
                    className="gm-empty-btn"
                    aria-pressed={navigating}
                    disabled={!navigating && !canNavigate}
                    title={
                      navigating
                        ? 'Stop turn-by-turn navigation'
                        : canNavigate
                          ? 'Start turn-by-turn navigation with camera alerts'
                          : 'Navigation needs a route with turn steps'
                    }
                    onClick={onToggleNavigate}
                  >
                    <Navigation size={16} />
                    {navigating ? 'Stop navigation' : 'Navigate'}
                  </button>
                )}
                {onShare && (
                  <button
                    type="button"
                    className="gm-share-btn"
                    title="Copy a shareable link to this route"
                    onClick={onShare}
                  >
                    <Share2 size={16} />
                    Share
                  </button>
                )}
              </div>
              {shareNotice && (
                <p className="gm-sheet-meta" role="status">
                  {shareNotice}
                </p>
              )}
              <CompareTable routes={routes} selectedId={selectedId} />
              <TurnSteps steps={best.steps} />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
