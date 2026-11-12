// OrCAD Capture DSN import check. Samples are not committed:
// ORCAD_DSN=/x/design.DSN ORCAD_ZIP=/x/project.zip (with the matching .brd) [ORCAD_SVG=/out/dir] node test/orcad_dsn.js
// Prints per-page counts, geometry sanity, the cross-check against the board and renders every page with schematic.js.
const assert = require("assert"), fs = require("fs"), path = require("path"), vm = require("vm");
require("./harness");
require("../src/import/altium_sch.js"); require("../src/export/altium_schlib.js");
const { ORCAD_DSN: dsn, ORCAD_ZIP: zip, ORCAD_SVG: svgDir } = process.env;
if (!dsn && !zip) { console.log("SKIP OrCAD DSN: set ORCAD_DSN and/or ORCAD_ZIP to the local samples"); process.exit(0); }
const entry = p => ({ path: path.basename(p), size: fs.statSync(p).size, read: async () => new Uint8Array(fs.readFileSync(p)) });
const key = p => p.map(v => v.toFixed(2)).join(",");
function report(docs) {
  for (const d of docs) {
    const inPage = ([x, y]) => x >= -0.01 && x <= d.width + 0.01 && y >= -d.height - 0.01 && y <= 0.01;
    const pts = [...d.wires.flatMap(w => w.points), ...d.pins.flatMap(p => [[p.x, p.y], [p.ex, p.ey]]), ...d.texts.map(t => [t.x, t.y]), ...d.shapes.flatMap(s => (s[0].match(/-?\d+(?:\.\d+)?/g) || []).map(Number).flatMap((v, i, a) => i % 2 ? [] : [[v, a[i + 1]]]))];
    const hot = new Set([...d.pins.map(p => key([p.ex, p.ey])), ...d.junctions.map(key), ...d.ports.map(p => key([p.x, p.y]))]), ends = new Map();
    for (const w of d.wires) for (const p of w.points) ends.set(key(p), (ends.get(key(p)) || 0) + 1);
    const labelled = new Set(d.ports.filter(p => p.type === 25).flatMap(p => d.wires.filter(w => w.net === p.netIndex).flatMap(w => w.points.map(key))));
    const all = d.wires.flatMap(w => w.points), onPin = all.filter(p => hot.has(key(p)) || ends.get(key(p)) >= 2), stub = all.filter(p => !onPin.includes(p) && labelled.has(key(p)));
    console.log(`  ${d.file}: ${d.components.length} parts, ${d.pins.length} pins, ${d.wires.length} wires, ${d.ports.filter(p => p.type === 25).length} net labels, ${d.ports.filter(p => p.type === 17).length} power, ${d.ports.filter(p => p.type === 18).length} off-page/port, ${d.junctions.length} junctions, ${d.nets.length} nets (${d.nets.filter(n => n.name).length} named); ` +
      `inside page ${pts.filter(inPage).length}/${pts.length}; wire ends on pin/junction/label/wire ${onPin.length}/${all.length}, label stubs ${stub.length}, dangling ${all.length - onPin.length - stub.length}; notes: ${d.unsupported.join("、") || "无"}`);
    assert.ok(d.components.every(c => c.ref && c.bb.every(Number.isFinite)) && d.pins.every(p => [p.x, p.y, p.ex, p.ey].every(Number.isFinite)));
  }
}
function render(d, file) { // the real viewer: src/schematic.js on a tiny DOM stand-in, serialised to SVG
  class E {
    constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.textContent = ""; }
    setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k]; } toggleAttribute(k, on) { if (on) this.attrs[k] = ""; else delete this.attrs[k]; }
    appendChild(c) { this.children.push(c); return c; } append(...c) { c.forEach(x => this.appendChild(x)); } addEventListener() {} querySelectorAll() { return []; } querySelector() { return null; } remove() {}
    set innerHTML(v) { this.children = []; } get innerHTML() { return ""; } getBoundingClientRect() { return { width: 1200, height: 850, left: 0, top: 0 }; }
  }
  const nodes = {}, ctx = vm.createContext({ Geom, document: { querySelector: s => nodes[s] ||= new E(s), createElementNS: (ns, t) => new E(t), createElement: t => new E(t) }, requestAnimationFrame() {} });
  for (const f of ["core/dom.js", "schematic.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", f), "utf8"), ctx);
  ctx.doc = d; vm.runInContext("SCH.doc = doc; renderSchSheet(false); schFit();", ctx);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const out = e => `<${e.tag}${Object.entries(e.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join("")}>${e.children.map(out).join("")}${esc(e.textContent)}</${e.tag}>`;
  const svg = nodes["#schSvg"]; svg.tag = "svg"; svg.attrs.xmlns = "http://www.w3.org/2000/svg"; svg.attrs.width = 1600; svg.attrs.height = Math.round(1600 * d.height / d.width);
  fs.writeFileSync(file, out(svg)); return file;
}
(async () => {
  if (dsn) {
    const res = await Project.load([entry(dsn)]);
    console.log(`bare DSN: ${res.boards.length} boards, ${res.schematics.length} pages, errors ${res.errors.length}, notes ${res.notes.length}`);
    assert.ok(res.schematics.length > 0 && !res.errors.length); report(res.schematics);
    if (svgDir) for (const d of res.schematics) console.log("  SVG", render(d, path.join(svgDir, path.basename(d.file) + ".svg")));
    const lib = AltiumSchLib.build(res.schematics), files = ImpAltium.cfb(lib.data);
    console.log(`SchLib from DSN: ${lib.components} symbols, ${lib.pins} pins, ${Object.keys(files).length} streams`); assert.ok(lib.components > 0 && files.FileHeader);
    const spec = await Project.load([{ path: "route.dsn", size: 40, read: async () => new TextEncoder().encode('(pcb "x.dsn"\n  (parser (string_quote ")))\n') }]);
    assert.ok(!spec.schematics.length && !spec.errors.length && !spec.notes.some(n => /route\.dsn/.test(n))); console.log("Specctra .dsn ignored");
  }
  if (!zip) return;
  const res = await Project.load([entry(zip)]), board = res.boards[0]?.board, docs = res.schematics;
  console.log(`zip: ${res.boards.length} boards (${board?.parts.length} parts), ${docs.length} pages, errors ${res.errors.length}`); assert.ok(board && docs.length);
  const parts = new Map(board.parts.map(p => [p.r, p])), comps = docs.flatMap(d => d.components.map(c => ({ c, d })));
  const refs = new Set(comps.map(x => x.c.ref)), dup = comps.length - refs.size;
  console.log(`designators: schematic ${refs.size} unique (${comps.length} placed, ${dup} repeated: ${[...new Set(comps.map(x => x.c.ref).filter((r, i, a) => a.indexOf(r) !== i))].join(",") || "-"}), board ${parts.size}; only in schematic: ${[...refs].filter(r => !parts.has(r)).join(",") || "-"}; only on board: ${[...parts.keys()].filter(r => !refs.has(r)).join(",") || "-"}`);
  const norm = s => String(s || "").toLowerCase().replace(/[\s\\/]+/g, "");
  const valueOf = p => p.v ?? p.value ?? p.val ?? "", bad = comps.filter(({ c }) => parts.has(c.ref) && norm(c.value) !== norm(valueOf(parts.get(c.ref))));
  console.log(`values: ${comps.length - bad.length}/${comps.length} agree; differ: ${bad.slice(0, 8).map(({ c }) => `${c.ref} ${c.value}≠${valueOf(parts.get(c.ref))}`).join("; ") || "-"}; D1=${comps.find(x => x.c.ref === "D1")?.c.value} C8=${comps.find(x => x.c.ref === "C8")?.c.value}`);
  let pins = 0, numOk = 0, named = 0, nameOk = 0; const netMap = new Map(), wrong = [];
  for (const { c, d } of comps) {
    const p = parts.get(c.ref); if (!p) continue;
    const pads = new Map(p.pads.map(q => [String(q[0]), q[1] || ""]));
    for (const i of c.pins) {
      const pin = d.pins[i]; pins++; if (!pads.has(pin.number)) { wrong.push(`${c.ref}.${pin.number}?`); continue; } numOk++;
      const bn = pads.get(pin.number), net = d.nets[pin.netIndex];
      if (pin.net) { named++; if (norm(pin.net) === norm(bn)) nameOk++; else wrong.push(`${c.ref}.${pin.number} ${pin.net}≠${bn}`); }
      if (net) { const k = d.file + "#" + pin.netIndex; (netMap.get(k) || netMap.set(k, new Set()).get(k)).add(bn); }
    }
  }
  const consistent = [...netMap.values()].filter(s => s.size === 1).length;
  console.log(`pins: ${numOk}/${pins} pin numbers exist on the board; named nets ${nameOk}/${named} agree; schematic nets mapping to exactly one board net ${consistent}/${netMap.size}; mismatches: ${wrong.slice(0, 12).join("; ") || "-"}`);
  for (const r of ["U6", "X1", "D1", "C8", "R2", "C25", "Q4"]) {
    const x = comps.find(x => x.c.ref === r); if (!x) { console.log(`  ${r}: not in schematic`); continue; }
    const p = parts.get(r), pads = new Map((p?.pads || []).map(q => [String(q[0]), q[1] || ""]));
    console.log(`  ${r} (${x.c.value}, ${x.c.footprint}): ` + x.c.pins.map(i => x.d.pins[i]).map(q => `${q.number}${q.name && q.name !== q.number ? "/" + q.name : ""}=${q.net || "~"}${pads.has(q.number) ? (norm(q.net) === norm(pads.get(q.number)) ? "" : "|brd " + (pads.get(q.number) || "~")) : "|no pad"}`).join(" "));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
