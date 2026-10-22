// KiCad 6–10 .kicad_pcb importer (S-expression). Validated pad-by-pad against pcbnew.
globalThis.ImpKiCad = (() => {
  // ---------- S-expression reader ----------
  function sexpr(src) {
    let i = 0, cur = null, root = null; const n = src.length, stack = [];
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 40) { const node = []; if (cur) cur.push(node); stack.push(cur); cur = node; i++; }
      else if (c === 41) { const done = cur; cur = stack.pop(); if (!cur && !root) root = done; i++; }
      else if (c <= 32) i++;
      else if (c === 34) {
        let j = i + 1, s = "", st = j;
        while (j < n) { const d = src.charCodeAt(j); if (d === 92) { s += src.slice(st, j); const e = src[j + 1]; s += e === "n" ? "\n" : e; j += 2; st = j; } else if (d === 34) break; else j++; }
        s += src.slice(st, j); if (cur) cur.push(s); i = j + 1;
      } else { let j = i; while (j < n) { const d = src.charCodeAt(j); if (d <= 32 || d === 40 || d === 41) break; j++; } if (cur) cur.push(src.slice(i, j)); i = j; }
    }
    return root;
  }
  const isA = Array.isArray;
  const kid = (n, k) => n && n.find(x => isA(x) && x[0] === k);
  const kids = (n, k) => n ? n.filter(x => isA(x) && x[0] === k) : [];
  const N = v => +v;
  const XY = (n, k) => { const c = kid(n, k); return c ? [N(c[1]), N(c[2])] : null; };
  const rot = (x, y, deg) => { if (!deg) return [x, y]; const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [x * c + y * s, -x * s + y * c]; };
  const f3 = v => { const r = Math.round(v * 1000) / 1000; return Object.is(r, -0) ? 0 : r; };
  const P = p => f3(p[0]) + " " + f3(p[1]);
  const polyD = pts => "M" + pts.map(P).join("L") + "Z";
  const circ = (cx, cy, r, n = 24) => Array.from({ length: n }, (_, k) => [cx + r * Math.cos(k * 2 * Math.PI / n), cy + r * Math.sin(k * 2 * Math.PI / n)]);
  function arcD(a, m, b) {
    const [x1, y1] = a, [x2, y2] = m, [x3, y3] = b;
    const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
    if (Math.abs(d) < 1e-9) return `M${P(a)}L${P(b)}`;
    const ux = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d;
    const uy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d;
    const r = Math.hypot(x1 - ux, y1 - uy);
    const sweep = ((x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1)) > 0 ? 1 : 0;
    const t = q => Math.atan2(q[1] - uy, q[0] - ux), TAU = 2 * Math.PI, nm = v => ((v % TAU) + TAU) % TAU;
    const span = sweep ? nm(t(b) - t(a)) : nm(t(a) - t(b));
    return `M${P(a)}A${f3(r)} ${f3(r)} 0 ${span > Math.PI ? 1 : 0} ${sweep} ${P(b)}`;
  }
  const strokeW = n => { const s = kid(n, "stroke"); const w = s ? kid(s, "width") : kid(n, "width"); return w ? N(w[1]) : 0.1; };
  const layerOf = n => { const l = kid(n, "layer"); return l ? l[1] : ""; };

  // graphic item -> {d, pts, layer}; T maps local -> board
  function gfx(n, T) {
    const t = n[0].replace(/^(gr|fp)_/, ""); let d = ""; const pts = [];
    if (t === "line") { const s = XY(n, "start"), e = XY(n, "end"); if (s && e) { const a = T(s), b = T(e); d = `M${P(a)}L${P(b)}`; pts.push(a, b); } }
    else if (t === "rect") { const s = XY(n, "start"), e = XY(n, "end"); if (s && e) { const c = [[s[0], s[1]], [e[0], s[1]], [e[0], e[1]], [s[0], e[1]]].map(T); d = polyD(c); pts.push(...c); } }
    else if (t === "circle") { const cc = XY(n, "center"), ee = XY(n, "end"); if (cc && ee) { const c = T(cc), e = T(ee), r = Math.hypot(e[0] - c[0], e[1] - c[1]);
      d = `M${P([c[0] - r, c[1]])}a${f3(r)} ${f3(r)} 0 1 0 ${f3(2 * r)} 0a${f3(r)} ${f3(r)} 0 1 0 ${f3(-2 * r)} 0`; pts.push([c[0] - r, c[1] - r], [c[0] + r, c[1] + r]); } }
    else if (t === "arc") { const s = XY(n, "start"), m = XY(n, "mid"), e = XY(n, "end"); if (s && e) { const a = T(s), b = T(e); if (m) { const mm = T(m); d = arcD(a, mm, b); pts.push(a, mm, b); } else { d = `M${P(a)}L${P(b)}`; pts.push(a, b); } } }
    else if (t === "poly") { const c = kids(kid(n, "pts"), "xy").map(q => T([N(q[1]), N(q[2])])); if (c.length) { d = polyD(c); pts.push(...c); } }
    else if (t === "curve") { const c = kids(kid(n, "pts"), "xy").map(q => T([N(q[1]), N(q[2])])); if (c.length === 4) { d = `M${P(c[0])}C${P(c[1])} ${P(c[2])} ${P(c[3])}`; pts.push(...c); } }
    return { d, pts, layer: layerOf(n), w: strokeW(n) };
  }

  // ---------- pad geometry (pad-local, unrotated) ----------
  function rrect(w, h, r, seg = 4) {
    r = Math.max(0, Math.min(r, w / 2, h / 2)); if (r < 1e-4) return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    const out = [], cs = [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 90], [-w / 2 + r, -h / 2 + r, 180], [w / 2 - r, -h / 2 + r, 270]];
    for (const [cx, cy, a0] of cs) for (let k = 0; k <= seg; k++) { const a = (a0 + 90 * k / seg) * Math.PI / 180; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    return out;
  }
  function chamfered(w, h, c, corners) {
    const has = k => corners.includes(k), x = w / 2, y = h / 2, o = [];
    if (has("top_left")) o.push([-x, -y + c], [-x + c, -y]); else o.push([-x, -y]);
    if (has("top_right")) o.push([x - c, -y], [x, -y + c]); else o.push([x, -y]);
    if (has("bottom_right")) o.push([x, y - c], [x - c, y]); else o.push([x, y]);
    if (has("bottom_left")) o.push([-x + c, y], [-x, y - c]); else o.push([-x, y]);
    return o;
  }
  function baseShape(shape, w, h, pad) {
    if (shape === "circle") return circ(0, 0, w / 2);
    if (shape === "oval") return rrect(w, h, Math.min(w, h) / 2, 6);
    if (shape === "roundrect") { const rr = kid(pad, "roundrect_rratio"); return rrect(w, h, Math.min(w, h) * (rr ? N(rr[1]) : .25)); }
    if (shape === "chamfered_rect" || kid(pad, "chamfer")) { const cr = kid(pad, "chamfer_ratio"), ch = kid(pad, "chamfer"); return chamfered(w, h, Math.min(w, h) * (cr ? N(cr[1]) : .2), ch ? ch.slice(1) : []); }
    if (shape === "trapezoid") { const dl = XY(pad, "rect_delta") || [0, 0], dx = w / 2, dy = h / 2, ddx = dl[0] / 2, ddy = dl[1] / 2;
      return [[-dx - ddy, dy + ddx], [dx + ddy, dy - ddx], [dx - ddy, -dy + ddx], [-dx + ddy, -dy - ddx]]; }
    return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  }
  function customPolys(pad, w, h) {
    const opt = kid(pad, "options"), anc = opt && kid(opt, "anchor"), polys = [baseShape(anc && anc[1] === "circle" ? "circle" : "rect", w, h, pad)];
    for (const g of (kid(pad, "primitives") || []).slice(1)) {
      if (!isA(g)) continue; const t = g[0].replace(/^gr_/, ""), sw = strokeW(g);
      if (t === "poly") { const c = kids(kid(g, "pts"), "xy").map(q => [N(q[1]), N(q[2])]); if (c.length > 2) polys.push(c); }
      else if (t === "circle") { const c = XY(g, "center"), e = XY(g, "end"); if (c && e) polys.push(circ(c[0], c[1], Math.hypot(e[0] - c[0], e[1] - c[1]) + sw / 2)); }
      else if (t === "rect") { const s = XY(g, "start"), e = XY(g, "end"); if (s && e) polys.push([[s[0], s[1]], [e[0], s[1]], [e[0], e[1]], [s[0], e[1]]]); }
      else if (t === "line") { const s = XY(g, "start"), e = XY(g, "end"); if (s && e) { const L = Math.hypot(e[0] - s[0], e[1] - s[1]) || 1e-6, nx = -(e[1] - s[1]) / L * sw / 2, ny = (e[0] - s[0]) / L * sw / 2;
        polys.push([[s[0] + nx, s[1] + ny], [e[0] + nx, e[1] + ny], [e[0] - nx, e[1] - ny], [s[0] - nx, s[1] - ny]]); } }
    }
    return polys;
  }

  function parse(text, fileName) {
    const t0 = text.trimStart();
    if (t0.startsWith("(kicad_pcb") === false) throw new Error("不是 KiCad PCB 文件");
    const root = sexpr(text);
    if (!root || root[0] !== "kicad_pcb") throw new Error("文件结构无法识别");
    const ver = +((kid(root, "version") || [])[1] || 0);
    if (kids(root, "module").length && !kids(root, "footprint").length) throw new Error("这是 KiCad 5 格式，请用 KiCad 6 以上打开后另存再导入");
    const netTable = {};
    for (const n of kids(root, "net")) if (n.length >= 3) netTable[n[1]] = n[2];
    const hasTable = Object.keys(netTable).length > 0;
    const netName = nn => { if (!nn) return ""; if (nn.length >= 3) return nn[2]; const v = nn[1] ?? ""; return hasTable && v in netTable ? netTable[v] : v; };
    const tb = kid(root, "title_block"), title = tb && kid(tb, "title") ? kid(tb, "title")[1] : "";

    const edges = [], ep = [], silk = { F: [], B: [] };
    const I = p => p;
    for (const n of root) {
      if (!isA(n) || !/^gr_(line|arc|circle|rect|poly|curve)$/.test(n[0])) continue;
      const g = gfx(n, I); if (!g.d) continue;
      if (g.layer === "Edge.Cuts") { edges.push(g.d); ep.push(...g.pts); }
      else if (g.layer === "F.SilkS") silk.F.push(g.d); else if (g.layer === "B.SilkS") silk.B.push(g.d);
    }
    const tracks = { F: [], B: [] }, pours = { F: [], B: [] }, vias = [];
    const cuSide = L => L === "F.Cu" ? "F" : L === "B.Cu" ? "B" : null;
    for (const n of root) {
      if (!isA(n)) continue;
      if (n[0] === "segment" || n[0] === "arc") {
        const L = layerOf(n), side = L === "F.Cu" ? "F" : L === "B.Cu" ? "B" : null; if (!side) continue;
        const s = XY(n, "start"), e = XY(n, "end"), w = f3(N((kid(n, "width") || [0, .2])[1])), m = XY(n, "mid");
        tracks[side].push([w, n[0] === "arc" && m ? arcD(s, m, e) : `M${P(s)}L${P(e)}`, netName(kid(n, "net"))]);
      } else if (n[0] === "via") { const a = XY(n, "at"), sz = N((kid(n, "size") || [0, .6])[1]); if (a) vias.push([f3(a[0]), f3(a[1]), f3(sz / 2), netName(kid(n, "net"))]); }
      else if (n[0] === "zone") { // filled copper of a zone, as KiCad last computed it
        const net = (kid(n, "net_name") || [])[1] || netName(kid(n, "net"));
        for (const fp of kids(n, "filled_polygon")) { const side = cuSide((kid(fp, "layer") || [])[1]); const pts = kid(fp, "pts"); if (!side || !pts) continue; const xy = kids(pts, "xy").map(q => [N(q[1]), N(q[2])]); if (xy.length > 2) pours[side].push(["M" + xy.map(P).join("L") + "Z", net]); }
      }
    }

    const parts = [];
    for (const fp of kids(root, "footprint")) {
      const at = kid(fp, "at") || ["at", 0, 0, 0], fx = N(at[1]), fy = N(at[2]), fa = N(at[3] || 0);
      const T = p => { const r = rot(p[0], p[1], fa); return [fx + r[0], fy + r[1]]; };
      const side = layerOf(fp) === "B.Cu" ? "B" : "F";
      const props = {};
      for (const p of kids(fp, "property")) props[p[1]] = p[2] ?? "";
      for (const t of kids(fp, "fp_text")) { if (t[1] === "reference" && !props.Reference) props.Reference = t[2]; if (t[1] === "value" && !props.Value) props.Value = t[2]; }
      const attr = (kid(fp, "attr") || []).slice(1);
      const flag = k => attr.includes(k) || ((kid(fp, k) || [])[1] === "yes");
      const ref = props.Reference || "?", libName = String(fp[1] || ""), fpName = libName.includes(":") ? libName.split(":").pop() : libName;
      const sheet = (kid(fp, "sheetname") || [])[1] || props.Sheetname || "";
      const body = [], sk = [], crt = [], bpts = [];
      for (const n of fp) {
        if (!isA(n) || !/^fp_(line|arc|circle|rect|poly|curve)$/.test(n[0])) continue;
        const g = gfx(n, T); if (!g.d) continue;
        if (/\.Fab$/.test(g.layer)) { body.push(g.d); bpts.push(...g.pts); }
        else if (/\.SilkS$/.test(g.layer)) sk.push(g.d);
        else if (/\.CrtYd$/.test(g.layer)) crt.push(...g.pts);
        else if (g.layer === "Edge.Cuts") { edges.push(g.d); ep.push(...g.pts); }
      }
      const cuSide = side === "B" ? "B.Cu" : "F.Cu";
      const pads = []; let pin1 = null; const ppts = [];
      for (const pad of kids(fp, "pad")) {
        const num = String(pad[1] ?? ""), type = pad[2], shape = pad[3];
        const layers = (kid(pad, "layers") || []).slice(1);
        const th = type === "thru_hole", npth = type === "np_thru_hole";
        const onCu = layers.some(l => l === cuSide || l === "*.Cu" || l === "F&B.Cu");
        if (!onCu && !th && !npth) continue;
        const pa = kid(pad, "at") || ["at", 0, 0, 0], pang = N(pa[3] || 0);
        const c = T([N(pa[1]), N(pa[2])]);
        const sz = kid(pad, "size") || ["size", .5, .5], w = N(sz[1]), h = N(sz[2] ?? sz[1]);
        const local = shape === "custom" ? customPolys(pad, w, h) : [baseShape(shape, w, h, pad)];
        const toB = q => { const r = rot(q[0], q[1], pang); return [c[0] + r[0], c[1] + r[1]]; };
        const polys = local.map(o => o.map(toB));
        let d = polys.map(polyD).join("");
        const dr = kid(pad, "drill");
        if (dr && (th || npth)) {
          const oval = dr[1] === "oval", dw = N(oval ? dr[2] : dr[1]), dh = N(oval ? (dr[3] ?? dr[2]) : dr[1]);
          if (dw > 0) { const hole = (oval ? rrect(dw, dh, Math.min(dw, dh) / 2, 6) : circ(0, 0, dw / 2, 20)).map(toB); d += polyD(hole.slice().reverse()); }
        }
        const all = polys.flat(); let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (const q of all) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); }
        ppts.push([x0, y0], [x1, y1]);
        const netN = kid(pad, "net");
        pads.push([num, npth ? "" : netName(netN), d, th ? 1 : npth ? 2 : 0, f3(c[0]), f3(c[1]), f3(Math.min(x1 - x0, y1 - y0))]);
        if (num === "1" && !pin1) pin1 = [f3(c[0]), f3(c[1])];
      }
      const bbSrc = crt.length ? crt : ppts.concat(bpts);
      let bb = [fx - .5, fy - .5, fx + .5, fy + .5];
      if (bbSrc.length) { bb = [1e9, 1e9, -1e9, -1e9]; for (const q of bbSrc) { bb[0] = Math.min(bb[0], q[0]); bb[1] = Math.min(bb[1], q[1]); bb[2] = Math.max(bb[2], q[0]); bb[3] = Math.max(bb[3], q[1]); } bb = bb.map(f3); }
      const attrTHT = attr.includes("through_hole") || (!attr.includes("smd") && pads.some(p => p[3] === 1));
      parts.push({
        r: ref, s: side, c: [f3(fx), f3(fy)], rot: fa, bb, pads, body: body.join(""), silk: sk.join(""),
        val: props.Value || "", fp: fpName, props, sheet, p1: pin1,
        tht: attrTHT ? 1 : 0, dnp: flag("dnp") ? 1 : 0, nobom: flag("exclude_from_bom") || attr.includes("board_only") ? 1 : 0,
      });
    }
    let bbox;
    const pts = ep.length ? ep : parts.flatMap(p => [[p.bb[0], p.bb[1]], [p.bb[2], p.bb[3]]]);
    if (pts.length) { bbox = [1e9, 1e9, -1e9, -1e9]; for (const q of pts) { bbox[0] = Math.min(bbox[0], q[0]); bbox[1] = Math.min(bbox[1], q[1]); bbox[2] = Math.max(bbox[2], q[0]); bbox[3] = Math.max(bbox[3], q[1]); } bbox = bbox.map(f3); }
    else bbox = [0, 0, 50, 50];
    return { ver, title, file: fileName, bbox, edges: edges.join(""), silk: { F: silk.F.join(""), B: silk.B.join("") }, tracks: { F: Geom.groupTracks(tracks.F), B: Geom.groupTracks(tracks.B) }, pours: { F: Geom.groupPours(pours.F), B: Geom.groupPours(pours.B) }, vias, parts };
  }

  return { parse, sexpr };
})();
