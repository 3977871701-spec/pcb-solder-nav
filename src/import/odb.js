// ODB++ importer (Altium, Allegro, PADS, Xpedition, KiCad 9+). Input: files relative to the ODB++ root.
globalThis.ImpODB = (() => {
  const G = Geom;
  const flip = ([x, y]) => [x, -y];
  async function readText(f) { let u8 = await f.read(); if (u8[0] === 0x1f && u8[1] === 0x9d) u8 = Files.unZ(u8); else if (u8[0] === 0x1f && u8[1] === 0x8b) u8 = await Files.gunzip(u8); return Files.decodeText(u8); }
  const unitOf = t => /^\s*(UNITS\s*=\s*INCH|U\s+INCH)/im.test(t) ? 25.4 : 1;

  // contour / simple shapes → polygons (local units already scaled)
  function shapeReader(s) {
    let polys = [], cur = null;
    return {
      line(tok) {
        const k = tok[0], n = i => +tok[i] * s;
        if (k === "RC") { const x = n(1), y = n(2), w = n(3), h = n(4); polys.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]); }
        else if (k === "CR") polys.push(G.circ(n(1), n(2), n(3)));
        else if (k === "SQ") { const x = n(1), y = n(2), h = n(3); polys.push([[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]]); }
        else if (k === "OB") { cur = { pts: [[n(1), n(2)]], hole: tok[3] === "H" }; }
        else if (k === "OS" && cur) cur.pts.push([n(1), n(2)]);
        else if (k === "OC" && cur) cur.pts.push(...G.arcPts(cur.pts[cur.pts.length - 1], [n(1), n(2)], [n(3), n(4)], tok[5] === "Y", 10));
        else if (k === "OE" && cur) { if (!cur.hole) polys.push(cur.pts); cur = null; }
        else return false;
        return true;
      },
      take() { const p = polys; polys = []; return p; },
    };
  }
  function parseEda(t) {
    const s = unitOf(t), nets = [], pkgs = [];
    let pkg = null, target = null; const sr = shapeReader(s);
    const flushTo = () => { if (target) target.push(...sr.take()); else sr.take(); };
    for (const raw of t.split(/\r?\n/)) {
      const l = raw.trim(); if (!l || l[0] === "#") continue;
      const tok = l.split(/\s+/);
      if (tok[0] === "NET") { flushTo(); nets.push(tok[1] === "$NONE$" ? "" : (tok[1] || "")); pkg = null; target = null; continue; }
      if (tok[0] === "PKG") { flushTo(); pkg = { name: tok[1], outline: [], pins: [] }; pkgs.push(pkg); target = pkg.outline; continue; }
      if (tok[0] === "PIN" && pkg) { flushTo(); const pin = { name: tok[1], type: tok[2], x: +tok[3] * s, y: +tok[4] * s, shapes: [] }; pkg.pins.push(pin); target = pin.shapes; continue; }
      if (sr.line(tok)) { if (tok[0] !== "OB" && tok[0] !== "OS" && tok[0] !== "OC") flushTo(); continue; }
      if (/^(SNT|FID|FGR|PRP|LYR|HDR|UNITS|@|&)/.test(tok[0])) { flushTo(); if (tok[0] === "SNT" || tok[0] === "FGR") target = null; }
    }
    flushTo();
    return { nets, pkgs };
  }
  function parseComps(t) {
    const s = unitOf(t), comps = []; let c = null;
    const unq = v => v.replace(/^'|'$/g, "");
    for (const raw of t.split(/\r?\n/)) {
      const l = raw.trim(); if (!l || l[0] === "#") continue;
      const tok = l.replace(/;.*$/, "").trim().split(/\s+/);
      if (tok[0] === "CMP") { c = { pkg: +tok[1], x: +tok[2] * s, y: +tok[3] * s, rot: +tok[4] || 0, mir: tok[5] === "M", ref: tok[6], part: tok.slice(7).join(" "), props: {}, pins: [] }; comps.push(c); }
      else if (tok[0] === "PRP" && c) { const m = l.match(/^PRP\s+(\S+)\s+(.*)$/); if (m) c.props[m[1]] = unq(m[2].replace(/\s+\d+$/, "").trim()); }
      else if (tok[0] === "TOP" && c) c.pins.push({ idx: +tok[1], x: +tok[2] * s, y: +tok[3] * s, rot: +tok[4] || 0, mir: tok[5] === "M", net: +tok[6], name: tok[8] ?? "" });
    }
    return comps;
  }
  // feature files: symbol table + L/A/P records
  function parseFeatures(t) {
    const s = unitOf(t), symScale = s === 1 ? 0.001 : 0.0254; // microns for metric files, mils for imperial
    const syms = {}, lines = [], pads = [], surfaces = [];
    let surf = null; const sr = shapeReader(s);
    const symSize = name => { if (!name) return 0.1; let m = name.match(/^r([\d.]+)/); if (m) return +m[1] * symScale; m = name.match(/^s([\d.]+)/); if (m) return +m[1] * symScale; m = name.match(/^rect([\d.]+)x([\d.]+)/); if (m) return Math.min(+m[1], +m[2]) * symScale; m = name.match(/^oval([\d.]+)x([\d.]+)/); if (m) return Math.min(+m[1], +m[2]) * symScale; return 0.1; };
    for (const raw of t.split(/\r?\n/)) {
      const l = raw.trim(); if (!l || l[0] === "#") continue;
      const tok = l.replace(/;.*$/, "").trim().split(/\s+/);
      if (/^\$\d+$/.test(tok[0])) { syms[tok[0].slice(1)] = tok[1]; continue; }
      if (tok[0] === "L") lines.push({ pts: [[+tok[1] * s, +tok[2] * s], [+tok[3] * s, +tok[4] * s]], w: symSize(syms[tok[5]]), dark: tok[6] !== "N" });
      else if (tok[0] === "A") { const a = [+tok[1] * s, +tok[2] * s]; lines.push({ pts: [a, ...G.arcPts(a, [+tok[3] * s, +tok[4] * s], [+tok[5] * s, +tok[6] * s], tok[10] === "Y", 10)], w: symSize(syms[tok[7]]), dark: tok[8] !== "N" }); }
      else if (tok[0] === "P") pads.push({ x: +tok[1] * s, y: +tok[2] * s, d: symSize(syms[tok[3]]), sym: syms[tok[3]] || "" });
      else if (tok[0] === "S") { surf = []; }
      else if (tok[0] === "SE") { if (surf) surfaces.push(...sr.take()); surf = null; }
      else if (surf && sr.line(tok)) continue;
    }
    return { lines, pads, surfaces };
  }
  function parseMatrix(t) {
    const out = [];
    for (const blk of t.matchAll(/LAYER\s*\{([^}]*)\}/g)) {
      const o = {}; for (const m of blk[1].matchAll(/(\w+)\s*=\s*(.*)/g)) o[m[1].toUpperCase()] = m[2].trim();
      out.push({ name: (o.NAME || "").toLowerCase(), type: (o.TYPE || "").toUpperCase(), row: +o.ROW || 0, ctx: (o.CONTEXT || "").toUpperCase(), add: (o.ADD_TYPE || "").toUpperCase() });
    }
    return out.sort((a, b) => a.row - b.row);
  }
  // package frame → board frame; conventions differ between exporters, pick the one matching absolute pin positions
  const CONV = [
    (x, y, r, m) => { if (m) x = -x; return G.rotM(x, y, -r); },  // mirror, then clockwise
    (x, y, r, m) => { const q = G.rotM(x, y, -r); if (m) q[0] = -q[0]; return q; },
    (x, y, r, m) => { if (m) x = -x; return G.rotM(x, y, r); },
    (x, y, r, m) => { const q = G.rotM(x, y, r); if (m) q[0] = -q[0]; return q; },
    (x, y, r) => G.rotM(x, y, -r),   // package data already flipped for bottom parts (KiCad 9/10 export)
    (x, y, r) => G.rotM(x, y, r),
  ];

  async function parse(files) {
    const by = re => files.find(f => re.test(f.path));
    const stepName = ((files.map(f => f.path.match(/^steps\/([^/]+)\//i)).find(Boolean)) || [])[1];
    if (!stepName) throw new Error("ODB++ 里没有 steps 目录");
    const P = (rel) => files.find(f => f.path.toLowerCase().replace(/\.z$/, "") === `steps/${stepName}/${rel}`.toLowerCase());
    const edaF = P("eda/data"); if (!edaF) throw new Error("ODB++ 里没有 eda/data（器件封装和网络）");
    const eda = parseEda(await readText(edaF));
    const matF = by(/^matrix\/matrix(\.z)?$/i), matrix = matF ? parseMatrix(await readText(matF)) : [];
    const b = G.newBoard(), edgePts = [];
    const profF = P("profile");
    if (profF) { const f = parseFeatures(await readText(profF)); for (const poly of f.surfaces) { const pts = poly.map(flip); b.edges += G.polyD(pts); edgePts.push(...pts); } }
    // copper / silk / drill layers
    const cu = matrix.filter(l => l.ctx === "BOARD" && /SIGNAL|POWER_GROUND|MIXED/.test(l.type));
    const topCu = cu[0], botCu = cu[cu.length - 1];
    const layerFile = l => P(`layers/${l.name}/features`);
    const tr = { F: [], B: [] };
    for (const [side, l] of [["F", topCu], ["B", botCu]]) { if (!l || (side === "B" && cu.length < 2)) continue; const f = layerFile(l); if (!f) continue; const ft = parseFeatures(await readText(f)); for (const ln of ft.lines) if (ln.dark) tr[side].push([ln.w, G.lineD(ln.pts.map(flip))]); }
    b.tracks = { F: G.groupTracks(tr.F), B: G.groupTracks(tr.B) };
    for (const l of matrix.filter(l => l.type === "SILK_SCREEN")) {
      const side = topCu && l.row < topCu.row ? "F" : botCu && l.row > botCu.row ? "B" : /bot|^b\./.test(l.name) ? "B" : "F";
      const f = layerFile(l); if (!f) continue; const ft = parseFeatures(await readText(f));
      b.silk[side] += ft.lines.map(ln => G.lineD(ln.pts.map(flip))).join("");
    }
    const holes = [];
    for (const l of matrix.filter(l => l.type === "DRILL")) { const f = layerFile(l); if (!f) continue; const ft = parseFeatures(await readText(f)); const plated = !/non.?plated|npth/i.test(l.name + " " + l.add); for (const p of ft.pads) holes.push({ x: p.x, y: -p.y, d: p.d, plated }); }
    const hg = holes;

    // components
    const convCount = CONV.map(() => 0);
    for (const [side, rel] of [["F", "layers/comp_+_top/components"], ["B", "layers/comp_+_bot/components"]]) {
      const f = P(rel); if (!f) continue;
      for (const c of parseComps(await readText(f))) {
        const pkg = eda.pkgs[c.pkg] || { name: "", outline: [], pins: [] };
        // choose the transform convention using absolute pin centres
        let ci = convCount.indexOf(Math.max(...convCount));
        if (c.pins.length) {
          let best = 1e9;
          CONV.forEach((fn, i) => { let e = 0; for (const tp of c.pins) { const pp = pkg.pins[tp.idx]; if (!pp) continue; const q = fn(pp.x, pp.y, c.rot, c.mir); e += Math.hypot(q[0] + c.x - tp.x, q[1] + c.y - tp.y); } if (e < best - 1e-9) { best = e; ci = i; } });
          convCount[ci]++;
        }
        const T = ([x, y]) => { const q = CONV[ci](x, y, c.rot, c.mir); return flip([q[0] + c.x, q[1] + c.y]); };
        const pins = c.pins.length ? c.pins : pkg.pins.map((p, i) => ({ idx: i, net: -1, name: p.name }));
        const pads = pins.map(tp => {
          const pp = pkg.pins[tp.idx] || { name: tp.name, x: tp.x - c.x, y: tp.y - c.y, shapes: [] };
          let polys = pp.shapes.map(poly => poly.map(T));
          if (!polys.length) { const ctr = tp.x !== undefined ? flip([tp.x, tp.y]) : T([pp.x, pp.y]); polys = [G.circ(ctr[0], ctr[1], 0.25)]; }
          const bb = G.bboxOf(polys.flat()), mx = (bb[0] + bb[2]) / 2, my = (bb[1] + bb[3]) / 2;
          const h = hg.find(h => Math.abs(h.x - mx) < 0.03 && Math.abs(h.y - my) < 0.03);
          const kind = h ? (h.plated ? 1 : 2) : (pp.type === "T" ? 1 : 0);
          return G.padRec(tp.name || pp.name, tp.net >= 0 ? eda.nets[tp.net] || "" : "", polys, kind, h ? G.polyD(G.circ(h.x, h.y, h.d / 2, 20).reverse()) : "");
        });
        const body = pkg.outline.map(o => G.polyD(o.map(T))).join("");
        const bpts = pkg.outline.flatMap(o => o.map(T));
        let bb = G.bboxOf(pads.flatMap(p => [[p[7][0], p[7][1]], [p[7][2], p[7][3]]]).concat(bpts));
        const ctr = flip([c.x, c.y]);
        if (!G.validBB(bb)) bb = [ctr[0] - .5, ctr[1] - .5, ctr[0] + .5, ctr[1] + .5];
        const props = { ...c.props };
        const val = props.Value || props.VALUE || props.value || props.Comment || props.COMMENT || "";
        const mpn = Object.entries(props).find(([k]) => /part.?number|^mpn$|manufacturer.?part/i.test(k)); if (mpn) props.MPN = mpn[1];
        const lcsc = Object.entries(props).find(([k]) => /lcsc|jlc/i.test(k)); if (lcsc) props.LCSC = lcsc[1];
        const p1 = pads.find(p => p[0] === "1");
        b.parts.push({ r: c.ref, s: side, c: ctr.map(G.f3), rot: c.rot, bb: bb.map(G.f3), pads, body, silk: "", val, fp: pkg.name, props, sheet: "",
          p1: p1 ? [p1[4], p1[5]] : null, tht: pads.length && pads.every(p => p[3] !== 0) ? 1 : 0, dnp: 0, nobom: 0 });
      }
    }
    for (const h of holes) if (h.plated && h.d < 0.5 && !b.parts.some(p => p.pads.some(q => Math.abs(q[4] - h.x) < 0.03 && Math.abs(q[5] - h.y) < 0.03))) b.vias.push([G.f3(h.x), G.f3(h.y), G.f3(h.d / 2 + 0.12)]);
    b._conv = convCount;
    return G.finishBoard(b, edgePts);
  }
  return { parse };
})();
