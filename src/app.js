// ======================= app =======================
const NS = "http://www.w3.org/2000/svg";
const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem("psn:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("psn:" + k, JSON.stringify(v)); } catch (e) {} },
};
let toastT;
function toast(msg, ms = 3200) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms); }

// ---------- IndexedDB (per-browser board cache) ----------
const DB = {
  db: null,
  async open() {
    if (this.db) return this.db;
    return this.db = await new Promise((res, rej) => {
      try { const r = indexedDB.open("pcb-solder-nav", 1); r.onupgradeneeded = () => r.result.createObjectStore("boards", { keyPath: "key" }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }
      catch (e) { rej(e); }
    });
  },
  async tx(mode, fn) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction("boards", mode), s = t.objectStore("boards"); const out = fn(s); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); }); },
  all() { return this.tx("readonly", s => s.getAll()).catch(() => []); },
  put(b) { return this.tx("readwrite", s => s.put(b)).catch(() => {}); },
  del(k) { return this.tx("readwrite", s => s.delete(k)).catch(() => {}); },
};

const S = { boards: [], b: null, side: "F", rot: 0, mode: "solder", lbl: LS.get("lbl", "ref"), trk: LS.get("trk", true), sel: null, cur: null, pad: null, vb: null, q: "", netIdx: {}, worldEl: null, pm: {} };
let doneAll = LS.get("done", {});
const doneOf = () => (doneAll[S.b.key] ||= {});
const saveDone = () => LS.set("done", doneAll);

// ---------- loading files ----------
async function readEntries(dirEntry, prefix) {
  const out = [], reader = dirEntry.createReader();
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const e of batch) out.push(...await walkEntry(e, prefix));
  }
  return out;
}
async function walkEntry(e, prefix = "") {
  const path = prefix + e.name;
  if (/(^|\/)(__MACOSX|\.git|node_modules|\.history)$/.test(path)) return [];
  if (e.isFile) { const f = await new Promise((res, rej) => e.file(res, rej)); return [fileEntry(f, path)]; }
  if (e.isDirectory) return readEntries(e, path + "/");
  return [];
}
const fileEntry = (f, path) => ({ path: path || f.webkitRelativePath || f.name, size: f.size, read: async () => new Uint8Array(await f.arrayBuffer()) });
// bump when import rules change: boards parsed by an older version are dropped on load and must be re-imported
const IMPORT_VER = 3;
const boardKey = (meta, b) => `${meta.path}|${b.parts.length}|${b.bbox.map(v => Math.round(v)).join(",")}`;
async function ingest(list) {
  if (!list.length) return;
  $("#loadMsg").textContent = `正在读取 ${list.length} 个文件…`;
  toast(`正在读取 ${list.length} 个文件…`, 60000);
  let res;
  try { res = await Project.load(list, msg => { $("#loadMsg").textContent = msg; }); }
  catch (e) { toast("读取失败：" + e.message, 6000); $("#loadMsg").textContent = ""; return; }
  $("#loadMsg").textContent = "";
  let firstKey = null; const added = [];
  // re-importing a folder replaces everything that earlier imports of that folder produced
  const roots = new Set(list.map(e => e.path.split("/")[0]).filter((r, _, a) => list.some(e => e.path.includes("/"))));
  for (const m of res.boards) {
    const b = m.board;
    Enrich.enrich(b, m.bom);
    if (!b.groups.length && !b.dnp.length) { res.notes.push(`${m.path.replace(/#.*$/, "")}：里面没有需要焊接的器件（可能只是封装库或板框），已跳过`); continue; }
    Object.assign(b, { name: m.name, sub: m.source, source: m.source, bomFile: m.bomFile || "", file: m.path.replace(/#.*$/, "").split("/").pop(), added: Date.now(), warn: b.warn || [], ver: IMPORT_VER });
    b.key = boardKey(m, b);
    const old = S.boards.findIndex(x => x.key === b.key || (x.name === b.name && x.source === b.source));
    if (old >= 0) { if (S.boards[old].key !== b.key) DB.del(S.boards[old].key); S.boards[old] = b; } else S.boards.push(b);
    DB.put(b); firstKey ||= b.key; added.push(b.key);
  }
  const newKeys = new Set(added);
  if (added.length) for (const old of S.boards.filter(x => [...roots].some(r => x.key.startsWith(r + "/")) && !newKeys.has(x.key))) { DB.del(old.key); S.boards = S.boards.filter(x => x !== old); }
  const msgs = [...res.errors.map(e => "✗ " + e), ...res.notes.map(n => "· " + n)];
  showNotes(msgs);
  const from = [...roots].join("、");
  if (firstKey) { toast(`${from ? "从 " + from + " " : ""}读入 ${added.length} 块板${msgs.length ? "，有 " + msgs.length + " 条说明" : ""}`); showApp(); openBoard(firstKey); }
  else toast(msgs.length ? msgs.slice(0, 3).join("\n") : "没有找到能识别的板子文件", 8000);
}
function showNotes(msgs) {
  for (const id of ["#notes", "#notesEmpty"]) { const n = $(id); if (!n) continue; n.hidden = !msgs.length; n.innerHTML = msgs.length ? `<b>导入说明</b><ul>${msgs.map(m => `<li>${esc(m)}</li>`).join("")}</ul>` : ""; }
}
function filesToList(files) { return [...files].map(f => fileEntry(f)); }
$("#inDir").onchange = e => { ingest(filesToList(e.target.files)); e.target.value = ""; };
$("#inFiles").onchange = e => { ingest(filesToList(e.target.files)); e.target.value = ""; };
$("#pickDir").onclick = () => $("#inDir").click();
$("#pickFiles").onclick = () => $("#inFiles").click();
let dragDepth = 0;
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
window.addEventListener("dragenter", e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $("#dropmask").hidden = false; });
window.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("dragleave", e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $("#dropmask").hidden = true; } });
window.addEventListener("drop", async e => {
  if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; $("#dropmask").hidden = true;
  const items = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  let list = [];
  if (items.length) for (const en of items) list.push(...await walkEntry(en));
  else list = filesToList(e.dataTransfer.files);
  ingest(list);
});

// ---------- demo board ----------
const DEMO = `(kicad_pcb (version 20240108) (generator "demo")
 (title_block (title "示例：LDO 小板"))
 (gr_rect (start 100 100) (end 130 120) (stroke (width 0.1)) (layer "Edge.Cuts"))
 (gr_circle (center 103 103) (end 104.6 103) (stroke (width 0.1)) (layer "Edge.Cuts"))
 (footprint "Package_TO_SOT_SMD:SOT-23-5" (layer "F.Cu") (at 114 110 90)
  (property "Reference" "U1") (property "Value" "AP2112K-3.3") (property "LCSC" "C51118") (attr smd)
  (fp_poly (pts (xy -0.9 -1.15) (xy 0.9 -1.15) (xy 0.9 1.45) (xy -0.6 1.45) (xy -0.9 1.15)) (stroke (width 0.1)) (layer "F.Fab"))
  (fp_rect (start -2.05 -1.7) (end 2.05 1.7) (stroke (width 0.05)) (layer "F.CrtYd"))
  (pad "1" smd roundrect (at -0.95 1.1375 90) (size 1.325 0.6) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net "VIN"))
  (pad "2" smd roundrect (at 0 1.1375 90) (size 1.325 0.6) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net "GND"))
  (pad "3" smd roundrect (at 0.95 1.1375 90) (size 1.325 0.6) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net "VIN"))
  (pad "4" smd roundrect (at 0.95 -1.1375 90) (size 1.325 0.6) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net ""))
  (pad "5" smd roundrect (at -0.95 -1.1375 90) (size 1.325 0.6) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net "+3V3")))
 (footprint "Capacitor_SMD:C_0805_2012Metric" (layer "F.Cu") (at 109 110 90)
  (property "Reference" "C1") (property "Value" "10uF") (property "LCSC" "C15850") (attr smd)
  (fp_rect (start -1 -0.625) (end 1 0.625) (stroke (width 0.1)) (layer "F.Fab"))
  (pad "1" smd roundrect (at -0.95 0 90) (size 1 1.45) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net "VIN"))
  (pad "2" smd roundrect (at 0.95 0 90) (size 1 1.45) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net "GND")))
 (footprint "Capacitor_SMD:C_0805_2012Metric" (layer "F.Cu") (at 119 110 90)
  (property "Reference" "C2") (property "Value" "10uF") (property "LCSC" "C15850") (attr smd)
  (fp_rect (start -1 -0.625) (end 1 0.625) (stroke (width 0.1)) (layer "F.Fab"))
  (pad "1" smd roundrect (at -0.95 0 90) (size 1 1.45) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net "+3V3"))
  (pad "2" smd roundrect (at 0.95 0 90) (size 1 1.45) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net "GND")))
 (footprint "Capacitor_SMD:C_0402_1005Metric" (layer "F.Cu") (at 116.5 106)
  (property "Reference" "C3") (property "Value" "100nF") (property "LCSC" "C1525") (attr smd)
  (fp_rect (start -0.5 -0.25) (end 0.5 0.25) (stroke (width 0.1)) (layer "F.Fab"))
  (pad "1" smd roundrect (at -0.48 0) (size 0.56 0.62) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net "+3V3"))
  (pad "2" smd roundrect (at 0.48 0) (size 0.56 0.62) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net "GND")))
 (footprint "Resistor_SMD:R_0603_1608Metric" (layer "F.Cu") (at 123 106)
  (property "Reference" "R1") (property "Value" "1k") (property "LCSC" "C21190") (attr smd)
  (fp_rect (start -0.8 -0.4) (end 0.8 0.4) (stroke (width 0.1)) (layer "F.Fab"))
  (pad "1" smd roundrect (at -0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net "+3V3"))
  (pad "2" smd roundrect (at 0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net "LED_A")))
 (footprint "LED_SMD:LED_0603_1608Metric" (layer "F.Cu") (at 123 110 270)
  (property "Reference" "D1") (property "Value" "绿灯") (property "LCSC" "C72043") (attr smd)
  (fp_poly (pts (xy -0.8 -0.4) (xy 0.8 -0.4) (xy 0.8 0.4) (xy -0.8 0.4)) (stroke (width 0.1)) (layer "F.Fab"))
  (fp_line (start -0.5 -0.4) (end -0.5 0.4) (stroke (width 0.1)) (layer "F.Fab"))
  (pad "1" smd roundrect (at -0.7875 0 270) (size 0.875 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net "GND"))
  (pad "2" smd roundrect (at 0.7875 0 270) (size 0.875 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net "LED_A")))
 (footprint "Resistor_SMD:R_0603_1608Metric" (layer "F.Cu") (at 116.5 114)
  (property "Reference" "R2") (property "Value" "10k") (property "LCSC" "C25804") (attr smd dnp)
  (fp_rect (start -0.8 -0.4) (end 0.8 0.4) (stroke (width 0.1)) (layer "F.Fab"))
  (pad "1" smd roundrect (at -0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net "VIN"))
  (pad "2" smd roundrect (at 0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net "GND")))
 (footprint "Capacitor_SMD:C_0402_1005Metric" (layer "B.Cu") (at 114 106)
  (property "Reference" "C4") (property "Value" "100nF") (property "LCSC" "C1525") (attr smd)
  (fp_rect (start -0.5 -0.25) (end 0.5 0.25) (stroke (width 0.1)) (layer "B.Fab"))
  (pad "1" smd roundrect (at 0.48 0) (size 0.56 0.62) (layers "B.Cu" "B.Paste" "B.Mask") (roundrect_rratio 0.25) (net "VIN"))
  (pad "2" smd roundrect (at -0.48 0) (size 0.56 0.62) (layers "B.Cu" "B.Paste" "B.Mask") (roundrect_rratio 0.25) (net "GND")))
 (footprint "Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical" (layer "F.Cu") (at 104 107.46)
  (property "Reference" "J1") (property "Value" "电源输入") (attr through_hole)
  (fp_rect (start -1.27 -1.27) (end 1.27 6.35) (stroke (width 0.1)) (layer "F.Fab"))
  (pad "1" thru_hole rect (at 0 0) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (net "VIN"))
  (pad "2" thru_hole oval (at 0 2.54) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (net "GND"))
  (pad "3" thru_hole oval (at 0 5.08) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (net "+3V3")))
 (footprint "TestPoint:TestPoint_Pad_1.0x1.0mm" (layer "F.Cu") (at 127 116)
  (property "Reference" "TP1") (property "Value" "3V3") (attr exclude_from_pos_files exclude_from_bom)
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net "+3V3")))
 (segment (start 104 107.46) (end 108.05 107.46) (width 0.5) (layer "F.Cu") (net "VIN"))
 (segment (start 108.05 107.46) (end 109 108.41) (width 0.5) (layer "F.Cu") (net "VIN"))
 (segment (start 109 108.41) (end 109 109.05) (width 0.5) (layer "F.Cu") (net "VIN"))
 (segment (start 119 109.05) (end 119 106) (width 0.4) (layer "F.Cu") (net "+3V3"))
 (segment (start 117 106) (end 122.175 106) (width 0.3) (layer "F.Cu") (net "+3V3"))
 (segment (start 123.825 106) (end 123 109.2125) (width 0.25) (layer "F.Cu") (net "LED_A"))
 (via (at 111 112) (size 0.6) (drill 0.3) (net "GND"))
)`;
$("#loadDemo").onclick = () => {
  const b = ImpKiCad.parse(DEMO, "demo.kicad_pcb"); Enrich.enrich(b, null);
  Object.assign(b, { name: "demo", sub: "示例板", source: "KiCad PCB（内置示例）", file: "demo.kicad_pcb", key: "demo#builtin", bomFile: "", added: Date.now(), warn: [], ver: IMPORT_VER });
  const i = S.boards.findIndex(x => x.key === b.key); if (i >= 0) S.boards[i] = b; else S.boards.push(b);
  DB.put(b); showApp(); openBoard(b.key);
};

// ---------- view transform (mirror for bottom, rotate in 90° steps) ----------
function view(side = S.side) {
  const [x0, y0, x1, y1] = S.b.bbox, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, B = side === "B", r = S.rot;
  const a = r * Math.PI / 180, c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
  const vec = (dx, dy) => { if (B) dx = -dx; return [dx * c - dy * s, dx * s + dy * c]; };
  const pt = (x, y) => { const v = vec(x - cx, y - cy); return [cx + v[0], cy + v[1]]; };
  const tf = `rotate(${r} ${cx} ${cy})` + (B ? ` translate(${2 * cx} 0) scale(-1 1)` : "");
  const up = (x, y) => `translate(${x} ${y})` + (B ? " scale(-1 1)" : "") + (r ? ` rotate(${-r})` : "");
  return { tf, pt, vec, up };
}
const onSide = (p, side) => p.tht || p.s === side;

// two drawing panes: A is the normal view; in double-sided pin testing A shows the top and B the (mirrored) bottom
const PANES = [
  { svg: $("#board"), box: $("#paneA"), tag: $("#tagA"), key: "vb", side: "F", world: null },
  { svg: $("#board2"), box: $("#paneB"), tag: $("#tagB"), key: "vb2", side: "B", world: null },
];
const P0 = PANES[0];
const paneOf = target => (target && PANES.find(P => P.box.contains(target))) || P0;
function selectedNet() { const pd = S.mode === "pin" && S.pad ? S.pm[S.pad.r]?.pads[S.pad.i] : null; return pd && pd[1] ? pd[1] : null; }
const isThruPad = x => { const p = S.pm[x.r]; return p && (p.tht || p.pads[x.i][3] === 1); };
// pads of the selected net on each side (through-hole pads count for both)
function netSides(net) {
  const out = { F: 0, B: 0 };
  for (const x of S.netIdx[net] || []) { const p = S.pm[x.r]; if (!p) continue; if (isThruPad(x)) { out.F++; out.B++; } else out[p.s]++; }
  return out;
}
// split when the selected net cannot be seen from one side alone
function wantSplit() {
  if (S.mode !== "pin") return false;
  if (S.splitForce) return true;
  const net = selectedNet(); if (!net) return false;
  const all = S.netIdx[net] || [];
  const smd = s => all.some(x => !isThruPad(x) && S.pm[x.r] && S.pm[x.r].s === s);
  const tht = all.some(isThruPad);
  return smd("B") && (smd("F") || tht);
}

function dirWord(dx, dy) {
  if (Math.hypot(dx, dy) < 0.05) return "中间";
  const a = Math.atan2(dy, dx) * 180 / Math.PI;
  return ["右", "右下", "下", "左下", "左", "左上", "上", "右上"][((Math.round(a / 45) % 8) + 8) % 8];
}
function orientText(p) {
  if (p.pol === "none-bi") return "双向 TVS，无极性，两个方向都行";
  if (p.pol && !p.p1) return `有极性，但这份数据没有引脚编号：方向请对照板上丝印${p.rot ? `（坐标文件角度 ${p.rot}°）` : ""}`;
  if (!p.pol) return "无极性";
  const side = S.split ? (p.tht ? "F" : p.s) : S.side;
  const v = view(side).vec(p.p1[0] - p.c[0], p.p1[1] - p.c[1]), w = dirWord(v[0], v[1]);
  const where = `（${side === "B" ? "底面" : "顶面"}视图${S.rot ? `，已转 ${S.rot}°` : ""}）`;
  if (p.pol === "k1") return `阴极 K 在${w}侧：器件色带/横线朝${w}${where}`;
  if (p.pol === "plus1") return `正极 + 在${w}侧${where}`;
  return `1 脚在${w}${w.length === 1 ? "侧" : "角"}：对准芯片圆点/缺角${where}`;
}

function shortVal(p) { const s = (p.val && p.val !== "~" ? p.val : p.nm || "").split(/\s+/)[0]; return s.length > 10 ? s.slice(0, 9) + "…" : s; }

function render() {
  const split = wantSplit(), was = !!S.split;
  S.split = split;
  PANES[1].box.hidden = !split;
  $("#splitBtn").setAttribute("aria-pressed", split);
  if (split) { P0.side = "F"; PANES[1].side = "B"; } else P0.side = S.side;
  if (split !== was) { S.vb = null; S.vb2 = null; }
  const net = selectedNet(), ns = net ? netSides(net) : null;
  for (const P of split ? PANES : [P0]) {
    renderPane(P);
    P.tag.innerHTML = (P.side === "B" ? "底面（镜像）" : "顶面") + (ns ? ` · 同网络 <b>${P.side === "B" ? ns.B : ns.F}</b> 个焊盘` : "");
  }
  P0.tag.hidden = !split && S.mode !== "pin";
}
function renderPane(P) {
  const b = S.b, svg = P.svg, side = P.side, V = view(side);
  svg.innerHTML = "";
  svg.classList.toggle("pinmode", S.mode === "pin");
  const [x0, y0, x1, y1] = b.bbox;
  const world = el("g", { transform: V.tf }, svg); P.world = world;
  el("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: .8, class: "b-fill" }, world);
  if (S.trk) {
    for (const [w, d] of b.tracks[side]) el("path", { d, class: "trk", "stroke-width": w }, world);
    for (const [vx, vy, vr] of b.vias) el("circle", { cx: vx, cy: vy, r: vr, class: "via" }, world);
  }
  if (b.silk[side]) el("path", { d: b.silk[side], class: "bsilk" }, world);
  if (b.edges) el("path", { d: b.edges, class: "b-edge" }, world);
  const done = doneOf(), pin = S.mode === "pin";
  const selRefs = new Set(pin ? [] : S.sel ? (b.groups.find(g => g.id === S.sel)?.refs || []) : (S.cur ? [S.cur] : []));
  const selNet = selectedNet();
  const netRefs = new Set(selNet ? (S.netIdx[selNet] || []).map(x => x.r) : []);
  if (pin && S.cur) netRefs.add(S.cur);
  if (selRefs.size || netRefs.size) world.classList.add("dim");
  const parts = el("g", {}, world), labels = el("g", {}, world), pnums = el("g", {}, world), rings = el("g", {}, world);
  for (const p of b.parts) {
    if (!onSide(p, side)) continue;
    const g = el("g", { class: "part" + (p.tp ? " tp" : "") + (p.dnp ? " dnp" : "") + (done[p.r] && !pin ? " done" : "") + (selRefs.has(p.r) ? " hi" : "") + (netRefs.has(p.r) ? " nhi" : "") + (S.cur === p.r ? " cur" : ""), "data-r": p.r }, parts);
    if (p.body) el("path", { d: p.body, class: "body" }, g);
    if (p.silk && !p.tp) el("path", { d: p.silk, class: "sk" }, g);
    const polar = p.pol && p.pol !== "none-bi";
    if (pin) {
      p.pads.forEach(([n, net, d, th, px, py, sz], i) => {
        if (!d) return;
        const isSel = S.pad && S.pad.r === p.r && S.pad.i === i, onNet = selNet && net === selNet;
        el("path", { d, class: "pad" + (th === 2 ? " npth" : "") + (n === "1" && polar ? " p1" : "") + (onNet ? " net" : "") + (isSel ? " psel" : "") }, g);
        if (n && th !== 2 && sz > 0) { const fs = Math.max(.12, Math.min(.9, sz * .55 / Math.max(1, n.length * .6))); const t = el("text", { transform: V.up(px, py), class: "pn", "font-size": fs }, pnums); t.textContent = n; }
        if (onNet || isSel) el("circle", { cx: px, cy: py, r: sz / 2 + .45, class: "ring" + (isSel ? " cur" : " net") }, rings);
      });
    } else {
      let pd = "", p1d = "", nd = "";
      for (const [n, net, d, th] of p.pads) { if (!d) continue; if (th === 2) nd += d; else if (n === "1" && polar) p1d += d; else pd += d; }
      if (pd) el("path", { d: pd, class: "pad" }, g);
      if (p1d) el("path", { d: p1d, class: "pad p1" }, g);
      if (nd) el("path", { d: nd, class: "pad npth" }, g);
    }
    el("rect", { x: p.bb[0], y: p.bb[1], width: p.bb[2] - p.bb[0], height: p.bb[3] - p.bb[1], fill: "transparent" }, g);
    if ((p.skip && !(pin && p.tp)) || S.lbl === "none") continue;
    const w = p.bb[2] - p.bb[0], h = p.bb[3] - p.bb[1], hi = selRefs.has(p.r);
    const fs = Math.max(.32, Math.min(1.3, Math.min(w, h) * .42)) * (hi ? 1.25 : 1);
    const cx = (p.bb[0] + p.bb[2]) / 2, cy = (p.bb[1] + p.bb[3]) / 2;
    const t = el("text", { transform: V.up(cx, cy), class: "lbl" + (hi ? " hi" : "") + (p.dnp ? " dnp" : ""), "font-size": fs, "stroke-width": fs * .22 }, labels);
    t.textContent = S.lbl === "val" && !pin ? shortVal(p) : p.r + (p.dnp ? " DNP" : "");
    if (hi) el("circle", { cx, cy, r: Math.max(w, h) / 2 + .9, class: "ring" + (S.cur === p.r ? " cur" : "") }, rings);
  }
  setVB(S[P.key], P);
}

// ---------- pan / zoom (per pane) ----------
function fitVB(P = P0) {
  const V = view(P.side), [x0, y0, x1, y1] = S.b.bbox, c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(q => V.pt(q[0], q[1]));
  const xs = c.map(q => q[0]), ys = c.map(q => q[1]), m = 3;
  return { x: Math.min(...xs) - m, y: Math.min(...ys) - m, w: Math.max(...xs) - Math.min(...xs) + 2 * m, h: Math.max(...ys) - Math.min(...ys) + 2 * m };
}
function setVB(v, P = P0) { const vb = S[P.key] = v || fitVB(P); P.svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`); }
function zoomAt(f, px, py, P = P0) {
  const v = S[P.key] || fitVB(P), r = P.svg.getBoundingClientRect();
  const s = Math.min(r.width / v.w, r.height / v.h), ox = (r.width - v.w * s) / 2, oy = (r.height - v.h * s) / 2;
  const wx = v.x + ((px ?? r.width / 2) - ox) / s, wy = v.y + ((py ?? r.height / 2) - oy) / s;
  const fw = fitVB(P).w, nw = Math.max(1.5, Math.min(fw * 2, v.w / f)), k = nw / v.w;
  setVB({ x: wx - (wx - v.x) * k, y: wy - (wy - v.y) * k, w: nw, h: v.h * k }, P);
}
// frame a set of board points in a pane
function frame(pts, P = P0, minSize = 12) {
  const V = view(P.side); let a = [1e9, 1e9, -1e9, -1e9];
  for (const q of pts) { const t = V.pt(q[0], q[1]); a = [Math.min(a[0], t[0]), Math.min(a[1], t[1]), Math.max(a[2], t[0]), Math.max(a[3], t[1])]; }
  if (a[0] > a[2]) return;
  const m = 4, w = Math.max(a[2] - a[0] + 2 * m, minSize), h = Math.max(a[3] - a[1] + 2 * m, minSize);
  setVB({ x: (a[0] + a[2]) / 2 - w / 2, y: (a[1] + a[3]) / 2 - h / 2, w, h }, P);
}
function zoomTo(refs, P = P0) {
  const pts = [];
  for (const r of refs) { const p = S.pm[r]; if (p) pts.push([p.bb[0], p.bb[1]], [p.bb[2], p.bb[3]]); }
  frame(pts, P);
}
// double-sided view: frame every pad of the selected net in each pane
function frameNet() {
  const net = selectedNet(); if (!net) return;
  for (const P of S.split ? PANES : [P0]) {
    const pts = [];
    for (const x of S.netIdx[net] || []) { const p = S.pm[x.r]; if (!p || !(onSide(p, P.side) || isThruPad(x))) continue; const q = p.pads[x.i]; pts.push([q[4] - 1, q[5] - 1], [q[4] + 1, q[5] + 1]); }
    if (pts.length) frame(pts, P); else setVB(null, P);
  }
}
const wrap = $("#wrap");
wrap.addEventListener("wheel", e => { if (e.target.closest(".card")) return; e.preventDefault(); const P = paneOf(e.target), r = P.svg.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top, P); }, { passive: false });
const ptrs = new Map(); let moved = false, dragPane = P0;
wrap.addEventListener("pointerdown", e => { if (e.target.closest(".card")) return; if (!ptrs.size) dragPane = paneOf(e.target); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = false; wrap.setPointerCapture(e.pointerId); wrap.classList.add("drag"); });
wrap.addEventListener("pointermove", e => {
  if (!ptrs.has(e.pointerId)) return;
  const P = dragPane, prev = ptrs.get(e.pointerId), cur = { x: e.clientX, y: e.clientY };
  if (ptrs.size === 1) {
    const dx = cur.x - prev.x, dy = cur.y - prev.y; if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    const v = S[P.key] || fitVB(P), r = P.svg.getBoundingClientRect(), s = Math.min(r.width / v.w, r.height / v.h);
    setVB({ ...v, x: v.x - dx / s, y: v.y - dy / s }, P);
  } else if (ptrs.size === 2) {
    moved = true;
    const other = [...ptrs.entries()].find(([k]) => k !== e.pointerId)[1];
    const d0 = Math.hypot(prev.x - other.x, prev.y - other.y), d1 = Math.hypot(cur.x - other.x, cur.y - other.y), r = P.svg.getBoundingClientRect();
    if (d0 > 0) zoomAt(d1 / d0, (cur.x + other.x) / 2 - r.left, (cur.y + other.y) / 2 - r.top, P);
  }
  ptrs.set(e.pointerId, cur);
});
const endPtr = e => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId); if (!ptrs.size) wrap.classList.remove("drag");
  if (!moved && e.type === "pointerup") {
    const P = paneOf(document.elementFromPoint(e.clientX, e.clientY) || e.target);
    if (S.mode === "pin") { const hp = padAt(e.clientX, e.clientY, P); if (hp) { pickPad(hp.r, hp.i, false, true); return; } }
    const hit = document.elementsFromPoint(e.clientX, e.clientY).map(n => n.closest && n.closest(".part")).find(Boolean);
    if (hit) pickPart(hit.dataset.r, false);
  }
};
wrap.addEventListener("pointerup", endPtr); wrap.addEventListener("pointercancel", endPtr);
function padAt(cx, cy, P = P0) {
  if (!P.world) return null;
  const pt = P.svg.createSVGPoint(); pt.x = cx; pt.y = cy;
  const v = S[P.key] || fitVB(P), w = pt.matrixTransform(P.world.getScreenCTM().inverse()), tol = v.w / 80;
  let best = null, bd = 1e9;
  for (const p of S.b.parts) {
    if (!onSide(p, P.side)) continue;
    p.pads.forEach(([n, net, d, th, px, py, sz], i) => { if (!d || th === 2) return; const dist = Math.hypot(w.x - px, w.y - py) - sz / 2; if (dist < bd) { bd = dist; best = { r: p.r, i }; } });
  }
  return bd < Math.max(.25, tol) ? best : null;
}

// ---------- toolbar ----------
const visiblePanes = () => S.split ? PANES : [P0];
const zoomAll = f => visiblePanes().forEach(P => zoomAt(f, undefined, undefined, P));
const fitAll = () => visiblePanes().forEach(P => setVB(null, P));
$("#zin").onclick = () => zoomAll(1.4); $("#zout").onclick = () => zoomAll(1 / 1.4); $("#zfit").onclick = fitAll;
$("#splitBtn").onclick = () => { S.splitForce = !S.splitForce; render(); if (S.split) { if (selectedNet()) frameNet(); else fitAll(); } };
$("#zsel").onclick = () => { const g = S.b.groups.find(g => g.id === S.sel); if (S.split && selectedNet()) frameNet(); else if (S.cur) zoomTo([S.cur]); else if (g) zoomTo(g.refs); };
document.querySelectorAll("#sideSeg button").forEach(btn => btn.onclick = () => setSide(btn.dataset.side, true));
document.querySelectorAll("#modeSeg button").forEach(btn => btn.onclick = () => setMode(btn.dataset.mode));
$("#rotBtn").onclick = () => { S.rot = (S.rot + 90) % 360; $("#rotBtn").textContent = `⟳ ${S.rot}°`; S.vb = null; S.vb2 = null; render(); renderCard(); };
$("#lblSel").value = S.lbl; $("#lblSel").onchange = e => { S.lbl = e.target.value; LS.set("lbl", S.lbl); render(); };
$("#trkBtn").setAttribute("aria-pressed", S.trk); $("#trkBtn").onclick = () => { S.trk = !S.trk; LS.set("trk", S.trk); $("#trkBtn").setAttribute("aria-pressed", S.trk); render(); };
function setSide(side, user) {
  if (S.side === side) return;
  S.side = side; S.vb = null;
  document.querySelectorAll("#sideSeg button").forEach(x => x.setAttribute("aria-pressed", x.dataset.side === side));
  if (user) { render(); renderCard(); }
}
function setMode(m) {
  S.mode = m; S.pad = null; S.cur = null; if (m === "pin") S.sel = null;
  document.querySelectorAll("#modeSeg button").forEach(x => x.setAttribute("aria-pressed", x.dataset.mode === m));
  $("#tpSec").hidden = m !== "pin";
  $("#hint").textContent = m === "pin" ? "点焊盘看引脚 · 两面都有连接时自动分屏" : "滚轮/双指缩放 · 拖动平移";
  $("#splitBtn").hidden = m !== "pin"; if (m !== "pin") S.splitForce = false;
  render(); renderList(); renderCard();
}

// ---------- selection ----------
const groupOfRef = r => S.b.groups.find(g => g.refs.includes(r));
function selectGroup(id, zoom) {
  if (S.mode === "pin") { const g0 = S.b.groups.find(g => g.id === id); if (g0) pickPart(g0.refs[0], true); return; }
  S.sel = S.sel === id && !zoom ? null : id; S.cur = null; S.pad = null;
  const g = S.b.groups.find(g => g.id === S.sel);
  if (g) { const p = S.pm[g.refs[0]]; if (p && !p.tht && p.s !== S.side) setSide(p.s); }
  render(); renderList(); renderCard();
  if (g && zoom) zoomTo(g.refs);
  const row = document.querySelector(`.grp[data-id="${S.sel}"]`); if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function pickPart(r, zoom) {
  const p = S.pm[r]; if (!p) return;
  const g = groupOfRef(r);
  S.sel = g && S.mode !== "pin" ? g.id : null; S.cur = r; S.pad = null;
  if (!p.tht && p.s !== S.side) setSide(p.s);
  render(); renderList(); renderCard();
  if (zoom) zoomTo([r]);
  const row = document.querySelector(`.grp[data-id="${S.sel}"]`); if (row && !zoom) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function pickPad(r, i, zoom, fromBoard) {
  const p = S.pm[r]; if (!p) return;
  const before = selectedNet();
  S.pad = { r, i }; S.cur = r;
  const willSplit = wantSplit();
  if (!willSplit && !p.tht && p.s !== S.side) setSide(p.s);
  render(); renderCard();
  const net = selectedNet();
  if (S.split) { if (net && (net !== before || !fromBoard)) frameNet(); }
  else if (zoom) zoomTo([r]);
}
const orderedGroups = () => S.b.groups.slice();
function stepGroup(dir, unfinishedOnly) {
  const gs = orderedGroups(); if (!gs.length) return;
  if (S.mode === "pin") setMode("solder");
  const done = doneOf(), at = gs.findIndex(g => g.id === S.sel);
  for (let k = 1; k <= gs.length; k++) {
    const g = gs[((at < 0 ? (dir > 0 ? -1 : 0) : at) + dir * k + gs.length * 2) % gs.length];
    if (!unfinishedOnly || !g.refs.every(r => done[r])) { S.sel = null; selectGroup(g.id, true); return; }
  }
  toast("这块板全部焊完了 ✓");
}
$("#nextBtn").onclick = () => stepGroup(1, true);
$("#prevBtn").onclick = () => stepGroup(-1, false);
$("#doneNext").onclick = () => {
  const g = S.b.groups.find(g => g.id === S.sel); if (!g) { stepGroup(1, true); return; }
  const done = doneOf(); g.refs.forEach(r => done[r] = 1); saveDone(); stepGroup(1, true);
};

// ---------- detail card ----------
function renderCard() {
  const c = $("#card"), p = S.cur && S.pm[S.cur];
  if (!p) { c.hidden = true; return; }
  c.hidden = false;
  const head = `<button type="button" class="x" aria-label="关闭">×</button>
    <div class="row1"><span class="ref">${esc(p.r)}</span><span class="nm">${esc(p.nm)}</span>${p.s === "B" ? '<span class="chip">底面</span>' : ""}${p.tht ? '<span class="chip">插件</span>' : ""}${p.dnp ? '<span class="chip">DNP 不焊</span>' : ""}</div>
    <div class="fn">${[p.fp, p.lcsc, p.mpn && p.mpn !== p.nm ? p.mpn : ""].filter(Boolean).map(x => `<span class="chip">${esc(x)}</span>`).join(" ")}</div>
    ${p.fn ? `<div class="fn">功能：${esc(p.fn)}</div>` : ""}
    ${p.note ? `<div class="note" style="grid-column:auto">⚠ ${esc(p.note)}</div>` : ""}`;
  if (S.mode === "pin") { c.innerHTML = head + pinBody(p); bindCard(c); return; }
  const g = groupOfRef(p.r), done = doneOf();
  c.innerHTML = head + `<div class="orient">${orientText(p)}</div>
    ${p.nets.length ? `<div class="nets">网络：${p.nets.slice(0, 12).map(esc).join(" · ")}${p.nets.length > 12 ? ` … 共 ${p.nets.length} 个` : ""}</div>` : ""}
    ${p.skip ? "" : `<div class="acts"><button type="button" class="tbtn" id="cdone">${done[p.r] ? "取消已焊" : "标记已焊 ✓"}</button>${g ? `<span class="hint">同类 ${g.refs.length} 个：${g.refs.map(esc).join(" ")}</span>` : ""}</div>`}`;
  bindCard(c);
  const b = c.querySelector("#cdone"); if (b) b.onclick = () => { done[p.r] ? delete done[p.r] : (done[p.r] = 1); saveDone(); render(); renderList(); renderCard(); };
}
const autoNet = n => /^\d+$/.test(n) || /^Net-\(|^unconnected-/i.test(n) || /-power-|^[a-z_]+-\w/.test(n);
function pinBody(p) {
  const netLabel = n => !n ? "未连接 (NC)" : esc(n) + (autoNet(n) ? ' <span class="hint">（自动命名的网络）</span>' : "");
  let body = "";
  if (S.pad && S.pad.r === p.r) {
    const [n, net] = p.pads[S.pad.i];
    const pinName = n === "" ? "无编号焊盘" : /^\d+$/.test(n) ? `第 ${esc(n)} 脚` : `${esc(n)} 脚`;
    const others = net ? (S.netIdx[net] || []).filter(x => !(x.r === p.r && x.i === S.pad.i)) : [];
    const tps = [...new Set(others.filter(x => S.pm[x.r]?.tp).map(x => x.r))], lim = 60;
    const chip = x => `<button type="button" data-r="${esc(x.r)}" data-i="${x.i}">${esc(x.r)}·<b>${esc(x.n || "–")}</b>${x.s === "B" ? "(底)" : ""}</button>`;
    body = `<div class="row1"><span>${pinName}</span><span>→</span><span class="netname">${netLabel(net)}</span></div>
      ${tps.length ? `<div class="orient">可在测试点 ${tps.map(esc).join("、")} 上测</div>` : ""}
      ${!net ? '<div class="hint">这个焊盘不接任何网络，应与其他点都不导通。</div>'
        : !others.length ? '<div class="orient">这个网络只有这一个焊盘：该脚在板上没有连到别处（未使用/悬空），应与其他点都不导通。</div>'
        : `<div class="hint">同网络还有 ${others.length} 个焊盘，与这里应导通：</div><div class="nchips">${others.slice(0, lim).map(chip).join("")}${others.length > lim ? `<span class="hint">… 共 ${others.length} 个</span>` : ""}</div>`}
      <div class="hint">本器件全部引脚：</div>`;
  } else body = `<div class="hint">点板上的焊盘，或下面的引脚：</div>`;
  const pins = p.pads.map((pd, i) => [pd, i]).filter(([pd]) => pd[2] && pd[3] !== 2);
  return body + `<div class="pins">${pins.map(([pd, i]) => `<button type="button" data-r="${esc(p.r)}" data-i="${i}" class="${S.pad && S.pad.r === p.r && S.pad.i === i ? "on" : ""}"><b>${esc(pd[0] || "–")}</b> ${pd[1] ? esc(pd[1]) : '<span class="hint">NC</span>'}</button>`).join("")}</div>`;
}
function bindCard(c) {
  c.querySelector(".x").onclick = () => { S.cur = null; S.pad = null; render(); renderList(); renderCard(); };
  c.querySelectorAll("button[data-i]").forEach(b => b.onclick = () => pickPad(b.dataset.r, +b.dataset.i, !!b.closest(".nchips")));
}

// ---------- side list ----------
function renderList() {
  const b = S.b, done = doneOf(), host = $("#steps"), q = S.q.trim().toUpperCase();
  host.innerHTML = "";
  let total = 0, nd = 0, tht = 0, bot = 0;
  const bySt = {};
  for (const g of b.groups) { (bySt[g.step] ||= []).push(g); total += g.refs.length; nd += g.refs.filter(r => done[r]).length; if (g.step === 30) tht += g.refs.length; if (g.step > 10 && g.step < 20) bot += g.refs.length; }
  $("#nums").innerHTML = `<span><b>${b.groups.length}</b> 种</span><span><b>${total - tht}</b> 贴片</span><span><b>${tht}</b> 插件</span>${bot ? `<span>底面 <b>${bot}</b></span>` : ""}${b.dnp.length ? `<span>DNP <b>${b.dnp.length}</b></span>` : ""}<span>已焊 <b>${nd}</b> / ${total}</span>`;
  $("#bar").style.width = (total ? nd / total * 100 : 0) + "%";
  $("#src").textContent = `${b.source || ""} · ${b.file || ""}${b.bomFile ? " + BOM " + b.bomFile : "（没有找到 BOM，名称取自设计文件里的值）"}`;
  const w = $("#warn"); w.hidden = !(b.warn && b.warn.length); w.innerHTML = (b.warn || []).map(x => `<div>⚠ ${esc(x)}</div>`).join("");
  const match = g => !q || g.refs.some(r => r.toUpperCase().includes(q)) || g.nm.toUpperCase().includes(q) || (g.lcsc || "").toUpperCase() === q;
  const anyHit = !q || b.groups.some(match);
  let idx = 0;
  for (const st of Object.keys(bySt).map(Number).sort((a, b) => a - b)) {
    const gs = anyHit ? bySt[st].filter(match) : bySt[st];
    if (!gs.length) continue;
    idx++;
    const [title, desc] = Enrich.STEPS[st];
    const sec = document.createElement("section"); sec.className = "step";
    sec.innerHTML = `<h2><span class="no">${idx}</span>${title}</h2><p>${desc}</p>`;
    for (const g of gs) {
      const nDone = g.refs.filter(r => done[r]).length, all = nDone === g.refs.length;
      const row = document.createElement("div");
      row.className = "grp" + (S.sel === g.id ? " sel" : "") + (all ? " alldone" : ""); row.dataset.id = g.id;
      const polTxt = g.pol === "k1" ? "有极性：阴极" : g.pol === "plus1" ? "有极性：正负" : g.pol === "pin1" ? "认 1 脚" : "";
      row.innerHTML = `<input type="checkbox" id="ck-${g.id}" ${all ? "checked" : ""} aria-label="这种全部已焊">
        <div class="gname">${esc(g.nm)}</div><div class="gcount">×${g.refs.length}</div>
        <div class="gmeta"><span class="chip">${esc(g.fp)}</span>${g.lcsc ? `<span class="chip">${esc(g.lcsc)}</span>` : ""}${polTxt ? `<span class="chip pol">${polTxt}</span>` : ""}${nDone && !all ? `<span>已焊 ${nDone}/${g.refs.length}</span>` : ""}</div>
        ${g.note ? `<div class="note">⚠ ${esc(g.note)}</div>` : ""}
        <div class="refs">${g.refs.map(r => `<button type="button" class="${done[r] ? "d" : ""}${S.cur === r ? " c" : ""}" data-r="${esc(r)}">${esc(r)}</button>`).join("")}</div>`;
      row.onclick = e => {
        if (e.target.matches("input")) { g.refs.forEach(r => e.target.checked ? (done[r] = 1) : delete done[r]); saveDone(); render(); renderList(); renderCard(); return; }
        const rb = e.target.closest(".refs button"); if (rb) { pickPart(rb.dataset.r, true); return; }
        selectGroup(g.id, true);
      };
      sec.appendChild(row);
    }
    host.appendChild(sec);
  }
  if (b.dnp.length) {
    const sec = document.createElement("section"); sec.className = "step";
    sec.innerHTML = `<h2>不焊（DNP）</h2><p>PCB 里标了 DNP 的器件，板图上用虚线框表示。</p><div class="refs" style="grid-column:auto">${b.dnp.map(r => `<button type="button" data-r="${esc(r)}">${esc(r)}</button>`).join("")}</div>`;
    sec.querySelectorAll("button").forEach(x => x.onclick = () => pickPart(x.dataset.r, true));
    host.appendChild(sec);
  }
}
function renderTps() {
  const tps = S.b.parts.filter(p => p.tp).sort((a, b) => Enrich.natcmp(a.r, b.r));
  if (S.b.noNets) { $("#tps").innerHTML = '<span class="note" style="grid-column:auto">这份数据没有网络信息（只有 Gerber + 坐标文件），没法查引脚连接。把 IPC-356 网表（嘉立创 Gerber 包里的 FlyingProbeTesting.json 也行）一起拖进来即可。</span>'; return; }
  $("#tps").innerHTML = tps.length ? tps.map(p => `<button type="button" data-r="${esc(p.r)}">${esc(p.r)} <span>${esc(p.pads[0]?.[1] || "未连接")}</span></button>`).join("") : '<span class="hint">这块板没有测试点</span>';
  $("#tps").querySelectorAll("button").forEach(b => b.onclick = () => pickPad(b.dataset.r, 0, true));
}

$("#q").addEventListener("input", e => {
  S.q = e.target.value; renderList();
  const q = S.q.trim().toUpperCase(); if (!q) return;
  const m = q.match(/^([A-Z_#]+\d+)[.\-·:](\w+)$/);
  if (m) { const p = S.pm[Object.keys(S.pm).find(r => r.toUpperCase() === m[1])]; const i = p ? p.pads.findIndex(pd => pd[0].toUpperCase() === m[2]) : -1;
    if (i >= 0) { if (S.mode !== "pin") setMode("pin"); pickPad(p.r, i, true); } return; }
  const p = S.b.parts.find(p => p.r.toUpperCase() === q);
  if (p) { pickPart(p.r, true); return; }
  const net = Object.keys(S.netIdx).find(n => n.toUpperCase() === q);
  if (net) { if (S.mode !== "pin") setMode("pin"); const x = S.netIdx[net][0]; pickPad(x.r, x.i, false); }
});
$("#clr").onclick = () => { S.sel = null; S.cur = null; S.pad = null; $("#q").value = ""; S.q = ""; render(); renderList(); renderCard(); fitAll(); };

$("#copyBom").onclick = async () => {
  const b = S.b, rows = [["步骤", "名称", "封装", "LCSC", "MPN", "数量", "位号", "极性", "备注"]];
  for (const g of b.groups) rows.push([Enrich.STEPS[g.step][0], g.nm, g.fp, g.lcsc, g.mpn, g.refs.length, g.refs.join(","), { k1: "阴极", plus1: "正负", pin1: "1脚" }[g.pol] || "", g.note]);
  if (b.dnp.length) rows.push(["DNP", "不焊", "", "", "", b.dnp.length, b.dnp.join(","), "", ""]);
  const tsv = rows.map(r => r.map(x => String(x ?? "").replace(/[\t\n]/g, " ")).join("\t")).join("\n");
  try { await navigator.clipboard.writeText(tsv); toast("已复制，可直接粘贴到 Excel"); }
  catch (e) { const ta = document.createElement("textarea"); ta.value = tsv; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); toast("已复制，可直接粘贴到 Excel"); } catch (e2) { toast("浏览器不允许复制"); } ta.remove(); }
};
let armed = null;
function twoStep(btn, label, fn) {
  if (armed === btn) { armed = null; btn.textContent = label; fn(); return; }
  armed = btn; const old = btn.textContent; btn.textContent = "再点一次确认"; setTimeout(() => { if (armed === btn) { armed = null; btn.textContent = old; } }, 3000);
}
$("#resetProg").onclick = e => twoStep(e.currentTarget, "清空进度", () => { doneAll[S.b.key] = {}; saveDone(); render(); renderList(); renderCard(); });
$("#rmAll").onclick = e => twoStep(e.currentTarget, "清空全部板子", () => {
  for (const b of S.boards) DB.del(b.key);
  S.boards = []; doneAll = {}; saveDone(); showNotes([]); showEmpty();
});
$("#rmBoard").onclick = e => twoStep(e.currentTarget, "移除这块板", () => {
  const k = S.b.key; DB.del(k); S.boards = S.boards.filter(x => x.key !== k); delete doneAll[k]; saveDone();
  if (S.boards.length) openBoard(S.boards[0].key); else showEmpty();
});

// ---------- keyboard ----------
document.addEventListener("keydown", e => {
  if (!S.b || e.target.matches("input, select, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (k === "n" || k === "N" || k === "]") stepGroup(1, true);
  else if (k === "[") stepGroup(-1, false);
  else if (k === " ") { e.preventDefault(); $("#doneNext").click(); }
  else if (k === "t" || k === "T") setMode(S.mode === "pin" ? "solder" : "pin");
  else if (k === "f" || k === "F") setSide(S.side === "F" ? "B" : "F", true);
  else if ((k === "d" || k === "D") && S.mode === "pin") $("#splitBtn").click();
  else if (k === "r" || k === "R") $("#rotBtn").click();
  else if (k === "0") fitAll();
  else if (k === "+" || k === "=") zoomAll(1.4);
  else if (k === "-") zoomAll(1 / 1.4);
  else if (k === "Escape") $("#clr").click();
  else return;
});

// ---------- boards ----------
function renderTabs() {
  const tabs = $("#tabs"); tabs.innerHTML = "";
  for (const b of S.boards) {
    const n = b.groups.reduce((a, g) => a + g.refs.length, 0);
    const t = document.createElement("button");
    t.type = "button"; t.setAttribute("role", "tab"); t.setAttribute("aria-selected", S.b && S.b.key === b.key);
    t.innerHTML = `<span class="k">${esc(b.name)}</span><span class="s">${esc(b.sub ? b.sub + " · " : "")}${n} 个</span>`;
    t.onclick = () => openBoard(b.key);
    tabs.appendChild(t);
  }
  const add = document.createElement("button"); add.type = "button"; add.className = "add"; add.innerHTML = '<span class="k">＋ 添加</span><span class="s">文件夹 / zip</span>';
  add.onclick = () => $("#inDir").click(); tabs.appendChild(add);
}
function openBoard(key) {
  S.b = S.boards.find(b => b.key === key) || S.boards[0];
  S.sel = null; S.cur = null; S.pad = null; S.vb = null; S.vb2 = null; S.split = false; S.splitForce = false; S.rot = 0; $("#rotBtn").textContent = "⟳ 0°";
  S.pm = Object.fromEntries(S.b.parts.map(p => [p.r, p]));
  S.netIdx = {};
  for (const p of S.b.parts) p.pads.forEach((pd, i) => { if (pd[1]) (S.netIdx[pd[1]] ||= []).push({ r: p.r, i, n: pd[0], s: p.tht ? "T" : p.s }); });
  for (const n in S.netIdx) S.netIdx[n].sort((a, b) => Enrich.natcmp(a.r, b.r) || a.i - b.i);
  setSide("F");
  document.querySelectorAll("#sideSeg button").forEach(x => x.setAttribute("aria-pressed", x.dataset.side === "F"));
  LS.set("last", S.b.key);
  renderTabs(); renderTps(); render(); renderList(); renderCard();
  if (S.mode === "solder" && S.b.groups.length) { const done = doneOf(); const g = S.b.groups.find(g => !g.refs.every(r => done[r])) || S.b.groups[0]; selectGroup(g.id, false); }
}
function showApp() { $("#empty").hidden = true; $("#app").hidden = false; $("#tabs").hidden = false; }
function showEmpty() { $("#empty").hidden = false; $("#app").hidden = true; $("#tabs").hidden = true; S.b = null; }
window.addEventListener("resize", () => { if (S.b) visiblePanes().forEach(P => setVB(S[P.key], P)); });

(async () => {
  let saved = await DB.all() || [];
  const stale = saved.filter(b => b.ver !== IMPORT_VER);
  if (stale.length) {
    for (const b of stale) DB.del(b.key);
    saved = saved.filter(b => b.ver === IMPORT_VER);
    const names = stale.filter(b => b.key !== "demo#builtin").map(b => b.name);
    if (names.length) showNotes([`· 之前用旧版本读入的 ${names.length} 块板（${names.slice(0, 8).join("、")}${names.length > 8 ? " 等" : ""}）已移除：导入规则更新了，旧结果可能不对。请点“＋ 添加”重新选择原来的文件夹。`]);
  }
  if (saved.length) {
    S.boards = saved.sort((a, b) => (a.added || 0) - (b.added || 0));
    showApp(); openBoard(LS.get("last", S.boards[0].key));
  } else {
    // first visit: open the built-in example so the page shows what it does
    $("#loadDemo").click(); toast("这是示例板。点右上角“＋ 添加”读入你自己的工程文件夹或生产文件。", 5000);
  }
})();
