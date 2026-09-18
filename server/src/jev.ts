import { validateP } from "./services/scoring.js";

export type JevMode = "jev" | "fake";

export interface RankInput {
  id: string;
  score: number;
  distanceM: number;
  durationS: number;
  exposureCount: number;
}

export interface Verdict {
  choice: string;
  confidence: number;
  fallbackUsed: boolean;
}

export interface RankResult {
  rankedIds: string[];
  verdicts: Record<string, Verdict>;
  mode: JevMode;
}

const SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 10000;
const VERIFY_TIMEOUT_MS = 5000;

export interface VerifyResult {
  valid: boolean;
  confidence?: number;
  error?: string;
}

/** Fast validity check for a pasted BYOK key. Minimal live call, never throws. */
export async function verifyKey(apiKey: string): Promise<VerifyResult> {
  const key = resolveKey(apiKey);
  if (!key) return { valid: false, error: "key-required" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(SYSTEMONE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        questions: [
          {
            type: "choice",
            question: "Verify key: pick route r1.",
            options: [
              { id: "r1", exposureCount: 0, durationS: 100, distanceM: 1000 },
              { id: "r2", exposureCount: 1, durationS: 100, distanceM: 1000 },
            ],
          },
        ],
      }),
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403)
      return { valid: false, error: "unauthorized" };
    if (!res.ok) return { valid: false, error: "unreachable" };
    const data = (await res.json()) as { confidence?: unknown };
    const confidence = Number((data as { confidence?: unknown }).confidence ?? 0);
    return {
      valid: true,
      confidence: Number.isFinite(confidence) ? confidence : 0,
    };
  } catch {
    return { valid: false, error: "unreachable" };
  } finally {
    clearTimeout(t);
  }
}

export function resolveKey(provided?: string): string {
  const p = (provided ?? "").trim();
  if (p && p.length <= 200) return p;
  return process.env.TYPESAFE_API_KEY ?? "";
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

function fallbackResult(routes: RankInput[], confidence: number, apiKey?: string): RankResult {
  const best = heuristicBest(routes);
  const rankedIds = [...routes].sort((a, b) => a.score - b.score).map((r) => r.id);
  const verdicts: Record<string, Verdict> = {};
  for (const r of routes)
    verdicts[r.id] = { choice: best.id, confidence, fallbackUsed: true };
  return { rankedIds, verdicts, mode: jevMode(apiKey) };
}

export interface ExposureInput {
  id: string;
  exposurePGeo: number;
  exposureCount: number;
  distanceM: number;
}

export interface ExposureEstimate {
  p: number;
  confidence: number;
  fallbackUsed: boolean;
  source: "jev-noul" | "geometric";
}

function geometricFallback(
  routes: ExposureInput[],
): Record<string, ExposureEstimate> {
  const out: Record<string, ExposureEstimate> = {};
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

export async function estimateExposure(
  routes: ExposureInput[],
  opts?: { threshold?: number; apiKey?: string },
): Promise<Record<string, ExposureEstimate>> {
  const threshold = opts?.threshold ?? confidenceThreshold();
  const key = resolveKey(opts?.apiKey);

  // No key → immediate geometric fallback for all.
  if (!key) return geometricFallback(routes);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(SYSTEMONE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        questions: routes.map((r) => ({
          type: "noul",
          question: `This route passes near ${r.exposureCount} Flock ALPR cameras with geometric exposure probability ${r.exposurePGeo}. What is the probability the vehicle is observed by at least one Flock camera?`,
        })),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return geometricFallback(routes);
    const data = (await res.json()) as unknown;
    const arr: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray((data as { answers?: unknown }).answers)
        ? ((data as { answers: unknown[] }).answers as unknown[])
        : [data];
    const out: Record<string, ExposureEstimate> = {};
    routes.forEach((r, i) => {
      const p = arr.length === routes.length ? parseNoulP(arr[i]) : null;
      const confidence = p === null ? 0 : Math.abs(p - 0.5) * 2;
      if (p === null || !(confidence >= threshold)) {
        out[r.id] = {
          p: validateP(r.exposurePGeo),
          confidence: p === null ? 0.9 : confidence,
          fallbackUsed: true,
          source: "geometric",
        };
      } else {
        out[r.id] = { p, confidence, fallbackUsed: false, source: "jev-noul" };
      }
    });
    return out;
  } catch {
    return geometricFallback(routes);
  } finally {
    clearTimeout(t);
  }
}

export async function rankRoutes(
  routes: RankInput[],
  opts?: { threshold?: number; apiKey?: string },
): Promise<RankResult> {
  if (routes.length === 0)
    return { rankedIds: [], verdicts: {}, mode: jevMode(opts?.apiKey) };
  const threshold = opts?.threshold ?? confidenceThreshold();
  const key = resolveKey(opts?.apiKey);

  // No key → deterministic fake scorer, same shape.
  if (!key) return fallbackResult(routes, 0.9, opts?.apiKey);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(SYSTEMONE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        questions: [
          {
            type: "choice",
            question:
              "Which route should the driver take? Minimize Flock camera exposure first, then travel time.",
            options: routes.map((r) => ({
              id: r.id,
              exposureCount: r.exposureCount,
              durationS: r.durationS,
              distanceM: r.distanceM,
            })),
          },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return fallbackResult(routes, 0.9, opts?.apiKey);
    const data = (await res.json()) as {
      choice?: string;
      decision?: string;
      selectedId?: string;
      confidence?: number;
    };
    const choice = data.choice ?? data.decision ?? data.selectedId;
    const confidence = Number(data.confidence ?? 0);
    if (!choice || !routes.some((r) => r.id === choice))
      return fallbackResult(routes, 0.9, opts?.apiKey);
    if (!(confidence >= threshold))
      return fallbackResult(routes, Number.isFinite(confidence) ? confidence : 0, opts?.apiKey);
    const rest = routes
      .filter((r) => r.id !== choice)
      .sort((a, b) => a.score - b.score)
      .map((r) => r.id);
    const verdicts: Record<string, Verdict> = {};
    for (const r of routes)
      verdicts[r.id] = { choice, confidence, fallbackUsed: false };
    return { rankedIds: [choice, ...rest], verdicts, mode: "jev" };
  } catch {
    return fallbackResult(routes, 0.9, opts?.apiKey);
  } finally {
    clearTimeout(t);
  }
}
