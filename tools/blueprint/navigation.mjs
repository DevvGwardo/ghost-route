// Feature pass: real-time navigation on a phone.
// Drives the recorded 2.3 km Rainey St → E 11th St route (3 Flock cameras,
// avoidance off) with emulated GPS that reports NO heading and NO speed —
// what most phone browsers give a web page — and asserts every promise the
// navigation view makes: driving camera, snapped puck with a computed heading,
// shrinking distances, camera alerts, reroute, pan/recenter, arrival, wake lock.
//   node tools/blueprint/navigation.mjs
import fs from "node:fs";
import { BP, TRIPS, tripHash, fixture, makeReport, launch, openApp, waitRoutes, mapLayers } from "./lib.mjs";

const { report, check, finish } = makeReport("navigation");
const browser = await launch();
const VP = { width: 390, height: 844 };
const STEP_M = 30; // metres per emulated fix
const TICK_MS = 450; // wall-clock between fixes (≈ 67 m/s compressed time)

const route = fixture(TRIPS.drive.fixture).routes[0];
const coords = route.coordinates;

// ---------------------------------------------------------------- geometry
const R = 6371000, D = Math.PI / 180;
const hav = (a, b) => {
  const s = Math.sin(((b[0] - a[0]) * D) / 2) ** 2 + Math.cos(a[0] * D) * Math.cos(b[0] * D) * Math.sin(((b[1] - a[1]) * D) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, s)));
};
const bearing = (a, b) => {
  const y = Math.sin((b[1] - a[1]) * D) * Math.cos(b[0] * D);
  const x = Math.cos(a[0] * D) * Math.sin(b[0] * D) - Math.sin(a[0] * D) * Math.cos(b[0] * D) * Math.cos((b[1] - a[1]) * D);
  return ((Math.atan2(y, x) / D) % 360 + 360) % 360;
};
const angDiff = (a, b) => Math.abs((((b - a) % 360) + 540) % 360 - 180);
/** Points every `step` metres along the route, with the local travel bearing. */
function walk(step) {
  const out = [];
  let carry = 0;
  for (let i = 0; i + 1 < coords.length; i++) {
    const a = coords[i], b = coords[i + 1];
    const len = hav(a, b);
    let d = carry;
    while (d < len) {
      const t = d / len;
      out.push({ lat: a[0] + (b[0] - a[0]) * t, lon: a[1] + (b[1] - a[1]) * t, brg: bearing(a, b), seg: i });
      d += step;
    }
    carry = d - len;
  }
  const last = coords[coords.length - 1];
  out.push({ lat: last[0], lon: last[1], brg: out.at(-1)?.brg ?? 0, seg: coords.length - 2 });
  return out;
}
const fixes = walk(STEP_M);
const totalM = coords.slice(1).reduce((s, c, i) => s + hav(coords[i], c), 0);

// ---------------------------------------------------------------- session
const wakeSpy = () => {
  window.__wakeCalls = [];
  const fake = {
    request: async (type) => {
      window.__wakeCalls.push(type);
      return { released: false, release: async function () { this.released = true; } };
    },
  };
  Object.defineProperty(Navigator.prototype, "wakeLock", { get: () => fake, configurable: true });
};
const videoDir = `${BP}/video/nav-raw`;
fs.rmSync(videoDir, { recursive: true, force: true });
const { ctx, page, routeCalls } = await openApp(browser, report, {
  viewport: VP,
  mobile: true,
  hash: tripHash(TRIPS.drive),
  geo: { latitude: fixes[0].lat, longitude: fixes[0].lon, accuracy: 8 },
  video: videoDir,
  init: wakeSpy,
});
await waitRoutes(page, 1);
await page.screenshot({ path: `${BP}/nav/00-planned.png` });

const shot = (name) => page.screenshot({ path: `${BP}/nav/${name}.png` });
const state = () =>
  page.evaluate(() => {
    const m = window.__grMap;
    const g = window.__ghost;
    const dot = document.querySelector(".gm-user-dot")?.getBoundingClientRect();
    return {
      nav: g.nav,
      navigating: g.navigating,
      bearing: m.getBearing(),
      pitch: m.getPitch(),
      zoom: m.getZoom(),
      padding: m.getPadding(),
      dot: dot ? { x: dot.left + dot.width / 2, y: dot.top + dot.height / 2 } : null,
      dist: document.querySelector(".gm-nav-dist")?.textContent ?? null,
      road: document.querySelector(".gm-nav-road")?.textContent ?? null,
      then: Boolean(document.querySelector(".gm-nav-then")),
      cam: document.querySelector(".gm-nav-cam")?.textContent ?? null,
      bar: document.querySelector(".gm-tripbar")?.textContent ?? null,
      chevron: Boolean(document.querySelector(".gm-next-turn")),
      arrow: Boolean(document.querySelector(".gm-user-dot.has-heading")),
    };
  });
const setFix = (p) => ctx.setGeolocation({ latitude: p.lat, longitude: p.lon, accuracy: 8 });

// ---------------------------------------------------------------- start
await page.click(".gm-start-btn");
await page.waitForFunction(() => window.__ghost.navigating && window.__ghost.nav.puck, null, { timeout: 15000 });
await page.waitForTimeout(1500);
const s0 = await state();
await shot("01-start");
check("Start", "Start enters navigation from the peek in one tap", s0.navigating);
const chrome = await page.evaluate(() => ({
  card: Boolean(document.querySelector(".gm-nav-card")),
  bar: Boolean(document.querySelector(".gm-tripbar")),
  sheet: Boolean(document.querySelector(".gm-sheet")),
  fabs: Boolean(document.querySelector(".gm-fabs")),
  toggle: Boolean(document.querySelector(".gm-3d-toggle")),
  chips: document.querySelectorAll(".gm-route-chip").length,
}));
check("Start", "Driving view: maneuver card + trip bar; sheet, FABs and route chips hidden", chrome.card && chrome.bar && !chrome.sheet && !chrome.fabs && !chrome.toggle && chrome.chips === 0, JSON.stringify(chrome));
check("Start", "Screen wake lock requested so the phone does not sleep mid-drive", (await page.evaluate(() => window.__wakeCalls)).includes("screen"));
check("Camera", "Map tilts into a driving perspective (pitch ≥ 40°)", s0.pitch >= 40, `pitch ${s0.pitch.toFixed(1)}°`);
check("Camera", "Puck sits low on screen, looking ahead (lower 40%)", s0.dot && s0.dot.y > VP.height * 0.6 && Math.abs(s0.dot.x - VP.width / 2) < 30, s0.dot ? `y=${Math.round(s0.dot.y)}/${VP.height}` : "no puck");
check("Camera", "Heading known with no device heading (from the road)", s0.nav.heading != null && s0.arrow, `heading ${s0.nav.heading?.toFixed(0)}°, first leg ${fixes[1].brg.toFixed(0)}°`);
check("Guidance", "Trip bar shows time left, distance left and arrival clock", /min/.test(s0.bar ?? "") && /km|m\b/.test(s0.bar ?? "") && /arrive/.test(s0.bar ?? ""), s0.bar);

// ---------------------------------------------------------------- drive
const trace = [];
let rerouteDone = false;
let rerouteSeen = false;
let recenterDone = false;
const offAt = Math.floor(fixes.length * 0.55);
const panAt = Math.floor(fixes.length * 0.3);
let frames = 0;
await page.evaluate(() => {
  window.__frames = 0;
  const f = () => { window.__frames++; requestAnimationFrame(f); };
  requestAnimationFrame(f);
});
const driveT0 = Date.now();
for (let i = 1; i < fixes.length; i++) {
  const f = fixes[i];
  await setFix(f);
  await page.waitForTimeout(TICK_MS);
  const s = await state();
  trace.push({ i, ...f, ...s });
  if (s.cam && !trace.some((t) => t.camShot)) { trace.at(-1).camShot = true; await shot("02-camera-alert"); }
  if (s.then && !trace.some((t) => t.thenShot)) { trace.at(-1).thenShot = true; await shot("03-then-preview"); }

  // Pan away mid-drive: follow pauses, Re-center brings it back.
  if (i === panAt && !recenterDone) {
    await page.waitForTimeout(1000);
    const box = await page.locator(".gr-map").boundingBox();
    await page.mouse.move(box.x + 200, box.y + 500);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 380, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const shown = await page.locator(".gm-nav-recenter").isVisible().catch(() => false);
    await shot("04-paused");
    check("Camera", "Dragging the map pauses follow and shows Re-center", shown);
    if (shown) await page.click(".gm-nav-recenter");
    await page.waitForTimeout(1300);
    const back = await state();
    check("Camera", "Re-center resumes the driving view on the puck", !(await page.locator(".gm-nav-recenter").isVisible().catch(() => false)) && back.dot && back.dot.y > VP.height * 0.6, back.dot ? `puck y=${Math.round(back.dot.y)}` : "");
    recenterDone = true;
  }

  // Leave the route for a few fixes (a missed turn): confirmed off-route → reroute.
  if (i === offAt && !rerouteDone) {
    const before = routeCalls.length;
    for (let k = 1; k <= 5; k++) {
      await setFix({ lat: f.lat + 0.0006 * k, lon: f.lon + 0.0028 });
      await page.waitForTimeout(500);
      const txt = await page.evaluate(() => document.querySelector(".gm-nav")?.textContent ?? "");
      if (/Rerouting/.test(txt)) {
        rerouteSeen = true;
        await shot("05-rerouting");
      }
    }
    await page.waitForTimeout(800);
    check("Reroute", "Leaving the route triggers exactly one reroute request", routeCalls.length === before + 1, `${routeCalls.length - before} request(s)`);
    check("Reroute", "Off-route fixes surface 'Rerouting…' (or the new plan lands first)", rerouteSeen || routeCalls.length === before + 1, rerouteSeen ? "banner shown" : "landed before a frame was sampled");
    const rr = routeCalls.at(-1);
    check("Reroute", "Reroute plans from the live fix, not the planned origin", rr && Math.abs(rr.origin.lat - TRIPS.drive.o[0]) > 1e-3, rr ? `${rr.origin.lat.toFixed(4)},${rr.origin.lon.toFixed(4)}` : "");
    rerouteDone = true;
    await setFix(f); // back on the road
    await page.waitForTimeout(1200);
  }
}
const driveS = (Date.now() - driveT0) / 1000;
frames = await page.evaluate(() => window.__frames);
report.perf.navFps = Math.round(frames / driveS);
report.perf.navFixes = fixes.length;
report.perf.routeKm = +(totalM / 1000).toFixed(2);

// ---------------------------------------------------------------- verdicts
const settled = trace.filter((t) => t.i > 2 && t.i < offAt - 1 && t.nav.puck);
const headErr = settled.map((t) => angDiff(t.nav.heading ?? 999, t.brg));
const headOk = headErr.filter((e) => e <= 25).length / Math.max(1, headErr.length);
check("Camera", "Computed heading tracks the road (≤25° on ≥90% of fixes)", headOk >= 0.9, `${(headOk * 100).toFixed(0)}% of ${headErr.length}, median ${headErr.sort((a, b) => a - b)[Math.floor(headErr.length / 2)]?.toFixed(1)}°`);
const camErr = settled.map((t) => angDiff(t.bearing, t.nav.heading ?? 0)).sort((a, b) => a - b);
const p50 = camErr[Math.floor(camErr.length / 2)] ?? 999;
check("Camera", "Map rotates with travel (median map-vs-heading gap ≤ 20°)", p50 <= 20, `median ${p50.toFixed(1)}°`);
const pitches = settled.map((t) => t.pitch);
check("Camera", "Driving tilt held for the whole drive", Math.min(...pitches) >= 40, `min ${Math.min(...pitches).toFixed(1)}°`);
const lowPuck = settled.filter((t) => t.dot && t.dot.y > VP.height * 0.55).length / Math.max(1, settled.length);
check("Camera", "Puck stays in the lower part of the screen while following", lowPuck >= 0.9, `${(lowPuck * 100).toFixed(0)}% of fixes`);

const preOff = trace.filter((t) => t.i < offAt && t.nav.remainingRouteM != null);
let backwards = 0;
for (let k = 1; k < preOff.length; k++) if (preOff[k].nav.remainingRouteM > preOff[k - 1].nav.remainingRouteM + 5) backwards++;
check("Guidance", "Distance left only goes down while on route", backwards === 0 && preOff.length > 10, `${preOff.length} fixes, ${backwards} increases; ${Math.round(preOff[0]?.nav.remainingRouteM)} → ${Math.round(preOff.at(-1)?.nav.remainingRouteM)} m`);
const tFirst = preOff[0]?.nav.remainingS, tLast = preOff.at(-1)?.nav.remainingS;
check("Guidance", "Time left counts down with distance", tFirst > tLast && tLast >= 0, `${Math.round(tFirst)} s → ${Math.round(tLast)} s`);
const accurate = settled.filter((t) => Math.abs(t.nav.remainingRouteM - (totalM - fixes.slice(0, t.i + 1).length * STEP_M + STEP_M)) < 60).length / Math.max(1, settled.length);
check("Guidance", "Distance left matches the true distance to go (±60 m)", accurate >= 0.9, `${(accurate * 100).toFixed(0)}% of fixes`);
const roads = [...new Set(trace.filter((t) => t.road).map((t) => t.road))];
check("Guidance", "Maneuver card walks through the turns in order", roads.length >= 3, roads.join(" → "));
check("Guidance", "'Then' preview appears for back-to-back turns", trace.some((t) => t.then));
check("Guidance", "Next-turn chevron marks the upcoming maneuver on the map", trace.filter((t) => t.chevron).length > trace.length * 0.5);
const camTicks = trace.filter((t) => t.cam);
const firstCamIdx = fixes.findIndex((f) => route.exposures.some((e) => hav([f.lat, f.lon], [e.lat, e.lon]) < 40));
check("Cameras", "Flock camera alert fires before the first camera is reached", camTicks.length > 0 && camTicks[0].i < firstCamIdx, `alert at fix ${camTicks[0]?.i}, camera at fix ${firstCamIdx}: "${camTicks[0]?.cam}"`);
const lastCamIdx = Math.max(...route.exposures.map((e) => fixes.reduce((bi, f, k) => (hav([f.lat, f.lon], [e.lat, e.lon]) < hav([fixes[bi].lat, fixes[bi].lon], [e.lat, e.lon]) ? k : bi), 0)));
check("Cameras", "Alert clears once every camera is behind", !trace.some((t) => t.i > lastCamIdx + 3 && t.i < offAt && t.cam), `last camera at fix ${lastCamIdx}`);
check("Cameras", "Camera zones stay painted on the route while driving", (await mapLayers(page)).some((l) => l.endsWith("-zones-fill")));

// ---------------------------------------------------------------- arrival
const end = coords[coords.length - 1];
await setFix({ lat: end[0], lon: end[1] });
await page.waitForTimeout(1500);
const arr = await state();
await shot("06-arrived");
check("Arrival", "Arriving shows 'You have arrived' with a Done button", /arrived/i.test(arr.bar ?? "") && (await page.locator(".gm-tripbar-done").isVisible()), arr.bar);
await page.click(".gm-tripbar-done");
await page.waitForTimeout(1200);
const after = await state();
check("Arrival", "Done returns to the planning view with the route sheet", !after.navigating && (await page.locator(".gm-sheet").isVisible()));
check("Arrival", "Leaving navigation drops the tilt and look-ahead padding", after.pitch < 1 && after.padding.top === 0, `pitch ${after.pitch.toFixed(1)}°, padding top ${after.padding.top}`);
check("Arrival", "GPS watch stops when navigation ends", after.nav.puck == null);
await shot("07-after");

check("Health", "No console errors or page exceptions", report.errors.length === 0, report.errors.slice(0, 3).join(" | "));
fs.writeFileSync(`${BP}/data/nav-trace.json`, JSON.stringify(trace.map(({ i, lat, lon, brg, nav, bearing: b, pitch, dot, dist, road, cam }) => ({ i, lat, lon, brg, heading: nav.heading, mapBearing: b, pitch, dotY: dot?.y, remainingRouteM: nav.remainingRouteM, remainingS: nav.remainingS, dist, road, cam })), null, 2));
const video = page.video();
await ctx.close();
if (video) fs.renameSync(await video.path(), `${BP}/video/navigation.webm`);
await finish(browser);
