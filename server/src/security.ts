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

const ROUTING_PRESETS = {
  demo: "https://router.project-osrm.org",
  fosssgis: "https://routing.openstreetmap.de",
} as const;

// Cloud metadata endpoint — never a legitimate routing backend.
const METADATA_IP = "169.254.169.254";

function isLoopbackHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  // 0.0.0.0 / :: ("all interfaces") route to localhost in practice.
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0" || h === "::";
}

function customRoutingOrigin(raw: string | undefined, allowLocal: boolean): string | null {
  let u: URL;
  try {
    u = new URL(raw ?? "");
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (isLoopbackHostname(u.hostname)) {
    // Local dev self-host (e.g. OSRM docker on :5000). Opt-in only:
    // loopback backends can reach anything on the box.
    if (!allowLocal) return null;
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  }
  if (u.protocol !== "https:") return null;
  if (u.hostname.toLowerCase() === METADATA_IP) return null;
  return u.origin;
}

export interface RoutingBackend {
  /** demo | fosssgis | custom — reported on GET /api/system/status. */
  name: string;
  /** https origin (no path, no credentials). */
  origin: string;
}

/**
 * Resolve the routing backend from operator env (never user input).
 * ROUTING_BACKEND=demo (default) | fosssgis | custom (+ OSRM_BASE).
 * Invalid config fails safe to demo — never throws, never crashes boot.
 */
export function resolveRoutingBackend(
  env: Record<string, string | undefined> = process.env,
): RoutingBackend {
  const preset = (env.ROUTING_BACKEND ?? "demo").trim().toLowerCase();
  if (preset === "fosssgis") return { name: "fosssgis", origin: ROUTING_PRESETS.fosssgis };
  if (preset === "custom") {
    const origin = customRoutingOrigin(env.OSRM_BASE, env.ALLOW_LOCAL_ROUTING === "1");
    if (origin) return { name: "custom", origin };
  }
  return { name: "demo", origin: ROUTING_PRESETS.demo };
}

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
