import { validateP } from "./services/scoring.js";

export type JevMode = "jev" | "fake";

export interface RankInput {
  id: string;
  score: number;
  distanceM: number;
  durationS: number;
  exposureCount: number;
  /** Combined geometric seen-risk 0..1 (computed pre-rank when available). */
  exposurePGeo?: number;
  /** Steps with exposureP > 0.1 — tells Jev where risk concentrates. */
  highRiskSteps?: number;
  cameraIds?: string[];
}

export interface JevTradeoff {
  savedExposures: number;
  extraSeconds: number;
  extraMeters: number;
}

export interface Verdict {
  choice: string;
  confidence: number;
  fallbackUsed: boolean;
  rationale?: string;
  tradeoff?: JevTradeoff;
}

export interface RankResult {
  rankedIds: string[];
  verdicts: Record<string, Verdict>;
  mode: JevMode;
  /**
   * True when a transport failure (timeout, network, non-2xx) forced the
   * deterministic fallback rather than the model genuinely being uncertain.
   * Callers must NOT cache degraded results — caching a timeout would make a
   * transient blip stick for the whole TTL.
   */
  degraded: boolean;
}

const SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 10000;
/**
 * User-initiated single check, behind a visible spinner. It was 5s, which is
 * below what a real model evaluation can take — and because a timeout used to
 * be reported as `unreachable`, a perfectly good key surfaced as "Could not
 * reach TypeSafe". Generous on purpose: nothing is on the routing hot path here.
 */
export const VERIFY_TIMEOUT_MS = 15000;

/**
 * Model alias for the evaluation endpoint (`jev-latest` is the documented
 * flagship alias). Pinnable via JEV_MODEL, but note the whole request shape is
 * version-coupled: an unknown alias is a 4xx, not a silent downgrade.
 */
const DEFAULT_MODEL = "jev-latest";
export function modelName(): string {
  const v = (process.env.JEV_MODEL ?? "").trim();
  return v || DEFAULT_MODEL;
}

/**
 * TypeSafe keys are bearer tokens — in practice JWTs of several hundred
 * characters. The previous 200-char cap dropped real keys on the floor, which
 * is why a perfectly good key reported as an unreachable service. The
 * verification question is answerable without a key until 4096.
 */
export const MAX_KEY_LENGTH = 4096;

export interface VerifyResult {
  valid: boolean;
  confidence?: number;
  /**
   * `key-required` | `invalid-key` | `unauthorized` | `invalid-request` |
   * `rate-limited` | `upstream-error` | `timeout` | `unreachable`. Distinct
   * values so the UI can say what actually happened instead of blaming the
   * network for everything — `timeout` (slow, retryable) is deliberately not
   * `unreachable` (can't get there at all).
   */
  error?: string;
  /** Upstream HTTP status when the failure was an HTTP response. */
  status?: number;
  /** Short upstream detail (key-scrubbed, truncated). Never contains the key. */
  detail?: string;
}

type UpstreamOutcome =
  | { ok: true; data: unknown }
  | {
      ok: false;
      kind: "auth" | "rejected" | "network" | "timeout";
      status?: number;
      detail?: string;
      /**
       * 429/529 — the docs call these out as retry-with-backoff. Marked here so
       * the retry decision stays with the transport rather than the caller.
       */
      retryable?: boolean;
      /** `Retry-After` in ms when the server sent one, else undefined. */
      retryAfterMs?: number;
    };

/** `Retry-After` (delta-seconds or an HTTP date), capped so it cannot eat the budget. */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 5_000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), 5_000);
  return undefined;
}

/** Backoff when a 429/529 arrives without `Retry-After`. */
const DEFAULT_BACKOFF_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One Answer object, keyed by the question id we chose (documented shape). */
interface SystemOneAnswer {
  type?: string;
  choice?: string;
  confidence?: number;
  noul?: number;
  probabilities?: Record<string, number>;
}

/** `answers` is a MAP keyed by question id in the documented API. */
function answersMap(data: unknown): Record<string, unknown> {
  const a = (data as { answers?: unknown } | null)?.answers;
  if (a && typeof a === "object" && !Array.isArray(a)) return a as Record<string, unknown>;
  return {};
}

function answerFor(data: unknown, id: string): SystemOneAnswer | null {
  const raw = answersMap(data)[id];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as SystemOneAnswer;
}

/** Legacy responses that carried answers as a positional array. */
function legacyAnswerArray(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  const a = (data as { answers?: unknown } | null)?.answers;
  return Array.isArray(a) ? a : null;
}

/** Upstream error text, scrubbed of anything key-shaped and flattened. */
function sanitizeDetail(raw: unknown): string | undefined {
  let text: string;
  if (typeof raw === "string") text = raw;
  else {
    try {
      text = JSON.stringify(raw);
    } catch {
      return undefined;
    }
  }
  if (!text) return undefined;
  const scrubbed = text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(sk-|rk_)[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!scrubbed) return undefined;
  return scrubbed.length > 200 ? `${scrubbed.slice(0, 197)}...` : scrubbed;
}

/**
 * One POST to the evaluation endpoint, with the failure CLASSIFIED.
 *
 * Collapsing every non-401/403 response into "unreachable" is what turned a
 * request-shape bug (a 422) into a phantom outage, so the kinds are kept
 * distinct all the way out to the caller. A timeout is likewise its own kind:
 * "the API is slow" and "the API is unreachable" need different fixes.
 *
 * `timeoutMs` is one HARD deadline for the whole call, retry included — a
 * retry must never push a request past the budget its caller set.
 */
async function callSystemOne(
  key: string,
  body: unknown,
  timeoutMs: number,
): Promise<UpstreamOutcome> {
  const budget = clampTimeoutMs(timeoutMs, TIMEOUT_MS);
  if (budget === 0) return { ok: false, kind: "timeout" };
  const deadline = Date.now() + budget;

  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, kind: "timeout" };

    const ctrl = new AbortController();
    let timedOut = false;
    const onAbort = (): void => {
      timedOut = true;
    };
    ctrl.signal.addEventListener("abort", onAbort);
    const t = setTimeout(() => ctrl.abort(), remaining);

    let outcome: UpstreamOutcome;
    try {
      const res = await fetch(SYSTEMONE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.ok) {
        outcome = { ok: true, data: (await res.json()) as unknown };
      } else {
        let parsed: unknown = null;
        try {
          parsed = await res.json();
        } catch {
          parsed = null;
        }
        const detail = sanitizeDetail(parsed);
        const after = retryAfterMs(res);
        outcome = {
          ok: false,
          kind: res.status === 401 || res.status === 403 ? "auth" : "rejected",
          status: res.status,
          ...(detail ? { detail } : {}),
          ...(res.status === 429 || res.status === 529 ? { retryable: true } : {}),
          ...(after !== undefined ? { retryAfterMs: after } : {}),
        };
      }
    } catch {
      // An abort here is OUR deadline firing, not a broken network.
      outcome = { ok: false, kind: timedOut ? "timeout" : "network" };
    } finally {
      clearTimeout(t);
      ctrl.signal.removeEventListener("abort", onAbort);
    }

    // Documented rate-limit handling: one retry, and only when the budget
    // genuinely still has room for another attempt after backing off.
    if (outcome.ok === false && outcome.retryable && attempt === 0) {
      const wait = outcome.retryAfterMs ?? DEFAULT_BACKOFF_MS;
      if (deadline - Date.now() > wait + 250) {
        await sleep(wait);
        continue;
      }
    }
    return outcome;
  }
}

const VERIFY_QUESTION = "verify";

/** Minimal well-formed evaluation request: two-option choice, nothing else. */
function verifyBody(): unknown {
  return {
    state: "Ghost Route key check: choose between two identical routes.",
    model: modelName(),
    questions: {
      [VERIFY_QUESTION]: {
        type: "choice",
        instructions: "Pick r1. This is a connectivity check, not a routing decision.",
        criteria: { r1: "The route to pick", r2: "The route not to pick" },
      },
    },
  };
}

/** Options for the validity check; `timeoutMs` is overridable for tests/tuning. */
export interface VerifyOpts {
  timeoutMs?: number;
}

/** Fast validity check for a pasted BYOK key. Minimal live call, never throws. */
export async function verifyKey(apiKey: string, opts?: VerifyOpts): Promise<VerifyResult> {
  const provided = (apiKey ?? "").trim();
  if (!provided) return { valid: false, error: "key-required" };
  const key = resolveKey(provided);
  // Present but unusable: never silently substitute another key (that would
  // verify a different key than the one being tested).
  if (!key) {
    return {
      valid: false,
      error: "invalid-key",
      detail: `key must be 1-${MAX_KEY_LENGTH} characters`,
    };
  }
  const out = await callSystemOne(key, verifyBody(), opts?.timeoutMs ?? VERIFY_TIMEOUT_MS);
  if (!out.ok) {
    const error =
      out.kind === "auth"
        ? "unauthorized"
        : out.kind === "network"
          ? "unreachable"
          : out.kind === "timeout"
            ? "timeout"
            : out.status === 429
              ? "rate-limited"
              : out.status !== undefined && out.status >= 500
                ? "upstream-error"
                : "invalid-request";
    return {
      valid: false,
      error,
      ...(out.status !== undefined ? { status: out.status } : {}),
      ...(out.detail ? { detail: out.detail } : {}),
    };
  }
  const answer = answerFor(out.data, VERIFY_QUESTION);
  const confidence = Number(answer?.confidence ?? 0);
  return {
    valid: true,
    confidence: Number.isFinite(confidence) ? confidence : 0,
  };
}

/**
 * BYOK key precedence: provided (trimmed) → env → "".
 *
 * A provided key is authoritative: an unusable one yields "" rather than
 * falling back to the operator's key, because quietly ranking (or verifying) a
 * different key than the user supplied is worse than not using one at all.
 * The length bound is a sanity cap for JWT-sized keys, not a validation rule.
 */
export function resolveKey(provided?: string): string {
  const p = (provided ?? "").trim();
  if (p) return p.length <= MAX_KEY_LENGTH ? p : "";
  const env = (process.env.TYPESAFE_API_KEY ?? "").trim();
  return env.length <= MAX_KEY_LENGTH ? env : "";
}

export function jevMode(apiKey?: string): JevMode {
  return resolveKey(apiKey) ? "jev" : "fake";
}

export function confidenceThreshold(): number {
  const v = Number(process.env.CONFIDENCE_THRESHOLD);
  return Number.isFinite(v) ? v : 0.4;
}

function heuristicBest(routes: RankInput[]): RankInput {
  return [...routes].sort((a, b) => a.score - b.score)[0];
}

function buildTradeoff(winner: RankInput, routes: RankInput[]): JevTradeoff {
  let fastest = winner;
  let maxExposure = winner.exposureCount;
  for (const r of routes) {
    if (r.durationS < fastest.durationS) fastest = r;
    if (r.exposureCount > maxExposure) maxExposure = r.exposureCount;
  }
  return {
    savedExposures: Math.max(0, maxExposure - winner.exposureCount),
    extraSeconds: Math.max(0, Math.round(winner.durationS - fastest.durationS)),
    extraMeters: Math.max(0, Math.round(winner.distanceM - fastest.distanceM)),
  };
}

function fmtMins(sec: number): string {
  const m = Math.round(sec / 60);
  return m <= 0 ? "<1 min" : `${m} min`;
}

function buildFallbackRationale(winner: RankInput, routes: RankInput[]): string {
  const t = buildTradeoff(winner, routes);
  const risk =
    typeof winner.exposurePGeo === "number"
      ? ` Seen risk ${Math.round(winner.exposurePGeo * 100)}%.`
      : "";
  const riskSteps =
    typeof winner.highRiskSteps === "number" && winner.highRiskSteps > 0
      ? ` ${winner.highRiskSteps} high-risk turn${winner.highRiskSteps === 1 ? "" : "s"}.`
      : "";
  if (t.savedExposures <= 0 && t.extraSeconds <= 0)
    return `Fewest cameras and fastest: ${winner.exposureCount} exposure${winner.exposureCount === 1 ? "" : "s"}.${risk}${riskSteps}`;
  if (t.savedExposures <= 0)
    return `Fastest route at ${winner.exposureCount} exposure${winner.exposureCount === 1 ? "" : "s"}.${risk}`;
  return `Avoids ${t.savedExposures} camera${t.savedExposures === 1 ? "" : "s"} vs most-exposed option${t.extraSeconds > 0 ? `, +${fmtMins(t.extraSeconds)} vs fastest` : " at no extra time"}.${risk}${riskSteps}`;
}

function sanitizeRationale(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().replace(/\s+/g, " ");
  if (!s) return undefined;
  return s.length > 280 ? s.slice(0, 277) + "…" : s;
}

function clampTimeoutMs(v: number | undefined, def: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return def;
  return Math.min(30_000, Math.max(0, Math.floor(v)));
}

/**
 * Deterministic best-first ranking. Exported so callers can reuse the exact
 * fallback (e.g. when the request budget is exhausted) without a network call.
 */
export function fallbackResult(
  routes: RankInput[],
  confidence: number,
  apiKey?: string,
  degraded = false,
): RankResult {
  const best = heuristicBest(routes);
  const rankedIds = [...routes].sort((a, b) => a.score - b.score).map((r) => r.id);
  const tradeoff = buildTradeoff(best, routes);
  const rationale = buildFallbackRationale(best, routes);
  const verdicts: Record<string, Verdict> = {};
  for (const r of routes)
    verdicts[r.id] = { choice: best.id, confidence, fallbackUsed: true, rationale, tradeoff };
  return { rankedIds, verdicts, mode: jevMode(apiKey), degraded };
}

export interface ExposureInput {
  id: string;
  exposurePGeo: number;
  exposureCount: number;
  distanceM: number;
}

/** Shared options: BYOK key, confidence gate, and a per-call time budget. */
export interface JevCallOpts {
  threshold?: number;
  apiKey?: string;
  /**
   * Hard cap for this call in ms (additive v1.2, spec P2-1). Lets one request
   * share a single deadline across ranking + exposure instead of each call
   * getting its own full 10s.
   */
  timeoutMs?: number;
}

export interface ExposureEstimate {
  p: number;
  confidence: number;
  fallbackUsed: boolean;
  source: "jev-noul" | "geometric";
}

/** Per-route exposure estimates, keyed by route id. */
export type EstimateExposureResult = Record<string, ExposureEstimate>;

export function geometricFallback(routes: ExposureInput[]): EstimateExposureResult {
  const out: EstimateExposureResult = {};
  for (const r of routes)
    out[r.id] = {
      p: validateP(r.exposurePGeo),
      confidence: 0.9,
      fallbackUsed: true,
      source: "geometric",
    };
  return out;
}

function parseNoulP(ans: unknown): number | null {
  if (typeof ans === "number") {
    const v = Number(ans);
    return Number.isFinite(v) ? validateP(v) : null;
  }
  if (ans !== null && typeof ans === "object") {
    const o = ans as Record<string, unknown>;
    for (const k of ["p_yes", "p", "noul", "probability"]) {
      const v = Number(o[k]);
      if (Number.isFinite(v)) return validateP(v);
    }
  }
  return null;
}

const EXPOSURE_QUESTION_PREFIX = "observed_";
const exposureQuestionId = (i: number): string => `${EXPOSURE_QUESTION_PREFIX}${i}`;

/**
 * One `noul` question per route, keyed by `observed_<index>`.
 *
 * Documented request shape: `{ state, model, questions: { <id>: { type,
 * instructions, criteria? } } }` — `questions` is a MAP and `model` is
 * required. The previous body sent an array of `{ type, question, options }`
 * with no `model`, which the API answers with a 422.
 */
function exposureBody(routes: ExposureInput[]): unknown {
  return {
    state: {
      task: "Estimate, per route, whether the vehicle is observed by at least one Flock ALPR camera.",
      routes: routes.map((r, i) => ({
        index: i,
        camerasWithinBuffer: r.exposureCount,
        geometricExposureProbability: r.exposurePGeo,
        distanceM: Math.round(r.distanceM),
      })),
    },
    model: modelName(),
    questions: Object.fromEntries(
      routes.map((r, i) => [
        exposureQuestionId(i),
        {
          type: "noul",
          instructions: `Route ${i} passes near ${r.exposureCount} Flock ALPR cameras with geometric exposure probability ${r.exposurePGeo}. Is the vehicle observed by at least one Flock camera on this route?`,
          criteria: {
            true: "Observed by at least one Flock ALPR camera",
            false: "Not observed by any Flock ALPR camera",
          },
        },
      ]),
    ),
  };
}

export async function estimateExposure(
  routes: ExposureInput[],
  opts?: JevCallOpts,
): Promise<EstimateExposureResult> {
  const threshold = opts?.threshold ?? confidenceThreshold();
  const key = resolveKey(opts?.apiKey);

  // No key → immediate geometric fallback for all.
  if (!key) return geometricFallback(routes);
  // No budget left → skip the network entirely (deterministic answer).
  if (opts?.timeoutMs !== undefined && clampTimeoutMs(opts.timeoutMs, TIMEOUT_MS) === 0)
    return geometricFallback(routes);

  const out = await callSystemOne(
    key,
    exposureBody(routes),
    clampTimeoutMs(opts?.timeoutMs, TIMEOUT_MS),
  );
  if (!out.ok) return geometricFallback(routes);

  const legacy = legacyAnswerArray(out.data);
  const result: EstimateExposureResult = {};
  routes.forEach((r, i) => {
    // Documented map shape first; positional arrays kept for older responses.
    const byId = parseNoulP(answerFor(out.data, exposureQuestionId(i)));
    const byIndex =
      byId === null && legacy && legacy.length === routes.length
        ? parseNoulP(legacy[i])
        : byId === null && legacy === null && routes.length === 1
          ? parseNoulP(out.data)
          : null;
    const p = byId ?? byIndex;
    const confidence = p === null ? 0 : Math.abs(p - 0.5) * 2;
    if (p === null || !(confidence >= threshold)) {
      result[r.id] = {
        p: validateP(r.exposurePGeo),
        confidence: p === null ? 0.9 : confidence,
        fallbackUsed: true,
        source: "geometric",
      };
    } else {
      result[r.id] = { p, confidence, fallbackUsed: false, source: "jev-noul" };
    }
  });
  return result;
}

const RANK_QUESTION = "best_route";

/** One-line rubric text for an option in the `criteria` map. */
function describeRoute(r: RankInput): string {
  const seen =
    typeof r.exposurePGeo === "number" ? `, seen risk ${Math.round(r.exposurePGeo * 100)}%` : "";
  const turns =
    typeof r.highRiskSteps === "number" && r.highRiskSteps > 0
      ? `, ${r.highRiskSteps} high-risk turn${r.highRiskSteps === 1 ? "" : "s"}`
      : "";
  return `${r.exposureCount} camera${r.exposureCount === 1 ? "" : "s"} within buffer${seen}${turns}, ${Math.round(r.durationS)}s, ${Math.round(r.distanceM)}m`;
}

/**
 * Ranking request. `criteria` (not `options`) is the documented rubric map:
 * option id → description, which is exactly the per-route facts we already
 * have, so nothing needs to be smuggled into a free-text question.
 */
function rankBody(routes: RankInput[]): unknown {
  return {
    state: {
      task: "Pick the road route a privacy-conscious driver should take.",
      options: routes.map((r) => ({
        id: r.id,
        camerasWithinBuffer: r.exposureCount,
        geometricExposureProbability: r.exposurePGeo ?? 0,
        highRiskSteps: r.highRiskSteps ?? 0,
        durationS: Math.round(r.durationS),
        distanceM: Math.round(r.distanceM),
      })),
    },
    model: modelName(),
    questions: {
      [RANK_QUESTION]: {
        type: "choice",
        instructions:
          "Which route should the driver take? Minimize Flock camera exposure first, then travel time. Prefer fewer cameras even at modest time cost; the tradeoff matters.",
        criteria: Object.fromEntries(routes.map((r) => [r.id, describeRoute(r)])),
      },
    },
  };
}

export async function rankRoutes(
  routes: RankInput[],
  opts?: JevCallOpts,
): Promise<RankResult> {
  if (routes.length === 0)
    return { rankedIds: [], verdicts: {}, mode: jevMode(opts?.apiKey), degraded: false };
  const threshold = opts?.threshold ?? confidenceThreshold();
  const key = resolveKey(opts?.apiKey);

  // No key → deterministic fake scorer, same shape.
  if (!key) return fallbackResult(routes, 0.9, opts?.apiKey);
  // Budget exhausted → deterministic answer, no network round-trip.
  if (opts?.timeoutMs !== undefined && clampTimeoutMs(opts.timeoutMs, TIMEOUT_MS) === 0)
    return fallbackResult(routes, 0.9, opts?.apiKey, true);

  const out = await callSystemOne(
    key,
    rankBody(routes),
    clampTimeoutMs(opts?.timeoutMs, TIMEOUT_MS),
  );
  // Any transport/HTTP failure → degraded (and deliberately not cached).
  if (!out.ok) return fallbackResult(routes, 0.9, opts?.apiKey, true);

  const data = out.data as Record<string, unknown>;
  const answer = answerFor(out.data, RANK_QUESTION);
  const choice =
    answer?.choice ??
    (typeof data.choice === "string" ? data.choice : undefined) ??
    (typeof data.decision === "string" ? data.decision : undefined) ??
    (typeof data.selectedId === "string" ? data.selectedId : undefined);
  const confidence = Number(answer?.confidence ?? data.confidence ?? 0);
  // A 200 with an unusable answer is not a transport failure — the model
  // simply did not give us something we can rank with.
  if (!choice || !routes.some((r) => r.id === choice))
    return fallbackResult(routes, 0.9, opts?.apiKey);
  if (!(confidence >= threshold))
    return fallbackResult(routes, Number.isFinite(confidence) ? confidence : 0, opts?.apiKey);
  const rest = routes
    .filter((r) => r.id !== choice)
    .sort((a, b) => a.score - b.score)
    .map((r) => r.id);
  const winner = routes.find((r) => r.id === choice) ?? heuristicBest(routes);
  const tradeoff = buildTradeoff(winner, routes);
  const rationale =
    sanitizeRationale(data.rationale) ??
    sanitizeRationale(data.reasoning) ??
    sanitizeRationale(data.explanation) ??
    sanitizeRationale(data.reason) ??
    buildFallbackRationale(winner, routes);
  const verdicts: Record<string, Verdict> = {};
  for (const r of routes)
    verdicts[r.id] = { choice, confidence, fallbackUsed: false, rationale, tradeoff };
  return { rankedIds: [choice, ...rest], verdicts, mode: "jev", degraded: false };
}
