// Shared harness plumbing for the Ghost Route blueprint scripts.
// Real Chrome via Playwright against the Vite dev server (`npm run dev:client`
// + `npm run dev:server`). Route responses come from recorded fixtures so every
// run plans the same trips; tiles and the camera endpoint stay live.
import { chromium } from "playwright";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const BP = process.env.BP_OUT ?? fileURLToPath(new URL("../../blueprint-out", import.meta.url));
export const APP_URL = process.env.APP_URL ?? "http://localhost:5174/";
const FIX_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));
for (const d of ["ui", "render", "nav", "video", "data"]) fs.mkdirSync(`${BP}/${d}`, { recursive: true });

export const fixture = (name) => JSON.parse(fs.readFileSync(`${FIX_DIR}${name}.json`, "utf8"));

/** Trips: deep-link endpoints + the recorded /api/route response. */
export const TRIPS = {
  north: { o: [30.25, -97.75], d: [30.35, -97.7], fixture: "trip-north", note: "7 routes, none camera-free" },
  clean: { o: [30.2672, -97.7431], d: [30.3072, -97.726], fixture: "trip-clean", note: "1 camera-free route" },
  drive: { o: [30.256, -97.74], d: [30.27, -97.73], fixture: "trip-drive", note: "2.3 km, 3 cameras, avoidance off" },
};
export const tripHash = (t, extra = "") =>
  `#r=${t.o[0].toFixed(5)},${t.o[1].toFixed(5)}~${t.d[0].toFixed(5)},${t.d[1].toFixed(5)}&avoid=1&buf=150&prof=driving${extra}`;

export function makeReport(name) {
  const report = { script: name, startedAt: new Date().toISOString(), checks: [], perf: {}, errors: [], notes: [] };
  const check = (area, title, ok, detail = "") => {
    report.checks.push({ area, name: title, ok: !!ok, detail: String(detail) });
    console.log(ok ? "PASS" : "FAIL", `[${area}]`, title, detail === "" ? "" : `— ${detail}`);
  };
  const finish = async (browser) => {
    fs.writeFileSync(`${BP}/data/report-${name}.json`, JSON.stringify(report, null, 2));
    const passed = report.checks.filter((c) => c.ok).length;
    console.log(`\n${name}: ${passed}/${report.checks.length} checks passed`, JSON.stringify(report.perf));
    await browser?.close();
    process.exit(passed === report.checks.length ? 0 : 1);
  };
  return { report, check, finish };
}

export async function launch() {
  return chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=metal", "--enable-gpu"] });
}

/**
 * New context + page with fixture-backed routing, a fixed reverse geocoder,
 * console/pageerror capture and a clean localStorage.
 */
export async function openApp(browser, report, opts = {}) {
  const { viewport = { width: 1440, height: 900 }, mobile = false, hash = "", geo = null, video = null, init = null } = opts;
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    isMobile: mobile,
    hasTouch: mobile,
    ...(geo ? { geolocation: geo, permissions: ["geolocation"] } : {}),
    ...(video ? { recordVideo: { dir: video, size: viewport } } : {}),
  });
  const routeCalls = [];
  await ctx.route("**/api/route", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    routeCalls.push(body);
    const o = body.origin ?? {};
    const trip = Object.values(TRIPS).find((t) => Math.abs(t.o[0] - o.lat) < 1e-3 && Math.abs(t.o[1] - o.lon) < 1e-3);
    // A reroute starts from a live fix, not a planned origin: serve the drive
    // fixture so the session continues (the harness asserts the call happened).
    const name = trip ? trip.fixture : "trip-drive";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture(name)) });
  });
  await ctx.route("**/nominatim.openstreetmap.org/reverse**", async (route) => {
    const u = new URL(route.request().url());
    const lat = Number(u.searchParams.get("lat"));
    const label = lat > 30.3 ? "Parmer Lane" : lat > 30.262 ? "East 11th Street" : lat > 30.252 ? "Rainey Street" : "West Gibson Street";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ name: "", address: { road: label, city: "Austin" }, display_name: `${label}, Austin` }),
    });
  });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // Tile/glyph 404s from the public basemap are not app errors.
    if (/Failed to load resource: the server responded with a status of 404/.test(t)) return;
    report.errors.push(t);
  });
  page.on("pageerror", (e) => report.errors.push(`pageerror: ${e.message}`));
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  if (hash) await page.goto(APP_URL + hash);
  await page.reload();
  await waitMap(page);
  return { ctx, page, routeCalls };
}

/** App ready: the map exists and its style has loaded. Never a bare sleep. */
export async function waitMap(page) {
  await page.waitForFunction(() => window.__grMap && window.__grMap.isStyleLoaded() && window.__ghost, null, { timeout: 45000 });
}

export async function waitRoutes(page, n = 1) {
  await page.waitForFunction((k) => (window.__ghost?.routes?.length ?? 0) >= k, n, { timeout: 45000 });
  // Let the fit animation (800 ms) and tiles settle before measuring.
  await page.waitForFunction(() => !window.__grMap.isMoving(), null, { timeout: 10000 });
  await page.waitForTimeout(900);
}

export const rectOf = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, left: r.left, right: r.right, bottom: r.bottom };
  }, sel);

export const overlap = (a, b) =>
  !!a && !!b && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;

/**
 * Unobstructed map rectangle: the viewport minus the floating panels. On a
 * phone the top card and the sheet stack vertically; on desktop they form a
 * left column.
 */
export async function freeRect(page) {
  return page.evaluate(() => {
    const vw = innerWidth;
    const vh = innerHeight;
    const r = (s) => document.querySelector(s)?.getBoundingClientRect() ?? null;
    const card = r(".gm-topcard");
    const sheet = r(".gm-sheet") ?? r(".gm-tripbar");
    if (vw >= 1024) {
      const right = Math.max(card?.right ?? 0, sheet?.right ?? 0);
      return { left: right, top: 0, right: vw, bottom: vh };
    }
    return { left: 0, top: card ? card.bottom : 0, right: vw, bottom: sheet ? sheet.top : vh };
  });
}

/** Share of the selected route's vertices that project inside `rect`. */
export async function routeInRect(page, rect) {
  return page.evaluate((fr) => {
    const m = window.__grMap;
    const g = window.__ghost;
    const src = m.getSource(`gr-route-${g.selectedId}`);
    const data = src?.serialize?.().data;
    const coords = data?.geometry?.coordinates ?? data?.features?.[0]?.geometry?.coordinates ?? [];
    if (coords.length === 0) return { share: 0, n: 0 };
    let inside = 0;
    for (const c of coords) {
      const p = m.project(c);
      if (p.x >= fr.left && p.x <= fr.right && p.y >= fr.top && p.y <= fr.bottom) inside++;
    }
    return { share: inside / coords.length, n: coords.length };
  }, rect);
}

export async function mapLayers(page) {
  return page.evaluate(() => window.__grMap.getStyle().layers.map((l) => l.id));
}
