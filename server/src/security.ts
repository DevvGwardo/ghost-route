import type { NextFunction, Request, Response } from "express";

const WINDOW_MS = 60_000;

// Per-limiter bucket registries (review gate: one shared map double-counts
// stacked middlewares and starves the tighter limit). Tracked for test resets.
const limiterBuckets = new Set<Map<string, number[]>>();

function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

function makeLimiter(max: number, windowMs: number) {
  const buckets = new Map<string, number[]>();
  limiterBuckets.add(buckets);
  return function limiter(req: Request, res: Response, next: NextFunction): void {
    const ip = clientIp(req);
    const now = Date.now();
    const cutoff = now - windowMs;
    const hits = buckets.get(ip) ?? [];
    const fresh = hits.filter((t) => t > cutoff);
    if (fresh.length >= max) {
      res.status(429).json({ error: "rate_limited", retryAfterMs: windowMs });
      return;
    }
    fresh.push(now);
    buckets.set(ip, fresh);
    next();
  };
}

/** General API limit: 120 req/min/IP. */
export const apiLimiter = makeLimiter(120, WINDOW_MS);

/** Tight limit for POST /api/route (fans out to OSRM): 10 req/min/IP. */
export const routeLimiter = makeLimiter(10, WINDOW_MS);

/** Spam guard for crowd-sourced camera writes: 30 req/min/IP. */
export const cameraWriteLimiter = makeLimiter(30, WINDOW_MS);

/** Test hook: reset in-memory buckets. */
export function __resetLimiters(): void {
  for (const b of limiterBuckets) b.clear();
}

// Redact anything key-like before it reaches a 500 body.
const KEY_LIKE =
  /(sk-[A-Za-z0-9_-]{8,}|rk_[A-Za-z0-9_-]{8,}|typesafe[_-]?api[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9._-]{8,}['"]?|api[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9._-]{8,}['"]?)/gi;

/** Express error handler: generic 500, no stack, no leaked keys. */
export function noKeyLeak(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  let msg = err instanceof Error ? err.message : "internal_error";
  msg = msg.replace(KEY_LIKE, "[redacted]");
  if (msg.length > 200) msg = msg.slice(0, 200);
  res.status(500).json({ error: "internal_error", message: msg });
}

const OSRM_HOST = "router.project-osrm.org";

/**
 * Validate the OSRM base URL against the allowlist.
 * Only https://router.project-osrm.org is permitted.
 * Returns the normalized origin, or null if rejected.
 */
export function ssrfSafeUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.hostname.toLowerCase() !== OSRM_HOST) return null;
  if (u.username || u.password) return null;
  return `https://${OSRM_HOST}`;
}
