// Blueprint sweep: planning UI states on desktop and phone, the layout promises
// the panels make to the map, and the route-selection interactions.
//   node tools/blueprint/sweep.mjs        (APP_URL, BP_OUT override defaults)
import {
  BP, TRIPS, tripHash, makeReport, launch, openApp, waitRoutes, rectOf, overlap, freeRect, routeInRect, mapLayers,
} from "./lib.mjs";

const { report, check, finish } = makeReport("sweep");
const browser = await launch();
const shot = (page, name) => page.screenshot({ path: `${BP}/ui/${name}.png` });

// ================================================================ desktop
{
  const vp = { width: 1440, height: 900 };
  const t0 = Date.now();
  const { ctx, page } = await openApp(browser, report, { viewport: vp });
  report.perf.desktopReadyMs = Date.now() - t0;
  await page.waitForTimeout(1200);
  await shot(page, "desk-01-empty");

  const spinner = await page.evaluate(() => {
    const b = document.querySelector(".gm-find-btn");
    const a = b ? getComputedStyle(b, "::after") : null;
    return { disabled: b?.disabled, content: a?.content, anim: a?.animationName };
  });
  check("Planning UI", "Idle Find button shows no loading spinner", spinner.disabled && (spinner.content === "none" || spinner.anim === "none"), JSON.stringify(spinner));

  // Plan a trip through a deep link (fixture-backed), timed to drawn routes.
  const t1 = Date.now();
  await page.goto(page.url().split("#")[0] + tripHash(TRIPS.north));
  await page.reload();
  await waitRoutes(page, 7);
  report.perf.deepLinkToRoutesMs = Date.now() - t1;
  await page.waitForFunction(() => !/^-?\d/.test(window.__ghost.originLabel), null, { timeout: 8000 }).catch(() => {});
  await shot(page, "desk-02-routes");

  const g = await page.evaluate(() => window.__ghost);
  check("Planning UI", "Shared link resolves both endpoints to street names", !/^-?\d/.test(g.originLabel) && !/^-?\d/.test(g.destinationLabel), `${g.originLabel} → ${g.destinationLabel}`);
  const openLists = await page.evaluate(() => ({
    lists: [...document.querySelectorAll(".gm-suggest")].filter((e) => e.offsetParent).length,
    focus: document.activeElement?.tagName,
  }));
  check("Planning UI", "No suggestion list opens without the user typing", openLists.lists === 0, JSON.stringify(openLists));

  const layers = await mapLayers(page);
  const alts = layers.filter((l) => l.endsWith("-altfill"));
  check("Route look", "Map draws the selected route + at most 2 alternatives (of 7)", alts.length <= 2 && layers.includes(`gr-route-${g.selectedId}-fill`), `alts=${alts.length}, routes=${g.routes.length}`);
  const iSel = layers.indexOf(`gr-route-${g.selectedId}-fill`);
  const iCam = layers.indexOf("gr-cam-dots");
  const iSelCam = layers.indexOf("gr-selcams-dot");
  check("Route look", "Camera dots render above the route line, exposed cameras above all", iSel >= 0 && iCam > iSel && iSelCam > iCam, `fill@${iSel} cams@${iCam} exposed@${iSelCam}`);
  check("Route look", "Camera zones painted on the selected route (it has 3 exposures)", layers.includes(`gr-route-${g.selectedId}-zones-fill`));
  check("Route look", "Direction arrows drawn along the selected route", layers.includes(`gr-route-${g.selectedId}-arrows`));

  const chips = await page.evaluate(() => [...document.querySelectorAll(".gm-route-chip")].filter((c) => getComputedStyle(c).visibility !== "hidden").map((c) => {
    const r = c.getBoundingClientRect();
    return { id: c.dataset.routeId, sel: c.classList.contains("sel"), text: c.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }));
  let chipOverlap = 0;
  for (let i = 0; i < chips.length; i++) for (let j = i + 1; j < chips.length; j++) if (overlap(chips[i], chips[j])) chipOverlap++;
  check("Route look", "One label chip per drawn route, none overlapping", chips.length === alts.length + 1 && chipOverlap === 0, chips.map((c) => c.text).join(" | "));

  const fr = await freeRect(page);
  const fit = await routeInRect(page, fr);
  check("Layout", "Desktop: fitted route lies in the map area right of the panel", fit.share >= 0.98, `${(fit.share * 100).toFixed(1)}% of ${fit.n} vertices`);
  report.perf.desktopRouteInView = +(fit.share * 100).toFixed(1);

  const start = await page.evaluate(() => {
    const b = document.querySelector(".gm-start-btn");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { visible: r.bottom <= innerHeight && r.top >= 0, onTop: b.contains(hit), enabled: !b.disabled };
  });
  check("Planning UI", "Start button visible and clickable without opening the sheet", start?.visible && start?.onTop && start?.enabled, JSON.stringify(start));

  // Select an alternative by its chip, then by tapping its line.
  const altChip = chips.find((c) => !c.sel);
  await page.mouse.click((altChip.left + altChip.right) / 2, (altChip.top + altChip.bottom) / 2);
  await page.waitForTimeout(500);
  const afterChip = await page.evaluate(() => window.__ghost.selectedId);
  check("Route look", "Tapping an alternative's chip selects that route", afterChip === altChip.id, `${g.selectedId} → ${afterChip}`);
  await page.waitForFunction(() => !window.__grMap.isMoving(), null, { timeout: 8000 });
  await page.waitForTimeout(600);
  await shot(page, "desk-03-alt-selected");
  const lineTarget = await page.evaluate(() => {
    const m = window.__grMap;
    const ids = m.getStyle().layers.map((l) => l.id).filter((l) => l.endsWith("-altfill"));
    for (const id of ids) {
      const src = m.getSource(id.replace(/-altfill$/, ""));
      const coords = src.serialize().data.geometry.coordinates;
      for (let i = Math.floor(coords.length * 0.3); i < coords.length * 0.7; i++) {
        const p = m.project(coords[i]);
        const el = document.elementFromPoint(p.x, p.y);
        if (!el || el.tagName !== "CANVAS") continue;
        const hits = m.queryRenderedFeatures([p.x, p.y]).map((f) => f.layer.id);
        if (hits[0] === id) return { x: p.x, y: p.y, id: src.serialize().data.properties.routeId };
      }
    }
    return null;
  });
  const before = await page.evaluate(() => ({ o: window.__ghost.originLabel, d: window.__ghost.destinationLabel }));
  if (lineTarget) {
    await page.mouse.click(lineTarget.x, lineTarget.y);
    await page.waitForTimeout(500);
  }
  const afterLine = await page.evaluate(() => ({ sel: window.__ghost.selectedId, o: window.__ghost.originLabel, d: window.__ghost.destinationLabel }));
  check("Route look", "Tapping an alternative line selects it (and moves no endpoint)", lineTarget && afterLine.sel === lineTarget.id && afterLine.o === before.o && afterLine.d === before.d, lineTarget ? `→ ${afterLine.sel}` : "no clear alt line point");

  // A camera tap opens its popup and must not re-plan the trip.
  await page.waitForFunction(() => !window.__grMap.isMoving(), null, { timeout: 8000 });
  const camPt = await page.evaluate(() => {
    const m = window.__grMap;
    const feats = m.queryRenderedFeatures({ layers: ["gr-cam-dots"] });
    for (const f of feats) {
      const p = m.project(f.geometry.coordinates);
      const el = document.elementFromPoint(p.x, p.y);
      if (el?.tagName !== "CANVAS") continue;
      const top = m.queryRenderedFeatures([p.x, p.y])[0];
      if (top?.layer.id === "gr-cam-dots") return { x: p.x, y: p.y };
    }
    return null;
  });
  const routesBefore = await page.evaluate(() => window.__ghost.routes.join());
  if (camPt) {
    await page.mouse.click(camPt.x, camPt.y);
    await page.waitForTimeout(1200);
  }
  const camAfter = await page.evaluate(() => ({
    popup: Boolean(document.querySelector(".maplibregl-popup")),
    o: window.__ghost.originLabel,
    d: window.__ghost.destinationLabel,
  }));
  check("Planning UI", "Tapping a camera opens its card without moving an endpoint", camPt && camAfter.popup && camAfter.o === before.o && camAfter.d === before.d, camPt ? JSON.stringify(camAfter) : "no clickable camera");
  await shot(page, "desk-04-camera-popup");
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.querySelector(".maplibregl-popup-close-button")?.click());
  void routesBefore;

  const pin = await page.evaluate(() => {
    const p = document.querySelector(".gm-marker.dest .gm-pin");
    const o = document.querySelector(".gm-marker.origin");
    return { pinBg: p && getComputedStyle(p).backgroundColor, originBg: o && getComputedStyle(o).backgroundColor };
  });
  check("Route look", "Endpoints don't share a camera dot's colour (pin + hollow ring)", pin.pinBg && !/217, 48, 37|176, 96, 0/.test(pin.pinBg) && pin.originBg === "rgb(255, 255, 255)", JSON.stringify(pin));

  const degraded = await page.evaluate(() => {
    const s = document.querySelector(".gm-degraded > span");
    return s ? { text: s.textContent, clipped: s.scrollHeight > s.clientHeight + 1 || s.scrollWidth > s.clientWidth + 1 } : null;
  });
  check("Planning UI", "Demo-mode notice is readable in full (no ellipsis)", degraded && !degraded.clipped, degraded?.text);

  // Expanded sheet: actions first, then the list.
  await page.click(".gm-peek");
  await page.waitForTimeout(500);
  await shot(page, "desk-05-sheet");
  const sheet = await page.evaluate(() => {
    const body = document.querySelector(".gm-sheet-body").getBoundingClientRect();
    const nav = [...document.querySelectorAll(".gm-detail-actions button")].find((b) => /Navigate/.test(b.textContent));
    const r = nav?.getBoundingClientRect();
    const subs = [...document.querySelectorAll(".gm-route-card .gm-subline")];
    return {
      navInView: !!r && r.top >= body.top && r.bottom <= body.bottom,
      truncated: subs.filter((s) => s.scrollWidth > s.clientWidth + 1).length,
      cards: subs.length,
      heur: [...document.querySelectorAll(".gm-route-card")].filter((c) => /\bheur\b/.test(c.textContent)).length,
    };
  });
  check("Planning UI", "Expanded sheet shows Navigate without scrolling past the list", sheet.navInView, JSON.stringify(sheet));
  check("Planning UI", "Route cards show full time/distance (no ellipsis)", sheet.truncated === 0, `${sheet.truncated}/${sheet.cards} truncated`);
  check("Planning UI", "No jargon 'heur' pill repeated on every card", sheet.heur === 0, `${sheet.heur} cards`);
  await page.click(".gm-sheet-handle");

  // Camera-free trip: green chip, no zones.
  await page.goto(page.url().split("#")[0] + tripHash(TRIPS.clean));
  await page.reload();
  await waitRoutes(page, 1);
  const clean = await page.evaluate(() => ({
    chip: document.querySelector(".gm-route-chip.sel")?.textContent,
    zones: window.__grMap.getStyle().layers.some((l) => l.id.endsWith("-zones-fill")),
  }));
  check("Route look", "Camera-free route: 'no cams' chip and no red zones", /no cams/.test(clean.chip ?? "") && !clean.zones, JSON.stringify(clean));
  await shot(page, "desk-06-clean");

  // Perf: frames while the map rotates in 3D with routes, cameras and chips up.
  await page.goto(page.url().split("#")[0] + tripHash(TRIPS.north));
  await page.reload();
  await waitRoutes(page, 7);
  report.perf.fps3dRotate = await page.evaluate(
    () =>
      new Promise((res) => {
        const m = window.__grMap;
        let frames = 0;
        const t0 = performance.now();
        const tick = () => {
          frames++;
          if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
          else res(Math.round((frames * 1000) / (performance.now() - t0)));
        };
        m.easeTo({ bearing: m.getBearing() + 90, duration: 2000, easing: (t) => t });
        requestAnimationFrame(tick);
      }),
  );
  report.perf.jsHeapMB = await page.evaluate(() => (performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null));
  await ctx.close();
}

// ================================================================ phone
{
  const vp = { width: 390, height: 844 };
  const { ctx, page } = await openApp(browser, report, { viewport: vp, mobile: true });
  await page.waitForTimeout(1500);
  await shot(page, "phone-01-empty");
  await page.goto(page.url().split("#")[0] + tripHash(TRIPS.north));
  await page.reload();
  await waitRoutes(page, 7);
  await page.waitForFunction(() => !/^-?\d/.test(window.__ghost.originLabel), null, { timeout: 8000 }).catch(() => {});
  await shot(page, "phone-02-routes");

  const card = await rectOf(page, ".gm-topcard");
  const compact = await page.evaluate(() => Boolean(document.querySelector(".gm-trip-summary")));
  check("Phone", "Routes shown → directions collapse to a two-line summary", compact && card.h <= 100, `card height ${Math.round(card.h)}px`);
  const fr = await freeRect(page);
  const share = ((fr.bottom - fr.top) * (fr.right - fr.left)) / (vp.width * vp.height);
  check("Phone", "At least half the screen is unobstructed map", share >= 0.5, `${(share * 100).toFixed(0)}%`);
  report.perf.phoneMapSharePct = Math.round(share * 100);
  const fit = await routeInRect(page, fr);
  check("Phone", "Fitted route lies between the top card and the sheet", fit.share >= 0.98, `${(fit.share * 100).toFixed(1)}% of ${fit.n} vertices`);
  report.perf.phoneRouteInView = +(fit.share * 100).toFixed(1);

  const rs = {
    card,
    sheet: await rectOf(page, ".gm-sheet"),
    fabs: await rectOf(page, ".gm-fabs"),
    toggle: await rectOf(page, ".gm-3d-toggle"),
    attrib: await rectOf(page, ".maplibregl-ctrl-attrib"),
  };
  const fabClash = ["card", "sheet"].filter((k) => overlap(rs.fabs, rs[k]) || overlap(rs.toggle, rs[k]));
  check("Phone", "Floating buttons clear the top card and the sheet", fabClash.length === 0 && !overlap(rs.fabs, rs.toggle), fabClash.join(",") || "clear");
  check("Phone", "Map attribution stays visible above the sheet", rs.attrib && rs.attrib.bottom <= rs.sheet.top + 1, rs.attrib ? `attrib bottom ${Math.round(rs.attrib.bottom)} / sheet top ${Math.round(rs.sheet.top)}` : "missing");
  const startP = await page.evaluate(() => {
    const b = document.querySelector(".gm-start-btn");
    const r = b?.getBoundingClientRect();
    return r ? { inView: r.bottom <= innerHeight && r.top >= 0, h: Math.round(r.height) } : null;
  });
  check("Phone", "Start button in the peek, thumb-sized (≥44px)", startP?.inView && startP.h >= 44, JSON.stringify(startP));

  await page.click(".gm-trip-summary");
  await page.waitForTimeout(400);
  const editing = await page.evaluate(() => Boolean(document.querySelector("#origin-input, .gm-field input")));
  await shot(page, "phone-03-edit");
  check("Phone", "Tapping the summary reopens the full trip editor", editing);
  // Options open on a phone: Find must still be reachable above the sheet.
  await page.click(".gm-options-toggle");
  await page.waitForTimeout(300);
  const findReach = await page.evaluate(() => {
    const b = [...document.querySelectorAll(".gm-find-btn")].at(-1);
    b.scrollIntoView({ block: "nearest" });
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { onTop: b.contains(top), by: top?.className ?? "" };
  });
  await shot(page, "phone-03b-options");
  check("Phone", "With route options open, Find stays reachable above the sheet", findReach.onTop, findReach.onTop ? "clear" : `covered by ${findReach.by}`);
  await page.click(".gm-options-toggle");
  await page.click('.gm-back-btn');
  await page.waitForTimeout(300);
  check("Phone", "Back returns to the compact summary", await page.evaluate(() => Boolean(document.querySelector(".gm-trip-summary"))));

  await page.click(".gm-peek");
  await page.waitForTimeout(500);
  await shot(page, "phone-04-sheet");
  const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  check("Phone", "No sideways scroll at 390px", noScroll);
  await ctx.close();
}

check("Health", "No console errors or page exceptions", report.errors.length === 0, report.errors.slice(0, 3).join(" | "));
await finish(browser);
