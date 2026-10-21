// 嘉立创EDA专业版 / EasyEDA Pro importer: .epro (zip), .epru (project backup), .epcb + .efoo.
// Each document is a list of lines `{"type":..,"id":..}||{body}|`, starting with a DOCHEAD line.
globalThis.ImpEasyEDA = (() => {
  const G = Geom, MIL = 0.0254;
  const isDoc = head => /^\s*\{"type":"DOCHEAD"\}\|\|/.test(head);

  function docs(text) {
    const out = []; let cur = null;
    for (const line of text.split(/\r?\n/)) {
      const k = line.indexOf("||"); if (k < 0) continue;
      let h, b;
      try { h = JSON.parse(line.slice(0, k)); } catch (e) { continue; }
      const raw = line.slice(k + 2).replace(/\|\s*$/, "");
      try { b = raw ? JSON.parse(raw) : {}; } catch (e) { b = raw; }
      if (h.type === "DOCHEAD") { cur = { head: b || {}, recs: [] }; out.push(cur); continue; }
      if (!cur) { cur = { head: { docType: "PCB" }, recs: [] }; out.push(cur); }
      cur.recs.push({ type: h.type, id: h.id, b });
    }
    return out;
  }

  // EasyEDA path → list of point runs (Y up, mil). Supports L, ARC/CARC, R, CIRCLE, nested arrays.
  function pathRuns(path) {
    if (!Array.isArray(path) || !path.length) return [];
    if (Array.isArray(path[0])) return path.flatMap(pathRuns);
    if (path[0] === "R") { const [, x, y, w, h] = path.map(Number); return [[[x, y], [x + w, y], [x + w, y - h], [x, y - h], [x, y]]]; }
    if (path[0] === "CIRCLE") { const [, cx, cy, r] = path.map(Number); const c = G.circ(cx, cy, r, 28); return [c.concat([c[0]])]; }
    const runs = []; let run = [], i = 0, cmd = "L";
    const num = v => typeof v === "number" || (typeof v === "string" && v !== "" && !isNaN(+v));
    while (i < path.length) {
      const t = path[i];
      if (!num(t)) { cmd = String(t).toUpperCase(); i++; continue; }
      if (!run.length) { run.push([+path[i], +path[i + 1]]); i += 2; continue; }
      if (cmd === "ARC" || cmd === "CARC") {
        const ang = +path[i], x = +path[i + 1], y = +path[i + 2]; i += 3;
        run.push(...arcByAngle(run[run.length - 1], [x, y], ang));
      } else if (cmd === "C") { // cubic bezier: c1x c1y c2x c2y x y
        const p0 = run[run.length - 1], c1 = [+path[i], +path[i + 1]], c2 = [+path[i + 2], +path[i + 3]], p3 = [+path[i + 4], +path[i + 5]]; i += 6;
        for (let k = 1; k <= 8; k++) { const t2 = k / 8, u = 1 - t2; run.push([u * u * u * p0[0] + 3 * u * u * t2 * c1[0] + 3 * u * t2 * t2 * c2[0] + t2 * t2 * t2 * p3[0], u * u * u * p0[1] + 3 * u * u * t2 * c1[1] + 3 * u * t2 * t2 * c2[1] + t2 * t2 * t2 * p3[1]]); }
      } else { run.push([+path[i], +path[i + 1]]); i += 2; }
    }
    if (run.length) runs.push(run);
    return runs;
  }
  // arc from a to b sweeping `ang` degrees (positive = counter-clockwise, Y up)
  function arcByAngle(a, b, ang) {
    if (!ang || Math.abs(ang) < 1e-6) return [b];
    const th = Math.abs(ang) * Math.PI / 180, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy); if (d < 1e-9) return [b];
    const r = d / 2 / Math.sin(th / 2), h = r * Math.cos(th / 2);
    const nx = -dy / d, ny = dx / d, sgn = ang > 0 ? 1 : -1;
    const c = [mx + nx * h * sgn, my + ny * h * sgn];
    return G.arcPts(a, b, c, ang < 0, 8);
  }
  function padPolys(dp, pad) {
    if (!dp) return [];
    const w = (+dp.width || 0) * MIL, h = (+dp.height || +dp.width || 0) * MIL;
    switch (String(dp.padType || "").toUpperCase()) {
      case "ELLIPSE": case "CIRCLE": return [Math.abs(w - h) < 1e-6 ? G.circ(0, 0, w / 2) : G.circ(0, 0, 1).map(([x, y]) => [x * w / 2, y * h / 2])];
      case "OVAL": return [G.rrect(w, h, Math.min(w, h) / 2, 6)];
      case "POLYGON": case "POLYLINE": return pathRuns(dp.path).map(r => r.map(([x, y]) => [x * MIL, y * MIL]));
      case "RECT": default: { const r = +dp.radius || 0; return [G.rrect(w, h, r <= 0 ? 0 : r <= 1 ? r * Math.min(w, h) / 2 : r * MIL)]; } // radius: ratio (≤1) or mil
    }
  }

  function build(pcb, pool) {
    const b = G.newBoard(), edgePts = [];
    const recs = pcb.recs, canvas = recs.find(r => r.type === "CANVAS");
    const flip = ([x, y]) => [x * MIL, -y * MIL];
    const attrs = {}; const padNet = {};
    for (const r of recs) {
      if (r.type === "ATTR" && r.b && r.b.parentId) (attrs[r.b.parentId] ||= {})[r.b.key] = r.b.value;
      if (r.type === "PAD_NET") { let id; try { id = JSON.parse(r.id); } catch (e) { continue; } const [, comp, num, padId] = id; const net = (r.b && r.b.padNet) || ""; padNet[comp + "|id|" + padId] = net; padNet[comp + "|n|" + num] = net; }
    }
    // board outline and silk
    const tracks = { F: [], B: [] }, silk = { F: [], B: [] };
    for (const r of recs) {
      const o = r.b; if (!o || typeof o !== "object") continue;
      const L = o.layerId;
      if ((r.type === "POLY" || r.type === "FILL") && L === 11) for (const run of pathRuns(o.path)) { const pts = run.map(flip); b.edges += G.lineD(pts); edgePts.push(...pts); }
      else if ((r.type === "POLY" || r.type === "LINE") && (L === 3 || L === 4)) {
        const runs = r.type === "LINE" ? [[[o.startX, o.startY], [o.endX, o.endY]]] : pathRuns(o.path);
        for (const run of runs) silk[L === 3 ? "F" : "B"].push(G.lineD(run.map(flip)));
      } else if (r.type === "LINE" && (L === 1 || L === 2)) tracks[L === 1 ? "F" : "B"].push([o.width * MIL, G.lineD([flip([o.startX, o.startY]), flip([o.endX, o.endY])])]);
      else if (r.type === "ARC" && (L === 1 || L === 2) && o.startX !== undefined) tracks[L === 1 ? "F" : "B"].push([o.width * MIL, G.lineD([[o.startX, o.startY], ...arcByAngle([o.startX, o.startY], [o.endX, o.endY], o.arcAngle ?? o.angle ?? 0)].map(flip))]);
      else if (r.type === "VIA") b.vias.push([G.f3(o.centerX * MIL), G.f3(-o.centerY * MIL), G.f3((o.viaDiameter || 20) * MIL / 2)]);
    }
    b.tracks = { F: G.groupTracks(tracks.F), B: G.groupTracks(tracks.B) };
    b.silk = { F: silk.F.join(""), B: silk.B.join("") };

    const fpCache = {};
    const footprintOf = uuid => {
      if (!uuid) return null;
      if (uuid in fpCache) return fpCache[uuid];
      const d = pool.foot[uuid]; if (!d) return fpCache[uuid] = null;
      const pads = [], body = [], sk = [], bound = [];
      let name = "";
      for (const r of d.recs) {
        const o = r.b; if (!o || typeof o !== "object") continue;
        if (r.type === "ATTR" && o.key === "Name") name = o.value;
        if (r.type === "PAD") pads.push(o);
        else if ((r.type === "POLY" || r.type === "FILL") && o.layerId === 3) sk.push(...pathRuns(o.path));
        else if ((r.type === "POLY" || r.type === "FILL") && (o.layerId === 9 || o.layerId === 13)) body.push(...pathRuns(o.path));
        else if ((r.type === "POLY" || r.type === "FILL") && o.layerId === 71) bound.push(...pathRuns(o.path));
        else if (r.type === "LINE" && o.layerId === 3) sk.push([[o.startX, o.startY], [o.endX, o.endY]]);
      }
      return fpCache[uuid] = { name: name || (d.head.title || ""), pads, body: body.length ? body : bound, sk };
    };
    const devOf = uuid => pool.dev[uuid] || null;

    for (const r of recs) {
      if (r.type !== "COMPONENT" || !r.b) continue;
      const o = r.b, A = attrs[r.id] || {};
      const dev = devOf(A.Device), da = (dev && dev.attrs) || {};
      const ref = A.Designator || da.Designator || ""; if (!ref || /\?$/.test(ref)) continue;
      const fp = footprintOf(A.Footprint || da.Footprint);
      const bottom = o.layerId === 2, ang = +o.angle || 0;
      // footprint (Y up, mil) → board (Y up, mil): bottom-side parts are mirrored across the X axis, then rotated
      // (checked against EasyEDA's own flying-probe export and against Allegro for the same board)
      const T = ([x, y]) => { if (bottom) y = -y; const q = G.rotM(x, y, ang); return flip([q[0] + o.x, q[1] + o.y]); };
      const pads = [];
      if (fp) for (const pd of fp.pads) {
        const local = padPolys(pd.defaultPad, pd).map(poly => poly.map(([x, y]) => { const q = G.rotM(x, y, +pd.padAngle || 0); return [q[0] / MIL + pd.centerX, q[1] / MIL + pd.centerY]; }));
        const polys = local.map(poly => poly.map(T));
        const hole = pd.hole && (+pd.hole.width > 0) ? pd.hole : null;
        const kind = hole ? (pd.plated === false ? 2 : 1) : 0;
        let holeD = "";
        if (hole) { const c = T([pd.centerX, pd.centerY]), hw = hole.width * MIL, hh = (hole.height || hole.width) * MIL; holeD = G.polyD((Math.abs(hw - hh) < 1e-6 ? G.circ(c[0], c[1], hw / 2, 20) : G.rrect(hw, hh, Math.min(hw, hh) / 2, 6).map(([x, y]) => [x + c[0], y + c[1]])).reverse()); }
        const net = padNet[r.id + "|id|" + pd.__id] ?? padNet[r.id + "|n|" + (pd.num ?? "")] ?? "";
        pads.push(G.padRec(pd.num ?? "", net, polys, kind, holeD));
      }
      const c = T([0, 0]);
      const body = fp ? fp.body.map(run => G.lineD(run.map(T))).join("") : "";
      const sk = fp ? fp.sk.map(run => G.lineD(run.map(T))).join("") : "";
      const bpts = fp ? fp.body.flatMap(run => run.map(T)) : [];
      let bb = G.bboxOf(pads.flatMap(p => [[p[7][0], p[7][1]], [p[7][2], p[7][3]]]).concat(bpts));
      if (!G.validBB(bb)) bb = [c[0] - .5, c[1] - .5, c[0] + .5, c[1] + .5];
      const props = { ...da, ...(o.attrs || {}), ...A };
      const resolve = v => String(v ?? "").replace(/^=/, "").replace(/\{([^}]+)\}/g, (m, k) => props[k] ?? "").trim();
      delete props.Device; delete props.Footprint; delete props.Symbol;
      const lcsc = props["Supplier Part"] || props["LCSC Part"] || props["LCSC"] || props["Supplier Part Number"] || "";
      if (lcsc) props.LCSC = lcsc;
      if (props["Manufacturer Part"]) props.MPN = props["Manufacturer Part"];
      const p1 = pads.find(p => p[0] === "1");
      const tht = pads.length && pads.every(p => p[3] !== 0) ? 1 : 0;
      b.parts.push({ r: ref, s: bottom ? "B" : "F", c: c.map(G.f3), rot: ang, bb: bb.map(G.f3), pads, body, silk: sk,
        val: resolve(A.Value || (o.attrs && o.attrs.Value) || da.Value || props.Name || ""), fp: (fp && fp.name) || (dev && dev.title) || "", props, sheet: "", p1: p1 ? [p1[4], p1[5]] : null,
        tht, dnp: /^(yes|true|1)$/i.test(String(A["Do Not Place"] ?? A.DNP ?? "")) ? 1 : 0, nobom: /^(no|false|0)$/i.test(String(A["Add into BOM"] ?? "yes")) ? 1 : 0 });
    }
    // free pads placed directly on the board (test points, mounting holes)
    for (const r of recs) {
      if (r.type !== "PAD" || !r.b || !r.b.num) continue;
      const pd = r.b, polys = padPolys(pd.defaultPad, pd).map(poly => poly.map(([x, y]) => { const q = G.rotM(x, y, +pd.padAngle || 0); return flip([q[0] / MIL + pd.centerX, q[1] / MIL + pd.centerY]); }));
      const kind = pd.hole && +pd.hole.width > 0 ? (pd.plated === false ? 2 : 1) : 0;
      const rec = G.padRec("1", pd.netName || "", polys, kind);
      const bb = rec[7];
      b.parts.push({ r: pd.num, s: pd.layerId === 2 ? "B" : "F", c: [rec[4], rec[5]], rot: 0, bb: bb.map(G.f3), pads: [rec], body: "", silk: "", val: pd.padType || "", fp: "PAD",
        props: {}, sheet: "", p1: null, tht: kind ? 1 : 0, dnp: 0, nobom: 1 });
    }
    return G.finishBoard(b, edgePts);
  }

  // gather every document from all EasyEDA files of a project and build one board per PCB document
  // items: strings or {text, name}; one board per PCB document (multi-board projects keep each board's own title)
  function parseProject(items) {
    const pool = { foot: {}, dev: {}, pcbs: [], boards: {} };
    for (const it of items) for (const d of docs(typeof it === "string" ? it : it.text)) {
      d.src = typeof it === "string" ? "" : it.name || "";
      const type = String(d.head.docType || "").toUpperCase(), uuid = d.head.uuid;
      if (type === "FOOTPRINT") {
        // keep record ids on pads so PAD_NET can match by pad id
        for (const r of d.recs) if (r.type === "PAD" && r.b && typeof r.b === "object") r.b.__id = r.id;
        if (uuid) pool.foot[uuid] = d;
      } else if (type === "DEVICE") {
        const meta = d.recs.find(r => r.type === "META");
        if (uuid) pool.dev[uuid] = { attrs: (meta && meta.b && meta.b.attributes) || {}, title: meta && meta.b && meta.b.title };
      } else if (type === "BOARD") { const meta = d.recs.find(r => r.type === "META"); if (uuid) pool.boards[uuid] = (meta && meta.b && meta.b.title) || ""; }
      else if (type === "PCB") pool.pcbs.push(d);
    }
    return pool.pcbs.map(p => {
      const meta = p.recs.find(r => r.type === "META"), board = build(p, pool);
      const withPads = board.parts.filter(q => q.pads.length && q.fp !== "PAD").length, comps = board.parts.filter(q => q.fp !== "PAD").length;
      // a PCB document hangs under a BOARD (PCB + schematic); its title tells archived/old boards apart from the current one
      const boardTitle = (meta && meta.b && pool.boards[meta.b.board]) || "";
      return { board, title: (meta && meta.b && meta.b.title) || p.head.title || "", boardTitle, uuid: p.head.uuid, time: +p.head.updateTime || 0, src: p.src, padCoverage: comps ? withPads / comps : 0, comps };
    });
  }
  return { parseProject, docs, isDoc, pathRuns };
})();
