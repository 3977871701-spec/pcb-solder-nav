// Allegro .brd importer checks through the same Project.load path the page uses (samples are not in the repo).
// ALLEGRO_BRD=/x/board.brd ALLEGRO_ZIP=/x/board.zip [ALLEGRO_SVG=/tmp/board.svg] [ALLEGRO_EXTRA=/a.brd:/b.brd] node test/allegro.js
// Oracles: Allegro's own board-space bounding box of every placed pad (stored in the file next to the footprint-local
// pad), and, for an extra board with "<file>.alg" (Allegro ASCII extract) beside it, the pin positions and nets in there,
// its etch shape / void outlines (pour area per net), its silkscreen text records and its custom-shape pad outlines.
const fs = require("fs"), path = require("path");
const { run } = require("./e2e.js");
let fails = 0;
const check = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); };
const pads = B => B.parts.flatMap(p => p.pads.map(q => ({ p, n: q[0], net: q[1], x: q[4], y: q[5], kind: q[3] })));
const summary = (label, res) => {
  const B = res.boards[0] && res.boards[0].board;
  if (!B) return null;
  const all = pads(B), nets = new Set(all.map(q => q.net).filter(Boolean));
  console.log(`== ${label}: [${res.boards[0].source}] parts ${B.parts.length} (bottom ${B.parts.filter(p => p.s === "B").length}), pads ${all.length}, nets ${nets.size}, vias ${B.vias.length}, outline bbox ${B.bbox.join(", ")} (${(B.bbox[2] - B.bbox[0]).toFixed(2)} × ${(B.bbox[3] - B.bbox[1]).toFixed(2)} mm)`);
  for (const n of res.notes) console.log("   note:", n);
  for (const e of res.errors) console.log("   error:", e);
  for (const w of B.warn || []) console.log("   warn:", w);
  return B;
};

// pads in the raw database: refdes.pin → [{ bbox centre and size, pin name, padstack copper shape code }] from the placed-pad blocks (pins without a number repeat)
function rawPads(u8) {
  const db = ImpAllegro.read(u8), { H, byKey, str } = db, sc = { 1: 0.0254, 2: 25.4, 3: 1, 4: 10, 5: 0.001 }[H.units] / H.div;
  const chain = (k, stop, nx = "next") => { const o = []; while (k && k !== stop && o.length < 1e6) { const b = byKey.get(k); if (!b) break; o.push(b); k = b[nx]; } return o; };
  const out = new Map();
  for (const def of chain(H.ll.x2B.head, H.ll.x2B.tail)) for (const inst of chain(def.inst, def.key)) {
    const ci = byKey.get(inst.inst), ref = ci ? str(ci.ref) : ""; if (!ref) continue;
    for (const pp of chain(inst.pad, inst.key, "nextInFp")) {
      const pd = byKey.get(pp.pad), pn = byKey.get(pp.pin), nm = pn && byKey.get(pn.pinName), ps = byKey.get(pd.ps);
      let type = 0; if (ps && ps.t === 0x1C) for (let li = 0; li < ps.layers; li++) { const c = ps.comps[ps.fixed + li * ps.per + 2]; if (c && c.t) { type = c.t; break; } }
      const k = ref + "." + str(pd.name); if (!out.has(k)) out.set(k, []); out.get(k).push({ x: (pp.c[0] + pp.c[2]) / 2 * sc, y: -(pp.c[1] + pp.c[3]) / 2 * sc, w: (pp.c[2] - pp.c[0]) * sc, h: (pp.c[3] - pp.c[1]) * sc, type, side: inst.layer ? "B" : "F", rot: inst.rot / 1000, pinName: nm && nm.t === 0x11 ? str(nm.name) : "" });
    }
  }
  return { db, out };
}
function oracle(B, u8, label) {
  const { db, out } = rawPads(u8), dev = {}; let n = 0, worst = 0, at = "", missing = 0;
  for (const q of pads(B)) {
    const c = out.get(q.p.r + "." + q.n); if (!c) { missing++; continue; }
    const r = c.reduce((a, z) => Math.hypot(z.x - q.x, z.y - q.y) < Math.hypot(a.x - q.x, a.y - q.y) ? z : a), d = Math.hypot(r.x - q.x, r.y - q.y), k = `${r.side}${r.rot}°`; n++;
    dev[k] = Math.max(dev[k] || 0, d); if (d > worst) { worst = d; at = `${q.p.r}.${q.n}`; }
  }
  check(n > 0 && worst < 0.002 && missing <= pads(B).filter(q => !/^[A-Z]+\d+$/.test(q.p.r)).length, `${label}: ${n} pads vs Allegro's own placed-pad boxes (format ${db.name}), max centre deviation ${worst.toFixed(4)} mm (${at || "-"}), unmatched ${missing} (parts without a designator: ${B.parts.filter(p => !/^[A-Z]+\d+$/.test(p.r)).length}); by side/rotation ${Object.entries(dev).map(([k, v]) => `${k}:${v.toFixed(4)}`).join(" ")}`);
  return out;
}

// ---- geometry for the pour / text / pad-shape checks (board mm, y down) ----
const ringsOf = d => (d.match(/M[^MZ]*/g) || []).map(s => s.slice(1).split("L").map(t => t.trim().split(/\s+/).map(Number))).filter(r => r.length > 2);
const bbOf = r => { const b = [1e9, 1e9, -1e9, -1e9]; for (const [x, y] of r) { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; } return b; };
const prep = list => list.map(r => ({ r, b: bbOf(r) }));
const inRing = ({ r, b }, x, y) => { if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) return false; let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > y) !== (r[j][1] > y) && x < (r[j][0] - r[i][0]) * (y - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) c = !c; return c; };
const inside = (P, x, y) => P.reduce((c, q) => inRing(q, x, y) ? !c : c, false); // even-odd over all rings, as the page fills pours
const area = r => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(a / 2); };
const depth = (P, i) => P.filter((o, j) => j !== i && inRing(o, P[i].r[0][0], P[i].r[0][1])).length; // rings around ring i: odd = a hole
const eoArea = P => P.reduce((s, q, i) => s + (depth(P, i) % 2 ? -1 : 1) * area(q.r), 0);
const segDist = (x, y, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L)) : 0; return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); };
const distTo = (P, x, y) => { let m = 1e9; for (const { r } of P) for (let i = 0, j = r.length - 1; i < r.length; j = i++) m = Math.min(m, segDist(x, y, r[j], r[i])); return m; };
const bbDist = (bb, [x, y]) => Math.hypot(Math.max(bb[0] - x, 0, x - bb[2]), Math.max(bb[1] - y, 0, y - bb[3]));
// text record [s, x, y, h, rot, just, mirrored, length] → its box corners; "alt" reads mirrored text as mirror-after-rotate instead of rotate-after-mirror
function textBox(t, alt) {
  const [, x, y, h, rot, al, mir, len] = t, u0 = al === "c" ? -len / 2 : al === "r" ? -len : 0, a = rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), m = mir ? -1 : 1;
  return [[u0, 0], [u0 + len, 0], [u0 + len, h], [u0, h]].map(([u, v]) => alt && mir ? [x - (u * c - v * s), y - (u * s + v * c)] : [x + m * u * c - v * s, y - (m * u * s + v * c)]);
}
const centre = q => [q.reduce((s, p) => s + p[0], 0) / q.length, q.reduce((s, p) => s + p[1], 0) / q.length];

function pourChecks(B, label, u8) {
  const db = ImpAllegro.read(u8), per = {};
  for (const s of db.blocks) if (s.t === 0x28 && s.ly[0] === 6) { const na = db.byKey.get(s.ptr1); if (na && na.t === 0x04) { const n = db.str((db.byKey.get(na.net) || {}).name), m = (per["L" + s.ly[1]] ||= {}); m[n] = (m[n] || 0) + 1; } }
  console.log(`   ${label}: copper fills per ETCH layer (database, all layers; the board model keeps the outer two): ${Object.entries(per).map(([k, m]) => `${k} ${Object.values(m).reduce((a, b) => a + b, 0)} [${Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${n}×${c}`).join(" ")}${Object.keys(m).length > 4 ? ` +${Object.keys(m).length - 4} nets` : ""}]`).join(" | ") || "none"}`);
  const edge = prep(ringsOf(B.edges)), all = pads(B);
  for (const side of ["F", "B"]) {
    const list = B.pours[side].map(([d, net]) => ({ net, P: prep(ringsOf(d)) })); if (!list.length) continue;
    let nv = 0, out = 0, worst = 0;
    for (const { P } of list) for (const { r } of P) for (const [x, y] of r) { nv++; if (!inside(edge, x, y)) { out++; worst = Math.max(worst, distTo(edge, x, y)); } }
    const isl = list.map(({ net, P }) => ({ net, n: P.filter((q, i) => depth(P, i) % 2 === 0).length, holes: P.filter((q, i) => depth(P, i) % 2).length, a: eoArea(P) })).sort((a, b) => b.a - a.a);
    check(out === 0 || worst < 0.05, `${label} ${side} pours: ${isl.reduce((s, e) => s + e.n, 0)} copper islands on ${list.length} nets (${isl.slice(0, 5).map(e => `${e.net || "(no net)"} ${e.n} island${e.n > 1 ? "s" : ""}/${e.holes} voids/${e.a.toFixed(1)} mm²`).join(", ")}${isl.length > 5 ? ", …" : ""}); ${nv} vertices, ${out} outside the board outline${out ? ` (max ${worst.toFixed(3)} mm)` : ""}`);
    // copper on this side: vias, SMD pads of parts on this side, plated through pads
    const pts = [...B.vias.map(v => ({ x: v[0], y: v[1], net: v[3], what: "via" })), ...all.filter(q => q.kind === 1 || (q.kind === 0 && q.p.s === side)).map(q => ({ x: q.x, y: q.y, net: q.net, what: `${q.p.r}.${q.n}` }))].filter(q => q.net);
    const pourNets = new Set(list.map(e => e.net)), hit = {}, bad = [];
    for (const q of pts) {
      if (pourNets.has(q.net)) { const h = (hit[q.net] ||= [0, 0, 0, 0]), via = q.what === "via" ? 0 : 2; h[via + 1]++; if (list.some(e => e.net === q.net && inside(e.P, q.x, q.y))) h[via]++; }
      const o = list.find(e => e.net !== q.net && inside(e.P, q.x, q.y)); if (o) bad.push(`${q.what}(${q.net}) in ${o.net}`);
    }
    const top = Object.entries(hit).sort((a, b) => b[1][1] + b[1][3] - a[1][1] - a[1][3]).slice(0, 4);
    check(bad.length <= pts.length * 0.01, `${label} ${side}: same-net copper inside its pour — ${top.map(([n, h]) => `${n}: vias ${h[0]}/${h[1]}, pads ${h[2]}/${h[3]}`).join("; ")}; other-net vias/pads inside a pour ${bad.length}/${pts.length}${bad.length ? ": " + bad.slice(0, 4).join(" ") : ""}`);
  }
}

function textChecks(B, label) {
  const T = B.texts || { F: [], B: [] }, parts = B.parts.filter(p => !p.nobom), hs = [];
  let once = 0, none = 0, dup = 0, other = 0; const near = [0, 0, 0, 0], miss = [], far = [];
  for (const p of parts) {
    const own = T[p.s].filter(t => t[0] === p.r), opp = T[p.s === "F" ? "B" : "F"].filter(t => t[0] === p.r);
    if (opp.length) other++;
    if (own.length === 1) once++; else if (!own.length) { none++; miss.push(p.r); } else dup++;
    for (const t of own.slice(0, 1)) { hs.push(t[3]); const d = bbDist(p.bb, centre(textBox(t))); near[d === 0 ? 0 : d <= 1 ? 1 : d <= 2 ? 2 : 3]++; if (d > 2) far.push(`${p.r} ${d.toFixed(1)} mm`); }
  }
  const found = once + dup;
  check(!dup && near[0] + near[1] + near[2] >= 0.5 * found && hs.every(h => h >= 0.3 && h <= 3),
    `${label} silkscreen text: ${T.F.length} top / ${T.B.length} bottom; designators of ${parts.length} parts: ${once} once on their side's silkscreen, ${dup} twice or more, ${none} missing${miss.length ? ` (${miss.slice(0, 6).join(" ")}${miss.length > 6 ? " …" : ""})` : ""}, ${other} also on the other side; text box centre inside the part box ${near[0]}, ≤ 1 mm ${near[1]}, 1–2 mm ${near[2]}, farther ${near[3]}${far.length ? ` (${far.slice(0, 4).join(", ")})` : ""}; char height ${hs.length ? `${Math.min(...hs)}–${Math.max(...hs)} mm` : "-"}`);
  const bot = parts.filter(p => p.s === "B").map(p => [p, T.B.find(t => t[0] === p.r)]).filter(([, t]) => t);
  if (bot.length) {
    const mir = bot.filter(([, t]) => t[6]).length, turned = bot.filter(([, t]) => t[4] % 180), dA = turned.map(([p, t]) => bbDist(p.bb, centre(textBox(t)))), dB = turned.map(([p, t]) => bbDist(p.bb, centre(textBox(t, 1))));
    const winA = dA.filter((d, i) => d < dB[i] - 0.01).length, winB = dB.filter((d, i) => d < dA[i] - 0.01).length;
    check(mir === bot.length && (turned.length < 30 || winA > 2 * winB), `${label} bottom-side designators: ${mir}/${bot.length} mirrored; ${turned.length} turned by 90°/270°/45°…: rotate-after-mirror (as footprints, used) puts ${dA.filter(d => d <= 1).length} within 1 mm of their part and is nearer for ${winA}, mirror-after-rotate ${dB.filter(d => d <= 1).length} / nearer for ${winB}`);
  }
}

function padBoxes(B, raw, label) {
  const by = {};
  for (const p of B.parts) for (const q of p.pads) {
    const c = raw.get(p.r + "." + q[0]); if (!c || !q[2]) continue;
    const r = c.reduce((a, z) => Math.hypot(z.x - q[4], z.y - q[5]) < Math.hypot(a.x - q[4], a.y - q[5]) ? z : a), bb = bbOf(ringsOf(q[2]).flat()), k = `${(r.w - bb[2] + bb[0]).toFixed(2)}/${(r.h - bb[3] + bb[1]).toFixed(2)}`;
    const s = (by["0x" + r.type.toString(16)] ||= { n: 0, m: {} }); s.n++; s.m[k] = (s.m[k] || 0) + 1;
  }
  console.log(`   ${label}: Allegro's placed-pad box minus our copper outline extent (w/h mm; the box spans every padstack layer, so the solder-mask opening shows as a margin), by shape code: ${Object.entries(by).map(([k, s]) => `${k} ×${s.n} [${Object.entries(s.m).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, n]) => `${m}:${n}`).join(" ")}]`).join(", ")}`);
  return by;
}

// Allegro ASCII extract: every "S!" row as an object keyed by the column names of the "A!" header above it
function algRows(lines) { const rows = []; let cols = null; for (const l of lines) { if (l.startsWith("A!")) cols = l.split("!"); else if (l.startsWith("S!") && cols) { const v = l.split("!"), o = {}; cols.forEach((c, i) => { o[c] = v[i]; }); rows.push(o); } } return rows; }
function algChecks(B, rows, unit, label) {
  // silkscreen text records: position, rotation, mirror, justification, text block size
  const SILK = new Set(["REF DES", "COMPONENT VALUE", "BOARD GEOMETRY", "PACKAGE GEOMETRY", "MANUFACTURING"]);
  const want = rows.filter(o => o.GRAPHIC_DATA_NAME === "TEXT" && SILK.has(o.CLASS) && /^(SILKSCREEN|AUTOSILK)_(TOP|BOTTOM)$/.test(o.SUBCLASS) && (o.GRAPHIC_DATA_7 || "").trim());
  let n = 0, worst = 0, at = "", badRot = 0, badMir = 0, badJust = 0, badH = 0, badLen = 0; const missing = [], used = new Set();
  for (const o of want) {
    const side = /BOTTOM/.test(o.SUBCLASS) ? "B" : "F", s = o.GRAPHIC_DATA_7, x = +o.GRAPHIC_DATA_1 * unit, y = -o.GRAPHIC_DATA_2 * unit, par = o.GRAPHIC_DATA_6.trim().split(/\s+/).map(Number);
    const cand = (B.texts[side] || []).filter(t => t[0] === s); if (!cand.length) { missing.push(`${o.CLASS}/${s}`); continue; }
    const t = cand.reduce((a, z) => Math.hypot(z[1] - x, z[2] - y) < Math.hypot(a[1] - x, a[2] - y) ? z : a), d = Math.hypot(t[1] - x, t[2] - y); n++; used.add(t);
    if (d > worst) { worst = d; at = s; }
    if (Math.abs(((t[4] - +o.GRAPHIC_DATA_3) % 360 + 360) % 360) > 0.01) badRot++;
    if (!!t[6] !== (o.GRAPHIC_DATA_4 === "YES")) badMir++;
    if (t[5] !== { LEFT: "l", CENTER: "c", RIGHT: "r" }[o.GRAPHIC_DATA_5]) badJust++;
    if (Math.abs(t[3] - par[2] * unit) > 0.002) badH++;
    if (Math.abs(t[7] - (s.length * par[3] + (s.length - 1) * par[5]) * unit) > 0.005) badLen++;
  }
  const extra = [...B.texts.F, ...B.texts.B].filter(t => !used.has(t));
  check(want.length && n >= 0.99 * want.length && !extra.length && worst < 0.005 && !badRot && !badMir && !badJust && !badH && !badLen, `${label} vs .alg silkscreen text records: ${n}/${want.length} matched by string and side (missing: ${missing.slice(0, 4).join(", ") || "none"}), ours not in the .alg ${extra.length}${extra.length ? " (" + extra.slice(0, 4).map(t => t[0]).join(" ") + ")" : ""}, max anchor deviation ${worst.toFixed(4)} mm (${at}), rotation/mirror/justification/height/run-length mismatches ${badRot}/${badMir}/${badJust}/${badH}/${badLen}`);
  // etch shapes and their voids on the outer layers: filled area per net
  const arcPts = (x1, y1, x2, y2, cx, cy, cw) => { const r = Math.hypot(x1 - cx, y1 - cy), t0 = Math.atan2(y1 - cy, x1 - cx); let sw = Math.atan2(y2 - cy, x2 - cx) - t0; if (cw) { if (sw >= -1e-9) sw -= 2 * Math.PI; } else if (sw <= 1e-9) sw += 2 * Math.PI; const k = Math.max(2, Math.ceil(Math.abs(sw) / (Math.PI / 360))); return Array.from({ length: k }, (_, i) => [cx + r * Math.cos(t0 + sw * (i + 1) / k), cy + r * Math.sin(t0 + sw * (i + 1) / k)]); };
  const ringsAlg = {};
  for (const o of rows) if (o.CLASS === "ETCH" && (o.SUBCLASS === "TOP" || o.SUBCLASS === "BOTTOM") && (o.GRAPHIC_DATA_10 === "SHAPE" || o.GRAPHIC_DATA_10 === "VOID")) { const [rec, seg, ring] = o.RECORD_TAG.trim().split(/\s+/).map(Number); (ringsAlg[`${o.SUBCLASS}|${o.NET_NAME}|${rec}|${ring}|${o.GRAPHIC_DATA_10}`] ||= []).push([seg, o]); }
  const algArea = {};
  for (const [k, segs] of Object.entries(ringsAlg)) {
    const [sub, net, , , kind] = k.split("|"), pts = []; segs.sort((a, b) => a[0] - b[0]);
    for (const [, o] of segs) { const g = i => +o["GRAPHIC_DATA_" + i]; if (!pts.length) pts.push([g(1), g(2)]); if (o.GRAPHIC_DATA_NAME === "ARC") pts.push(...arcPts(g(1), g(2), g(3), g(4), g(5), g(6), o.GRAPHIC_DATA_9 === "CLOCKWISE")); else pts.push([g(3), g(4)]); }
    const key = (sub === "TOP" ? "F" : "B") + "|" + net; algArea[key] = (algArea[key] || 0) + (kind === "VOID" ? -1 : 1) * area(pts) * unit * unit;
  }
  const mine = {}; for (const side of ["F", "B"]) for (const [d, net] of B.pours[side]) mine[side + "|" + net] = eoArea(prep(ringsOf(d)));
  const keys = [...new Set([...Object.keys(algArea), ...Object.keys(mine)])], rel = keys.map(k => [k, (mine[k] || 0) - (algArea[k] || 0), algArea[k] || 0]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const tot = s => keys.filter(k => k[0] === s).reduce((a, k) => a + (algArea[k] || 0), 0), totM = s => keys.filter(k => k[0] === s).reduce((a, k) => a + (mine[k] || 0), 0);
  check(rel.every(([, dd, a]) => Math.abs(dd) <= Math.max(0.05, 0.01 * a)), `${label} vs .alg etch shapes (outer layers, arcs at 0.5°): filled area per side/net on ${keys.length} nets, top ${totM("F").toFixed(1)} vs ${tot("F").toFixed(1)} mm², bottom ${totM("B").toFixed(1)} vs ${tot("B").toFixed(1)} mm²; largest differences ${rel.slice(0, 3).map(([k, dd, a]) => `${k} ${dd >= 0 ? "+" : ""}${dd.toFixed(3)} of ${a.toFixed(2)} mm²`).join(", ")}`);
  // custom (shape symbol) pads: board-space outline of the pad figure
  const fig = {};
  for (const o of rows) if (o.CLASS === "PIN" && o.SUBCLASS === "TOP" && /^FIG_SHAPE/.test(o.PAD_SHAPE_NAME || "") && o.REFDES) { const k = o.REFDES + "." + o.PIN_NUMBER; (fig[k] ||= []).push([+o.GRAPHIC_DATA_1 * unit, -o.GRAPHIC_DATA_2 * unit], [+o.GRAPHIC_DATA_3 * unit, -o.GRAPHIC_DATA_4 * unit]); }
  let fn = 0, fworst = 0, fat = "";
  for (const [k, pts] of Object.entries(fig)) { const [ref, pin] = k.split("."), p = B.parts.find(z => z.r === ref), q = p && p.pads.find(z => z[0] === pin); if (!q) continue; const a = bbOf(pts), b = bbOf(ringsOf(q[2]).flat()), dv = Math.max(...a.map((v, i) => Math.abs(v - b[i]))); fn++; if (dv > fworst) { fworst = dv; fat = k; } }
  if (Object.keys(fig).length) check(fn === Object.keys(fig).length && fworst < 0.01, `${label} vs .alg custom-shape pad outlines: ${fn}/${Object.keys(fig).length} pads, max bounding-box deviation ${fworst.toFixed(4)} mm (${fat})`);
}

function render(B, file, side = "F") {
  const [x0, y0, x1, y1] = B.bbox, m = 1, w = Math.max(x1 - x0, y1 - y0) + 2 * m, h = w, s = [], esc = t => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0 - m} ${y0 - m} ${w} ${h}" width="${Math.round(w * 40)}" height="${Math.round(h * 40)}" style="background:#0d1b12">`);
  if (side === "B") s.push(`<g transform="translate(${x0 + x1} 0) scale(-1 1)">`); // bottom view, as the page shows it
  s.push(`<path d="${B.edges}" fill="#123020" stroke="#e8e070" stroke-width="0.08"/>`);
  const col = side === "F" ? "#c83a3a" : "#3a68c8";
  for (const [d] of B.pours[side]) s.push(`<path d="${d}" fill="${col}" fill-opacity="0.35" fill-rule="evenodd"/>`);
  for (const [tw, d] of B.tracks[side]) s.push(`<path d="${d}" fill="none" stroke="${col}" stroke-opacity="0.75" stroke-width="${tw}" stroke-linecap="round"/>`);
  for (const v of B.vias) s.push(`<circle cx="${v[0]}" cy="${v[1]}" r="${v[2]}" fill="#b0b0b0"/>`);
  s.push(`<path d="${B.silk[side]}" fill="none" stroke="#f0f0f0" stroke-width="0.1"/>`);
  for (const p of B.parts) {
    if (p.s !== side && !p.tht) continue;
    if (p.s === side) s.push(`<path d="${p.silk}" fill="none" stroke="#f0f0f0" stroke-width="0.1"/>`);
    for (const q of p.pads) s.push(`<path d="${q[2]}" fill="${q[0] === "1" ? "#4aa3ff" : q[3] ? "#d4a017" : "#e0b040"}" fill-rule="evenodd"/>`);
  }
  for (const [t, x, y, ch, rot, al, mir, len] of B.texts[side]) s.push(`<text transform="translate(${x} ${y}) rotate(${-rot})${mir ? " scale(-1 1)" : ""}" font-size="${(ch / 0.72).toFixed(3)}" text-anchor="${al === "c" ? "middle" : al === "r" ? "end" : "start"}" textLength="${len}" lengthAdjust="spacingAndGlyphs" fill="#ffffff" font-family="Helvetica, Arial, sans-serif">${esc(t)}</text>`);
  if (side === "B") s.push("</g>");
  s.push("</svg>"); fs.writeFileSync(file, s.join("\n")); console.log("SVG written:", file);
}

(async () => {
  const brd = process.env.ALLEGRO_BRD, zip = process.env.ALLEGRO_ZIP;
  if (brd) {
    const res = await run([brd], { quiet: true }), B = summary(path.basename(brd), res);
    check(B && res.boards.length === 1 && !res.errors.length, "bare .brd loads as one board without errors");
    if (!B) return;
    const all = pads(B);
    check(B.parts.every(p => /^[A-Z]+\d+$/.test(p.r)), `designators look real: ${B.parts.slice(0, 12).map(p => p.r).join(" ")} …`);
    // pad count per footprint vs the pin count in its name (exposed pad allowed)
    const want = fp => { const m = fp.match(/QFN(\d+)|TDFN-(\d+)|VSON-(\d+)|VQFN-(\d+)|SOT-363()|SOT-23$()|-(\d+)P$|^[RCL]\d{4}$()|SOD-323()|DFN\d+-(\d+)/); if (!m) return null;
      if (m[5] !== undefined) return [6]; if (m[6] !== undefined) return [3]; if (m[8] !== undefined || m[9] !== undefined) return [2]; const n = +(m[1] || m[2] || m[3] || m[4] || m[7] || m[10]); return [n, n + 1]; };
    const byFp = {}; for (const p of B.parts) (byFp[p.fp] ||= new Set()).add(p.pads.length);
    const rows = Object.entries(byFp).map(([fp, s]) => ({ fp, got: [...s], want: want(fp) })).filter(r => r.want);
    check(rows.every(r => r.got.every(n => r.want.includes(n))), `pin counts match footprint names: ${rows.map(r => `${r.fp}=${r.got.join("/")}`).join(", ")}`);
    const [bx0, by0, bx1, by1] = B.bbox, out = all.filter(q => q.x < bx0 - 0.01 || q.x > bx1 + 0.01 || q.y < by0 - 0.01 || q.y > by1 + 0.01);
    check(!out.length, `all ${all.length} pad centres inside the outline bbox${out.length ? ": " + out.slice(0, 5).map(q => q.p.r + "." + q.n).join(" ") : ""}`);
    // unit scaling: 0402 pad pitch ≈ 1 mm, QFN48 6x6 pitch 0.4 mm
    const d2 = B.parts.filter(p => /^[RC]0402$/.test(p.fp)).map(p => Math.hypot(p.pads[0][4] - p.pads[1][4], p.pads[0][5] - p.pads[1][5]));
    check(d2.length && d2.every(d => Math.abs(d - 1.0) < 0.1), `0402 pad centre spacing ${Math.min(...d2).toFixed(3)}–${Math.max(...d2).toFixed(3)} mm over ${d2.length} parts`);
    for (const p of B.parts.filter(p => /QFN48/.test(p.fp))) {
      const pp = p.pads.filter(q => q[6] < 1), nn = pp.map(a => Math.min(...pp.filter(b => b !== a).map(b => Math.hypot(a[4] - b[4], a[5] - b[5]))));
      const span = Math.max(...pp.map(q => q[4])) - Math.min(...pp.map(q => q[4]));
      check(Math.abs(Math.min(...nn) - 0.4) < 0.005 && Math.abs(Math.max(...nn) - 0.4) < 0.005, `${p.r} ${p.fp} rot ${p.rot}°: pitch ${Math.min(...nn).toFixed(3)}–${Math.max(...nn).toFixed(3)} mm, pad-row span ${span.toFixed(2)} mm, EP ${p.pads.find(q => q[6] >= 1)[0]}`);
    }
    const u8 = new Uint8Array(fs.readFileSync(brd)), raw = oracle(B, u8, "transform (rotation / mirror / scale) check");
    // pin names from the schematic symbol vs the nets on those pins
    const osc = [...raw].map(([k, l]) => [k, l[0]]).filter(([, r]) => /OSC/.test(r.pinName)).map(([k, r]) => { const [ref, n] = k.split("."), q = all.find(z => z.p.r === ref && z.n === n); return { k, name: r.pinName, net: q ? q.net : "?" }; });
    console.log("   pins named *OSC*: " + osc.map(o => `${o.k} ${o.name} → net ${o.net || "(unconnected)"}`).join("; "));
    // a pin named "PH0-OSC_IN" must sit on net OSC_IN whenever such a net exists (PC15-OSC32_OUT used as GPIO is fine)
    const netSet = new Set(all.map(q => q.net)), named = osc.filter(o => netSet.has(o.name.replace(/^[^-]*-/, "")));
    check(named.length >= 2 && named.every(o => o.name.endsWith("-" + o.net)), `MCU pin names agree with the nets they name: ${named.map(o => `${o.k} ${o.name}=${o.net}`).join(", ")}`);
    const x = B.parts.find(p => /3225/.test(p.fp)); if (x) console.log(`   crystal ${x.r}: ${x.pads.map(q => `${q[0]}:${q[1]}`).join(" ")}`);
    // two-pin parts and net sanity
    const two = B.parts.filter(p => p.pads.length === 2), shorted = two.filter(p => p.pads[0][1] && p.pads[0][1] === p.pads[1][1]);
    const cnt = {}; for (const q of all) if (q.net) cnt[q.net] = (cnt[q.net] || 0) + 1;
    const single = Object.keys(cnt).filter(n => cnt[n] === 1);
    check(!shorted.length, `${two.length} two-pin parts, ${shorted.length} with both pins on one net${shorted.length ? ": " + shorted.map(p => p.r).join(" ") : ""}; nets with one pad only: ${single.length}${single.length ? " (" + single.slice(0, 8).join(" ") + ")" : ""}`);
    const gnd = B.parts.filter(p => /^C\d/.test(p.r) && p.pads.length === 2 && p.pads.some(q => q[1] === "GND")).length;
    console.log(`   ${gnd}/${B.parts.filter(p => /^C\d/.test(p.r)).length} capacitors have one pin on GND; sample values: ${B.parts.filter(p => p.val).slice(0, 8).map(p => `${p.r}=${p.val}`).join(" ")}`);
    padBoxes(B, raw, path.basename(brd));
    pourChecks(B, path.basename(brd), u8);
    textChecks(B, path.basename(brd));
    if (process.env.ALLEGRO_SVG) { render(B, process.env.ALLEGRO_SVG); render(B, process.env.ALLEGRO_SVG.replace(/(\.svg)?$/i, "-bottom.svg"), "B"); }
  }
  if (zip) {
    const res = await run([zip], { quiet: true }), B = summary(path.basename(zip), res);
    check(B && res.boards.length === 1 && !res.errors.length && !res.notes.some(n => /brd|allegro|不支持|读不了/i.test(JSON.stringify(n))), "zip (with the OrCAD .DSN beside the .brd) loads as one board, no errors and no notes about the board");
  }
  for (const f of (process.env.ALLEGRO_EXTRA || "").split(":").filter(Boolean)) {
    const res = await run([f], { quiet: true }), B = summary(path.basename(f), res);
    if (!B) { check(false, `${path.basename(f)} did not load`); continue; }
    const u8 = new Uint8Array(fs.readFileSync(f)), raw = oracle(B, u8, path.basename(f));
    padBoxes(B, raw, path.basename(f));
    pourChecks(B, path.basename(f), u8);
    textChecks(B, path.basename(f));
    if (fs.existsSync(f + ".alg")) { // Allegro ASCII extract: compare pin positions and nets
      const lines = fs.readFileSync(f + ".alg", "latin1").split(/\r?\n/), unit = /!mils!/.test(lines.slice(0, 5).join("")) ? 0.0254 : 1, pins = new Map(); let cols = null;
      for (const l of lines) { if (l.startsWith("A!")) { cols = l.split("!"); continue; } if (!l.startsWith("S!") || !cols || !cols.includes("PIN_X")) continue;
        const v = l.split("!"), o = Object.fromEntries(cols.map((c, i) => [c, v[i]])); if (o.CLASS === "PIN" && o.REFDES && o.PIN_X) { const k = o.REFDES + "." + o.PIN_NUMBER; if (!pins.has(k)) pins.set(k, []); const fig = /^FIG_(RECTANGLE|CIRCLE|SQUARE|OBLONG|ROUNDED|CHAMFERED|OCTAGON)/.test(o.GRAPHIC_DATA_NAME) && o.GRAPHIC_DATA_1 !== ""; // copper figure centre; PIN_X/Y is the pin origin (differs for offset pads)
          pins.get(k).push({ x: (fig ? +o.GRAPHIC_DATA_1 : +o.PIN_X) * unit, y: -(fig ? +o.GRAPHIC_DATA_2 : +o.PIN_Y) * unit, net: o.NET_NAME || "", custom: /^FIG_SHAPE/.test(o.PAD_SHAPE_NAME || o.GRAPHIC_DATA_NAME) }); } }
      let n = 0, worst = 0, at = "", netBad = 0, ex = [], shaped = 0;
      for (const q of pads(B)) { const c = pins.get(q.p.r + "." + q.n); if (!c) continue; const r = c.reduce((a, z) => Math.hypot(z.x - q.x, z.y - q.y) < Math.hypot(a.x - q.x, a.y - q.y) ? z : a); n++; const d = r.custom ? 0 : Math.hypot(r.x - q.x, r.y - q.y); if (r.custom) shaped++; if (d > worst) { worst = d; at = q.p.r + "." + q.n; } if (r.net !== q.net) { netBad++; if (ex.length < 4) ex.push(`${q.p.r}.${q.n}:${q.net}|${r.net}`); } }
      check(n > 0.95 * pads(B).length && worst < 0.01 && !netBad, `${path.basename(f)} vs its Allegro .alg extract (pad figure centres, nets): ${n}/${pads(B).length} pads matched, max deviation ${worst.toFixed(4)} mm (${at}; ${shaped} custom-shape pads compared by net only, the .alg gives their pin origin), net mismatches ${netBad} ${ex.join(" ")}`);
      algChecks(B, algRows(lines), unit, path.basename(f));
    }
  }
  console.log(fails ? `${fails} check(s) failed` : "all checks passed");
  process.exitCode = fails ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
