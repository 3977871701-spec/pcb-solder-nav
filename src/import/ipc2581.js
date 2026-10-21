// IPC-2581 (rev A/B/C) importer — exported by Cadence Allegro/OrCAD, Altium, PADS, Xpedition, Zuken, KiCad 8+.
globalThis.ImpIPC2581 = (() => {
  const { X } = Files, G = Geom;
  const UNITS = { MILLIMETER: 1, MM: 1, MICRON: 0.001, INCH: 25.4, MIL: 0.0254, MILS: 0.0254 };
  const num = v => (v === undefined || v === "" ? 0 : +v);

  // Xform → function on Y-up points. Mirrored parts: flip X, then rotate the other way (matches Allegro and KiCad exports).
  function xfFn(xf, loc, s) {
    const rot = xf ? num(xf.a.rotation) : 0, mir = xf && xf.a.mirror === "true", sc = xf && xf.a.scale ? +xf.a.scale : 1;
    const ox = (xf ? num(xf.a.xOffset) : 0) * s, oy = (xf ? num(xf.a.yOffset) : 0) * s;
    const lx = (loc ? num(loc.a.x) : 0) * s, ly = (loc ? num(loc.a.y) : 0) * s;
    return p => { let x = p[0] * sc, y = p[1] * sc; if (mir) x = -x; const r = G.rotM(x, y, mir ? -rot : rot); return [r[0] + ox + lx, r[1] + oy + ly]; };
  }
  function polyPts(poly, s, cwFix = false) {
    const out = [];
    for (const st of poly.c) {
      if (st.n === "PolyBegin" || st.n === "PolyStepSegment") out.push([num(st.a.x) * s, num(st.a.y) * s]);
      else if (st.n === "PolyStepCurve" && out.length) {
        const b = [num(st.a.x) * s, num(st.a.y) * s], c = [num(st.a.centerX) * s, num(st.a.centerY) * s];
        out.push(...G.arcPts(out[out.length - 1], b, c, st.a.clockwise === "true"));
      }
    }
    return out;
  }
  function makeCtx(top) {
    const ctx = { std: {}, user: {}, line: {}, s: 1 };
    const ch = X.find(top, "CadHeader"); ctx.s = UNITS[(ch && ch.a.units || "MILLIMETER").toUpperCase()] || 1;
    const content = X.kid(top, "Content");
    const us = n => UNITS[(n.a.units || "").toUpperCase()] || ctx.s;
    for (const d of X.kids(content, "DictionaryStandard")) { const s = us(d); for (const e of X.kids(d, "EntryStandard")) ctx.std[e.a.id] = { el: e.c[0], s }; }
    for (const d of X.kids(content, "DictionaryUser")) { const s = us(d); for (const e of X.kids(d, "EntryUser")) ctx.user[e.a.id] = { el: e.c[0], s }; }
    for (const d of X.kids(content, "DictionaryLineDesc")) { const s = us(d); for (const e of X.kids(d, "EntryLineDesc")) { const ld = X.kid(e, "LineDesc"); ctx.line[e.a.id] = ld ? num(ld.a.lineWidth) * s : 0.1; } }
    return ctx;
  }
  // primitive element → list of polygons (local, Y up, mm)
  function prim(el, s, ctx, depth = 0) {
    if (!el || depth > 4) return [];
    const a = k => num(el.a[k]) * s;
    switch (el.n) {
      case "StandardPrimitiveRef": { const e = ctx.std[el.a.id]; return e ? prim(e.el, e.s, ctx, depth + 1) : []; }
      case "UserPrimitiveRef": { const e = ctx.user[el.a.id]; return e ? prim(e.el, e.s, ctx, depth + 1) : []; }
      case "UserSpecial": { const out = []; for (const f of el.c) out.push(...prim(f, s, ctx, depth + 1)); return out; }
      case "Circle": return [G.circ(0, 0, a("diameter") / 2)];
      case "RectCenter": return [G.rect(a("width"), a("height"))];
      case "RectRound": return [G.rrect(a("width"), a("height"), a("radius"))];
      case "RectCham": { const w = a("width"), h = a("height"), c = a("chamfer"), x = w / 2, y = h / 2; return [[[-x + c, -y], [x - c, -y], [x, -y + c], [x, y - c], [x - c, y], [-x + c, y], [-x, y - c], [-x, -y + c]]]; }
      case "RectCorner": { const x0 = a("lowerLeftX"), y0 = a("lowerLeftY"), x1 = a("upperRightX"), y1 = a("upperRightY"); return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]; }
      case "Oval": return [G.rrect(a("width"), a("height"), Math.min(a("width"), a("height")) / 2, 6)];
      case "Ellipse": return [G.circ(0, 0, 1).map(([x, y]) => [x * a("width") / 2, y * a("height") / 2])];
      case "Diamond": { const w = a("width") / 2, h = a("height") / 2; return [[[0, h], [w, 0], [0, -h], [-w, 0]]]; }
      case "Triangle": { const b = a("base") / 2, h = a("height") / 2; return [[[-b, -h], [b, -h], [0, h]]]; }
      case "Hexagon": case "Octagon": return [G.rect(a("width") || a("length"), a("height") || a("length"))];
      case "Donut": case "Thermal": case "Moire": return [G.circ(0, 0, (a("outerDiameter") || a("diameter")) / 2)];
      case "Butterfly": return [G.circ(0, 0, a("diameter") / 2 || a("side") / 2)];
      case "Contour": { const p = X.kid(el, "Polygon"); return p ? [polyPts(p, s)] : []; }
      case "Polygon": return [polyPts(el, s)];
      default: return [];
    }
  }
  // stroke-like features → list of point runs (Y up)
  function strokes(el, s, ctx) {
    const w = () => { const r = X.kid(el, "LineDescRef"), d = X.kid(el, "LineDesc"); return r ? ctx.line[r.a.id] ?? 0.1 : d ? num(d.a.lineWidth) * s : 0.1; };
    if (el.n === "UserSpecial" || el.n === "Features") return el.c.flatMap(c => strokes(c, s, ctx));
    if (el.n === "UserPrimitiveRef") { const e = ctx.user[el.a.id]; return e && e.el ? strokes(e.el, e.s, ctx) : []; }
    if (el.n === "Polyline") return [{ pts: polyPts(el, s), w: w() }];
    if (el.n === "Line") return [{ pts: [[num(el.a.startX) * s, num(el.a.startY) * s], [num(el.a.endX) * s, num(el.a.endY) * s]], w: w() }];
    if (el.n === "Arc") { const a0 = [num(el.a.startX) * s, num(el.a.startY) * s]; return [{ pts: [a0, ...G.arcPts(a0, [num(el.a.endX) * s, num(el.a.endY) * s], [num(el.a.centerX) * s, num(el.a.centerY) * s], el.a.clockwise === "true")], w: w() }]; }
    return [];
  }
  const flip = p => [p[0], -p[1]];

  function parse(text, fileName) {
    const root = Files.xml(text), top = X.find(root, "IPC-2581");
    if (!top) throw new Error("不是 IPC-2581 文件");
    const ctx = makeCtx(top), s = ctx.s;
    const cad = X.find(top, "CadData"); if (!cad) throw new Error("IPC-2581 文件里没有 CadData（可能只导出了 BOM）");
    const layers = {};
    for (const L of X.kids(cad, "Layer")) layers[L.a.name] = { fn: (L.a.layerFunction || "").toUpperCase(), side: (L.a.side || "").toUpperCase() };
    const isCu = fn => /CONDUCTOR|SIGNAL|PLANE|MIXED|CONDFILM|CONDFOIL/.test(fn);
    const cuNames = Object.keys(layers).filter(n => isCu(layers[n].fn));
    const sideOfLayer = n => { const L = layers[n]; if (L && (L.side === "TOP" || L.side === "BOTTOM")) return L.side === "TOP" ? "F" : "B";
      if (cuNames.length) { if (n === cuNames[0]) return "F"; if (n === cuNames[cuNames.length - 1]) return "B"; }
      return /bot|b\.cu|bottom|back/i.test(n) ? "B" : /top|f\.cu|front/i.test(n) ? "F" : null; };
    const step = X.kid(cad, "Step"); if (!step) throw new Error("IPC-2581 文件里没有 Step");
    const b = G.newBoard(), edgePts = [];

    // outline
    const prof = X.kid(step, "Profile");
    if (prof) for (const pg of [X.kid(prof, "Polygon"), ...X.kids(prof, "Cutout")].filter(Boolean)) { const pts = polyPts(pg, s).map(flip); b.edges += G.polyD(pts); edgePts.push(...pts); }

    // logical nets (fallback for pad nets)
    const lnet = {};
    for (const ln of X.kids(step, "LogicalNet")) for (const pr of X.kids(ln, "PinRef")) lnet[pr.a.componentRef + "\u0001" + pr.a.pin] = ln.a.name;

    // copper features: pads with PinRef, vias, tracks
    const padsByRef = {}, tracks = { F: [], B: [] }, silk = { F: [], B: [] }, holes = [];
    for (const lf of X.kids(step, "LayerFeature")) {
      const L = layers[lf.a.layerRef] || { fn: "" };
      if (L.fn === "DRILL") { for (const set of X.kids(lf, "Set")) for (const h of X.kids(set, "Hole")) holes.push({ x: num(h.a.x) * s, y: -num(h.a.y) * s, d: num(h.a.diameter) * s, plated: h.a.platingStatus !== "NONPLATED" }); continue; }
      const side = sideOfLayer(lf.a.layerRef);
      if (/SILKSCREEN|LEGEND/.test(L.fn) && side) {
        for (const set of X.kids(lf, "Set")) for (const f of X.kids(set, "Features")) { const T = xfFn(X.kid(f, "Xform"), X.kid(f, "Location"), s); for (const g of f.c) for (const st of strokes(g, s, ctx)) silk[side].push(G.lineD(st.pts.map(T).map(flip))); }
        continue;
      }
      if (!isCu(L.fn) || !side) continue;
      if (cuNames.length > 1 && lf.a.layerRef !== cuNames[0] && lf.a.layerRef !== cuNames[cuNames.length - 1] && !(layers[lf.a.layerRef].side === "TOP" || layers[lf.a.layerRef].side === "BOTTOM")) continue;
      for (const set of X.kids(lf, "Set")) {
        const net = set.a.net || "";
        const setPin = X.kid(set, "PinRef");
        for (const pad of X.kids(set, "Pad")) {
          const T = xfFn(X.kid(pad, "Xform"), X.kid(pad, "Location"), s);
          const pe = pad.c.find(c => !/^(Xform|Location|PinRef|NonstandardAttribute)$/.test(c.n));
          const polys = prim(pe, s, ctx).map(poly => poly.map(T).map(flip));
          const pr = X.kid(pad, "PinRef") || setPin;
          if (pr && pr.a.componentRef) {
            const key = pr.a.componentRef, list = (padsByRef[key] ||= []);
            if (!list.some(q => q.pin === pr.a.pin && q.side !== side)) list.push({ pin: pr.a.pin, net, polys, side });
          } else if (polys.length) {
            const bb = G.bboxOf(polys.flat());
            if (G.validBB(bb)) b.vias.push([G.f3((bb[0] + bb[2]) / 2), G.f3((bb[1] + bb[3]) / 2), G.f3((bb[2] - bb[0]) / 2)]);
          }
        }
        for (const f of X.kids(set, "Features")) {
          const T = xfFn(X.kid(f, "Xform"), X.kid(f, "Location"), s);
          for (const g of f.c) for (const st of strokes(g, s, ctx)) tracks[side].push([st.w, G.lineD(st.pts.map(T).map(flip))]);
        }
      }
    }
    // dedupe vias that appear on several layers
    const vseen = new Set(); b.vias = b.vias.filter(v => { const k = v[0] + "," + v[1]; if (vseen.has(k)) return false; vseen.add(k); return true; });
    b.tracks = { F: G.groupTracks(tracks.F), B: G.groupTracks(tracks.B) };
    b.silk = { F: silk.F.join(""), B: silk.B.join("") };

    // packages
    const pkgs = {};
    for (const pk of X.kids(step, "Package")) {
      const lp = X.kid(pk, "LandPattern");
      const pinOf = (pd, pinName) => { const T = xfFn(X.kid(pd, "Xform"), X.kid(pd, "Location"), s); const pe = pd.c.find(c => !/^(Xform|Location|PinRef|NonstandardAttribute)$/.test(c.n)); return { pin: pinName, polys: prim(pe, s, ctx).map(p => p.map(T)), th: /THRU/i.test(pd.a.type || "") }; };
      // Allegro: <LandPattern><Pad>…<PinRef pin/></Pad>;  KiCad: <Pin number type>
      const pins = lp ? X.kids(lp, "Pad").map(pd => { const pr = X.kid(pd, "PinRef"); return pinOf(pd, pr ? pr.a.pin : ""); })
        : X.kids(pk, "Pin").map(pd => pinOf(pd, pd.a.number || ""));
      const outl = [];
      for (const host of [X.kid(pk, "AssemblyDrawing"), pk].filter(Boolean)) { const o = X.kid(host, "Outline"); if (o) { const pg = X.kid(o, "Polygon"); if (pg) { outl.push(polyPts(pg, s)); break; } } }
      const sk = [];
      const ss = X.kid(pk, "SilkScreen");
      if (ss) for (const mk of [...X.kids(ss, "Marking"), ...X.kids(ss, "Outline")]) { const T = xfFn(X.kid(mk, "Xform"), X.kid(mk, "Location"), s); for (const g of mk.c) { for (const st of strokes(g, s, ctx)) sk.push(st.pts.map(T)); if (g.n === "Polygon") sk.push(polyPts(g, s).map(T)); } }
      pkgs[pk.a.name] = { pins, outl, sk };
    }

    // BOM inside the file
    const bomInfo = {};
    for (const bom of X.findAll(top, "Bom")) for (const it of X.kids(bom, "BomItem")) {
      const ch = {}; for (const t of X.findAll(it, "Textual")) ch[t.a.textualCharacteristicName || t.a.definitionName || ""] = t.a.textualCharacteristicValue ?? t.a.value ?? "";
      for (const rd of X.kids(it, "RefDes")) bomInfo[rd.a.name] = { ch, populate: rd.a.populate !== "false", oem: it.a.OEMDesignNumberRef || "" };
    }

    const added = []; let xfErr = 0;
    for (const c of X.kids(step, "Component")) {
      const ref = c.a.refDes; if (!ref) continue;
      const side = sideOfLayer(c.a.layerRef) || "F";
      const T = xfFn(X.kid(c, "Xform"), X.kid(c, "Location"), s);
      const loc = X.kid(c, "Location"), cx = loc ? num(loc.a.x) * s : 0, cy = loc ? -num(loc.a.y) * s : 0;
      const pk = pkgs[c.a.packageRef] || { pins: [], outl: [], sk: [] };
      const fromPkg = pk.pins.map(p => ({ pin: p.pin, net: lnet[ref + "\u0001" + p.pin] || "", polys: p.polys.map(poly => poly.map(T).map(flip)), side }));
      let raw = padsByRef[ref];
      if (!raw || !raw.length) raw = fromPkg;
      else { // exporters may leave mechanical / unnumbered pads without a PinRef: take them from the package
        const ctr = q => { const bb = G.bboxOf(q.polys.flat()); return [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2]; };
        const have = raw.map(ctr), boxes = raw.map(q => G.bboxOf(q.polys.flat()));
        const inside = c => boxes.some(bb => c[0] > bb[0] && c[0] < bb[2] && c[1] > bb[1] && c[1] < bb[3]); // e.g. paste windows on an exposed pad
        for (const q of fromPkg) {
          if (!q.polys.length) continue; const c0 = ctr(q);
          const same = raw.find(r => r.pin === q.pin && q.pin);
          if (same) { const c1 = ctr(same); xfErr = Math.max(xfErr, Math.hypot(c1[0] - c0[0], c1[1] - c0[1])); continue; }
          if (!have.some(h => Math.hypot(h[0] - c0[0], h[1] - c0[1]) < 0.05) && !inside(c0)) { raw = raw.concat([q]); added.push([c0, ref + "." + q.pin]); }
        }
      }
      const mount = (c.a.mountType || "").toUpperCase();
      const tht = /TH/.test(mount) && mount !== "SMT";
      const pads = raw.map(q => {
        let kind = 0; const bb = G.bboxOf(q.polys.flat()), mx = (bb[0] + bb[2]) / 2, my = (bb[1] + bb[3]) / 2;
        let holeD = "";
        const h = holes.find(h => Math.abs(h.x - mx) < 0.02 && Math.abs(h.y - my) < 0.02);
        if (h) { kind = h.plated ? 1 : 2; holeD = G.polyD(G.circ(h.x, h.y, h.d / 2, 20).reverse()); }
        else if (tht) kind = 1;
        return G.padRec(q.pin, q.net || lnet[ref + "\u0001" + q.pin] || "", q.polys, kind, holeD);
      });
      const body = pk.outl.map(o => G.polyD(o.map(T).map(flip))).join("");
      const sk = pk.sk.map(o => G.lineD(o.map(T).map(flip))).join("");
      const bpts = pk.outl.flatMap(o => o.map(T).map(flip));
      let bb = G.bboxOf(pads.flatMap(p => [[p[7][0], p[7][1]], [p[7][2], p[7][3]]]).concat(bpts));
      if (!G.validBB(bb)) bb = [cx - .5, cy - .5, cx + .5, cy + .5];
      const props = {};
      for (const na of X.kids(c, "NonstandardAttribute")) props[na.a.name] = na.a.value;
      const bi = bomInfo[ref];
      if (bi) for (const [k, v] of Object.entries(bi.ch)) if (v && !(k in props)) props[k] = v;
      const val = props.VALUE || props.Value || props.COMP_VALUE || props.value || "";
      const mpn = Object.entries(props).find(([k]) => /part.?number|^mpn$|manufacturer.?part|^pn$/i.test(k));
      if (mpn) props.MPN = mpn[1];
      const lcsc = Object.entries(props).find(([k]) => /lcsc|jlc/i.test(k)); if (lcsc) props.LCSC = lcsc[1];
      if (!props.MPN && c.a.part && !/[_]{1}.*[_]/.test(c.a.part)) props.MPN = c.a.part;
      const p1 = pads.find(p => p[0] === "1");
      b.parts.push({ r: ref, s: side, c: [G.f3(cx), G.f3(cy)], rot: num((X.kid(c, "Xform") || { a: {} }).a.rotation), bb: bb.map(G.f3), pads, body, silk: sk,
        val, fp: c.a.packageRef || "", props, sheet: "", p1: p1 ? [p1[4], p1[5]] : null, tht: tht ? 1 : 0, dnp: bi && !bi.populate ? 1 : 0, nobom: 0 });
    }
    if (added.length) b.vias = b.vias.filter(v => !added.some(([c]) => Math.hypot(c[0] - v[0], c[1] - v[1]) < 0.05));
    b._added = added.map(a => a[1]); b._xfErr = xfErr;
    return G.finishBoard(b, edgePts);
  }
  const detect = head => /<IPC-2581[\s>]/.test(head);
  return { parse, detect };
})();
