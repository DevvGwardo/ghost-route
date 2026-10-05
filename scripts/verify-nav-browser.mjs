#!/usr/bin/env node
/**
 * Browser verification for Ghost Route navigation follow mode (P0-1).
 *
 * Drives a REAL Chrome against the Vite dev server over the Chrome DevTools
 * Protocol (no playwright/puppeteer dependency — Node 22 ships a global
 * WebSocket). All network is stubbed with `Fetch.fulfillRequest`, so the run is
 * deterministic and needs no OSRM, no tiles, and no API server:
 *
 *   - GET  /api/health          -> fake-mode descriptor
 *   - GET  /api/cameras         -> one camera 200m ahead on the route
 *   - POST /api/route           -> a synthetic 1km northbound route with steps
 *   - carto style.json          -> empty style (no tiles/glyphs needed)
 *
 * Then it asserts the things that were previously only *reasoned* about:
 * follow-mode centering, heading -> bearing, marker rendering, the driven/
 * remaining split, the imminent-camera ring, pan-to-pause, and off-route
 * reroute. Camera state is read through the dev-only `window.__grMap` handle.
 *
 * Usage:  node scripts/verify-nav-browser.mjs
 * Exit code 0 only when every assertion passes.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// A dedicated port: other projects (and the repo's own dev server) may already
// hold 5174. strictPort makes a collision fail loudly instead of silently
// drifting to another port, and --host 127.0.0.1 keeps it IPv4-reachable.
const APP_PORT = 5199;
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;
const CDP_PORT = 9333;
const CHROME =
  process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORT = { width: 420, height: 820 };

// ---------------------------------------------------------------- synthetic route
const LAT0 = 30.3;
const LON0 = -97.7;
const STEP_DEG = 0.0006; // ~66.8m per step at this latitude
const M_PER_DEG_LAT = 111_320;

const coords = Array.from({ length: 16 }, (_, i) => [LAT0 + i * STEP_DEG, LON0]);
const totalM = (coords.length - 1) * STEP_DEG * M_PER_DEG_LAT;
/** The camera sits at route index 3 => ~200m ahead of a user at the origin. */
const CAM_INDEX = 3;
const CAMERA = {
  id: 'cam-verify-1',
  lat: coords[CAM_INDEX][0],
  lon: coords[CAM_INDEX][1],
  source: 'verify',
  verified: true,
};

function mkStep(index, from, to, instruction, maneuverKind) {
  const seg = coords.slice(from, to);
  const distanceM = (seg.length - 1) * STEP_DEG * M_PER_DEG_LAT;
  return {
    index,
    instruction,
    maneuver: maneuverKind,
    maneuverKind,
    distanceM,
    durationS: distanceM / 11,
    exposureP: 0,
    cameraIds: [],
    coordinates: seg,
  };
}

const steps = [
  mkStep(0, 0, 8, 'Head north on Test Ave', 'depart'),
  mkStep(1, 7, 13, 'Turn right onto Main St', 'right'),
  mkStep(2, 12, 16, 'Arrive at destination', 'arrive'),
];
const NEXT_MANEUVER = steps[1].coordinates[0]; // ~467m ahead of the origin

function routePayload(body = {}) {
  const r = {
    id: 'route-0',
    coordinates: coords,
    distanceM: totalM,
    durationS: totalM / 11,
    exposures: [
      { cameraId: CAMERA.id, lat: CAMERA.lat, lon: CAMERA.lon, distM: 0 },
    ],
    exposureCount: 1,
    score: 10_000 + totalM,
    isClean: false,
    exposureP: 0.95,
    jevExposure: { p: 0.95, confidence: 0.9, fallbackUsed: false, source: 'geometric' },
    jev: { choice: 'route-0', confidence: 0.9, fallbackUsed: false },
    steps,
  };
  return {
    routes: [r],
    rankedBy: 'jev',
    jevMode: 'jev',
    profile: body.profile || 'driving',
    // Cycling is "unsupported" here so the driving-fallback notice is exercised.
    ...(body.profile === 'cycling' ? { profileFallback: true } : {}),
    cleanSearch:
      body.avoidFlock === false
        ? { cleanFound: false, rounds: 0, osrmCalls: 0, skipped: 'avoid-disabled' }
        : { cleanFound: false, rounds: 1, osrmCalls: 2 },
  };
}

const EMPTY_STYLE = { version: 8, name: 'verify', sources: {}, layers: [] };

// ---------------------------------------------------------------- results
const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failed += 1;
}
function approx(a, b, tol) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- CDP client
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const h of this.handlers.get(msg.method) ?? []) h(msg.params, msg.sessionId);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
  on(method, fn) {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), fn]);
  }
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

// ---------------------------------------------------------------- main
const routeRequests = [];
/** Last clickExpr diagnostic — attached to the check that follows it. */
let clickDiag = null;

async function main() {
  // 1. Vite dev server -------------------------------------------------------
  const viteBin = join(process.cwd(), 'client', 'node_modules', '.bin', 'vite');
  const vite = spawn(
    viteBin,
    ['--port', String(APP_PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: join(process.cwd(), 'client'), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  vite.stdout.on('data', (d) => {
    if (process.env.VERBOSE) process.stdout.write(`[vite] ${d}`);
  });
  vite.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  const viteUp = await waitForHttp(APP_URL, 60_000);
  check('vite dev server reachable', viteUp, APP_URL);
  if (!viteUp) return;

  // 2. Chrome ---------------------------------------------------------------
  // Kept inside the project (a browser profile is a side effect we must not
  // scatter outside the repo) and removed on the way out.
  const profile = join(process.cwd(), '.verify-chrome-profile');
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + profile,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      // Software WebGL so maplibre can create a context without a GPU.
      '--enable-unsafe-swiftshader',
      '--use-angle=swiftshader',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  chrome.stderr.on('data', () => {});

  let cdp;
  let sessionId;
  try {
    const cdpUp = await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 30_000);
    check('chrome remote debugging reachable', cdpUp, `port ${CDP_PORT}`);
    if (!cdpUp) return;

    const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    cdp = new CDP(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));

    const input = (method, params) => cdp.send(method, params, sessionId);
    const evaluate = async (expression) => {
      const r = await input('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error(
          `page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
        );
      }
      return r.result.value;
    };

    // No trailing slash: CDP matches origins exactly.
    const ORIGIN = `http://127.0.0.1:${APP_PORT}`;
    await cdp.send('Browser.grantPermissions', {
      origin: ORIGIN,
      permissions: ['geolocation'],
    });
    await input('Page.enable');
    await input('Runtime.enable');
    await input('Log.enable');
    const pageLog = [];
    cdp.on('Runtime.consoleAPICalled', (p) => {
      pageLog.push(`console.${p.type}: ${(p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')}`);
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      pageLog.push(`pageerror: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
    });
    await input('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Network stubs: everything the app needs, nothing real.
    const routeDelay = { ms: 30 };
    cdp.on('Fetch.requestPaused', async (params, sid) => {
      const { requestId, request } = params;
      const url = request.url;
      const json = (obj, code = 200) =>
        cdp.send(
          'Fetch.fulfillRequest',
          {
            requestId,
            responseCode: code,
            responseHeaders: [
              { name: 'content-type', value: 'application/json' },
              { name: 'access-control-allow-origin', value: '*' },
            ],
            body: Buffer.from(JSON.stringify(obj)).toString('base64'),
          },
          sid,
        );
      try {
        if (url.includes('voyager-gl-style')) return await json(EMPTY_STYLE);
        if (url.includes('/api/health'))
          return await json({ ok: true, jev: { mode: 'fake', threshold: 0.4 } });
        if (url.includes('/api/cameras')) return await json({ cameras: [CAMERA], total: 1 });
        if (url.includes('/api/system/status'))
          return await json({
            mode: 'fake',
            threshold: 0.4,
            cameraCount: 1,
            cameraCounts: { total: 1, verified: 1 },
            routingBackend: 'demo',
            osrm: 'https://router.project-osrm.org',
          });
        if (url.includes('/api/route')) {
          let body = {};
          if (request.postData) {
            body = JSON.parse(request.postData);
            routeRequests.push(body);
          }
          await sleep(routeDelay.ms);
          return await json(routePayload(body));
        }
        return await cdp.send('Fetch.continueRequest', { requestId }, sid);
      } catch (e) {
        console.error('stub error', url, e.message);
      }
    });
    await input('Fetch.enable', {
      patterns: [
        { urlPattern: '*/api/*', requestStage: 'Request' },
        { urlPattern: '*voyager-gl-style*', requestStage: 'Request' },
      ],
    });

    // Geolocation: user at the route origin, heading east (90deg).
    const setFix = (lat, lon, heading, accuracy = 6) =>
      input('Emulation.setGeolocationOverride', { latitude: lat, longitude: lon, accuracy, heading, speed: 12 });

    await setFix(coords[0][0], coords[0][1], 90);
    await input('Page.navigate', { url: APP_URL });
    await input('Emulation.setGeolocationOverride', {
      latitude: coords[0][0],
      longitude: coords[0][1],
      accuracy: 6,
      heading: 90,
      speed: 12,
    });

    // 3. Wait for the map -----------------------------------------------------
    const mapReady = await (async () => {
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline) {
        const ok = await evaluate(
          `Boolean(window.__grMap) && window.__grMap.isStyleLoaded() && window.__grMap.getStyle().layers !== undefined`,
        ).catch(() => false);
        if (ok) return true;
        await sleep(300);
      }
      return false;
    })();
    check('maplibre map constructed + style loaded in a real browser', mapReady);
    if (!mapReady) {
      const diag = await evaluate(
        `({ hasMap: Boolean(window.__grMap), ua: navigator.userAgent, webgl: (() => { try { const c = document.createElement('canvas'); return Boolean(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return String(e.message); } })() })`,
      ).catch((e) => ({ error: e.message }));
      check('diagnostics', false, JSON.stringify(diag));
      return;
    }

    // Spy on camera moves so a "map did not follow" result can be attributed to
    // the app (no easeTo issued) vs the map (easeTo issued but ignored).
    await evaluate(`(() => {
      const m = window.__grMap;
      window.__easeCalls = [];
      if (m.__spied) return true;
      const orig = m.easeTo.bind(m);
      m.easeTo = (o) => { window.__easeCalls.push({ kind: 'ease', center: o && o.center, bearing: o && o.bearing, zoom: o && o.zoom }); return orig(o); };
      const ofly = m.flyTo.bind(m);
      m.flyTo = (o) => { window.__easeCalls.push({ kind: 'fly', center: o && o.center }); return ofly(o); };
      m.__spied = true;
      return true;
    })()`);

    const camState = () =>
      evaluate(`(() => { const m = window.__grMap; const s = m.getStyle(); return {
        lat: m.getCenter().lat, lon: m.getCenter().lng,
        bearing: m.getBearing(), zoom: m.getZoom(), pitch: m.getPitch(),
        styleLoaded: m.isStyleLoaded(),
        layers: s && s.layers ? s.layers.map((l) => l.id) : [],
      }; })()`);
    // Guard: if the dev-only handle ever points at a torn-down map, say so
    // instead of reporting a misleading layer failure.
    const pre = await camState();
    check('map global exposes a live style (not a discarded instance)', pre.layers.length > 0, `layers=${pre.layers.length} styleLoaded=${pre.styleLoaded}`);

    // Before navigation there is no GPS feed at all.
    check(
      'no user dot before navigation starts',
      (await evaluate(`!document.querySelector('.gm-user-dot')`)) === true,
    );

    // 4. Set endpoints (two map clicks) -> route request ----------------------
    const clickAt = async (x, y) => {
      await input('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
      });
      await input('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
      });
    };
    // Pick points that are genuinely the canvas — the top card and the bottom
    // sheet overlay it, and clicking/dragging an overlay does nothing.
    const findMapPoints = async (count) =>
      evaluate(`(() => {
        const canvas = document.querySelector('.maplibregl-canvas');
        if (!canvas) return [];
        const r = canvas.getBoundingClientRect();
        const out = [];
        for (let y = Math.round(r.top + 30); y < r.bottom - 30; y += 10) {
          for (const x of [
            Math.round(r.left + r.width * 0.3),
            Math.round(r.left + r.width * 0.5),
            Math.round(r.left + r.width * 0.7),
          ]) {
            if (document.elementFromPoint(x, y) === canvas) {
              if (!out.some((p) => Math.abs(p.y - y) < 40)) out.push({ x, y });
              if (out.length >= ${count}) return out;
            }
          }
        }
        return out;
      })()`);

    const mapPoints = await findMapPoints(2);
    check('found unobstructed canvas points for interaction', mapPoints.length >= 2, JSON.stringify(mapPoints));
    await clickAt(mapPoints[0].x, mapPoints[0].y);
    await clickAt(mapPoints[1].x, mapPoints[1].y);

    const gotRoute = await (async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (routeRequests.length > 0) return true;
        await sleep(200);
      }
      return false;
    })();
    check('two map clicks produce a /api/route request', gotRoute, `requests=${routeRequests.length}`);
    check('route request carries both endpoints', Boolean(routeRequests[0]?.origin && routeRequests[0]?.destination));

    // 5. Expand the sheet and start navigation --------------------------------
    const waitForPage = async (expr, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expr).catch(() => false)) return true;
        await sleep(150);
      }
      return false;
    };
    // Scroll into view first: the sheet's controls can sit below the fold.
    const rectOf = async (finderExpr) =>
      evaluate(`(() => {
        const el = ${finderExpr};
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
      })()`);
    /**
     * Clicks a point that genuinely belongs to the target element.
     *
     * `rectOf` centres the element, which can put it UNDER the bottom sheet —
     * the click then lands on the sheet and the check that follows is a lie.
     * So scan the element's own box for a point where elementFromPoint resolves
     * to it (or a descendant) and click there; if no such point exists, report
     * what is covering it instead of clicking that occluder blindly.
     */
    const clickExpr = async (finderExpr) => {
      const point = await evaluate(`(() => {
        const el = ${finderExpr};
        if (!el) return { missing: true };
        const first = el.getBoundingClientRect();
        if (first.width <= 0 || first.height <= 0) return { missing: true, zero: true };
        const scan = () => {
          const b = el.getBoundingClientRect();
          for (const fy of [0.5, 0.3, 0.7, 0.15, 0.85]) {
            for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85]) {
              const x = b.left + b.width * fx;
              const y = b.top + b.height * fy;
              if (x < 1 || y < 1 || x > innerWidth - 1 || y > innerHeight - 1) continue;
              const top = document.elementFromPoint(x, y);
              if (top === el || el.contains(top)) return { x, y, ok: true };
            }
          }
          return null;
        };
        // Inside a scrollable card, 'nearest' pins a deep control to the
        // container's BOTTOM edge — which is under the sheet. Try to bring it
        // to the top first, then fall back.
        for (const block of ['start', 'center', 'nearest']) {
          el.scrollIntoView({ block, inline: 'nearest' });
          const hit = scan();
          if (hit) return hit;
        }
        const b = el.getBoundingClientRect();
        const x = b.left + b.width / 2;
        const y = b.top + b.height / 2;
        const top = document.elementFromPoint(x, y);
        return {
          x, y, ok: false,
          occludedBy: String(top?.className || top?.tagName || 'none'),
          rect: { top: Math.round(b.top), h: Math.round(b.height) },
        };
      })()`).catch((e) => ({ error: e.message }));
      clickDiag = point;
      if (!point || point.missing || point.error || !point.ok) {
        // Deliberately do NOT click the occluder: a blind click on whatever is
        // on top produces cascading nonsense (a "dismiss" that starts
        // navigation, a filter toggle that collapses the sheet), which reads
        // as unrelated failures further down.
        return false;
      }
      await clickAt(point.x, point.y);
      return true;
    };
    const clickSelector = (selector) =>
      clickExpr(`document.querySelector(${JSON.stringify(selector)})`);
    const clickButtonByText = (text) =>
      clickExpr(
        `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)`,
      );
    /**
     * Waits for the button to exist in its enabled state before clicking.
     * A route request in flight disables Find and renames it to "Finding…",
     * so an immediate click would silently do nothing.
     */
    const clickButtonWhenReady = async (text, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await clickButtonByText(text)) return true;
        await sleep(200);
      }
      return false;
    };

    // The route response must have rendered before the peek control exists.
    const peekReady = await waitForPage(`Boolean(document.querySelector('.gm-peek'))`);
    check('route result rendered in the sheet', peekReady);
    check('expanded route sheet', await clickSelector('.gm-peek'));
    const navReady = await waitForPage(
      `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Navigate' && !b.disabled)`,
    );
    check('Navigate control enabled (route has steps)', navReady);
    check('clicked Navigate', await clickButtonByText('Navigate'));
    check('navigation banner became active', await waitForPage(`Boolean(document.querySelector('.gm-nav'))`));

    // 6. Wait for the first GPS fix -------------------------------------------
    const gotFix = await (async () => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (await evaluate(`Boolean(document.querySelector('.gm-user-dot'))`).catch(() => false)) return true;
        await sleep(200);
      }
      return false;
    })();
    check('user position dot rendered from the GPS watch', gotFix);
    if (!gotFix) {
      const diag = await evaluate(`(async () => {
        const nav = document.querySelector('.gm-nav');
        let perm = null;
        try { perm = (await navigator.permissions.query({ name: 'geolocation' })).state; } catch (e) { perm = 'query-failed: ' + e.message; }
        return {
          navText: nav ? nav.innerText : null,
          permission: perm,
          hasGeo: typeof navigator !== 'undefined' && 'geolocation' in navigator,
          mapCount: document.querySelectorAll('.maplibregl-map').length,
          styleLoaded: window.__grMap ? window.__grMap.isStyleLoaded() : null,
          stylePresent: window.__grMap ? window.__grMap.getStyle() != null : null,
          layers: window.__grMap && window.__grMap.getStyle() ? window.__grMap.getStyle().layers.map((l) => l.id) : null,
          directProbe: await new Promise((res) => {
            const t = setTimeout(() => res('timeout'), 4000);
            try {
              navigator.geolocation.getCurrentPosition(
                (p) => { clearTimeout(t); res('fix ' + p.coords.latitude + ',' + p.coords.longitude + ' heading=' + p.coords.heading); },
                (e) => { clearTimeout(t); res('error code ' + e.code + ' ' + e.message); },
                { enableHighAccuracy: true, timeout: 3500 },
              );
            } catch (e) { clearTimeout(t); res('threw ' + e.message); }
          }),
        };
      })()`);
      console.log('DIAGNOSTICS (no fix):', JSON.stringify(diag, null, 2));
      const interesting = pageLog.filter((l) => /error|warning|pageerror/i.test(l));
      console.log(`PAGE LOG (${interesting.length} of ${pageLog.length}):\n` + interesting.join('\n---\n'));
    }
    await sleep(1200); // let the follow easeTo settle

    // 7. Follow mode: centered on the fix, bearing = heading ------------------
    const s1 = await camState();
    check(
      'follow mode centers the map on the live fix',
      approx(s1.lat, coords[0][0], 0.0005) && approx(s1.lon, coords[0][1], 0.0005),
      `center=${s1.lat.toFixed(5)},${s1.lon.toFixed(5)} fix=${coords[0][0]},${coords[0][1]}`,
    );
    check('bearing follows the GPS heading (90deg)', approx(s1.bearing, 90, 1.5), `bearing=${s1.bearing}`);
    check('follow mode zooms to street level', s1.zoom >= 16, `zoom=${s1.zoom}`);
    // v1.3: navigation uses a tilted driving view on every screen size (the
    // planning view still stays flat on narrow screens).
    check('navigation tilts into the driving perspective (pitch 50)', approx(s1.pitch, 50, 1), `pitch=${s1.pitch}`);

    // 8. Marker rendering + heading applied to *rendering* --------------------
    const markers = await evaluate(`(() => {
      const dot = document.querySelector('.gm-user-dot');
      const chev = document.querySelector('.gm-next-turn');
      const out = { dot: Boolean(dot), chev: Boolean(chev) };
      if (dot && chev) {
        const d = dot.getBoundingClientRect(), c = chev.getBoundingClientRect();
        out.dx = (c.left + c.width / 2) - (d.left + d.width / 2);
        out.dy = (c.top + c.height / 2) - (d.top + d.height / 2);
      }
      return out;
    })()`);
    check('next-turn chevron marker rendered', markers.chev);
    // Bearing 90 => east is up, so a point due NORTH renders to the LEFT.
    check(
      'rendered geometry is rotated: next maneuver (due north) draws left of the dot',
      markers.dx < -40 && Math.abs(markers.dx) > Math.abs(markers.dy) * 2,
      `dx=${markers.dx?.toFixed(1)} dy=${markers.dy?.toFixed(1)}`,
    );

    // 9. Layers: imminent-camera ring, and the driven/remaining split --------
    check(
      'imminent-camera highlight ring present',
      s1.layers.includes('gr-nav-cams-ring'),
      s1.layers.filter((id) => id.includes('nav-cam')).join(',') || 'none',
    );
    check(
      'camera alert surfaced in the banner (camera 200m ahead)',
      await evaluate(`/Flock camera in/.test(document.body.innerText)`),
    );
    check(
      'turn instruction surfaced in the banner',
      await evaluate(`/Turn right onto Main St/i.test(document.body.innerText)`),
    );
    check(
      'no recenter control while follow is active',
      !(await evaluate(`Boolean(document.querySelector('.gm-nav-recenter'))`)),
    );

    // 9a. Voice guidance toggle: present while navigating, off by default,
    // flips aria-pressed on click, and persists into ghostroute.prefs.
    const voiceBtn = await evaluate(`(() => {
      const b = document.querySelector('.gm-nav-voice');
      return b ? { pressed: b.getAttribute('aria-pressed') } : null;
    })()`);
    check(
      'voice toggle present while navigating, off by default',
      Boolean(voiceBtn) && voiceBtn.pressed === 'false',
      JSON.stringify(voiceBtn),
    );
    check('voice toggle clickable', await clickSelector('.gm-nav-voice'));
    check(
      'voice toggle turns on (aria-pressed)',
      await evaluate(`document.querySelector('.gm-nav-voice')?.getAttribute('aria-pressed') === 'true'`),
    );
    await sleep(600); // prefs persist debounced at 300ms — wait it out
    check(
      'voice preference persisted to localStorage',
      await evaluate(`(() => {
        try { return JSON.parse(localStorage.getItem('ghostroute.prefs') || '{}').voice === true; }
        catch { return false; }
      })()`),
    );
    check('voice toggle clickable (back off)', await clickSelector('.gm-nav-voice'));
    check(
      'voice toggle turns off again',
      await evaluate(`document.querySelector('.gm-nav-voice')?.getAttribute('aria-pressed') === 'false'`),
    );
    // Nothing has been driven yet, so there must be NO traveled overlay.
    check(
      'no traveled overlay before any distance is covered',
      !s1.layers.some((id) => id.endsWith('-driven')),
      s1.layers.filter((id) => id.includes('driven')).join(',') || 'none',
    );

    // 9b. Drive forward along the route --------------------------------------
    const callsBefore = await evaluate(`window.__easeCalls.length`);
    await setFix(coords[4][0], coords[4][1], 90);
    await sleep(2000);
    const s1b = await camState();
    if (!(approx(s1b.lat, coords[4][0], 0.001) && approx(s1b.lon, coords[4][1], 0.001))) {
      const trace = await evaluate(`(() => ({
        newEaseCalls: window.__easeCalls.slice(${callsBefore}),
        totalEaseCalls: window.__easeCalls.length,
        recenterVisible: Boolean(document.querySelector('.gm-nav-recenter')),
        dotRect: (() => { const d = document.querySelector('.gm-user-dot'); if (!d) return null; const r = d.getBoundingClientRect(); const c = document.querySelector('.maplibregl-canvas').getBoundingClientRect(); return { dx: Math.round(r.left + r.width / 2 - (c.left + c.width / 2)), dy: Math.round(r.top + r.height / 2 - (c.top + c.height / 2)) }; })(),
      }))()`);
      console.log('DIAGNOSTICS (moving fix):', JSON.stringify(trace, null, 2));
    }
    check(
      'follow tracks a MOVING fix (map re-centers on the new position)',
      approx(s1b.lat, coords[4][0], 0.001) && approx(s1b.lon, coords[4][1], 0.001),
      `center=${s1b.lat.toFixed(5)},${s1b.lon.toFixed(5)} fix=${coords[4][0]},${coords[4][1]}`,
    );
    check(
      'traveled/remaining overlay appears once distance is covered',
      s1b.layers.some((id) => id.endsWith('-driven')),
      s1b.layers.filter((id) => id.includes('driven')).join(',') || 'none',
    );
    check(
      'route layers rendered for the selected route',
      s1.layers.some((id) => id.includes('gr-route-') && id.endsWith('-casing')),
    );
    // Once the camera is behind the driver the alert must clear (there is a
    // second camera only if one exists ahead — here there is none).
    check(
      'camera alert clears once the camera is behind the driver',
      !(await evaluate(`/Flock camera in/.test(document.body.innerText)`)),
    );

    // 10. Panning pauses follow; recenter resumes it --------------------------
    // Record what the map actually fires so a failed pause can be attributed
    // to the synthetic drag or to the app's gesture discrimination.
    await evaluate(`(() => {
      const m = window.__grMap;
      window.__moveEvents = [];
      if (m.__evSpied) return true;
      for (const name of ['dragstart', 'rotatestart', 'movestart', 'drag', 'dragend']) {
        m.on(name, (e) => window.__moveEvents.push({
          name,
          hasOriginal: Boolean(e && e.originalEvent),
          originalType: e && e.originalEvent ? e.originalEvent.type : null,
        }));
      }
      m.__evSpied = true;
      return true;
    })()`);
    const dragPoints = await findMapPoints(1);
    const dragFrom = dragPoints[0] ?? { x: 200, y: 200 };
    await input('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: dragFrom.x, y: dragFrom.y, button: 'left', buttons: 1, clickCount: 1,
    });
    for (let i = 1; i <= 8; i += 1) {
      await input('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: dragFrom.x - i * 12, y: dragFrom.y, button: 'none', buttons: 1,
      });
      await sleep(50);
    }
    await input('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: dragFrom.x - 96, y: dragFrom.y, button: 'left', buttons: 0, clickCount: 1,
    });
    await sleep(900);
    const recenterShown = await evaluate(`Boolean(document.querySelector('.gm-nav-recenter'))`);
    if (!recenterShown) {
      const evts = await evaluate(`window.__moveEvents`);
      console.log('DIAGNOSTICS (drag did not pause follow):', JSON.stringify(evts, null, 2));
    }
    check('panning away pauses follow mode (recenter control appears)', recenterShown);

    // A new fix must NOT recenter the map while follow is paused.
    await setFix(coords[7][0], coords[7][1], 90);
    await sleep(1400);
    const s2 = await camState();
    check(
      'paused follow does not snap back to the fix',
      !approx(s2.lat, coords[7][0], 0.0003),
      `center=${s2.lat.toFixed(5)} fix=${coords[7][0]}`,
    );

    // Is the recenter control actually the topmost element where we click?
    const recenterHit = await evaluate(`(() => {
      const b = document.querySelector('.gm-nav-recenter');
      if (!b) return { present: false };
      const r = b.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return {
        present: true,
        x, y, w: r.width, h: r.height,
        topTag: top ? top.tagName : null,
        topClass: top ? String(top.className) : null,
        isSelf: top === b,
        containedBySelf: Boolean(top && b.contains(top)),
      };
    })()`);
    check(
      'recenter control is the topmost element at its own center',
      recenterHit.isSelf || recenterHit.containedBySelf,
      JSON.stringify(recenterHit),
    );
    check('recenter control clickable', await clickSelector('.gm-nav-recenter'));
    const recenterHidden = await (async () => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (!(await evaluate(`Boolean(document.querySelector('.gm-nav-recenter'))`))) return true;
        await sleep(150);
      }
      return false;
    })();
    check('recenter click resumed follow (control disappears again)', recenterHidden);
    await sleep(2000);
    const s3 = await camState();
    check(
      'recenter resumes follow (map back on the live fix)',
      approx(s3.lat, coords[7][0], 0.001) && approx(s3.lon, coords[7][1], 0.001),
      `center=${s3.lat.toFixed(5)},${s3.lon.toFixed(5)} fix=${coords[7][0]}`,
    );

    // 11. Off-route -> reroute from the live fix ------------------------------
    // Follow must be active again before the off-route test means anything.
    const s4 = await camState();
    check(
      'follow mode active before the off-route scenario',
      approx(s4.lat, coords[7][0], 0.001),
      `center=${s4.lat.toFixed(5)} fix=${coords[7][0]}`,
    );

    const routesBefore = routeRequests.length;
    routeDelay.ms = 1500; // keep the "Rerouting..." state observable
    const offLat = coords[0][0] + 0.02; // ~2.2km west of the route
    for (let i = 0; i < 4; i += 1) {
      await setFix(offLat + i * 0.00005, LON0, 90);
      await sleep(400);
    }
    const sawRerouting = await (async () => {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        if (await evaluate(`/Rerouting/.test(document.body.innerText)`).catch(() => false)) return true;
        await sleep(200);
      }
      return false;
    })();
    check('confirmed off-route surfaces "Rerouting..." in the banner', sawRerouting);

    const rerouted = await (async () => {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        if (routeRequests.length > routesBefore) return true;
        await sleep(200);
      }
      return false;
    })();
    check('off-route triggers exactly one reroute request', rerouted && routeRequests.length === routesBefore + 1,
      `before=${routesBefore} after=${routeRequests.length}`);
    const rerouteBody = routeRequests[routeRequests.length - 1];
    check(
      'reroute re-plans from the live fix (origin = off-route position)',
      Boolean(rerouteBody) && approx(rerouteBody.origin.lat, offLat, 0.001) && approx(rerouteBody.origin.lon, LON0, 0.001),
      JSON.stringify(rerouteBody?.origin),
    );
    check(
      'reroute keeps the original destination',
      Boolean(rerouteBody) && approx(rerouteBody.destination.lat, routeRequests[0].destination.lat, 1e-9),
    );
    await sleep(2500);
    check(
      'guidance recovers after the reroute (no stuck Rerouting state)',
      !(await evaluate(`/Rerouting/.test(document.body.innerText)`)),
    );
    check(
      'navigation is still active after reroute (still following)',
      await evaluate(`Boolean(document.querySelector('.gm-user-dot'))`),
    );
    // ---- 7. v1.2 features: options, share, degraded notice, deep link ------
    const waitForText = async (re, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const t = await evaluate('document.body.innerText').catch(() => '');
        if (re.test(t ?? '')) return true;
        await sleep(150);
      }
      return false;
    };
    const waitForNewRequest = async (from, pred, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = routeRequests.slice(from).find(pred);
        if (hit) return hit;
        await sleep(150);
      }
      return null;
    };
    const clickByAria = (label) =>
      clickExpr(
        `[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)} && !b.disabled)`,
      );

    // The degraded notice must never sit on top of the maneuver banner.
    check(
      'degraded notice stays off screen while navigating',
      !(await evaluate(`Boolean(document.querySelector('.gm-degraded'))`)),
    );
    check('stopped navigation', await clickByAria('Stop navigation'));
    // v1.3: on narrow screens a planned trip collapses to a two-line summary;
    // tapping it reopens the full card. Every option step below reopens it
    // (and the options panel) because each Find collapses it again.
    const openEditor = async (withOptions = false) => {
      if (await evaluate(`Boolean(document.querySelector('.gm-trip-summary'))`)) {
        await clickSelector('.gm-trip-summary');
        await sleep(250);
      }
      if (withOptions && !(await evaluate(`Boolean(document.querySelector('#gr-route-options'))`))) {
        await clickSelector('.gm-options-toggle');
        await sleep(250);
      }
    };
    check(
      'trip summary offered after stopping navigation (narrow screen)',
      await waitForPage(`Boolean(document.querySelector('.gm-trip-summary'))`),
    );
    await openEditor();
    check(
      'directions card restored from the summary',
      await waitForPage(`Boolean(document.querySelector('.gm-options-toggle'))`),
    );

    // Degraded-mode notice: health says fake JEV, status says demo backend.
    check(
      'degraded notice rendered once navigation ends',
      await waitForPage(`Boolean(document.querySelector('.gm-degraded'))`),
    );
    check(
      'degraded notice explains the demo routing backend',
      await evaluate(
        `/demo router/.test(document.querySelector('.gm-degraded')?.innerText ?? '')`,
      ),
    );
    check('dismissed the degraded notice', await clickSelector('.gm-degraded-x'));
    check(
      'dismissal removes the notice',
      await waitForPage(`!document.querySelector('.gm-degraded')`, 4000),
    );

    // ---- route options: travel profile + camera filters --------------------
    const layout = await evaluate(`(() => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) };
      };
      return { vh: innerHeight, topcard: box('.gm-topcard'), sheet: box('.gm-sheet'), toggle: box('.gm-options-toggle') };
    })()`);
    const openOptions = await clickSelector('.gm-options-toggle');
    await sleep(250);
    const optionsOpen = await evaluate(`Boolean(document.querySelector('#gr-route-options'))`);
    check(
      'opened route options',
      openOptions && optionsOpen,
      `layout=${JSON.stringify(layout)}`,
    );
    const bufferRange = await evaluate(
      `(() => { const el = document.querySelector('#gr-buffer'); return el ? el.min + '..' + el.max : 'missing'; })()`,
    );
    check('buffer slider range matches the server (50..5000)', bufferRange === '50..5000', bufferRange);
    check(
      'three travel modes offered',
      await evaluate(
        `['Drive','Walk','Bike'].every((t) => [...document.querySelectorAll('.gm-profile-btn')].some((b) => b.textContent.trim() === t))`,
      ),
    );

    const beforeOpts = routeRequests.length;
    await openEditor();
    check('picked the Walk profile', await clickButtonByText('Walk'));
    await sleep(1500);
    check(
      'option changes do not silently re-route',
      routeRequests.length === beforeOpts,
      `requests=${routeRequests.length}`,
    );
    check(
      'clicked Find after the profile change',
      await clickButtonWhenReady('Find clean route'),
      `diag=${JSON.stringify(clickDiag)}`,
    );
    const walkReq = await waitForNewRequest(beforeOpts, (b) => b.profile === 'walking');
    check('profile reaches the API as profile=walking', Boolean(walkReq), `profile=${walkReq?.profile}`);

    const beforeVerify = routeRequests.length;
    await openEditor(true);
    check('enabled verified-cameras-only', await clickSelector('#gr-verified'), JSON.stringify(clickDiag));
    const findFilter = await clickButtonWhenReady('Find clean route');
    check('clicked Find with the filter set', findFilter, findFilter ? '' : JSON.stringify(await evaluate(`({ btns: [...document.querySelectorAll('button')].map((b) => b.textContent.trim().slice(0, 24) + (b.disabled ? '(off)' : '')).filter(Boolean), summary: Boolean(document.querySelector('.gm-trip-summary')) })`)));
    const verifyReq = await waitForNewRequest(
      beforeVerify,
      (b) => b.cameraFilter?.verifiedOnly === true,
    );
    check(
      'verified-only reaches the API as cameraFilter.verifiedOnly',
      Boolean(verifyReq),
      JSON.stringify(verifyReq?.cameraFilter ?? null),
    );

    const beforeDir = routeRequests.length;
    await openEditor(true);
    check('disabled direction filtering', await clickSelector('#gr-dir'), JSON.stringify(clickDiag));
    check('clicked Find after disabling direction filtering', await clickButtonWhenReady('Find clean route'));
    const dirReq = await waitForNewRequest(beforeDir, (b) => b.respectDirection === false);
    check(
      'direction opt-out reaches the API as respectDirection=false',
      Boolean(dirReq),
      `respectDirection=${dirReq?.respectDirection}`,
    );

    // ---- avoidance off: the sheet must say so, not "no clean route" -------
    const beforeAvoid = routeRequests.length;
    await openEditor(true);
    check('turned camera avoidance off', await clickSelector('#gr-avoid'));
    check('clicked Find with avoidance off', await clickButtonWhenReady('Find clean route'), JSON.stringify(clickDiag));
    await waitForNewRequest(beforeAvoid, (b) => b.avoidFlock === false);
    check(
      'avoidance-off is surfaced as its own state (not "no clean route")',
      await waitForText(/Camera avoidance is off/),
    );
    check(
      'no stale "no camera-free route" banner while avoidance is off',
      !(await evaluate(`/No camera-free route/.test(document.body.innerText)`)),
    );

    // ---- share a link ------------------------------------------------------
    // v1.3: reopening the trip editor on a narrow screen collapses the sheet
    // (room for the card); Share lives in the expanded sheet.
    if (await evaluate(`Boolean(document.querySelector('.gm-peek'))`)) {
      await clickSelector('.gm-peek');
      await sleep(300);
    }
    const shareReady = await waitForPage(
      `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Share')`,
    );
    check('Share control offered for the selected route', shareReady);
    if (shareReady) {
      check('clicked Share', await clickSelector('.gm-share-btn'));
      const noticed = await waitForText(/Link copied to clipboard|#r=/);
      check(
        'share produces a link notice (clipboard or the URL itself)',
        noticed,
        await evaluate(`document.querySelector('.gm-detail-actions')?.parentElement?.innerText?.slice(-120) ?? 'no-detail'`),
      );
    }

    // ---- recents persist ---------------------------------------------------
    const recentsRaw = await evaluate(`window.localStorage.getItem('ghostroute.recent')`);
    check(
      'plotted trip recorded in ghostroute.recent',
      typeof recentsRaw === 'string' && /"destination"/.test(recentsRaw),
      String(recentsRaw ?? '').slice(0, 80),
    );

    // ---- deep link boot ----------------------------------------------------
    const deepBefore = routeRequests.length;
    // The `?dl=1` query is load-bearing: navigating to the SAME url with only
    // a different hash is a same-document navigation, so the SPA never
    // remounts and never reads the link. The query forces a real reload.
    await input('Page.navigate', {
      url: `${APP_URL}?dl=1#r=30.30,-97.70~30.35,-97.65&prof=cycling&vd=1&buf=300`,
    });
    await setFix(30.3, -97.7, 90);
    const hydrated = await waitForPage(
      `(() => { const el = document.querySelector('#gr-origin'); return Boolean(el) && el.value.trim().length > 0; })()`,
      25_000,
    );
    check(
      'deep link hydrates the origin without typing',
      hydrated,
      await evaluate(
        `JSON.stringify({ hash: location.hash, origin: document.querySelector('#gr-origin')?.value ?? null, root: Boolean(document.querySelector('.gm-root')), err: document.body.innerText.slice(0, 90) })`,
      ),
    );
    const deepReq = await waitForNewRequest(deepBefore, () => true, 15_000);
    check(
      'deep-linked options reach the API (profile, filter, buffer)',
      deepReq?.profile === 'cycling' &&
        deepReq?.cameraFilter?.verifiedOnly === true &&
        deepReq?.bufferMeters === 300,
      JSON.stringify(
        deepReq ? { profile: deepReq.profile, filter: deepReq.cameraFilter, buf: deepReq.bufferMeters } : null,
      ),
    );
    check(
      'unsupported profile surfaces the driving fallback notice',
      await waitForText(/showing driving directions/),
    );

    check(
      'no uncaught page exceptions during the v1.2 flows',
      pageLog.filter((l) => /pageerror/.test(l)).length === 0,
      pageLog.filter((l) => /pageerror/.test(l)).slice(0, 2).join(' | '),
    );

    return await camState();
  } finally {
    try {
      if (cdp) await cdp.send('Browser.close').catch(() => {});
    } catch {
      /* ignore */
    }
    chrome.kill('SIGKILL');
    vite.kill('SIGKILL');
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

let fatal = null;
main()
  .catch((e) => {
    fatal = e;
  })
  .finally(() => {
    console.log('\n================ browser verification ================');
    for (const r of results) {
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
    }
    if (fatal) {
      console.log(`\nFATAL: ${fatal.message}`);
      if (process.env.VERBOSE) console.log(fatal.stack);
    }
    const total = results.length;
    console.log(
      `\n${total - failed}/${total} checks passed${fatal ? ' (run aborted early)' : ''}`,
    );
    process.exit(failed > 0 || fatal ? 1 : 0);
  });
