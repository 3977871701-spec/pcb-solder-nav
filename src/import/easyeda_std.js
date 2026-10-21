// 嘉立创EDA标准版 / EasyEDA Standard PCB source (.json, head.docType "3"). Units: 10 mil, Y grows downward.
globalThis.ImpEasyStd = (() => {
  const G = Geom, K = 0.254; // 10 mil → mm
  const isStd = obj => obj && obj.head && String(obj.head.docType) === "3" && Array.isArray(obj.shape);
  const nums = s => String(s || "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
  const pairs = a => { const o = []; for (let i = 0; i + 1 < a.length; i += 2) o.push([a[i] * K, a[i + 1] * K]); return o; };
  // SVG path with absolute M/L/A/Z → point runs (mm)
  function pathRuns(d) {
    const tok = String(d || "").match(/[MLAZHVmlazhv]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
    const runs = []; let run = [], cmd = "M", i = 0, cur = [0, 0];
    const n = () => +tok[i++];
    while (i < tok.length) {
      if (/[A-Za-z]/.test(tok[i])) { cmd = tok[i++].toUpperCase(); if (cmd === "Z") { if (run.length) { run.push(run[0]); runs.push(run); run = []; } } continue; }
      if (cmd === "M") { if (run.length) runs.push(run); cur = [n(), n()]; run = [cur]; cmd = "L"; }
      else if (cmd === "L") { cur = [n(), n()]; run.push(cur); }
      else if (cmd === "H") { cur = [n(), cur[1]]; run.push(cur); }
      else if (cmd === "V") { cur = [cur[0], n()]; run.push(cur); }
      else if (cmd === "A") {
        const rx = n(), ry = n(); n(); const large = n(), sweep = n(), x = n(), y = n();
        const a = cur, b = [x, y], r = Math.max(rx, ry, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2);
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1], dd = Math.hypot(dx, dy) || 1e-9;
        const h = Math.sqrt(Math.max(0, r * r - dd * dd / 4)), sgn = (large === sweep) ? -1 : 1;
        const c = [mx - dy / dd * h * sgn, my + dx / dd * h * sgn];
        run.push(...G.arcPts(a, b, c, sweep === 0, 10)); cur = b;
      } else i++;
    }
    if (run.length) runs.push(run);
    return runs.map(r => r.map(([x, y]) => [x * K, y * K]));
  }
  function padRec(f) {
    // PAD~shape~x~y~w~h~layer~net~number~holeR~points~rotation~id~holeLength~holePoints~plated~…
    const shape = f[1], x = +f[2] * K, y = +f[3] * K, w = +f[4] * K, h = +f[5] * K, layer = f[6], net = f[7] || "", num = f[8] || "", holeR = +f[9] * K || 0, rot = +f[11] || 0;
    let polys;
    const pts = pairs(nums(f[10]));
    if ((shape === "RECT" || shape === "POLYGON") && pts.length >= 3) polys = [pts];
    else if (shape === "OVAL" && pts.length === 2) { const r = Math.min(w, h) / 2, [a, b] = pts, L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9, ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
      polys = [G.rrect(L + 2 * r, 2 * r, r, 6).map(([px, py]) => { const q = G.rotK(px, py, -ang); return [q[0] + (a[0] + b[0]) / 2, q[1] + (a[1] + b[1]) / 2]; })]; }
    else if (shape === "ELLIPSE") polys = [G.circ(x, y, w / 2)];
    else polys = [G.rect(w, h).map(([px, py]) => { const q = G.rotK(px, py, rot); return [q[0] + x, q[1] + y]; })];
    const kind = layer === "11" ? (f[15] === "N" ? 2 : 1) : 0;
    const holeD = holeR > 0 ? G.polyD(G.circ(x, y, holeR, 20).reverse()) : "";
    return { rec: G.padRec(num, net, polys, kind, holeD), layer };
  }
  function parse(obj, fileName) {
    if (!isStd(obj)) throw new Error("不是嘉立创EDA标准版 PCB 文件");
    const b = G.newBoard(), edgePts = [], tr = { F: [], B: [] }, silk = { F: [], B: [] };
    const lineRuns = f => pairs(nums(f));
    for (const s of obj.shape) {
      const f = s.split("~"), t = f[0];
      if (t === "TRACK") {
        const w = +f[1] * K, L = f[2], pts = lineRuns(f[4]);
        if (L === "10") { b.edges += G.lineD(pts); edgePts.push(...pts); }
        else if (L === "1" || L === "2") tr[L === "1" ? "F" : "B"].push([w, G.lineD(pts)]);
        else if (L === "3" || L === "4") silk[L === "3" ? "F" : "B"].push(G.lineD(pts));
      } else if (t === "ARC") {
        const L = f[2], runs = pathRuns(f[4]);
        if (L === "10") for (const r of runs) { b.edges += G.lineD(r); edgePts.push(...r); }
        else if (L === "3" || L === "4") for (const r of runs) silk[L === "3" ? "F" : "B"].push(G.lineD(r));
      } else if (t === "VIA") b.vias.push([G.f3(+f[1] * K), G.f3(+f[2] * K), G.f3(+f[3] * K / 2)]);
      else if (t === "LIB") {
        const subs = s.split("#@$"), hf = subs[0].split("~");
        const attrs = {}; const at = (hf[3] || "").split("`"); for (let i = 0; i + 1 < at.length; i += 2) attrs[at[i]] = at[i + 1];
        let ref = "", val = "";
        const pads = [], body = [], sk = []; let padLayer = null;
        for (const sub of subs.slice(1)) {
          const g = sub.split("~");
          if (g[0] === "TEXT" && g[1] === "P") ref = g[10] || ref;
          else if (g[0] === "TEXT" && g[1] === "N") val = g[10] || val;
          else if (g[0] === "PAD") { const p = padRec(g); pads.push(p.rec); if (p.layer !== "11") padLayer = p.layer; }
          else if (g[0] === "TRACK" && (g[2] === "3" || g[2] === "4")) sk.push(G.lineD(lineRuns(g[4])));
          else if (g[0] === "TRACK" && (g[2] === "99" || g[2] === "13" || g[2] === "14")) body.push(G.lineD(lineRuns(g[4])));
          else if (g[0] === "CIRCLE" && (g[5] === "3" || g[5] === "4")) sk.push(G.circleD(+g[1] * K, +g[2] * K, +g[3] * K));
          else if (g[0] === "ARC" && (g[2] === "3" || g[2] === "4")) sk.push(...pathRuns(g[4]).map(G.lineD));
          else if (g[0] === "SOLIDREGION" && g[1] === "99") body.push(...pathRuns(g[3]).map(r => G.polyD(r)));
        }
        if (!ref) continue;
        const side = (hf[7] === "2" || padLayer === "2") ? "B" : "F";
        let bb = G.bboxOf(pads.flatMap(p => [[p[7][0], p[7][1]], [p[7][2], p[7][3]]]));
        const cx = +hf[1] * K, cy = +hf[2] * K;
        if (!G.validBB(bb)) bb = [cx - .5, cy - .5, cx + .5, cy + .5];
        const p1 = pads.find(p => p[0] === "1");
        const props = { ...attrs };
        if (attrs["BOM_Supplier Part"]) props.LCSC = attrs["BOM_Supplier Part"];
        if (attrs["BOM_Manufacturer Part"]) props.MPN = attrs["BOM_Manufacturer Part"];
        b.parts.push({ r: ref, s: side, c: [G.f3(cx), G.f3(cy)], rot: +hf[4] || 0, bb: bb.map(G.f3), pads, body: body.join(""), silk: sk.join(""),
          val, fp: attrs.package || "", props, sheet: "", p1: p1 ? [p1[4], p1[5]] : null, tht: pads.length && pads.every(p => p[3] !== 0) ? 1 : 0, dnp: 0, nobom: 0 });
      }
    }
    b.tracks = { F: G.groupTracks(tr.F), B: G.groupTracks(tr.B) };
    b.silk = { F: silk.F.join(""), B: silk.B.join("") };
    return G.finishBoard(b, edgePts);
  }
  return { parse, isStd };
})();
