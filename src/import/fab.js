// Builds a board from manufacturing outputs that every EDA tool can produce:
// Gerber (+ drill) for geometry, pick-and-place (坐标文件) for parts, optional IPC-D-356 / JLC flying-probe for pins & nets.
globalThis.ImpFab = (() => {
  const G = Geom;
  const flip = ([x, y]) => [x, -y];

  // spatial hash for nearest-point queries
  function grid(items, cell = 1) {
    const m = new Map(), key = (i, j) => i * 100003 + j;
    for (const it of items) { const k = key(Math.floor(it.x / cell), Math.floor(it.y / cell)); let a = m.get(k); if (!a) m.set(k, a = []); a.push(it); }
    return {
      near(x, y, r) { const out = [], i0 = Math.floor((x - r) / cell), i1 = Math.floor((x + r) / cell), j0 = Math.floor((y - r) / cell), j1 = Math.floor((y + r) / cell);
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const a = m.get(key(i, j)); if (a) for (const it of a) if (Math.hypot(it.x - x, it.y - y) <= r) out.push(it); } return out; },
      nearest(x, y, rmax = 3) { let best = null, bd = rmax; for (const it of this.near(x, y, rmax)) { const d = Math.hypot(it.x - x, it.y - y); if (d < bd) { bd = d; best = it; } } return best ? { it: best, d: bd } : null; },
    };
  }
  const med = v => { const s = v.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };

  // find transform (scale for unit, y sign, offset) that maps CPL points onto pad geometry
  function alignCPL(cpl, pads, padRefs) {
    const opts = [];
    const scales = cpl.explicit ? [1] : [1, 0.0254, 25.4, 1 / 0.0254].filter((v, i, a) => a.indexOf(v) === i);
    for (const sc of scales) for (const sy of [1, -1]) opts.push({ sc, sy });
    let best = null;
    if (padRefs) { // pads know their reference designators: compare centroids directly
      const cen = {};
      for (const p of pads) if (p.ref) { const c = cen[p.ref] ||= { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 }; c.x0 = Math.min(c.x0, p.x); c.y0 = Math.min(c.y0, p.y); c.x1 = Math.max(c.x1, p.x); c.y1 = Math.max(c.y1, p.y); }
      for (const o of opts) {
        const dx = [], dy = [];
        for (const r of cpl.rows) { const c = cen[r.ref]; if (!c) continue; dx.push((c.x0 + c.x1) / 2 - r.x * o.sc); dy.push((c.y0 + c.y1) / 2 - r.y * o.sc * o.sy); }
        if (!dx.length) continue;
        const ox = med(dx), oy = med(dy);
        const res = med(cpl.rows.filter(r => cen[r.ref]).map(r => { const c = cen[r.ref]; return Math.hypot((c.x0 + c.x1) / 2 - r.x * o.sc - ox, (c.y0 + c.y1) / 2 - r.y * o.sc * o.sy - oy); }));
        if (!best || res < best.res) best = { ...o, ox, oy, res };
      }
      return best;
    }
    // no designators on pads: part centres sit midway between neighbouring pads (true for passives, most ICs),
    // so align CPL points to those midpoints using a robust (median) score; keep the given origin when it already fits.
    const pg = grid(pads, 1.5), targets = [];
    for (const p of pads) { // midpoints with the 3 nearest neighbours (the partner pad is not always the closest one)
      targets.push({ x: p.x, y: p.y });
      const nb = pg.near(p.x, p.y, 4).filter(q => q !== p).map(q => [Math.hypot(q.x - p.x, q.y - p.y), q]).sort((a, b) => a[0] - b[0]).slice(0, 3);
      for (const [, q] of nb) targets.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
    }
    const g = grid(targets, 1);
    const score = (o, ox, oy) => { const ds = cpl.rows.map(r => { const n = g.nearest(r.x * o.sc + ox, r.y * o.sc * o.sy + oy, 3); return n ? n.d : 3; }); return med(ds); };
    const pb = G.bboxOf(pads.map(p => [p.x, p.y]));
    for (const o of opts) {
      const z = score(o, 0, 0);
      if (z < 0.1) { if (!best || z < best.res) best = { ...o, ox: 0, oy: 0, res: z }; continue; }
      const cb = G.bboxOf(cpl.rows.map(r => [r.x * o.sc, r.y * o.sc * o.sy]));
      const starts = [[0, 0], [(pb[0] + pb[2]) / 2 - (cb[0] + cb[2]) / 2, (pb[1] + pb[3]) / 2 - (cb[1] + cb[3]) / 2], [pb[0] - cb[0], pb[1] - cb[1]]];
      for (const [sx, sy0] of starts) {
        let cx = sx, cy = sy0, cs = score(o, cx, cy);
        for (const step of [2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01]) {
          let improved = true, guard = 0;
          while (improved && guard++ < 60) {
            improved = false;
            for (const [ddx, ddy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) { const sc2 = score(o, cx + ddx, cy + ddy); if (sc2 < cs - 1e-6) { cs = sc2; cx += ddx; cy += ddy; improved = true; } }
          }
        }
        if (!best || cs < best.res - 1e-6) best = { ...o, ox: cx, oy: cy, res: cs };
      }
      if (best && best.sc === o.sc && best.sy === o.sy && z <= best.res + 0.03) best = { ...o, ox: 0, oy: 0, res: z }; // keep the file's own origin unless clearly worse
    }
    return best;
  }

  // inputs: {layers:{cuF,cuB,pasteF,pasteB,silkF,silkB,outline}: parsed gerbers, holes:[...], cpl, net:{pads, comps, source}, names}
  function build(inp) {
    const b = G.newBoard(), warn = [], edgePts = [];
    const L = inp.layers;
    // outline
    if (L.outline) {
      for (const d of L.outline.draws) { const pts = d.pts.map(flip); b.edges += G.lineD(pts); edgePts.push(...pts); }
      for (const r of L.outline.regions) { const pts = r.pts.map(flip); b.edges += G.polyD(pts); edgePts.push(...pts); }
    } else warn.push("没有板框层，板子外形按焊盘范围估计");
    // tracks & silk
    const tr = { F: [], B: [] };
    for (const [s, l] of [["F", L.cuF], ["B", L.cuB]]) if (l) for (const d of l.draws) if (d.dark) tr[s].push([d.w, G.lineD(d.pts.map(flip))]);
    b.tracks = { F: G.groupTracks(tr.F), B: G.groupTracks(tr.B) };
    for (const [s, l] of [["F", L.silkF], ["B", L.silkB]]) if (l) b.silk[s] = l.draws.map(d => G.lineD(d.pts.map(flip))).join("") + l.regions.map(r => G.polyD(r.pts.map(flip))).join("");
    const holes = inp.holes || [];
    const hg = grid(holes, 1);
    const flashOf = { F: L.cuF ? L.cuF.flashes.filter(f => f.dark) : [], B: L.cuB ? L.cuB.flashes.filter(f => f.dark) : [] };
    const fg = { F: grid(flashOf.F, 1), B: grid(flashOf.B, 1) };
    const shapeAt = (f) => f.sh.polys.map(poly => poly.map(([x, y]) => flip([x + f.x, y + f.y])));

    // ---- pads ----
    let pads = [], padRefs = false;
    if (inp.net && inp.net.pads && inp.net.pads.length) {
      padRefs = true;
      for (const q of inp.net.pads) {
        if (q.via) { b.vias.push([G.f3(q.x), G.f3(-q.y), G.f3(Math.max(q.hole, 0.3) / 2 + 0.1)]); continue; }
        const side = q.side === "B" ? "B" : "F";
        const hit = fg[side].nearest(q.x, q.y, 0.05) || (q.side === "T" ? fg.B.nearest(q.x, q.y, 0.05) : null);
        let polys;
        if (hit) polys = shapeAt(hit.it);
        else { const w = q.w || 0.5, h = q.h || q.w || 0.5; polys = [(/^[CE]/i.test(q.shape || "") ? G.circ(0, 0, w / 2) : G.rect(w, h)).map(([x, y]) => { const r = G.rotM(x, y, q.rot || 0); return flip([r[0] + q.x, r[1] + q.y]); })]; }
        pads.push({ ref: q.ref, pin: q.pin, net: q.net, x: q.x, y: q.y, side: q.side === "T" ? "T" : side, polys, hole: q.hole || 0, plated: q.plated !== false });
      }
    } else {
      const x2 = flashOf.F.concat(flashOf.B).some(f => f.attrs && f.attrs.P);
      if (x2) {
        padRefs = true;
        for (const s of ["F", "B"]) for (const f of flashOf[s]) { const P = f.attrs.P; if (!P) continue; const h = hg.nearest(f.x, f.y, 0.05); pads.push({ ref: P[0], pin: P[1] || "", net: (f.attrs.N || [""])[0], x: f.x, y: f.y, side: h ? "T" : s, polys: shapeAt(f), hole: h ? h.it.d : 0, plated: h ? h.it.plated !== false : true }); }
      } else {
        // geometry only: SMD pads come from paste flashes, plated-hole pads from copper flashes on drill hits
        for (const s of ["F", "B"]) {
          const paste = L["paste" + s], cu = flashOf[s];
          const used = new Set();
          // paste openings → the copper pad that contains them (an exposed pad may have several paste windows)
          const holder = pf => { let best = null, area = 1e9; for (const f of fg[s].near(pf.x, pf.y, 6)) { const bb = G.bboxOf(f.sh.polys.flat()); if (pf.x >= f.x + bb[0] - 0.01 && pf.x <= f.x + bb[2] + 0.01 && pf.y >= f.y + bb[1] - 0.01 && pf.y <= f.y + bb[3] + 0.01) { const a = (bb[2] - bb[0]) * (bb[3] - bb[1]); if (a < area) { area = a; best = f; } } } return best; };
          if (paste) for (const pf of paste.flashes) { const f = holder(pf) || pf; if (used.has(f)) continue; used.add(f); pads.push({ ref: "", pin: "", net: "", x: f.x, y: f.y, side: s, polys: shapeAt(f), hole: 0, plated: true }); }
          for (const f of cu) {
            if (used.has(f)) continue;
            const h = hg.nearest(f.x, f.y, 0.05);
            if (h) { if (s === "B" && fg.F.nearest(f.x, f.y, 0.05)) continue; if (!h.it.via && (h.it.d >= 0.5 || h.it.plated === false)) pads.push({ ref: "", pin: "", net: "", x: f.x, y: f.y, side: "T", polys: shapeAt(f), hole: h.it.d, plated: h.it.plated !== false }); }
            else if (!paste) pads.push({ ref: "", pin: "", net: "", x: f.x, y: f.y, side: s, polys: shapeAt(f), hole: 0, plated: true });
          }
        }
        warn.push("没有 IPC-356 网表或飞针文件：焊盘按距离归到最近的器件，没有引脚编号和网络，“测引脚”不可用");
      }
    }
    if (!b.vias.length) for (const h of holes) if (h.plated !== false && (h.via || h.d < 0.5) && !pads.some(p => Math.abs(p.x - h.x) < 0.05 && Math.abs(p.y - h.y) < 0.05)) b.vias.push([G.f3(h.x), G.f3(-h.y), G.f3(h.d / 2 + 0.12)]);

    // ---- components ----
    const comps = new Map();
    let cplInfo = null;
    if (inp.cpl && inp.cpl.rows.length) {
      const al = (pads.length && alignCPL(inp.cpl, pads, padRefs)) || { sc: 1, sy: 1, ox: 0, oy: 0, res: 0 }; // no copper (placement-only): nothing to align to
      cplInfo = al;
      if (Math.abs(al.ox) > 0.05 || Math.abs(al.oy) > 0.05) warn.push(`坐标文件与 Gerber 原点不同，已自动对齐（偏移 ${al.ox.toFixed(2)}, ${al.oy.toFixed(2)} mm）`);
      if (al.sc !== 1) warn.push(`坐标文件单位按 ${al.sc === 0.0254 ? "mil" : al.sc === 25.4 ? "inch" : "mm"} 处理`);
      if (al.sy === -1) warn.push("坐标文件的 Y 轴方向与 Gerber 相反，已翻转");
      if (al.res > 1) warn.push(`坐标文件和 Gerber 对不太上（平均偏差 ${al.res.toFixed(2)} mm），器件位置可能不准`);
      for (const r of inp.cpl.rows) comps.set(r.ref, { ref: r.ref, x: r.x * al.sc + al.ox, y: r.y * al.sc * al.sy + al.oy, rot: r.rot, side: r.side, val: r.val, fp: r.fp, pads: [] });
    } else if (inp.net && inp.net.comps && inp.net.comps.length) {
      for (const c of inp.net.comps) comps.set(c.ref, { ...c, val: "", fp: "", pads: [] });
    }
    if (padRefs) {
      for (const p of pads) {
        if (!p.ref) continue;
        let c = comps.get(p.ref);
        if (!c) { c = { ref: p.ref, x: null, y: null, rot: 0, side: null, val: "", fp: "", pads: [] }; comps.set(p.ref, c); }
        c.pads.push(p);
      }
    } else if (comps.size) {
      // Most footprints are point-symmetric about their centre: a pad whose mirror image through a part's centre is
      // also a pad (same size) very likely belongs to that part. Fall back to the nearest centre otherwise.
      const cg = grid([...comps.values()], 2), padG = grid(pads, 1);
      const R0 = { "01005": 0.35, "0201": 0.55, "0402": 0.85, "0603": 1.2, "0805": 1.5, "1206": 2.1, "1210": 2.1, "1812": 3, "2010": 3, "2512": 3.6 };
      const maxR = c => {
        const f = (c.fp || (inp.bom && inp.bom[c.ref] && inp.bom[c.ref].fp) || "");
        const k = (f.match(/(?:^|[^0-9])(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)(?![0-9])/) || [])[1];
        // imperial size codes only mean chip size for R/C/D/LED or a plain "L0402"-style name — "MWSA0402" is a 4×4 mm power inductor
        const chipLike = /^(R|C|FB|D|LED|RN)\d/i.test(c.ref) || /^(L|IND)?_?(01005|0201|0402|0603|0805|1206)(_|$)/i.test(f.trim());
        if (k && chipLike) return R0[k];
        if (/SOD-?(323|523|923)|SC-?79/i.test(f)) return 1.6; if (/SOD-?123/i.test(f)) return 2.2; if (/SOT-?(23|323|523|363|353|563)|SC-?70|SC-?88/i.test(f)) return 1.8;
        if (/^(R|C|FB)\d/i.test(c.ref)) return 2.2;
        if (/^L\d/i.test(c.ref)) return 3.5;
        return 15;
      };
      const sz = p => { const bb = G.bboxOf(p.polys.flat()); return [bb[2] - bb[0], bb[3] - bb[1]]; };
      const sameSize = (a, b) => { const x = sz(a), y = sz(b); return Math.abs(Math.min(...x) - Math.min(...y)) < 0.03 && Math.abs(Math.max(...x) - Math.max(...y)) < 0.03; };
      const okSide = (p, c) => p.side === "T" || c.side === p.side;
      const left = [];
      // through-hole rows (pin headers, encoders…): link plated holes of equal size up to one 2.54 mm pitch apart and give
      // each linked group to the part whose placement point lies on it (THT footprints are often anchored at pin 1)
      const thtPads = pads.filter(p => p.hole > 0), claimed = new Set();
      if (thtPads.length) {
        const tg = grid(thtPads, 3), parent = new Map(thtPads.map(p => [p, p]));
        const find = p => { while (parent.get(p) !== p) { parent.set(p, parent.get(parent.get(p))); p = parent.get(p); } return p; };
        for (const p of thtPads) for (const q of tg.near(p.x, p.y, 2.6)) if (q !== p && Math.abs(q.hole - p.hole) < 0.05) parent.set(find(p), find(q));
        const groupsT = new Map(); for (const p of thtPads) { const r = find(p); if (!groupsT.has(r)) groupsT.set(r, []); groupsT.get(r).push(p); }
        for (const grp of groupsT.values()) {
          const owners = [...comps.values()].filter(c => grp.some(p => Math.hypot(p.x - c.x, p.y - c.y) < 0.3)); // a part anchored on one of the holes
          if (owners.length === 1) { owners[0].pads.push(...grp); grp.forEach(p => claimed.add(p)); continue; }
          if (owners.length > 1) {
            // several headers butted end to end. Order the holes along the row; parts anchored at pin 1 own the run from their
            // anchor up to the next anchor (or down to the previous one) — pick whichever reading leaves fewer holes unowned
            // the linked holes may form several parallel rows: split into rows in the direction where most anchors sit on a row
            const rowsOf = alongX => { const m = new Map(); for (const p of grp) { const k = Math.round((alongX ? p.y : p.x) / 0.1); if (!m.has(k)) m.set(k, []); m.get(k).push(p); } return m; };
            const onRow = (alongX, row) => owners.filter(c => row.some(p => Math.hypot(p.x - c.x, p.y - c.y) < 0.3));
            let alongX = true, best = -1;
            for (const ax of [true, false]) { let sc = 0; for (const row of rowsOf(ax).values()) if (onRow(ax, row).length) sc += row.length; if (sc > best) { best = sc; alongX = ax; } }
            const owner = new Map();
            for (const row of rowsOf(alongX).values()) {
              const t = p => alongX ? p.x : p.y;
              const anchors = onRow(alongX, row).map(c => ({ c, t: alongX ? c.x : c.y })).sort((a, b) => a.t - b.t);
              if (!anchors.length) continue;
              const assign = dir => row.map(p => { const v = t(p) + 1e-6 * dir; const a = dir > 0 ? anchors.filter(a => a.t <= v).pop() : anchors.find(a => a.t >= v); return a ? a.c : null; });
              const fwd = assign(1), back = assign(-1);
              const pick = fwd.filter(x => !x).length <= back.filter(x => !x).length ? fwd : back;
              row.forEach((p, i) => { if (pick[i]) owner.set(p, pick[i]); });
            }
            // rows without an anchor (second row of a 2×N header): follow the nearest already-owned hole
            for (let pass = 0; pass < 4; pass++) for (const p of grp) {
              if (owner.has(p)) continue;
              let b = null, bd = 2.7; for (const q of grp) { const o = owner.get(q); if (!o) continue; const d = Math.hypot(p.x - q.x, p.y - q.y); if (d < bd) { bd = d; b = o; } }
              if (b) owner.set(p, b);
            }
            for (const p of grp) {
              let b = owner.get(p);
              if (!b) { let bd = 1e9; for (const c of owners) { const d = Math.hypot(p.x - c.x, p.y - c.y); if (d < bd) { bd = d; b = c; } } }
              b.pads.push(p); claimed.add(p);
            }
          }
        }
      }
      for (const p of pads) {
        if (claimed.has(p)) continue;
        let best = null, bd = 1e9;
        for (const c of cg.near(p.x, p.y, 15)) {
          if (!okSide(p, c)) continue;
          const d = Math.hypot(c.x - p.x, c.y - p.y);
          if (d > maxR(c)) continue;
          const mx = 2 * c.x - p.x, my = 2 * c.y - p.y;
          const twin = d < 0.03 ? p : padG.near(mx, my, 0.04).find(q => q.side === p.side && sameSize(p, q));
          if (twin && d < bd) { bd = d; best = c; }
        }
        if (best) best.pads.push(p); else left.push(p);
      }
      // a symmetric "twin" can be a coincidence (e.g. a neighbouring connector's staggered rows): pads clearly farther
      // out than the rest of a part's pads (a jump in the distance profile) are released and reassigned below
      for (const c of comps.values()) {
        if (c.pads.length < 4) continue;
        const ds = c.pads.filter(p => !claimed.has(p)).map(p => [Math.hypot(p.x - c.x, p.y - c.y), p]).sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < ds.length; i++) {
          const gap = ds[i][0] - ds[i - 1][0];
          if (gap > Math.max(0.6, 0.15 * ds[i - 1][0]) && ds.length - i <= 0.4 * ds.length) {
            const out = new Set(ds.slice(i).map(x => x[1]));
            c.pads = c.pads.filter(p => !out.has(p)); left.push(...out);
            break;
          }
        }
      }
      // freeze each part's pad extent before the fallback, otherwise one stray pad grows the box and drags neighbours in
      const core = new Map([...comps.values()].map(c => [c, c.pads.length ? { bb: G.bboxOf(c.pads.map(q => [q.x, q.y])), pads: c.pads.slice() } : null]));
      for (const p of left) { // asymmetric pads (SOT-23 etc.): nearest part whose existing pads are close by
        let best = null, bd = 1e9;
        for (const c of cg.near(p.x, p.y, 12)) {
          if (!okSide(p, c)) continue;
          let d = Math.hypot(c.x - p.x, c.y - p.y);
          if (d > maxR(c) + 0.5) continue;
          const k = core.get(c);
          if (k) { const bb = k.bb; const dx = Math.max(bb[0] - p.x, 0, p.x - bb[2]), dy = Math.max(bb[1] - p.y, 0, p.y - bb[3]); d = Math.min(d, Math.hypot(dx, dy) + 0.2); }
          if (k && !k.pads.some(q => sameSize(p, q))) d *= 2.5; // a part rarely mixes pad sizes: prefer one that already has this size // a part rarely mixes pad sizes: prefer one that already has this size
          if (d < bd) { bd = d; best = c; }
        }
        if (best) best.pads.push(p);
      }
    } else warn.push("没有坐标文件，无法知道哪个焊盘属于哪个器件");

    for (const c of comps.values()) {
      const recs = c.pads.map(p => {
        const kind = p.hole > 0 ? (p.plated ? 1 : 2) : 0;
        const holeD = p.hole > 0 ? G.polyD(G.circ(p.x, -p.y, p.hole / 2, 20).reverse()) : "";
        return G.padRec(p.pin || "", p.net || "", p.polys, kind, holeD);
      });
      let side = c.side;
      if (!side) { const smd = c.pads.filter(p => p.side !== "T"); side = smd.length && smd.every(p => p.side === "B") ? "B" : "F"; }
      let bb = G.bboxOf(recs.flatMap(q => [[q[7][0], q[7][1]], [q[7][2], q[7][3]]]));
      const cx = c.x != null ? c.x : (bb[0] + bb[2]) / 2, cy = c.x != null ? -c.y : (bb[1] + bb[3]) / 2;
      if (!G.validBB(bb)) bb = [cx - .5, cy - .5, cx + .5, cy + .5];
      const m = 0.15, body = G.polyD([[bb[0] - m, bb[1] - m], [bb[2] + m, bb[1] - m], [bb[2] + m, bb[3] + m], [bb[0] - m, bb[3] + m]]);
      const p1 = recs.find(q => q[0] === "1");
      const tht = recs.length && recs.every(q => q[3] !== 0) ? 1 : 0;
      b.parts.push({ r: c.ref, s: side, c: [G.f3(cx), G.f3(cy)], rot: c.rot || 0, bb: [bb[0] - m, bb[1] - m, bb[2] + m, bb[3] + m].map(G.f3), pads: recs, body, silk: "",
        val: c.val || "", fp: c.fp || "", props: {}, sheet: "", p1: p1 ? [p1[4], p1[5]] : null, tht, dnp: 0, nobom: 0, nopin: padRefs ? 0 : 1 });
    }
    const board = G.finishBoard(b, edgePts);
    board.warn = warn;
    board.noNets = !padRefs || !pads.some(p => p.net);
    board.align = cplInfo;
    return board;
  }
  return { build, alignCPL };
})();
