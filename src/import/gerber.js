// Gerber RS-274X (incl. aperture macros, arcs, regions, X2 attributes) and Excellon drill readers.
// Output in mm, CAD frame (Y up). Callers flip Y for display.
globalThis.ImpGerber = (() => {
  const G = Geom;

  // ---------- aperture macro expressions ----------
  function evalExpr(expr, vars) {
    const s = expr.replace(/\s+/g, "").replace(/\$(\d+)/g, (m, k) => `(${vars[+k] ?? 0})`).replace(/x/gi, "*");
    if (!/^[-+*/().\d eE]*$/.test(s)) return 0;
    try { return Function(`"use strict";return (${s || 0});`)(); } catch (e) { return 0; }
  }
  // macro body → function(params) → polygons (local, Y up)
  function compileMacro(body) {
    const stmts = body.split("*").map(x => x.trim()).filter(Boolean);
    return params => {
      const vars = {}; params.forEach((v, i) => vars[i + 1] = v);
      const polys = [];
      for (const st of stmts) {
        if (/^0/.test(st) && !/^0\./.test(st)) continue; // comment
        const asg = st.match(/^\$(\d+)\s*=\s*(.+)$/);
        if (asg) { vars[+asg[1]] = evalExpr(asg[2], vars); continue; }
        const a = st.split(",").map(t => evalExpr(t, vars));
        const code = a[0], on = a[1] !== 0;
        let poly = null, rot = 0;
        if (code === 1) { poly = G.circ(a[3] || 0, a[4] || 0, a[2] / 2, 20); rot = a[5] || 0; }
        else if (code === 20 || code === 2) { const w = a[2], x1 = a[3], y1 = a[4], x2 = a[5], y2 = a[6]; rot = a[7] || 0; const L = Math.hypot(x2 - x1, y2 - y1) || 1e-9, nx = -(y2 - y1) / L * w / 2, ny = (x2 - x1) / L * w / 2; poly = [[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]]; }
        else if (code === 21) { const w = a[2], h = a[3], cx = a[4], cy = a[5]; rot = a[6] || 0; poly = G.rect(w, h).map(([x, y]) => [x + cx, y + cy]); }
        else if (code === 22) { const w = a[2], h = a[3], x = a[4], y = a[5]; rot = a[6] || 0; poly = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]; }
        else if (code === 4) { const n = a[2]; poly = []; for (let k = 0; k <= n; k++) poly.push([a[3 + 2 * k], a[4 + 2 * k]]); rot = a[5 + 2 * n] || 0; }
        else if (code === 5) { const n = a[2], cx = a[3], cy = a[4], d = a[5]; rot = a[6] || 0; poly = Array.from({ length: n }, (_, k) => [cx + d / 2 * Math.cos(2 * Math.PI * k / n), cy + d / 2 * Math.sin(2 * Math.PI * k / n)]); }
        else if (code === 6) { poly = G.circ(a[1], a[2], a[3] / 2, 20); rot = a[9] || 0; }
        else if (code === 7) { poly = G.circ(a[1], a[2], a[3] / 2, 20); rot = a[6] || 0; }
        if (!poly) continue;
        if (code === 6 || code === 7) { polys.push(rot ? poly.map(p => G.rotM(p[0], p[1], rot)) : poly); continue; }
        if (!on) continue; // exposure off: knock-out, ignored for display
        polys.push(rot ? poly.map(p => G.rotM(p[0], p[1], rot)) : poly);
      }
      return polys;
    };
  }
  function apertureShape(ap, macros) {
    if (ap.sh) return ap.sh;
    const p = ap.params, u = ap.unit || 1;
    let sh;
    switch (ap.tpl) {
      case "C": sh = { polys: [G.circ(0, 0, p[0] * u / 2, 20)], d: p[0] * u, round: true }; break;
      case "R": sh = { polys: [G.rect(p[0] * u, (p[1] ?? p[0]) * u)], d: Math.min(p[0], p[1] ?? p[0]) * u }; break;
      case "O": { const w = p[0] * u, h = (p[1] ?? p[0]) * u; sh = { polys: [G.rrect(w, h, Math.min(w, h) / 2, 6)], d: Math.min(w, h) }; break; }
      case "P": { const n = Math.max(3, Math.round(p[1] || 3)), r = p[0] * u / 2, rot = (p[2] || 0) * Math.PI / 180; sh = { polys: [Array.from({ length: n }, (_, k) => [r * Math.cos(rot + 2 * Math.PI * k / n), r * Math.sin(rot + 2 * Math.PI * k / n)])], d: p[0] * u }; break; }
      default: { const m = macros[ap.tpl]; const polys = (m ? m(p) : []).map(poly => poly.map(([x, y]) => [x * u, y * u])); const bb = G.bboxOf(polys.flat()); sh = { polys, d: G.validBB(bb) ? Math.min(bb[2] - bb[0], bb[3] - bb[1]) : 0.1 }; }
    }
    return ap.sh = sh;
  }

  // ---------- Gerber ----------
  function parse(text) {
    let unit = 1, fmt = { xi: 2, xd: 4, yi: 2, yd: 4, lz: true };
    const aps = {}, macros = {}, attrsF = {};
    let cur = null, x = 0, y = 0, interp = 1, quadrant = 75, region = false, polarityDark = true;
    const obj = {}; // current object attributes (X2 TO.)
    const flashes = [], draws = [], regions = [];
    let contour = null;
    const conv = (s, axis) => {
      if (s === undefined) return undefined;
      if (s.includes(".")) return +s * unit;
      const neg = s[0] === "-"; let d = s.replace(/^[+-]/, "");
      const I = axis === "x" ? fmt.xi : fmt.yi, D = axis === "x" ? fmt.xd : fmt.yd;
      if (!fmt.lz) d = d.padEnd(I + D, "0"); // trailing zeros omitted
      const v = parseInt(d, 10) / Math.pow(10, D);
      return (neg ? -v : v) * unit;
    };
    const closeContour = () => { if (contour && contour.length > 2) regions.push({ pts: contour, dark: polarityDark }); contour = null; };
    // tokenise: extended blocks %...% and plain word commands ending with *
    const re = /%([^%]*)%|([^%*]+)\*/g; let m;
    while ((m = re.exec(text))) {
      if (m[1] !== undefined) {
        for (const blk of m[1].split("*").map(t => t.trim()).filter(Boolean).reduce((acc, t) => { // macros keep their body together
          if (acc.am) { acc.am.body.push(t); return acc; }
          if (/^AM/.test(t)) { acc.am = { name: t.slice(2), body: [] }; acc.list.push(acc.am); return acc; }
          acc.list.push(t); return acc;
        }, { list: [], am: null }).list) {
          if (typeof blk === "object") { macros[blk.name] = compileMacro(blk.body.join("*")); continue; }
          if (/^FS/.test(blk)) { const f = blk.match(/FS([LT])?([AI])?.*?X(\d)(\d)Y(\d)(\d)/); if (f) fmt = { lz: f[1] !== "T", xi: +f[3], xd: +f[4], yi: +f[5], yd: +f[6] }; }
          else if (/^MO/.test(blk)) unit = /MOIN/.test(blk) ? 25.4 : 1;
          else if (/^AD/.test(blk)) {
            const a = blk.match(/^ADD(\d+)([^,]+)(?:,(.*))?$/); if (!a) continue;
            aps[+a[1]] = { tpl: a[2], params: a[3] ? a[3].split("X").map(Number) : [], unit };
          }
          else if (/^LP/.test(blk)) polarityDark = blk[2] !== "C";
          else if (/^TF/.test(blk)) { const [k, ...v] = blk.slice(2).split(","); attrsF[k] = v; }
          else if (/^TO/.test(blk)) { const [k, ...v] = blk.slice(2).split(","); obj[k] = v; }
          else if (/^TD/.test(blk)) { const k = blk.slice(2); if (k) delete obj[k]; else for (const q in obj) delete obj[q]; }
        }
        continue;
      }
      let w = m[2].trim(); if (!w) continue;
      if (/^G0?4/.test(w)) continue;
      if (/^M0?2/.test(w)) break;
      const g = w.match(/G0?(\d+)/g);
      if (g) for (const gg of g) {
        const n = +gg.slice(1);
        if (n === 1 || n === 2 || n === 3) interp = n;
        else if (n === 74 || n === 75) quadrant = n;
        else if (n === 36) { region = true; contour = null; }
        else if (n === 37) { closeContour(); region = false; }
        else if (n === 70) unit = 25.4; else if (n === 71) unit = 1;
      }
      const dsel = w.match(/D(\d+)$/);
      const coords = w.match(/X([+-]?[\d.]+)|Y([+-]?[\d.]+)|I([+-]?[\d.]+)|J([+-]?[\d.]+)/g);
      if (dsel && +dsel[1] >= 10 && !coords) { cur = +dsel[1]; continue; }
      if (dsel && +dsel[1] >= 10) cur = +dsel[1];
      const get = k => { const r = w.match(new RegExp(k + "([+-]?[\\d.]+)")); return r ? r[1] : undefined; };
      const nx = get("X") !== undefined ? conv(get("X"), "x") : x, ny = get("Y") !== undefined ? conv(get("Y"), "y") : y;
      const iv = get("I") !== undefined ? conv(get("I"), "x") : 0, jv = get("J") !== undefined ? conv(get("J"), "y") : 0;
      let op = w.match(/D0?([123])(?!\d)/); op = op ? +op[1] : (coords ? 1 : 0);
      if (!coords && !op) continue;
      if (op === 2) { if (region) { closeContour(); contour = [[nx, ny]]; } x = nx; y = ny; continue; }
      if (op === 3) {
        const ap = aps[cur]; if (ap) { const sh = apertureShape(ap, macros); flashes.push({ x: nx, y: ny, ap: cur, sh, dark: polarityDark, attrs: { ...obj } }); }
        x = nx; y = ny; continue;
      }
      // op 1: draw / region edge
      let seg;
      if (interp === 1) seg = [[nx, ny]];
      else {
        let c;
        if (quadrant === 75) c = [x + iv, y + jv];
        else { // single quadrant: pick the centre that gives equal radii
          let best = null, bd = 1e9;
          for (const sx of [1, -1]) for (const sy of [1, -1]) { const cc = [x + sx * Math.abs(iv), y + sy * Math.abs(jv)]; const d = Math.abs(Math.hypot(x - cc[0], y - cc[1]) - Math.hypot(nx - cc[0], ny - cc[1])); if (d < bd) { bd = d; best = cc; } }
          c = best;
        }
        seg = G.arcPts([x, y], [nx, ny], c, interp === 2, 8);
        if (quadrant === 74 && seg.length > 30) seg = [[nx, ny]];
      }
      if (region) { if (!contour) contour = [[x, y]]; contour.push(...seg); }
      else { const ap = aps[cur]; draws.push({ pts: [[x, y], ...seg], w: ap ? apertureShape(ap, macros).d : 0.1, dark: polarityDark, attrs: { ...obj } }); }
      x = nx; y = ny;
    }
    closeContour();
    return { flashes, draws, regions, attrs: attrsF };
  }

  // ---------- Excellon ----------
  function drill(text) {
    let unit = 25.4, lz = true, intD = 2, decD = 4, fmtSet = false;
    const tools = {}, holes = []; let tool = null, x = 0, y = 0, inHeader = false, plated = null;
    const ff = text.match(/FILE_FORMAT\s*=\s*(\d+)\s*:\s*(\d+)/i); if (ff) { intD = +ff[1]; decD = +ff[2]; fmtSet = true; }
    const ffm = text.slice(0, 3000).match(/TF\.FileFunction,(NonPlated|Plated|MixedPlating)/i);
    if (ffm) plated = /^NonPlated$/i.test(ffm[1]) ? false : /^Plated$/i.test(ffm[1]) ? true : null;
    let pending = null; // per-tool attributes written by KiCad and X2 tools: "; #@! TA.AperFunction,Plated,PTH,ViaDrill"
    const conv = s => {
      if (s.includes(".")) return +s * unit;
      const neg = s[0] === "-"; let d = s.replace(/^[+-]/, "");
      const v = lz ? parseInt(d.padEnd(intD + decD, "0"), 10) / Math.pow(10, decD) : parseInt(d, 10) / Math.pow(10, decD);
      return (neg ? -v : v) * unit;
    };
    for (const raw of text.split(/\r?\n/)) {
      const l = raw.trim(); if (!l) continue;
      if (l[0] === ";") { const ta = l.match(/TA\.AperFunction,(.*)$/i); if (ta) pending = { plated: !/NonPlated/i.test(ta[1]), via: /Via/i.test(ta[1]) }; continue; }
      if (l === "M48") { inHeader = true; continue; }
      if (l === "%" || l === "M95") { inHeader = false; continue; }
      if (/^(METRIC|M71)/.test(l)) { unit = 1; if (!fmtSet) { intD = 3; decD = 3; } if (/TZ/.test(l)) lz = false; if (/LZ/.test(l)) lz = true; const f = l.match(/,0*(\d+)\.(\d+)/) || l.match(/,(0+)\.(0+)/); if (f) { intD = f[1].length; decD = f[2].length; fmtSet = true; } continue; }
      if (/^(INCH|M72)/.test(l)) { unit = 25.4; if (!fmtSet) { intD = 2; decD = 4; } if (/TZ/.test(l)) lz = false; if (/LZ/.test(l)) lz = true; continue; }
      const td = l.match(/^T(\d+).*C([\d.]+)/);
      if (td && (inHeader || !tools[+td[1]])) { tools[+td[1]] = { d: +td[2] * unit, plated: pending ? pending.plated : null, via: pending ? pending.via : false }; pending = null; if (!inHeader) tool = +td[1]; continue; }
      const ts = l.match(/^T(\d+)$/); if (ts) { tool = +ts[1]; continue; }
      const c = l.match(/^(?:G0?1|G85)?X([+-]?[\d.]+)?Y?([+-]?[\d.]+)?/);
      if (/^X|^Y|^G85|^G01/.test(l)) {
        const xm = l.match(/X([+-]?[\d.]+)/), ym = l.match(/Y([+-]?[\d.]+)/);
        if (xm) x = conv(xm[1]); if (ym) y = conv(ym[1]);
        if (tool !== null && tools[tool] !== undefined) { const t = tools[tool]; holes.push({ x, y, d: t.d, plated: t.plated ?? plated, via: t.via }); }
      }
    }
    return holes;
  }

  // ---------- layer role from file name / X2 FileFunction ----------
  function role(name, head) {
    const n = name.toLowerCase(), base = n.split("/").pop();
    const ff = (head.match(/%TF\.FileFunction,([^*%]+)/) || [])[1] || "";
    if (ff) {
      if (/^Copper,L1,Top/i.test(ff) || /^Copper,L\d+,Top/i.test(ff)) return "cuF";
      if (/^Copper,L\d+,Bot/i.test(ff)) return "cuB";
      if (/^Copper/i.test(ff)) return "cuIn";
      if (/^Soldermask,Top/i.test(ff)) return "maskF"; if (/^Soldermask,Bot/i.test(ff)) return "maskB";
      if (/^Paste,Top/i.test(ff)) return "pasteF"; if (/^Paste,Bot/i.test(ff)) return "pasteB";
      if (/^Legend,Top/i.test(ff)) return "silkF"; if (/^Legend,Bot/i.test(ff)) return "silkB";
      if (/^Profile/i.test(ff)) return "outline";
      if (/^(Plated|NonPlated)/i.test(ff)) return "drill";
      return "other";
    }
    const ext = base.includes(".") ? base.split(".").pop() : "";
    const E = { gtl: "cuF", gbl: "cuB", gts: "maskF", gbs: "maskB", gtp: "pasteF", gbp: "pasteB", gto: "silkF", gbo: "silkB", gko: "outline", gm1: "outline", gml: "outline", gm: "outline", g1: "cuIn", g2: "cuIn", g3: "cuIn", g4: "cuIn", drl: "drill", xln: "drill", exc: "drill", ncd: "drill", drd: "drill" };
    if (E[ext]) return E[ext];
    // KiCad names, EasyEDA names, Allegro .art names
    const s = base.replace(/\.(gbr|ger|art|pho|gbx|txt|cnc|nc)$/, "");
    if (/(^|[-_ ])(f_cu|top_?layer|toplayer|l1_top|^top|copper_top|cu_top|layer1)($|[-_ ])/.test(s) || /^l1[-_]/.test(s) || s === "top") return "cuF";
    if (/(^|[-_ ])(b_cu|bottom_?layer|bottomlayer|bottom|bot|copper_bottom|cu_bot)($|[-_ ])/.test(s) && !/(mask|paste|silk|sold|legend|overlay)/.test(s)) return "cuB";
    if (/(f_mask|top_?solder_?mask|mask_top|sold(er)?_?top|soldermask_top|topsoldermask|smt)/.test(s)) return "maskF";
    if (/(b_mask|bottom_?solder_?mask|mask_bot|sold(er)?_?bot|soldermask_bot|bottomsoldermask|smb)/.test(s)) return "maskB";
    if (/(f_paste|top_?paste|paste_top|pastemask_top|toppaste|spt)/.test(s)) return "pasteF";
    if (/(b_paste|bottom_?paste|paste_bot|bottompaste|spb)/.test(s)) return "pasteB";
    if (/(f_silk|top_?silk|silk_?top|silkscreen_top|legend_top|overlay_top|topsilk|sst)/.test(s)) return "silkF";
    if (/(b_silk|bottom_?silk|silk_?bot|silkscreen_bot|legend_bot|overlay_bot|bottomsilk|ssb)/.test(s)) return "silkB";
    if (/(edge_cuts|outline|board_?outline|boardoutline|profile|keepout|dim)/.test(s)) return "outline";
    if (/^(l\d+|in\d|inner)/.test(s) || /inner/.test(s) || /gnd|pwr|plane/.test(s)) return "cuIn";
    if (/drill|\.drl$/.test(n)) return "drill";
    return "other";
  }
  const isGerber = head => /%FS[LT]?[AI]?X\d\dY\d\d\*%|%MO(MM|IN)\*%|G04 |%ADD\d+/.test(head);
  const isDrill = head => /^\s*M48\b/m.test(head) || /;\s*(DRILL|FILE_FORMAT|TYPE=PLATED|#@!)/i.test(head) && /^T\d+C[\d.]+/m.test(head);
  return { parse, drill, role, isGerber, isDrill };
})();
