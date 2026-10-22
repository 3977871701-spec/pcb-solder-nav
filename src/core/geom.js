// Shared geometry helpers. Board model units: millimetres, SVG orientation (y grows downward).
globalThis.Geom = (() => {
  const f3 = v => { const r = Math.round(v * 1000) / 1000; return Object.is(r, -0) ? 0 : r; };
  const P = p => f3(p[0]) + " " + f3(p[1]);
  const polyD = pts => pts.length ? "M" + pts.map(P).join("L") + "Z" : "";
  const lineD = pts => pts.length ? "M" + pts.map(P).join("L") : "";
  const circ = (cx, cy, r, n = 24) => Array.from({ length: n }, (_, k) => [cx + r * Math.cos(k * 2 * Math.PI / n), cy + r * Math.sin(k * 2 * Math.PI / n)]);
  const circleD = (cx, cy, r) => `M${P([cx - r, cy])}a${f3(r)} ${f3(r)} 0 1 0 ${f3(2 * r)} 0a${f3(r)} ${f3(r)} 0 1 0 ${f3(-2 * r)} 0`;
  // KiCad-style rotation (y down, positive angle turns counter-clockwise on screen)
  const rotK = (x, y, deg) => { if (!deg) return [x, y]; const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [x * c + y * s, -x * s + y * c]; };
  // Math rotation (y up, counter-clockwise)
  const rotM = (x, y, deg) => { if (!deg) return [x, y]; const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c]; };
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
  // points along an arc from a to b around centre c; cw = clockwise in the coordinate system given
  function arcPts(a, b, c, cw, stepDeg = 10) {
    const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
    let t0 = Math.atan2(a[1] - c[1], a[0] - c[0]), t1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
    const TAU = 2 * Math.PI;
    let sw = cw ? t0 - t1 : t1 - t0; sw = ((sw % TAU) + TAU) % TAU;
    if (sw < 1e-9 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) sw = TAU;
    const n = Math.max(2, Math.ceil(sw / (stepDeg * Math.PI / 180)));
    const out = [];
    for (let k = 1; k <= n; k++) { const t = t0 + (cw ? -1 : 1) * sw * k / n; out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); }
    return out;
  }
  function rrect(w, h, r, seg = 4) {
    r = Math.max(0, Math.min(r, w / 2, h / 2)); if (r < 1e-4) return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    const out = [], cs = [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 90], [-w / 2 + r, -h / 2 + r, 180], [w / 2 - r, -h / 2 + r, 270]];
    for (const [cx, cy, a0] of cs) for (let k = 0; k <= seg; k++) { const a = (a0 + 90 * k / seg) * Math.PI / 180; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    return out;
  }
  const rect = (w, h) => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  function bboxOf(pts, bb = [1e9, 1e9, -1e9, -1e9]) {
    for (const q of pts) { if (q[0] < bb[0]) bb[0] = q[0]; if (q[1] < bb[1]) bb[1] = q[1]; if (q[0] > bb[2]) bb[2] = q[0]; if (q[1] > bb[3]) bb[3] = q[1]; }
    return bb;
  }
  const validBB = bb => bb && bb[0] <= bb[2] && bb[1] <= bb[3];
  // pad record used by the renderer: [num, net, pathD, kind(0 smd / 1 plated hole / 2 npth), cx, cy, minSize]
  function padRec(num, net, polys, kind, holeD = "") {
    const all = polys.flat(); const bb = bboxOf(all);
    const d = polys.map(polyD).join("") + holeD;
    if (net && /^Unused_[0-9A-F]+$/i.test(net)) net = ""; // Allegro names every unconnected pin "Unused_…"
    return [String(num ?? ""), net || "", d, kind, f3((bb[0] + bb[2]) / 2), f3((bb[1] + bb[3]) / 2), f3(Math.min(bb[2] - bb[0], bb[3] - bb[1])), bb];
  }
  // empty board skeleton every importer fills in
  const newBoard = () => ({ bbox: null, edges: "", silk: { F: "", B: "" }, tracks: { F: [], B: [] }, pours: { F: [], B: [] }, vias: [], parts: [] });
  function finishBoard(b, edgePts) {
    let bb = edgePts && edgePts.length ? bboxOf(edgePts) : null;
    if (!validBB(bb)) { bb = [1e9, 1e9, -1e9, -1e9]; for (const p of b.parts) bboxOf([[p.bb[0], p.bb[1]], [p.bb[2], p.bb[3]]], bb); }
    if (!validBB(bb)) bb = [0, 0, 50, 50];
    b.bbox = bb.map(f3);
    for (const p of b.parts) for (const pd of p.pads) pd.length = 7; // drop internal bbox
    return b;
  }
  // group tracks by width and net: input [[w, d, net?], ...] → [[w, joinedD, net]]
  function groupTracks(list) { const m = {}; for (const [w, d, net = ""] of list) (m[f3(w) + "" + net] ||= []).push(d); return Object.entries(m).map(([k, a]) => { const [w, net] = k.split(""); return [+w, a.join(""), net]; }); }
  // group copper pours by net: [[d, net], ...] → [[joinedD, net]]
  function groupPours(list) { const m = {}; for (const [d, net = ""] of list) (m[net] ||= []).push(d); return Object.entries(m).map(([net, a]) => [a.join(""), net]); }
  return { f3, P, polyD, lineD, circ, circleD, rotK, rotM, arcD, arcPts, rrect, rect, bboxOf, validBB, padRec, newBoard, finishBoard, groupTracks, groupPours };
})();
