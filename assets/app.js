/* Gunnison County Land Attributes – independent research dashboard.
   Data: data/attributes.json (built by scripts/build_data.py),
         data/geo_index.json + data/parcels.geojson (built by scripts/build_geometry.py). */
(() => {
  "use strict";

  // ------------------------------------------------------------------ constants
  const NO_VALUE = -1, NO_LAND = -2, NO_LAND_OK = -3;
  const RECORD_URL = (acct) => `https://property.spatialest.com/co/gunnison#/property/${encodeURIComponent(acct)}`;
  const NEIGHBOR_CATS = ["lea", "land_primary", "views", "access_surface", "access_maint",
                         "electricity", "sewer", "water"];
  const ISSUES = {
    missing:             { label: "Missing",                   group: "missing",  about: "A core land attribute (land use, LEA, primary land type, views, site access road type & maintenance, electricity, sewer, water) is blank. When enough neighbors agree, the detail shows what they carry." },
    outlier:             { label: "Differs from neighbors",    group: "outlier",  about: "The account's value differs from the value most comparable properties around it carry (settings on the Review & Stats page)." },
    multiple:            { label: "More than one value",       group: "conflict", about: "A single-value attribute (primary/secondary land type, views) holds more than one value." },
    conflict:            { label: "Conflicting values",        group: "conflict", about: "A utility field holds values that contradict each other (e.g. INSTALLED and NOT AVAILABLE)." },
    repeated:            { label: "Repeated value",            group: "conflict", about: "The same value is entered more than once in a field." },
    same_as_primary:     { label: "Secondary = primary",       group: "conflict", about: "Secondary land type is the same as the primary land type." },
    legacy:              { label: "Legacy access code only",   group: "legacy",   about: "Site access carries only the older YEAR ROUND / SEASONAL code with no road type." },
    improved_no_utility: { label: "Improved, utility shows none", group: "improved", about: "The account is improved (residential, condo, commercial or mobile home with improvement value > $0) but a utility shows none / not installed / not available (off-grid excluded)." },
    no_land:             { label: "No land record",            group: "no_land",  about: "The account is in the general account download but has no row in the Land Attributes download. Mobile home (M) accounts and condos are excluded: they normally have no land line." },
    unmapped:            { label: "Not on parcel map",         group: "unmapped", about: "No parcel polygon matches the account or parcel number (usually mineral / oil & gas interests or new accounts)." },
  };
  const ISSUE_COLS = [
    ["missing", "Missing"], ["conflict", "Data conflicts"], ["legacy", "Legacy access code"],
    ["improved", "Improved, no utility"], ["outlier", "Differs from neighbors"],
  ];
  const BASEMAPS = {
    light: { tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"],
             attribution: "Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors", maxzoom: 16 },
    dark:  { tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}"],
             attribution: "Tiles © Esri — Esri, HERE, Garmin, © OpenStreetMap contributors", maxzoom: 16 },
    aerial:{ tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
             attribution: "Imagery © Esri, Maxar, Earthstar Geographics" },
    topo:  { tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"],
             attribution: "Tiles © Esri" },
  };
  const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;

  // ------------------------------------------------------------------ helpers
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (n == null ? "—" : Math.round(n).toLocaleString());
  const pct = (a, b) => (b ? (100 * a / b) : 0);
  const money = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString());
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Cb|Isds|Lea|Mh|Qcp|Govt)\b/g, (m) => m.toUpperCase());
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  function downloadCSV(name, header, rows) {
    const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [header, ...rows].map((r) => r.map(q).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  // ------------------------------------------------------------------ state
  let D, GEO, A, CATS, CAT_IX, VALUES, fpAccts, typesList, areasList;
  const S = {
    ci: 0, val: 0, valueText: "",
    types: new Set(), area: "",
    showFlags: false, basemap: "light",
    nb: { basis: "adjacent", min: 4, agree: 0.75 },
    review: { issue: "", ci: "", text: "", limit: 200 },
    distCi: 0,
  };
  let outliers = [];            // [{a, ci, own, top, agree, n}]
  let consensus = new Map();    // "a|ci" -> {top, agree, n}  (for accounts missing a value)
  let flagsByFp = null;         // Map ci -> Set(fp) of flagged footprints
  const whenReady = [];
  let map, mapReady = false, prevH = null, prevF = null, selFp = -1;

  const acctPass = (a) => (!S.types.size || S.types.has(a.type)) && (!S.area || a.area === S.area);
  // Mobile home (M…) accounts and condo units normally carry no land line, so a missing land record is expected.
  const landExpected = (a) => !(a.account.startsWith("M") || a.improvedType === "Condo" || a.condo);
  const noLandKind = (a) => a.account.startsWith("M") ? "Mobile home account" : "Condo unit";
  const valName = (ci, v) => v === NO_VALUE ? "No value recorded" : v === NO_LAND ? "No land record" : v === NO_LAND_OK ? "Mobile home / condo (no land line)" : VALUES[ci][v];
  const keyName = (ci, key) => key === "" ? "(blank)" : key.split("|").map((v) => VALUES[ci][+v]).join(" + ");

  // ------------------------------------------------------------------ load
  Promise.all([
    fetch("data/attributes.json", { cache: "no-cache" }).then((r) => r.json()),
    fetch("data/geo_index.json", { cache: "no-cache" }).then((r) => r.json()),
  ]).then(([d, g]) => {
    D = d; GEO = g.footprints;
    CATS = D.categories; VALUES = D.values;
    CAT_IX = Object.fromEntries(CATS.map((c, i) => [c.key, i]));
    const F = D.fields;
    A = D.rows.map((r) => Object.fromEntries(F.map((f, i) => [f, r[i]])));
    fpAccts = GEO.map(() => []);
    A.forEach((a, i) => { if (a.fp >= 0) fpAccts[a.fp].push(i); });
    const typeCounts = {}; const areaCounts = {};
    A.forEach((a) => { typeCounts[a.type] = (typeCounts[a.type] || 0) + 1; if (a.area) areaCounts[a.area] = (areaCounts[a.area] || 0) + 1; });
    typesList = Object.entries(typeCounts).sort((x, y) => y[1] - x[1]);
    areasList = Object.keys(areaCounts).sort();
    S.ci = CAT_IX.land_primary ?? 0;
    S.distCi = S.ci;
    readHash();
    computeOutliers();
    initControls();
    initSearch();
    initMap();
    applyHighlight();
    route();
  }).catch((e) => { $("loading").textContent = "Could not load data: " + e.message; console.error(e); });

  // ------------------------------------------------------------------ routing / hash
  function readHash() {
    const [page, qs] = location.hash.slice(1).split("?");
    const p = new URLSearchParams(qs || "");
    if (p.has("c") && CAT_IX[p.get("c")] != null) S.ci = CAT_IX[p.get("c")];
    if (p.has("v")) {
      const v = p.get("v");
      S.val = v === "_none" ? NO_VALUE : v === "_noland" ? NO_LAND : v === "_mhcondo" ? NO_LAND_OK : Math.max(0, VALUES[S.ci].indexOf(v));
    }
    return page || "map";
  }
  function writeHash() {
    if (currentPage() !== "map") return;
    const v = S.val === NO_VALUE ? "_none" : S.val === NO_LAND ? "_noland" : S.val === NO_LAND_OK ? "_mhcondo" : VALUES[S.ci][S.val];
    history.replaceState(null, "", `#map?c=${encodeURIComponent(CATS[S.ci].key)}&v=${encodeURIComponent(v)}`);
  }
  const currentPage = () => (location.hash.slice(1).split("?")[0] || "map");
  function route() {
    const page = ["map", "stats", "about"].includes(currentPage()) ? currentPage() : "map";
    for (const p of ["map", "stats", "about"]) $("page-" + p).hidden = p !== page;
    document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.page === page));
    if (page === "map" && map) { map.resize(); writeHash(); }
    if (page === "stats") renderStats();
    if (page === "about") renderAbout();
  }
  addEventListener("hashchange", () => { readHash(); if (currentPage() === "map" && D) { renderValues(); applyHighlight(); } route(); });

  // ------------------------------------------------------------------ controls (map page)
  function catOptions(sel, withAll) {
    const groups = {};
    CATS.forEach((c, i) => (groups[c.group] ||= []).push([c, i]));
    sel.innerHTML = (withAll ? `<option value="">All attributes</option>` : "") +
      Object.entries(groups).map(([g, cs]) => `<optgroup label="${esc(g)}">${cs.map(([c, i]) => `<option value="${i}">${esc(c.label)}</option>`).join("")}</optgroup>`).join("");
  }
  function renderChips(el) {
    el.innerHTML = typesList.map(([t, n]) => `<button class="chip${S.types.has(t) ? " on" : ""}" data-t="${esc(t)}" data-tip="${fmt(n)} accounts">${esc(t)}</button>`).join("");
  }
  function renderAreaSelect(el) {
    el.innerHTML = `<option value="">All areas</option>` + areasList.map((a) => `<option ${a === S.area ? "selected" : ""}>${esc(a)}</option>`).join("");
  }
  function filtersChanged() {
    renderChips($("type-chips")); renderChips($("s-type-chips"));
    $("area").value = S.area; $("s-area").value = S.area;
    if (currentPage() === "stats") renderStats();
    renderValues(); applyHighlight();
  }
  function initControls() {
    catOptions($("cat")); $("cat").value = S.ci;
    $("cat").onchange = () => { S.ci = +$("cat").value; S.val = 0; S.valueText = ""; $("value-filter").value = ""; renderValues(); applyHighlight(); writeHash(); };
    $("value-filter").oninput = () => { S.valueText = $("value-filter").value.trim().toLowerCase(); renderValues(); };
    $("values").onclick = (e) => { const li = e.target.closest("li[data-v]"); if (li) selectValue(+li.dataset.v); };
    $("prev").onclick = () => flip(-1);
    $("next").onclick = () => flip(1);
    addEventListener("keydown", (e) => {
      if (currentPage() !== "map" || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      if (e.key === "ArrowDown" || e.key === "j") { flip(1); e.preventDefault(); }
      if (e.key === "ArrowUp" || e.key === "k") { flip(-1); e.preventDefault(); }
      if (e.key === "Escape") closeDetail();
    });
    for (const el of [$("type-chips"), $("s-type-chips")]) {
      el.onclick = (e) => { const b = e.target.closest(".chip"); if (!b) return; const t = b.dataset.t; S.types.has(t) ? S.types.delete(t) : S.types.add(t); filtersChanged(); };
    }
    renderChips($("type-chips")); renderChips($("s-type-chips"));
    renderAreaSelect($("area")); renderAreaSelect($("s-area"));
    $("area").onchange = () => { S.area = $("area").value; filtersChanged(); if (S.area) zoomToAccounts(A.filter((a) => a.area === S.area)); };
    $("s-area").onchange = () => { S.area = $("s-area").value; filtersChanged(); };
    $("show-flags").onchange = () => { S.showFlags = $("show-flags").checked; document.querySelector(".flag-legend").hidden = !S.showFlags; applyFlags(); };
    $("basemap").onclick = (e) => { const b = e.target.closest("button"); if (b) setBasemap(b.dataset.bm); };
    $("detail-close").onclick = closeDetail;
    $("detail-body").onclick = (e) => {
      const b = e.target.closest("[data-show-all]"); if (b) openDetail(+b.dataset.showAll, true);
      const c = e.target.closest("[data-pick]"); if (c) { const [ci, v] = c.dataset.pick.split(":").map(Number); S.ci = ci; $("cat").value = ci; selectValue(v); }
    };

    // stats controls
    $("nb-basis").onchange = $("nb-min").onchange = $("nb-agree").onchange = () => {
      S.nb = { basis: $("nb-basis").value, min: Math.max(2, +$("nb-min").value || 4), agree: +$("nb-agree").value };
      computeOutliers(); renderStats(); applyFlags();
    };
    catOptions($("dist-cat")); $("dist-cat").value = S.distCi;
    $("dist-cat").onchange = () => { S.distCi = +$("dist-cat").value; renderDist(); };
    $("r-issue").innerHTML = `<option value="">All issues</option>` + Object.entries(ISSUES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("");
    catOptions($("r-cat"), true);
    $("r-issue").onchange = () => { S.review.issue = $("r-issue").value; S.review.group = ""; S.review.limit = 200; renderReview(); };
    $("r-cat").onchange = () => { S.review.ci = $("r-cat").value; S.review.limit = 200; renderReview(); };
    $("r-text").oninput = debounce(() => { S.review.text = $("r-text").value.trim().toLowerCase(); S.review.limit = 200; renderReview(); }, 150);
    $("more").onclick = () => { S.review.limit += 500; renderReview(); };
    $("export").onclick = exportReview;
    $("coverage").onclick = (e) => {
      const td = e.target.closest("td[data-ci]"); if (!td) return;
      if (td.dataset.type) { S.types = new Set([td.dataset.type]); } else S.types.clear();
      setReview(td.dataset.ci === "land" ? "no_land" : "missing", td.dataset.ci === "land" ? "" : td.dataset.ci);
      filtersChanged();
      $("review").closest(".card").scrollIntoView({ behavior: "smooth" });
    };
    $("issue-summary").onclick = (e) => {
      const b = e.target.closest("button[data-issue]"); if (!b) return;
      setReview(b.dataset.issue, b.dataset.ci); renderReview();
      $("review").closest(".card").scrollIntoView({ behavior: "smooth" });
    };
    $("review").onclick = (e) => { const b = e.target.closest("button[data-go]"); if (b) goToIssue(+b.dataset.go, +b.dataset.ci); };
    $("dist").onclick = (e) => { const t = e.target.closest("[data-v]"); if (!t) return; S.ci = S.distCi; $("cat").value = S.ci; S.val = +t.dataset.v; location.hash = "#map"; };

    // shared tooltip for [data-tip]
    const tip = $("tip");
    document.addEventListener("mouseover", (e) => { const el = e.target.closest("[data-tip]"); if (!el) { tip.hidden = true; return; } tip.innerHTML = el.dataset.tip; tip.hidden = false; });
    document.addEventListener("mousemove", (e) => { if (!tip.hidden) { tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + "px"; tip.style.top = (e.clientY + 16) + "px"; } });
    renderValues();
  }
  function setReview(issue, ci) {
    // "conflict"/"improved" are summary groups; map to a concrete issue filter where possible
    const map1 = { conflict: "", improved: "improved_no_utility" };
    S.review.issue = issue in map1 ? map1[issue] : issue;
    S.review.group = issue === "conflict" ? "conflict" : "";
    S.review.ci = ci ?? ""; S.review.limit = 200;
    $("r-issue").value = S.review.issue; $("r-cat").value = S.review.ci;
  }

  // ------------------------------------------------------------------ value list
  function valueCounts(ci) {
    const counts = new Map(); let noVal = 0, noLand = 0, noLandOk = 0;
    for (const a of A) {
      if (!acctPass(a)) continue;
      if (!a.hasLand) { landExpected(a) ? noLand++ : noLandOk++; continue; }
      const vs = a.attrs[ci];
      if (!vs.length) noVal++;
      for (const v of vs) counts.set(v, (counts.get(v) || 0) + 1);
    }
    return { counts, noVal, noLand, noLandOk };
  }
  let visibleVals = [];
  function renderValues() {
    const ci = S.ci; const { counts, noVal, noLand, noLandOk } = valueCounts(ci);
    const items = VALUES[ci].map((name, v) => [v, name, counts.get(v) || 0]).filter((x) => x[2] > 0 || x[0] === S.val);
    items.sort((x, y) => y[2] - x[2]);
    const specials = [[NO_VALUE, "No value recorded", noVal], [NO_LAND, "No land record", noLand], [NO_LAND_OK, "Mobile home / condo (no land line)", noLandOk]];
    const q = S.valueText;
    const all = [...items, ...specials].filter(([v, name]) => !q || name.toLowerCase().includes(q) || v === S.val);
    visibleVals = all.map((x) => x[0]);
    if (!visibleVals.includes(S.val) && visibleVals.length) S.val = visibleVals[0];
    $("values").innerHTML = all.map(([v, name, n]) =>
      `<li data-v="${v}" role="option" class="${v === S.val ? "on" : ""}${v < 0 ? " special" : ""}" aria-selected="${v === S.val}"><span>${esc(v < 0 ? "— " + name : name)}</span><span class="n">${fmt(n)}</span></li>`).join("");
    const on = $("values").querySelector("li.on"); if (on) on.scrollIntoView({ block: "nearest" });
  }
  function selectValue(v) { S.val = v; renderValues(); applyHighlight(); writeHash(); }
  function flip(d) {
    if (!visibleVals.length) return;
    const i = visibleVals.indexOf(S.val);
    selectValue(visibleVals[(i + d + visibleVals.length) % visibleVals.length]);
  }
  const accountMatches = (a, ci, v) => v === NO_LAND ? !a.hasLand && landExpected(a) : v === NO_LAND_OK ? !a.hasLand && !landExpected(a) : !a.hasLand ? false : v === NO_VALUE ? a.attrs[ci].length === 0 : a.attrs[ci].includes(v);

  // ------------------------------------------------------------------ map
  function initMap() {
    const sources = {}, layers = [];
    for (const [k, b] of Object.entries(BASEMAPS)) {
      sources["bm-" + k] = { type: "raster", tiles: b.tiles, tileSize: 256, attribution: b.attribution, maxzoom: b.maxzoom || 19 };
      layers.push({ id: "bm-" + k, type: "raster", source: "bm-" + k, layout: { visibility: "none" } });
    }
    map = new maplibregl.Map({
      container: "map",
      style: { version: 8, sources, layers },
      bounds: [[-107.95, 38.15], [-106.25, 39.25]],
      fitBoundsOptions: { padding: 20 },
      maxZoom: 19, attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-left");
    map.on("load", () => {
      map.addSource("parcels", { type: "geojson", data: "data/parcels.geojson", tolerance: 0.25, buffer: 32 });
      map.addLayer({ id: "parcels-fill", type: "fill", source: "parcels", paint: {} });
      map.addLayer({ id: "parcels-line", type: "line", source: "parcels", paint: {} });
      map.addLayer({ id: "parcels-flag", type: "line", source: "parcels", paint: {
        "line-color": "#d03b3b", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.2, 15, 2.6],
        "line-opacity": ["case", ["boolean", ["feature-state", "f"], false], 1, 0] } });
      map.addLayer({ id: "parcels-sel", type: "line", source: "parcels", paint: {
        "line-color": prefersDark ? "#ffffff" : "#0b0b0b", "line-width": 3,
        "line-opacity": ["case", ["boolean", ["feature-state", "sel"], false], 1, 0] } });
      setBasemap(S.basemap);
      const ready = () => {
        if (mapReady || !map.isSourceLoaded("parcels")) return;
        mapReady = true; $("loading").hidden = true; prevH = null; prevF = null;
        map.off("sourcedata", ready);
        applyHighlight();
        for (const fn of whenReady.splice(0)) fn();
      };
      map.on("sourcedata", ready);
    });

    const tipEl = $("hover-tip"); let pending = null;
    map.on("mousemove", "parcels-fill", (e) => {
      map.getCanvas().style.cursor = "pointer";
      pending = e; requestAnimationFrame(() => {
        if (!pending) return; const ev = pending; pending = null;
        const fp = ev.features[0].id; const accts = fpAccts[fp] || [];
        const a = A[accts[0]];
        let html = a ? `<strong>${esc(a.address || a.account)}</strong>` : `<strong>Parcel ${esc(GEO[fp][1][0] || "")}</strong>`;
        if (accts.length > 1) html += ` <span class="m">+${accts.length - 1} more account${accts.length > 2 ? "s" : ""}</span>`;
        if (a) {
          const vs = a.hasLand ? a.attrs[S.ci].map((v) => VALUES[S.ci][v]) : null;
          html += `<div class="m">${esc(CATS[S.ci].label)}: ${esc(vs == null ? (landExpected(a) ? "no land record" : noLandKind(a).toLowerCase() + ", no land line") : vs.length ? vs.join(", ") : "—")}</div>`;
        } else html += `<div class="m">No account in current data</div>`;
        tipEl.innerHTML = html; tipEl.hidden = false;
        const { x, y } = ev.point; const w = map.getCanvas().clientWidth;
        tipEl.style.left = Math.min(x + 14, w - tipEl.offsetWidth - 6) + "px"; tipEl.style.top = (y + 14) + "px";
      });
    });
    map.on("mouseleave", "parcels-fill", () => { map.getCanvas().style.cursor = ""; tipEl.hidden = true; pending = null; });
    map.on("click", "parcels-fill", (e) => openDetail(e.features[0].id));
  }

  function setBasemap(bm) {
    S.basemap = bm;
    document.querySelectorAll("#basemap button").forEach((b) => b.classList.toggle("on", b.dataset.bm === bm));
    if (!map || !map.getLayer("parcels-fill")) return;
    const real = bm === "light" && prefersDark ? "dark" : bm;
    for (const k of Object.keys(BASEMAPS)) map.setLayoutProperty("bm-" + k, "visibility", k === real ? "visible" : "none");
    const onImagery = bm === "aerial";
    const dark = real === "dark";
    const hl = onImagery ? "rgba(85,152,231,0.72)" : dark ? "rgba(57,135,229,0.68)" : "rgba(42,120,214,0.60)";
    const hlLine = onImagery ? "#cde2fb" : dark ? "#9ec5f4" : "#184f95";
    const other = onImagery ? "rgba(255,255,255,0.10)" : dark ? "rgba(200,200,190,0.10)" : "rgba(120,120,115,0.16)";
    const line = onImagery ? "rgba(255,255,255,0.55)" : dark ? "rgba(200,200,190,0.35)" : "rgba(95,95,90,0.45)";
    const h = ["coalesce", ["feature-state", "h"], 0];
    map.setPaintProperty("parcels-fill", "fill-color", ["match", h, 2, hl, 1, other, "rgba(0,0,0,0)"]);
    map.setPaintProperty("parcels-line", "line-color", ["match", h, 2, hlLine, line]);
    map.setPaintProperty("parcels-line", "line-width", ["interpolate", ["linear"], ["zoom"], 8, ["match", h, 2, 0.6, 0.15], 13, ["match", h, 2, 1, 0.5], 17, ["match", h, 2, 1.6, 1.1]]);
    map.setPaintProperty("parcels-sel", "line-color", onImagery || dark ? "#ffffff" : "#0b0b0b");
    document.documentElement.style.setProperty("--hl", hl.replace(/[\d.]+\)$/, "0.85)"));
  }

  let lastMatchFps = [];
  function applyHighlight() {
    const ci = S.ci, v = S.val;
    const H = new Uint8Array(GEO.length);
    let nAcct = 0; const fps = [];
    A.forEach((a) => {
      if (!acctPass(a)) return;
      const m = accountMatches(a, ci, v);
      if (m) nAcct++;
      if (a.fp < 0) return;
      if (m) { if (H[a.fp] !== 2) fps.push(a.fp); H[a.fp] = 2; }
      else if (a.hasLand && H[a.fp] === 0) H[a.fp] = 1;
    });
    lastMatchFps = fps;
    if (mapReady) {
      for (let i = 0; i < H.length; i++) if (!prevH || prevH[i] !== H[i]) map.setFeatureState({ source: "parcels", id: i }, { h: H[i] });
      prevH = H;
    }
    const unmapped = nAcct - A.filter((a) => a.fp >= 0 && acctPass(a) && accountMatches(a, ci, v)).length;
    $("summary").innerHTML = `<div><strong>${fmt(nAcct)}</strong> account${nAcct === 1 ? "" : "s"} on <strong>${fmt(fps.length)}</strong> parcel${fps.length === 1 ? "" : "s"}</div>
      <div>${esc(CATS[ci].label)} · ${esc(valName(ci, v))}${unmapped ? ` · ${fmt(unmapped)} not on map` : ""}</div>
      <div class="actions"><button class="linkbtn" id="zoom-hl" ${fps.length ? "" : "disabled"}>Zoom to these</button><button class="linkbtn" id="dl-hl" ${nAcct ? "" : "disabled"}>Download list</button><button class="linkbtn" id="zoom-all">Whole county</button></div>`;
    $("zoom-hl").onclick = () => zoomToFps(lastMatchFps);
    $("zoom-all").onclick = () => map.fitBounds([[-107.95, 38.15], [-106.25, 39.25]], { padding: 20 });
    $("dl-hl").onclick = () => {
      const rows = A.filter((a) => acctPass(a) && accountMatches(a, ci, v)).map((a) => [a.account, a.parcel, a.type, a.address, a.area, a.subdivision, a.hasLand ? a.attrs[ci].map((x) => VALUES[ci][x]).join("; ") : ""]);
      downloadCSV(`${CATS[ci].key}_${valName(ci, v).replace(/[^a-z0-9]+/gi, "_")}.csv`, ["account", "parcel", "account_type", "address", "area", "subdivision", CATS[ci].label], rows);
    };
    applyFlags();
    if (selFp >= 0 && !$("detail").hidden) openDetail(selFp, false, true);
  }

  function applyFlags() {
    if (!mapReady) return;
    const F = new Uint8Array(GEO.length);
    if (S.showFlags) {
      const ci = S.ci;
      A.forEach((a) => { if (a.fp >= 0 && acctPass(a) && a.flags.some((f) => f[0] === ci && f[1] !== "missing")) F[a.fp] = 1; });
      for (const o of outliers) if (o.ci === ci) { const a = A[o.a]; if (a.fp >= 0 && acctPass(a)) F[a.fp] = 1; }
    }
    for (let i = 0; i < F.length; i++) if (!prevF || prevF[i] !== F[i]) map.setFeatureState({ source: "parcels", id: i }, { f: !!F[i] });
    prevF = F;
  }

  function zoomToFps(fps, maxZoom = 16) {
    if (!fps.length || !map) return;
    if (!fps.some((f) => GEO[f][2])) return;
    let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
    for (const f of fps) { const b = GEO[f][2]; if (!b) continue; x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
    const detailOpen = !$("detail").hidden && innerWidth > 760;
    map.fitBounds([[x0, y0], [x1, y1]], { padding: { top: 40, bottom: 40, left: 40, right: detailOpen ? 400 : 40 }, maxZoom, duration: 700 });
  }
  const zoomToAccounts = (accts) => zoomToFps([...new Set(accts.filter((a) => a.fp >= 0).map((a) => a.fp))], 15);

  // ------------------------------------------------------------------ detail card
  function setSel(fp) {
    if (!mapReady) return;
    if (selFp >= 0) map.setFeatureState({ source: "parcels", id: selFp }, { sel: false });
    selFp = fp;
    if (fp >= 0) map.setFeatureState({ source: "parcels", id: fp }, { sel: true });
  }
  function closeDetail() { $("detail").hidden = true; setSel(-1); }
  function openDetail(fp, showAll = false, keep = false, focusAcct = -1) {
    setSel(fp);
    let accts = fpAccts[fp] || [];
    if (focusAcct >= 0) accts = [focusAcct, ...accts.filter((i) => i !== focusAcct)];
    const LIMIT = 12;
    const shown = showAll ? accts : accts.slice(0, LIMIT);
    const parcels = GEO[fp][1];
    let html = "";
    if (!accts.length) {
      html = `<h3>Parcel ${esc(parcels.join(", ") || "—")}</h3><div class="meta">No account in the current data download matches this parcel.${GEO[fp][0].length ? ` Shapefile account: ${esc(GEO[fp][0].join(", "))}` : ""}</div>`;
    } else if (accts.length > 1) {
      html += `<div class="meta">${fmt(accts.length)} accounts share this parcel shape</div>`;
    }
    html += shown.map((i) => acctHTML(i)).join("");
    if (!showAll && accts.length > LIMIT) html += `<div class="more-accts"><button class="linkbtn" data-show-all="${fp}">Show all ${fmt(accts.length)} accounts</button></div>`;
    const body = $("detail-body"); const scroll = keep ? $("detail").scrollTop : 0;
    body.innerHTML = html; $("detail").hidden = false; $("detail").scrollTop = scroll;
  }
  function acctHTML(i) {
    const a = A[i];
    const rows = [];
    if (a.hasLand) {
      CATS.forEach((c, ci) => {
        const vs = a.attrs[ci];
        if (!vs.length && !D.core.includes(c.key) && ci !== S.ci) return;
        const cell = vs.length ? vs.map((v) => `<button class="linkbtn" data-pick="${ci}:${v}" title="Show on map">${esc(VALUES[ci][v])}</button>`).join(", ")
                               : `<button class="linkbtn empty" data-pick="${ci}:${NO_VALUE}" title="Show accounts missing this">—</button>`;
        rows.push(`<tr class="${ci === S.ci ? "cur" : ""}"><td>${esc(c.label)}</td><td>${cell}</td></tr>`);
      });
    }
    const issues = issuesFor(i);
    return `<div class="acct">
      <h3><a href="${RECORD_URL(a.account)}" target="_blank" rel="noopener">${esc(a.account)}</a> <span class="meta">· ${esc(a.type)}${a.improvedType && a.improvedType !== a.type ? " · " + esc(a.improvedType) : ""}</span></h3>
      <div class="meta">${esc(a.address || "No situs address")}${a.area ? " · " + esc(a.area) : ""}<br>
        Parcel ${esc(a.parcel || "—")}${a.subdivision ? " · " + esc(a.subdivision) : ""}${a.condo ? " · " + esc(a.condo) : ""}<br>
        ${a.landSize ? "Land " + esc(a.landSize) + " · " : ""}${D.valueYear || ""} actual: land ${money(a.landValue)}, impr. ${money(a.impValue)}, total ${money(a.totalValue)}</div>
      ${a.hasLand ? `<table>${rows.join("")}</table>` : `<div class="empty">${landExpected(a) ? "No row in the Land Attributes download." : noLandKind(a) + " — no land line expected."}</div>`}
      ${issues.length ? `<ul class="flags">${issues.map((x) => `<li>⚠ <strong>${esc(x.cat)}</strong> — ${esc(ISSUES[x.code].label)}${x.detail ? ": " + esc(x.detail) : ""}</li>`).join("")}</ul>` : ""}
    </div>`;
  }

  // ------------------------------------------------------------------ neighborhood consistency
  function computeOutliers() {
    const cis = NEIGHBOR_CATS.map((k) => CAT_IX[k]).filter((x) => x != null);
    const { basis, min, agree } = S.nb;
    outliers = []; consensus = new Map();
    const keyOf = (a, ci) => a.attrs[ci].slice().sort((x, y) => x - y).join("|");

    const judge = (i, ci, counts, total) => {
      if (total < min) return;
      let top = null, topN = 0;
      for (const [k, n] of counts) if (n > topN) { top = k; topN = n; }
      const share = topN / total;
      if (share < agree) return;
      const own = keyOf(A[i], ci);
      if (own === "") consensus.set(i + "|" + ci, { top, agree: topN, n: total });
      else if (own !== top) outliers.push({ a: i, ci, own, top, agree: topN, n: total });
    };

    // Utilities legitimately differ between vacant and built lots ("TO SITE" vs "INSTALLED"),
    // so for those attributes compare improved accounts only with improved ones, vacant with vacant.
    const utilCis = new Set(["electricity", "sewer", "water"].map((k) => CAT_IX[k]));
    const improved = (j) => (A[j].impValue || 0) > 0;

    if (basis === "adjacent") {
      A.forEach((a, i) => {
        if (!a.hasLand || a.fp < 0) return;
        const comps = [];
        for (const f of [a.fp, ...GEO[a.fp][3]]) for (const j of fpAccts[f]) if (j !== i && A[j].hasLand) comps.push(j);
        if (comps.length < min) return;
        const imp = improved(i);
        for (const ci of cis) {
          const counts = new Map(); let total = 0;
          const util = utilCis.has(ci);
          for (const j of comps) {
            if (util && improved(j) !== imp) continue;
            const k = keyOf(A[j], ci); if (k === "") continue; counts.set(k, (counts.get(k) || 0) + 1); total++;
          }
          judge(i, ci, counts, total);
        }
      });
    } else {
      const groups = new Map();
      A.forEach((a, i) => { if (a.hasLand && a.subdivision) (groups.get(a.subdivision) || groups.set(a.subdivision, []).get(a.subdivision)).push(i); });
      for (const all of groups.values()) {
        if (all.length <= min) continue;
        for (const ci of cis) for (const members of utilCis.has(ci) ? [all.filter(improved), all.filter((j) => !improved(j))] : [all]) {
          const counts = new Map(); let total = 0;
          const keys = members.map((i) => keyOf(A[i], ci));
          keys.forEach((k) => { if (k !== "") { counts.set(k, (counts.get(k) || 0) + 1); total++; } });
          members.forEach((i, m) => {
            const own = keys[m];
            if (own !== "") { counts.set(own, counts.get(own) - 1); total--; }
            judge(i, ci, counts, total);
            if (own !== "") { counts.set(own, counts.get(own) + 1); total++; }
          });
        }
      }
    }
  }
  const basisWord = () => (S.nb.basis === "adjacent" ? "neighbors" : "subdivision accounts");
  function issuesFor(i) {
    const a = A[i]; const out = [];
    if (!a.hasLand && landExpected(a)) out.push({ code: "no_land", ci: -1, cat: "Land record", detail: a.improvedType ? a.improvedType : "" });
    if (a.fp < 0) out.push({ code: "unmapped", ci: -1, cat: "Map", detail: a.parcel ? "parcel " + a.parcel : "" });
    for (const [ci, code, detail] of a.flags) {
      let d = detail;
      if (code === "missing") {
        const c = consensus.get(i + "|" + ci);
        if (c) d = `${c.agree} of ${c.n} ${basisWord()} have ${keyName(ci, c.top)}`;
      }
      out.push({ code, ci, cat: CATS[ci].label, detail: d });
    }
    for (const o of outliersByAcct().get(i) || []) {
      out.push({ code: "outlier", ci: o.ci, cat: CATS[o.ci].label, detail: `this: ${keyName(o.ci, o.own)} · ${o.agree} of ${o.n} ${basisWord()}: ${keyName(o.ci, o.top)}` });
    }
    return out;
  }
  let _obA = null, _obSrc = null;
  function outliersByAcct() {
    if (_obSrc === outliers) return _obA;
    _obA = new Map(); for (const o of outliers) (_obA.get(o.a) || _obA.set(o.a, []).get(o.a)).push(o);
    _obSrc = outliers; return _obA;
  }

  // ------------------------------------------------------------------ stats page
  function renderStats() {
    if (!D) return;
    renderChips($("s-type-chips")); $("s-area").value = S.area;
    const acc = A.map((a, i) => i).filter((i) => acctPass(A[i]));
    const land = acc.filter((i) => A[i].hasLand);
    const expected = acc.filter((i) => landExpected(A[i]));
    const expectedWith = expected.filter((i) => A[i].hasLand).length;
    const coreCis = D.core.map((k) => CAT_IX[k]);
    const missingAny = land.filter((i) => coreCis.some((ci) => !A[i].attrs[ci].length)).length;
    const conflictCodes = new Set(["multiple", "conflict", "repeated", "same_as_primary"]);
    const conflictAccts = acc.filter((i) => A[i].flags.some((f) => conflictCodes.has(f[1]))).length;
    const ob = outliersByAcct();
    const outAccts = acc.filter((i) => ob.has(i)).length;
    const unmapped = acc.filter((i) => A[i].fp < 0).length;
    const tiles = [
      [fmt(acc.length), "Accounts", S.types.size || S.area ? "in current filter" : "all accounts"],
      [pct(expectedWith, expected.length).toFixed(1) + "%", "Have a land record", `${fmt(expected.length - expectedWith)} without · ${fmt(acc.length - expected.length)} mobile home / condo excluded`],
      [fmt(missingAny), "Missing a core attribute", `${pct(missingAny, land.length).toFixed(1)}% of land records`],
      [fmt(conflictAccts), "Data-entry conflicts", "multiple / conflicting / repeated"],
      [fmt(outAccts), "Differ from neighbors", `≥${Math.round(S.nb.agree * 100)}% of ${S.nb.min}+ ${basisWord()} agree`],
      [fmt(unmapped), "Not on parcel map", "no matching polygon"],
    ];
    $("tiles").innerHTML = tiles.map(([v, l, s]) => `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div><div class="s">${s}</div></div>`).join("");
    renderCoverage(acc);
    renderIssueSummary(acc);
    renderDist();
    renderReview();
  }

  function seqColor(p) {
    const steps = ["--seq-100", "--seq-200", "--seq-300", "--seq-400", "--seq-500", "--seq-600"];
    const i = p >= 98 ? 5 : p >= 90 ? 4 : p >= 75 ? 3 : p >= 50 ? 2 : p >= 25 ? 1 : 0;
    return [`var(${steps[i]})`, i >= 3 ? "#fff" : "#0b0b0b"];
  }
  function renderCoverage(acc) {
    const types = typesList.map((t) => t[0]).filter((t) => acc.some((i) => A[i].type === t));
    const cols = [...types.map((t) => [t, (i) => A[i].type === t]), ["All", () => true]];
    const coreCis = D.core.map((k) => CAT_IX[k]).concat([CAT_IX.land_secondary, CAT_IX.unique].filter((x) => x != null));
    const cell = (ids, has, ci, t) => {
      if (!ids.length) return `<td class="c">—</td>`;
      const n = ids.filter(has).length, p = pct(n, ids.length); const [bg, fg] = seqColor(p);
      return `<td class="c" style="background:${bg};color:${fg}" data-ci="${ci}" ${t === "All" ? "" : `data-type="${esc(t)}"`} data-tip="<strong>${esc(t)}</strong><br>${fmt(n)} of ${fmt(ids.length)} have it<br>${fmt(ids.length - n)} missing — click to list">${p.toFixed(p > 99 && p < 100 ? 1 : 0)}%</td>`;
    };
    const byCol = cols.map(([, f]) => acc.filter(f));
    let html = `<thead><tr><th>Attribute</th>${cols.map(([t], k) => `<th class="c">${esc(t)}<br><span style="font-weight:400;text-transform:none">${fmt(byCol[k].length)}</span></th>`).join("")}</tr></thead><tbody>`;
    html += `<tr><td>Has land record <span style="color:var(--muted)">(excl. mobile homes &amp; condos)</span></td>${cols.map(([t], k) => cell(byCol[k].filter((i) => landExpected(A[i])), (i) => A[i].hasLand, "land", t)).join("")}</tr>`;
    for (const ci of coreCis) {
      const optional = !D.core.includes(CATS[ci].key);
      html += `<tr><td>${esc(CATS[ci].label)}${optional ? ` <span style="color:var(--muted)">(optional)</span>` : ""}</td>${cols.map(([t], k) => cell(byCol[k].filter((i) => A[i].hasLand), (i) => A[i].attrs[ci].length > 0, ci, t)).join("")}</tr>`;
    }
    $("coverage").innerHTML = html + "</tbody>";
  }

  function renderIssueSummary(acc) {
    const accSet = new Set(acc);
    const counts = new Map(); // ci -> {group: n}
    const bump = (ci, g) => { const r = counts.get(ci) || counts.set(ci, {}).get(ci); r[g] = (r[g] || 0) + 1; };
    for (const i of acc) for (const [ci, code] of A[i].flags) bump(ci, ISSUES[code].group);
    for (const o of outliers) if (accSet.has(o.a)) bump(o.ci, "outlier");
    const cis = CATS.map((c, ci) => ci).filter((ci) => counts.has(ci));
    const colMax = Object.fromEntries(ISSUE_COLS.map(([g]) => [g, Math.max(1, ...cis.map((ci) => counts.get(ci)[g] || 0))]));
    let html = `<thead><tr><th>Attribute</th>${ISSUE_COLS.map(([g, l]) => `<th class="num">${l}</th>`).join("")}</tr></thead><tbody>`;
    for (const ci of cis) {
      const r = counts.get(ci);
      html += `<tr><td>${esc(CATS[ci].label)}</td>${ISSUE_COLS.map(([g]) => {
        const n = r[g] || 0;
        return `<td class="num">${n ? `<div class="bar-cell"><button class="linkbtn" data-issue="${g}" data-ci="${ci}">${fmt(n)}</button><span class="b" style="width:${Math.max(2, 60 * n / colMax[g])}px"></span></div>` : `<span style="color:var(--muted)">—</span>`}</td>`;
      }).join("")}</tr>`;
    }
    $("issue-summary").innerHTML = html + "</tbody>";
  }

  function renderDist() {
    const ci = S.distCi; const { counts, noVal } = valueCounts(ci);
    const landN = A.filter((a) => acctPass(a) && a.hasLand).length;
    let items = [...counts.entries()].sort((x, y) => y[1] - x[1]);
    const MAX = 40; const extra = items.length - MAX; items = items.slice(0, MAX);
    const max = Math.max(1, noVal, ...items.map((x) => x[1]));
    const bar = (v, name, n, muted) => `<div class="name" title="${esc(name)}">${esc(name)}</div>
      <div class="track" data-v="${v}" data-tip="<strong>${esc(name)}</strong><br>${fmt(n)} accounts · ${pct(n, landN).toFixed(1)}% of land records<br>Click to view on map" style="cursor:pointer">
      <span class="fill" style="width:${(78 * n / max).toFixed(2)}%;${muted ? "background:var(--axis)" : ""}"></span><span class="val">${fmt(n)}</span></div>`;
    $("dist").innerHTML = items.map(([v, n]) => bar(v, VALUES[ci][v], n)).join("") + bar(NO_VALUE, "No value recorded", noVal, true) +
      (extra > 0 ? `<div></div><div class="val" style="color:var(--muted)">+ ${extra} more values (see the map's value list)</div>` : "");
  }

  function reviewRows() {
    const { issue, ci, text, group } = S.review;
    const rows = [];
    A.forEach((a, i) => {
      if (!acctPass(a)) return;
      for (const x of issuesFor(i)) {
        if (issue && x.code !== issue) continue;
        if (!issue && group && ISSUES[x.code].group !== group) continue;
        if (ci !== "" && x.ci !== +ci) continue;
        rows.push([i, x]);
      }
    });
    if (!text) return rows;
    return rows.filter(([i, x]) => { const a = A[i]; return (a.account + " " + a.parcel + " " + a.address + " " + a.subdivision + " " + a.area + " " + x.cat + " " + x.detail + " " + ISSUES[x.code].label).toLowerCase().includes(text); });
  }
  function renderReview() {
    const rows = reviewRows();
    const shown = rows.slice(0, S.review.limit);
    $("review-count").textContent = `${fmt(rows.length)} issue${rows.length === 1 ? "" : "s"} across ${fmt(new Set(rows.map((r) => r[0])).size)} accounts${S.review.group === "conflict" && !S.review.issue ? " (all data-conflict types)" : ""}.`;
    $("review").innerHTML = `<thead><tr><th>Account</th><th>Type</th><th>Area</th><th>Subdivision / address</th><th>Attribute</th><th>Issue</th><th>Detail</th><th></th></tr></thead><tbody>` +
      shown.map(([i, x]) => { const a = A[i]; return `<tr>
        <td class="nw"><a href="${RECORD_URL(a.account)}" target="_blank" rel="noopener">${esc(a.account)}</a></td>
        <td class="nw">${esc(a.type)}</td><td>${esc(a.area)}</td>
        <td>${esc(a.subdivision || a.address)}</td><td>${esc(x.cat)}</td>
        <td class="code" data-tip="${esc(ISSUES[x.code].about)}">${esc(ISSUES[x.code].label)}</td><td>${esc(x.detail)}</td>
        <td class="nw">${a.fp >= 0 ? `<button class="linkbtn" data-go="${i}" data-ci="${x.ci}">Map →</button>` : ""}</td></tr>`; }).join("") + "</tbody>";
    $("more").hidden = rows.length <= shown.length;
    $("more").textContent = `Show more (${fmt(rows.length - shown.length)} remaining)`;
  }
  function exportReview() {
    const rows = reviewRows().map(([i, x]) => { const a = A[i]; return [a.account, a.parcel, a.type, a.improvedType, a.address, a.area, a.subdivision, x.cat, ISSUES[x.code].label, x.detail, RECORD_URL(a.account)]; });
    downloadCSV("land_attribute_review.csv", ["account", "parcel", "account_type", "improved_type", "address", "area", "subdivision", "attribute", "issue", "detail", "county_record"], rows);
  }
  function goToIssue(i, ci) {
    const a = A[i];
    if (ci >= 0) { S.ci = ci; S.val = a.hasLand && a.attrs[ci].length ? a.attrs[ci][0] : NO_VALUE; }
    else { S.val = a.hasLand ? S.val : landExpected(a) ? NO_LAND : NO_LAND_OK; }
    $("cat").value = S.ci; S.valueText = ""; $("value-filter").value = "";
    location.hash = "#map";
    setTimeout(() => { focusAccount(i); }, 50);
  }
  function focusAccount(i) {
    const a = A[i];
    if (a.fp < 0) return;
    const go = () => { openDetail(a.fp, false, false, i); zoomToFps([a.fp], 17); };
    mapReady ? go() : whenReady.push(go);
  }

  // ------------------------------------------------------------------ about page
  function renderAbout() {
    const nLand = A.filter((a) => a.hasLand).length;
    $("about-data").innerHTML = [
      ["Data built", D.generated],
      ["Land attributes", D.sources.land],
      ["General account info", D.sources.general],
      ["Values", D.sources.values + (D.valueYear ? ` (${D.valueYear} actual values)` : "")],
      ["Accounts", `${fmt(A.length)} (${fmt(nLand)} with a land record)`],
      ["Parcel shapes", `${fmt(GEO.length)} (from the county tax-parcel shapefile)`],
    ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
    $("about-checks").innerHTML = Object.values(ISSUES).map((x) => `<li><strong>${esc(x.label)}</strong> — ${esc(x.about)}</li>`).join("");
  }

  // ------------------------------------------------------------------ search
  let index = null;
  function buildIndex() {
    index = [];
    A.forEach((a, i) => index.push({ kind: "Account", label: a.account, sub: [a.address, a.type].filter(Boolean).join(" · "), text: `${a.account} ${a.parcel} ${a.parcel.replace(/\D/g, "")} ${a.address}`.toLowerCase(), i }));
    const subs = new Map();
    A.forEach((a, i) => { if (a.subdivision && a.fp >= 0) (subs.get(a.subdivision) || subs.set(a.subdivision, []).get(a.subdivision)).push(i); });
    for (const [s, ids] of subs) index.push({ kind: "Subdivision", label: s, sub: `${ids.length} accounts`, text: s.toLowerCase(), ids });
    for (const ar of areasList) index.push({ kind: "Area", label: ar, sub: "", text: ar.toLowerCase(), area: ar });
  }
  function initSearch() {
    const inp = $("search"), ul = $("search-results"); let results = [], on = 0;
    const run = () => {
      if (!index) buildIndex();
      const q = inp.value.trim().toLowerCase();
      if (q.length < 2) { ul.hidden = true; return; }
      const qd = q.replace(/[-\s]/g, "");
      const scored = [];
      for (const e of index) {
        let s = -1;
        if (e.label.toLowerCase() === q) s = 0;
        else if (e.label.toLowerCase().startsWith(q)) s = 1;
        else if (/^\d{4,}$/.test(qd) && e.kind === "Account" && e.text.includes(qd)) s = 1;
        else if (e.text.includes(q)) s = e.kind === "Account" ? 3 : 2;
        if (s >= 0) scored.push([s, e]);
        if (scored.length > 400) break;
      }
      scored.sort((x, y) => x[0] - y[0] || (x[1].kind === "Account") - (y[1].kind === "Account"));
      results = scored.slice(0, 12).map((x) => x[1]); on = 0;
      ul.innerHTML = results.length ? results.map((e, k) => `<li data-k="${k}" class="${k === 0 ? "on" : ""}"><span class="k">${e.kind}</span>${esc(e.label)} <span class="s">${esc(e.sub)}</span></li>`).join("") : `<li class="s">No matches</li>`;
      ul.hidden = false;
    };
    const pick = (e) => {
      ul.hidden = true; inp.blur();
      if (location.hash.slice(1).split("?")[0] !== "map") location.hash = "#map";
      setTimeout(() => {
        if (e.kind === "Account") focusAccount(e.i);
        else if (e.kind === "Subdivision") zoomToAccounts(e.ids.map((i) => A[i]));
        else { S.area = e.area; filtersChanged(); zoomToAccounts(A.filter((a) => a.area === e.area)); }
      }, 30);
    };
    inp.addEventListener("input", debounce(run, 90));
    inp.addEventListener("focus", run);
    inp.addEventListener("keydown", (ev) => {
      const lis = ul.querySelectorAll("li[data-k]");
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { on = (on + (ev.key === "ArrowDown" ? 1 : -1) + lis.length) % Math.max(1, lis.length); lis.forEach((l, k) => l.classList.toggle("on", k === on)); ev.preventDefault(); }
      if (ev.key === "Enter" && results[on]) pick(results[on]);
      if (ev.key === "Escape") ul.hidden = true;
    });
    ul.addEventListener("mousedown", (ev) => { const li = ev.target.closest("li[data-k]"); if (li) { ev.preventDefault(); pick(results[+li.dataset.k]); } });
    inp.addEventListener("blur", () => setTimeout(() => (ul.hidden = true), 150));
  }
})();
