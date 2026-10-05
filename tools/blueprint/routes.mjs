// Route-look matrix: every recorded trip × {desktop, phone} × {2D, 3D}.
// Each frame is measured, not just captured: is the whole selected route in
// the unobstructed map area, are both endpoints visible, do the label chips
// stay clear of each other and of the panels, and is the line actually drawn
// where the route is (rendered-feature probe at sampled vertices).
//   node tools/blueprint/routes.mjs
import { BP, TRIPS, tripHash, makeReport, launch, openApp, waitRoutes, freeRect, routeInRect, overlap } from "./lib.mjs";

const { report, check, finish } = makeReport("routes");
const browser = await launch();
const VIEWS = [
  { key: "desk", vp: { width: 1440, height: 900 }, mobile: false },
  { key: "phone", vp: { width: 390, height: 844 }, mobile: true },
];
report.frames = [];

for (const view of VIEWS) {
  const { ctx, page } = await openApp(browser, report, { viewport: view.vp, mobile: view.mobile });
  for (const [tripKey, trip] of Object.entries(TRIPS)) {
    await page.goto(page.url().split("#")[0] + tripHash(trip));
    await page.reload();
    await waitRoutes(page, 1);
    for (const mode of ["2d", "3d"]) {
      const is3D = await page.evaluate(() => document.querySelector(".gm-3d-toggle")?.getAttribute("aria-pressed") === "true");
      if ((mode === "3d") !== is3D) {
        await page.click(".gm-3d-toggle");
        await page.waitForFunction(() => !window.__grMap.isMoving(), null, { timeout: 8000 });
        await page.waitForTimeout(700);
      }
      const name = `${view.key}-${tripKey}-${mode}`;
      await page.screenshot({ path: `${BP}/render/${name}.png` });
      const fr = await freeRect(page);
      const fit = await routeInRect(page, fr);
      const m = await page.evaluate((free) => {
        const inFree = (r) => r.left >= free.left - 1 && r.right <= free.right + 1 && r.top >= free.top - 1 && r.bottom <= free.bottom + 1;
        const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
        const all = [...document.querySelectorAll(".gm-route-chip")];
        const chips = all.filter((c) => getComputedStyle(c).visibility !== "hidden").map(box);
        const hiddenChips = all.length - chips.length;
        const selShown = all.some((c) => c.classList.contains("sel") && getComputedStyle(c).visibility !== "hidden");
        const markers = [...document.querySelectorAll(".gm-marker")].map(box);
        // Is the selected line actually rendered under its own vertices?
        const map = window.__grMap;
        const g = window.__ghost;
        const coords = map.getSource(`gr-route-${g.selectedId}`).serialize().data.geometry.coordinates;
        // How much of the free area the line spans (the larger of width/height share).
        const proj = coords.map((c) => map.project(c));
        const pxs = proj.map((p) => p.x), pys = proj.map((p) => p.y);
        const fill = Math.max((Math.max(...pxs) - Math.min(...pxs)) / (free.right - free.left), (Math.max(...pys) - Math.min(...pys)) / (free.bottom - free.top));
        let probed = 0, drawn = 0;
        for (let i = 0; i < coords.length; i += Math.max(1, Math.floor(coords.length / 25))) {
          const p = map.project(coords[i]);
          if (p.x < free.left || p.x > free.right || p.y < free.top || p.y > free.bottom) continue;
          probed++;
          const hits = map.queryRenderedFeatures([[p.x - 3, p.y - 3], [p.x + 3, p.y + 3]]).map((f) => f.layer.id);
          if (hits.some((id) => id.startsWith(`gr-route-${g.selectedId}`))) drawn++;
        }
        return {
          hiddenChips,
          selShown,
          chips,
          chipsInFree: chips.filter(inFree).length,
          markersInFree: markers.filter(inFree).length,
          markers: markers.length,
          drawnShare: probed ? drawn / probed : 0,
          fill,
          pitch: map.getPitch(),
          zoom: map.getZoom(),
        };
      }, fr);
      let chipClash = 0;
      for (let i = 0; i < m.chips.length; i++) for (let j = i + 1; j < m.chips.length; j++) if (overlap(m.chips[i], m.chips[j])) chipClash++;
      const frame = {
        name, trip: tripKey, view: view.key, mode,
        routeInView: +(fit.share * 100).toFixed(1),
        endpointsVisible: `${m.markersInFree}/${m.markers}`,
        chips: m.chips.length, hiddenChips: m.hiddenChips, selChip: m.selShown, chipClash, chipsInFree: m.chipsInFree,
        lineDrawn: +(m.drawnShare * 100).toFixed(0),
        fill: Math.round(m.fill * 100),
        pitch: +m.pitch.toFixed(0), zoom: +m.zoom.toFixed(1),
      };
      report.frames.push(frame);
      console.log(JSON.stringify(frame));
    }
  }
  await ctx.close();
}

const F = report.frames;
const worst = (k) => Math.min(...F.map((f) => f[k]));
check("Matrix", `Whole selected route in the unobstructed map (all ${F.length} frames ≥ 95%)`, F.every((f) => f.routeInView >= 95), `worst ${worst("routeInView")}%`);
check("Matrix", "Route fills the free map (spans ≥ 60% of its width or height)", F.every((f) => f.fill >= 60), `worst ${worst("fill")}%, ${F.map((f) => f.fill).join("/")}`);
check("Matrix", "Both endpoint markers visible in every frame", F.every((f) => f.endpointsVisible === "2/2"), F.filter((f) => f.endpointsVisible !== "2/2").map((f) => `${f.name} ${f.endpointsVisible}`).join(", ") || "all 2/2");
check("Matrix", "Visible label chips never overlap each other", F.every((f) => f.chipClash === 0), F.filter((f) => f.chipClash).map((f) => f.name).join(", ") || "0 clashes");
check("Matrix", "The selected route's chip is always shown", F.every((f) => f.selChip), F.filter((f) => !f.selChip).map((f) => f.name).join(", ") || "all frames");
report.perf.chipsHiddenByDeclutter = F.reduce((s, f) => s + f.hiddenChips, 0);
check("Matrix", "Label chips stay clear of the panels", F.every((f) => f.chipsInFree === f.chips), F.filter((f) => f.chipsInFree !== f.chips).map((f) => `${f.name} ${f.chipsInFree}/${f.chips}`).join(", ") || "all clear");
check("Matrix", "Selected line rendered under its own vertices (≥ 90% of probes)", F.every((f) => f.lineDrawn >= 90), `worst ${worst("lineDrawn")}%`);
check("Matrix", "3D frames are pitched, 2D frames flat", F.every((f) => (f.mode === "3d" ? f.pitch >= 45 : f.pitch === 0)));
check("Health", "No console errors or page exceptions", report.errors.length === 0, report.errors.slice(0, 3).join(" | "));
await finish(browser);
