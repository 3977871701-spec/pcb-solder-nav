// Allegro .brd importer checks through the same Project.load path the page uses (samples are not in the repo).
// ALLEGRO_BRD=/x/board.brd ALLEGRO_ZIP=/x/board.zip [ALLEGRO_SVG=/tmp/board.svg] [ALLEGRO_EXTRA=/a.brd:/b.brd] node test/allegro.js
// Oracles: Allegro's own board-space bounding box of every placed pad (stored in the file next to the footprint-local
// pad), and, for an extra board with "<file>.alg" (Allegro ASCII extract) beside it, the pin positions and nets in there.
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

// pads in the raw database: refdes.pin → [{ bbox centre, pin name }] from the placed-pad blocks (pins without a number repeat)
function rawPads(u8) {
  const db = ImpAllegro.read(u8), { H, byKey, str } = db, sc = { 1: 0.0254, 2: 25.4, 3: 1, 4: 10, 5: 0.001 }[H.units] / H.div;
  const chain = (k, stop, nx = "next") => { const o = []; while (k && k !== stop && o.length < 1e6) { const b = byKey.get(k); if (!b) break; o.push(b); k = b[nx]; } return o; };
  const out = new Map();
  for (const def of chain(H.ll.x2B.head, H.ll.x2B.tail)) for (const inst of chain(def.inst, def.key)) {
    const ci = byKey.get(inst.inst), ref = ci ? str(ci.ref) : ""; if (!ref) continue;
    for (const pp of chain(inst.pad, inst.key, "nextInFp")) {
      const pd = byKey.get(pp.pad), pn = byKey.get(pp.pin), nm = pn && byKey.get(pn.pinName);
      const k = ref + "." + str(pd.name); if (!out.has(k)) out.set(k, []); out.get(k).push({ x: (pp.c[0] + pp.c[2]) / 2 * sc, y: -(pp.c[1] + pp.c[3]) / 2 * sc, side: inst.layer ? "B" : "F", rot: inst.rot / 1000, pinName: nm && nm.t === 0x11 ? str(nm.name) : "" });
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
function render(B, file) {
  const [x0, y0, x1, y1] = B.bbox, m = 1, w = x1 - x0 + 2 * m, h = y1 - y0 + 2 * m, s = [];
  s.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0 - m} ${y0 - m} ${w} ${h}" width="${Math.round(w * 40)}" height="${Math.round(h * 40)}" style="background:#0d1b12">`);
  s.push(`<path d="${B.edges}" fill="#123020" stroke="#e8e070" stroke-width="0.08"/>`);
  for (const [side, col] of [["B", "#3a68c8"], ["F", "#c83a3a"]]) for (const [tw, d] of B.tracks[side]) s.push(`<path d="${d}" fill="none" stroke="${col}" stroke-opacity="0.55" stroke-width="${tw}" stroke-linecap="round"/>`);
  for (const v of B.vias) s.push(`<circle cx="${v[0]}" cy="${v[1]}" r="${v[2]}" fill="#b0b0b0"/>`);
  s.push(`<path d="${B.silk.F}" fill="none" stroke="#f0f0f0" stroke-width="0.06"/>`);
  for (const p of B.parts) {
    s.push(`<path d="${p.silk}" fill="none" stroke="#f0f0f0" stroke-width="0.06"/>`);
    for (const q of p.pads) s.push(`<path d="${q[2]}" fill="${q[0] === "1" ? "#4aa3ff" : q[3] ? "#d4a017" : "#e0b040"}" fill-rule="evenodd"/>`);
    const fs2 = Math.max(0.25, Math.min(0.8, (p.bb[2] - p.bb[0]) / 3));
    s.push(`<text x="${(p.bb[0] + p.bb[2]) / 2}" y="${(p.bb[1] + p.bb[3]) / 2}" font-size="${fs2}" fill="#7fffd4" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif">${p.r}</text>`);
  }
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
    const raw = oracle(B, new Uint8Array(fs.readFileSync(brd)), "transform (rotation / mirror / scale) check");
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
    if (process.env.ALLEGRO_SVG) render(B, process.env.ALLEGRO_SVG);
  }
  if (zip) {
    const res = await run([zip], { quiet: true }), B = summary(path.basename(zip), res);
    check(B && res.boards.length === 1 && !res.errors.length && !res.notes.length, "zip (with the OrCAD .DSN beside the .brd) loads as one board, no errors and no 'unsupported' notes");
  }
  for (const f of (process.env.ALLEGRO_EXTRA || "").split(":").filter(Boolean)) {
    const res = await run([f], { quiet: true }), B = summary(path.basename(f), res);
    if (!B) { check(false, `${path.basename(f)} did not load`); continue; }
    oracle(B, new Uint8Array(fs.readFileSync(f)), path.basename(f));
    if (fs.existsSync(f + ".alg")) { // Allegro ASCII extract: compare pin positions and nets
      const lines = fs.readFileSync(f + ".alg", "latin1").split(/\r?\n/), unit = /!mils!/.test(lines.slice(0, 5).join("")) ? 0.0254 : 1, pins = new Map(); let cols = null;
      for (const l of lines) { if (l.startsWith("A!")) { cols = l.split("!"); continue; } if (!l.startsWith("S!") || !cols || !cols.includes("PIN_X")) continue;
        const v = l.split("!"), o = Object.fromEntries(cols.map((c, i) => [c, v[i]])); if (o.CLASS === "PIN" && o.REFDES && o.PIN_X) { const k = o.REFDES + "." + o.PIN_NUMBER; if (!pins.has(k)) pins.set(k, []); const fig = /^FIG_(RECTANGLE|CIRCLE|SQUARE|OBLONG|ROUNDED|CHAMFERED|OCTAGON)/.test(o.GRAPHIC_DATA_NAME) && o.GRAPHIC_DATA_1 !== ""; // copper figure centre; PIN_X/Y is the pin origin (differs for offset pads)
          pins.get(k).push({ x: (fig ? +o.GRAPHIC_DATA_1 : +o.PIN_X) * unit, y: -(fig ? +o.GRAPHIC_DATA_2 : +o.PIN_Y) * unit, net: o.NET_NAME || "", custom: /^FIG_SHAPE/.test(o.PAD_SHAPE_NAME || o.GRAPHIC_DATA_NAME) }); } }
      let n = 0, worst = 0, at = "", netBad = 0, ex = [], shaped = 0;
      for (const q of pads(B)) { const c = pins.get(q.p.r + "." + q.n); if (!c) continue; const r = c.reduce((a, z) => Math.hypot(z.x - q.x, z.y - q.y) < Math.hypot(a.x - q.x, a.y - q.y) ? z : a); n++; const d = r.custom ? 0 : Math.hypot(r.x - q.x, r.y - q.y); if (r.custom) shaped++; if (d > worst) { worst = d; at = q.p.r + "." + q.n; } if (r.net !== q.net) { netBad++; if (ex.length < 4) ex.push(`${q.p.r}.${q.n}:${q.net}|${r.net}`); } }
      check(n > 0.95 * pads(B).length && worst < 0.01 && !netBad, `${path.basename(f)} vs its Allegro .alg extract (pad figure centres, nets): ${n}/${pads(B).length} pads matched, max deviation ${worst.toFixed(4)} mm (${at}; ${shaped} custom-shape pads compared by net only, the .alg gives their pin origin), net mismatches ${netBad} ${ex.join(" ")}`);
    }
  }
  console.log(fails ? `${fails} check(s) failed` : "all checks passed");
  process.exitCode = fails ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
