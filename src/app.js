// ======================= app =======================
const LS = {
  get(k, d) { try { const v = localStorage.getItem("psn:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("psn:" + k, JSON.stringify(v)); } catch (e) {} },
};
// theme: follow the system unless the viewer picked one
const THEMES = [["", "◐ 跟随系统"], ["light", "☀ 浅色"], ["dark", "☾ 深色"]];
function applyTheme(t) { const th = THEMES.find(x => x[0] === t) || THEMES[0]; if (th[0]) document.documentElement.dataset.theme = th[0]; else delete document.documentElement.dataset.theme; $("#themeBtn").textContent = th[1]; }
applyTheme(LS.get("theme", ""));
$("#themeBtn").onclick = () => { const i = THEMES.findIndex(x => x[0] === (document.documentElement.dataset.theme || "")), t = THEMES[(i + 1) % THEMES.length][0]; LS.set("theme", t); applyTheme(t); };
let toastT;
// act = [buttonLabel, fn] adds one action button (e.g. 撤销)
function toast(msg, ms = 3200, act) {
  const t = $("#toast"); t.textContent = msg;
  if (act) { const b = document.createElement("button"); b.type = "button"; b.textContent = act[0]; b.onclick = () => { t.hidden = true; act[1](); }; t.append(b); }
  t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms);
}

// ---------- IndexedDB (per-browser board cache) ----------
const DB = {
  db: null,
  async open() {
    if (this.db) return this.db;
    return this.db = await new Promise((res, rej) => {
      try {
        const r = indexedDB.open("pcb-solder-nav", 3);
        r.onupgradeneeded = () => {
          if (!r.result.objectStoreNames.contains("boards")) r.result.createObjectStore("boards", { keyPath: "key" });
          if (!r.result.objectStoreNames.contains("schematics")) r.result.createObjectStore("schematics", { keyPath: "key" });
          if (!r.result.objectStoreNames.contains("schSources")) r.result.createObjectStore("schSources", { keyPath: "key" });
        };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
  },
  async tx(mode, fn, store = "boards") { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction(store, mode), s = t.objectStore(store); const out = fn(s); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); }); },
  all(store = "boards") { return this.tx("readonly", s => s.getAll(), store).catch(() => []); },
  get(k, store = "boards") { return this.tx("readonly", s => s.get(k), store).catch(() => null); },
  put(b, store = "boards") { return this.tx("readwrite", s => s.put(b), store).catch(() => {}); },
  del(k, store = "boards") { return this.tx("readwrite", s => s.delete(k), store).catch(() => {}); },
};

const S = { boards: [], b: null, side: "F", rot: 0, mode: "solder", lbl: LS.get("lbl", "ref"), trk: LS.get("trk", true), hideDone: LS.get("hideDone", false), sel: null, cur: null, pad: null, vb: null, q: "", netIdx: {}, worldEl: null, pm: {} };
let doneAll = LS.get("done", {});
const doneOf = () => (doneAll[S.b.key] ||= {});
const saveDone = (key = S.b?.key) => { LS.set("done", doneAll); if (key) markDirty(key); };
// progress changes can be undone (Ctrl+Z / U): snapshot the board's done map before each change
const undoStack = [];
function remember(label) { undoStack.push({ key: S.b.key, done: { ...doneOf() }, label }); if (undoStack.length > 30) undoStack.shift(); }
function undo() {
  let u; while ((u = undoStack.pop()) && !S.boards.some(b => b.key === u.key));
  if (!u) { toast("没有可以撤销的操作"); return; }
  doneAll[u.key] = u.done; saveDone(u.key);
  if (S.b.key !== u.key) openBoard(u.key); else { render(); renderList(); renderCard(); }
  toast("已撤销：" + u.label);
}
const undoAct = ["撤销", () => undo()];
// power-up check ticks: { boardKey: { net: 1 } }
let pwrAll = LS.get("pwr", {});
const savePwr = (key = S.b?.key) => { LS.set("pwr", pwrAll); if (key) markDirty(key); };
function dropProgress(k) { delete doneAll[k]; delete pwrAll[k]; LS.set("done", doneAll); LS.set("pwr", pwrAll); }
// a re-imported revision of a board keeps the ticks of designators that still exist
function moveProgress(from, b) {
  if (from === b.key) return;
  const refs = new Set(b.parts.map(p => p.r)), d = Object.entries(doneAll[from] || {}).filter(([r]) => refs.has(r));
  if (d.length) doneAll[b.key] = { ...Object.fromEntries(d), ...doneAll[b.key] };
  if (pwrAll[from]) pwrAll[b.key] = { ...pwrAll[from], ...pwrAll[b.key] };
  dropProgress(from);
}
const sameDesign = (a, b) => { const A = new Set(a.parts.map(p => p.r)), n = b.parts.filter(p => A.has(p.r)).length; return n >= 0.7 * Math.min(A.size, b.parts.length); };

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
const IMPORT_VER = 5;
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
  const roots = new Set(list.filter(e => e.path.includes("/")).map(e => e.path.split("/")[0]));
  for (const m of res.boards) {
    const b = m.board;
    Enrich.enrich(b, m.bom);
    if (!b.groups.length && !b.dnp.length) { res.notes.push(`${m.path.replace(/#.*$/, "")}：里面没有需要焊接的器件（可能只是封装库或板框），已跳过`); continue; }
    Object.assign(b, { name: m.name, sub: m.source, source: m.source, bomFile: m.bomFile || "", file: m.path.replace(/#.*$/, "").split("/").pop(), added: Date.now(), warn: b.warn || [], ver: IMPORT_VER });
    b.key = boardKey(m, b);
    // same key, or the same board re-exported somewhere else (same name and source, mostly the same designators)
    const old = S.boards.findIndex(x => x.key === b.key || (x.name === b.name && x.source === b.source && sameDesign(x, b)));
    if (old >= 0) { const o = S.boards[old]; if (o.key !== b.key) { markDeleted(o.key); DB.del(o.key); moveProgress(o.key, b); } S.boards[old] = b; } else S.boards.push(b);
    DB.put(b); markDirty(b.key); firstKey ||= b.key; added.push(b.key);
  }
  const newKeys = new Set(added);
  if (added.length) for (const old of S.boards.filter(x => [...roots].some(r => x.key.startsWith(r + "/")) && !newKeys.has(x.key))) {
    const heir = S.boards.find(x => newKeys.has(x.key) && !doneAll[x.key] && sameDesign(old, x));
    markDeleted(old.key); DB.del(old.key); if (heir) moveProgress(old.key, heir); else dropProgress(old.key); S.boards = S.boards.filter(x => x !== old);
  }
  const schematicCount = ingestSchematics(res.schematics || [], roots);
  const msgs = [...res.errors.map(e => "✗ " + e), ...res.notes.map(n => "· " + n)];
  S.flash = null;
  // import notes belong to the boards this import produced, so switching tabs shows the right ones
  for (const k of added) { const b = S.boards.find(x => x.key === k); if (b) { b.notes = msgs; DB.put(b); } }
  if (!firstKey) showNotes(msgs);
  const from = [...roots].join("、");
  if (firstKey) { toast(`${from ? "从 " + from + " " : ""}读入 ${added.length} 块板${schematicCount ? `、${schematicCount} 页原理图` : ""}${msgs.length ? "，有 " + msgs.length + " 条说明" : ""}`); showApp(); openBoard(firstKey); }
  else if (schematicCount) { toast(`已加入 ${schematicCount} 页原理图${msgs.length ? "，有 " + msgs.length + " 条说明" : ""}`); showSchematics(); }
  else toast(msgs.length ? msgs.slice(0, 3).join("\n") : "没有找到能识别的板子或原理图文件", 8000);
}
function showNotes(msgs) {
  for (const id of ["#notes", "#notesEmpty"]) { const n = $(id); if (!n) continue; n.hidden = !msgs.length; n.innerHTML = msgs.length ? `<b>导入说明</b><ul>${msgs.map(m => `<li>${esc(m)}</li>`).join("")}</ul>` : ""; }
}
function filesToList(files) { return [...files].map(f => fileEntry(f)); }
// iPad / iPhone cannot pick folders (iPadOS reports itself as a Mac with touch): offer files / zip only and say how to zip a folder
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
if (IOS) { $("#pickDir").hidden = true; $("#pickFiles").classList.add("primary"); $("#iosTip").hidden = false; $("#drop h2").textContent = "选择工程 zip / rar 或文件"; }
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
  const side = S.split ? p.s : S.side;
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
  const selNet = selectedNet();
  if (S.trk) {
    // copper in one group so overlapping pieces do not stack up in opacity; the selected net is drawn again on top
    const cu = el("g", { class: "cu" }, world), on = el("g", { class: "cu on" }, world);
    for (const [d, net] of (b.pours && b.pours[side]) || []) el("path", { d, class: "pour" }, selNet && net === selNet ? on : cu);
    for (const [w, d, net] of b.tracks[side]) el("path", { d, class: "trk", "stroke-width": w }, selNet && net === selNet ? on : cu);
    for (const [vx, vy, vr, net] of b.vias) { const g = selNet && net === selNet ? on : cu; el("circle", { cx: vx, cy: vy, r: vr, class: "via" }, g); el("circle", { cx: vx, cy: vy, r: Math.max(.05, vr * .45), class: "vhole" }, g); }
  }
  if (b.silk[side]) el("path", { d: b.silk[side], class: "bsilk" }, world);
  if (b.edges) el("path", { d: b.edges, class: "b-edge" }, world);
  const done = doneOf(), pin = S.mode === "pin";
  const selRefs = new Set(pin ? [] : S.sel ? (b.groups.find(g => g.id === S.sel)?.refs || []) : (S.cur ? [S.cur] : []));
  const netRefs = new Set(selNet ? (S.netIdx[selNet] || []).map(x => x.r) : []);
  if (pin && S.cur) netRefs.add(S.cur);
  if (selRefs.size || netRefs.size) world.classList.add("dim");
  const parts = el("g", {}, world), labels = el("g", {}, world), pnums = el("g", {}, world), rings = el("g", {}, world);
  for (const p of b.parts) {
    // parts placed on the other side are hidden; of a through-hole part only its holes show through
    const thru = p.s !== side;
    if (thru && !p.tht) continue;
    const g = el("g", { class: "part" + (thru ? " thru" : "") + (p.tp ? " tp" : "") + (p.dnp ? " dnp" : "") + (done[p.r] && !pin ? " done" : "") + (selRefs.has(p.r) ? " hi" : "") + (netRefs.has(p.r) ? " nhi" : "") + (S.cur === p.r ? " cur" : ""), "data-r": p.r }, parts);
    if (p.body && !thru) el("path", { d: p.body, class: "body" }, g);
    if (p.silk && !p.tp && !thru) el("path", { d: p.silk, class: "sk" }, g);
    const polar = p.pol && p.pol !== "none-bi", p1n = p.p1n ?? "1";
    if (pin) {
      // neighbours of the selected pad on another net: a bridge there is a short
      const nbs = S.pad && S.pad.r === p.r ? neighbours(p, S.pad.i) : [];
      const bad = nbs.length && nbs.length <= 8 ? new Set(nbs.filter(j => bridgeKind(p.pads[S.pad.i][1], p.pads[j][1]) === "diff")) : null;
      p.pads.forEach(([n, net, d, th, px, py, sz], i) => {
        if (!d) return;
        const isSel = S.pad && S.pad.r === p.r && S.pad.i === i, onNet = selNet && net === selNet;
        el("path", { d, class: "pad" + (th === 2 ? " npth" : "") + (n === p1n && polar ? " p1" : "") + (onNet ? " net" : "") + (isSel ? " psel" : "") }, g);
        if (n && th !== 2 && sz > 0) { const fs = Math.max(.12, Math.min(.9, sz * .55 / Math.max(1, n.length * .6))); const t = el("text", { transform: V.up(px, py), class: "pn", "font-size": fs }, pnums); t.textContent = n; }
        if (onNet || isSel) el("circle", { cx: px, cy: py, r: sz / 2 + .45, class: "ring" + (isSel ? " cur" : " net") }, rings);
        else if (bad && bad.has(i)) el("circle", { cx: px, cy: py, r: sz / 2 + .3, class: "ring nb" }, rings);
      });
    } else {
      let pd = "", p1d = "", nd = "";
      for (const [n, net, d, th] of p.pads) { if (!d) continue; if (th === 2) nd += d; else if (n === p1n && polar) p1d += d; else pd += d; }
      if (pd) el("path", { d: pd, class: "pad" }, g);
      if (p1d) el("path", { d: p1d, class: "pad p1" }, g);
      if (nd) el("path", { d: nd, class: "pad npth" }, g);
    }
    if (thru) continue;
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
wrap.addEventListener("wheel", e => { e.preventDefault(); const P = paneOf(e.target), r = P.svg.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top, P); }, { passive: false });
// a press counts as a click only if the pointer ends up near where it went down (slow drags move a pixel per event)
const ptrs = new Map(); let moved = false, dragPane = P0, down = null;
wrap.addEventListener("pointerdown", e => { if (!ptrs.size) { dragPane = paneOf(e.target); down = { x: e.clientX, y: e.clientY, btn: e.button }; moved = false; } else moved = true; ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); wrap.setPointerCapture(e.pointerId); wrap.classList.add("drag"); });
wrap.addEventListener("pointermove", e => {
  if (!ptrs.has(e.pointerId)) return;
  const P = dragPane, prev = ptrs.get(e.pointerId), cur = { x: e.clientX, y: e.clientY };
  if (ptrs.size === 1) {
    const dx = cur.x - prev.x, dy = cur.y - prev.y; if (down && Math.hypot(cur.x - down.x, cur.y - down.y) > 5) moved = true;
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
  if (!moved && e.type === "pointerup" && down && down.btn === 0) {
    const P = paneOf(document.elementFromPoint(e.clientX, e.clientY) || e.target);
    if (S.mode === "pin") { const hp = padAt(e.clientX, e.clientY, P); if (hp) { pickPad(hp.r, hp.i, false, true); return; } }
    const hit = document.elementsFromPoint(e.clientX, e.clientY).map(n => n.closest && n.closest(".part:not(.thru)")).find(Boolean);
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
  render(); renderList(); renderCard(); renderPwr();
}

// ---------- selection ----------
const groupOfRef = r => S.b.groups.find(g => g.refs.includes(r));
function selectGroup(id, zoom) {
  if (S.mode === "pin") { const g0 = S.b.groups.find(g => g.id === id); if (g0) pickPart(g0.refs[0], true); return; }
  S.sel = S.sel === id && !zoom ? null : id; S.cur = null; S.pad = null;
  const g = S.b.groups.find(g => g.id === S.sel);
  if (g) { const p = S.pm[g.refs[0]]; if (p && p.s !== S.side) setSide(p.s); }
  render(); renderList(); renderCard();
  if (g && zoom) zoomTo(g.refs);
  const row = document.querySelector(`.grp[data-id="${S.sel}"]`); if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function pickPart(r, zoom) {
  const p = S.pm[r]; if (!p) return;
  const g = groupOfRef(r);
  S.sel = g && S.mode !== "pin" ? g.id : null; S.cur = r; S.pad = null;
  if (p.s !== S.side) setSide(p.s);
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
// returns false when nothing is left to go to
function stepGroup(dir, unfinishedOnly, quiet) {
  const gs = orderedGroups(); if (!gs.length) return false;
  if (S.mode === "pin") setMode("solder");
  const done = doneOf(), at = gs.findIndex(g => g.id === S.sel);
  for (let k = 1; k <= gs.length; k++) {
    const g = gs[((at < 0 ? (dir > 0 ? -1 : 0) : at) + dir * k + gs.length * 2) % gs.length];
    if (!unfinishedOnly || !g.refs.every(r => done[r])) { S.sel = null; selectGroup(g.id, true); return true; }
  }
  if (!quiet) toast("这块板全部焊完了 ✓");
  return false;
}
$("#nextBtn").onclick = () => stepGroup(1, true);
$("#prevBtn").onclick = () => stepGroup(-1, false);
$("#doneNext").onclick = () => {
  const g = S.b.groups.find(g => g.id === S.sel); if (!g) { stepGroup(1, true); return; }
  const done = doneOf(), was = g.refs.filter(r => !done[r]).length;
  if (was) { remember(`${g.nm} 标记已焊`); g.refs.forEach(r => done[r] = 1); saveDone(); }
  const more = stepGroup(1, true, true);
  if (!more) { render(); renderList(); renderCard(); }
  if (was) toast(`✓ ${g.nm} ×${g.refs.length} 已焊${more ? "" : " · 这块板全部焊完了"}`, 4000, undoAct);
  else if (!more) toast("这块板全部焊完了 ✓");
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
  const b = c.querySelector("#cdone"); if (b) b.onclick = () => { remember(`${p.r} ${done[p.r] ? "取消已焊" : "标记已焊"}`); done[p.r] ? delete done[p.r] : (done[p.r] = 1); saveDone(); render(); renderList(); renderCard(); };
}
const autoNet = n => /^\d+$/.test(n) || /^Net-\(|^unconnected-/i.test(n) || /-power-|^[a-z_]+-\w/.test(n);
// pad outline bbox from its path (absolute M/L points); circles drawn with arcs fall back to centre ± size
const boxCache = new WeakMap();
function padBox(pd) {
  let b = boxCache.get(pd); if (b) return b;
  b = [1e9, 1e9, -1e9, -1e9];
  if (!/[aAcC]/.test(pd[2])) { const re = /[ML]\s*(-?[\d.]+(?:e-?\d+)?)[\s,]+(-?[\d.]+(?:e-?\d+)?)/g; let m; while ((m = re.exec(pd[2]))) Geom.bboxOf([[+m[1], +m[2]]], b); }
  if (b[0] > b[2]) { const h = pd[6] / 2; b = [pd[4] - h, pd[5] - h, pd[4] + h, pd[5] + h]; }
  boxCache.set(pd, b); return b;
}
// pads of the same part close enough to bridge with solder: gap within 0.3 mm of the closest one (3+ pin parts only)
function neighbours(p, i) {
  const me = p.pads[i]; if (!me || !me[2]) return [];
  const live = p.pads.map((q, j) => [q, j]).filter(([q, j]) => j !== i && q[2] && q[3] !== 2 && !(q[0] && q[0] === me[0]));
  if (live.length < 2) return [];
  const a = padBox(me), gap = q => { const b = padBox(q); return Math.hypot(Math.max(0, b[0] - a[2], a[0] - b[2]), Math.max(0, b[1] - a[3], a[1] - b[3])); };
  const g = live.map(([q, j]) => [j, gap(q)]), lim = Math.min(Math.min(...g.map(x => x[1])) + 0.3, 1.5), seen = new Set();
  return g.filter(x => x[1] <= lim).sort((x, y) => x[1] - y[1]).map(x => x[0]).filter(j => { const n = p.pads[j][0]; if (n && seen.has(n)) return false; seen.add(n); return true; });
}
const bridgeKind = (net, other) => !net || !other ? "nc" : net === other ? "same" : "diff";
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
      ${bridgeHtml(p, S.pad.i, net)}
      <div class="hint">本器件全部引脚：</div>`;
  } else body = `<div class="hint">点板上的焊盘，或下面的引脚：</div>`;
  const pins = p.pads.map((pd, i) => [pd, i]).filter(([pd]) => pd[2] && pd[3] !== 2);
  return body + `<div class="pins">${pins.map(([pd, i]) => `<button type="button" data-r="${esc(p.r)}" data-i="${i}" class="${S.pad && S.pad.r === p.r && S.pad.i === i ? "on" : ""}"><b>${esc(pd[0] || "–")}</b> ${pd[1] ? esc(pd[1]) : '<span class="hint">NC</span>'}</button>`).join("")}</div>`;
}
// solder-bridge check: which neighbouring pads may touch this one and which must not
function bridgeHtml(p, i, net) {
  const nb = neighbours(p, i); if (!nb.length) return "";
  const k = nb.map(j => bridgeKind(net, p.pads[j][1])), diff = k.filter(x => x === "diff").length;
  // a thermal pad borders every pin around it: summarise instead of listing them all
  if (nb.length > 8) return `<div class="hint">相邻焊盘（查连锡）：四周 ${nb.length} 个焊盘都挨着它${diff ? `，<b class="bad">其中 ${diff} 个不同网络</b>，焊完看一圈有没有和它连上` : ""}</div>`;
  const TXT = { same: "同网络", diff: "✗ 不能连", nc: "悬空" }, TIP = { same: "同一网络：连锡也不影响电路", diff: "不同网络：连锡就短路", nc: "有一边不接网络：一般没影响，最好也分开" };
  return `<div class="hint">相邻焊盘（查连锡）：${diff ? `<b class="bad">${diff} 个不同网络，连上就短路</b>` : "都是同网络或悬空，连锡不影响电路"}</div>
    <div class="nchips nb">${nb.map((j, n) => `<button type="button" class="${k[n]}" data-r="${esc(p.r)}" data-i="${j}" title="${TIP[k[n]]}"><b>${esc(p.pads[j][0] || "–")}</b> ${p.pads[j][1] ? esc(p.pads[j][1]) : "NC"} <span>${TXT[k[n]]}</span></button>`).join("")}</div>`;
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
    let gs = anyHit ? bySt[st].filter(match) : bySt[st];
    if (!gs.length) continue;
    idx++;
    const [title, desc] = Enrich.STEPS[st];
    const refs = bySt[st].flatMap(g => g.refs), sd = refs.filter(r => done[r]).length, fin = sd === refs.length;
    const sec = document.createElement("section"); sec.className = "step" + (fin ? " fin" : "");
    sec.innerHTML = `<h2><span class="no">${idx}</span>${title}<span class="cnt">${fin ? "✓ " : ""}${sd}/${refs.length}</span></h2>${fin && S.hideDone ? "" : `<p>${desc}</p>`}`;
    // hiding finished groups never hides search hits or the group being worked on
    if (S.hideDone && !q) gs = gs.filter(g => g.id === S.sel || !g.refs.every(r => done[r]));
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
        if (e.target.matches("input")) { remember(`${g.nm} ${e.target.checked ? "标记已焊" : "取消已焊"}`); g.refs.forEach(r => e.target.checked ? (done[r] = 1) : delete done[r]); saveDone(); render(); renderList(); renderCard(); return; }
        const rb = e.target.closest(".refs button"); if (rb) { pickPart(rb.dataset.r, true); showStage(); return; }
        selectGroup(g.id, true); showStage();
      };
      sec.appendChild(row);
    }
    host.appendChild(sec);
  }
  if (b.dnp.length) {
    const sec = document.createElement("section"); sec.className = "step";
    sec.innerHTML = `<h2>不焊（DNP）</h2><p>PCB 里标了 DNP 的器件，板图上用虚线框表示。</p><div class="refs" style="grid-column:auto">${b.dnp.map(r => `<button type="button" data-r="${esc(r)}">${esc(r)}</button>`).join("")}</div>`;
    sec.querySelectorAll("button").forEach(x => x.onclick = () => { pickPart(x.dataset.r, true); showStage(); });
    host.appendChild(sec);
  }
}
const narrow = matchMedia("(max-width: 900px)");
// phones: the board sits above the list, so bring it back into view after picking something from the list
function showStage() { if (!narrow.matches) return; const st = $(".stage"), r = st.getBoundingClientRect(); if (r.top < -40 || r.top > innerHeight * .3) st.scrollIntoView({ behavior: "smooth", block: "start" }); }
$("#hideDone").setAttribute("aria-pressed", S.hideDone); $("#hideDone").onclick = () => { S.hideDone = !S.hideDone; LS.set("hideDone", S.hideDone); $("#hideDone").setAttribute("aria-pressed", S.hideDone); renderList(); };
function renderTps() {
  const tps = S.b.parts.filter(p => p.tp).sort((a, b) => Enrich.natcmp(a.r, b.r));
  if (S.b.noNets) { $("#tps").innerHTML = '<span class="note" style="grid-column:auto">这份数据没有网络信息（只有 Gerber + 坐标文件），没法查引脚连接。把 IPC-356 网表（嘉立创 Gerber 包里的 FlyingProbeTesting.json 也行）一起拖进来即可。</span>'; return; }
  $("#tps").innerHTML = tps.length ? tps.map(p => `<button type="button" data-r="${esc(p.r)}">${esc(p.r)} <span>${esc(p.pads[0]?.[1] || "未连接")}</span></button>`).join("") : '<span class="hint">这块板没有测试点</span>';
  $("#tps").querySelectorAll("button").forEach(b => b.onclick = () => { pickPad(b.dataset.r, 0, true); showStage(); });
}
// ---------- power-up check: measure every supply net against ground before the first power-on ----------
const leaf = n => n.split("/").pop();
const isGnd = n => /^([ADPSC]GND|GND|VSS|0V$|EARTH$)/i.test(leaf(n));
const isPwr = n => !isGnd(n) && /^([+-]?\d+(\.\d+)?V\d*|V_?(CC|DD|BAT|BUS|IN|SYS|MOT|M|USB|IO|CORE|REF|AA|DDA|DDIO|LED|OUT|PP|S|SUPPLY)|BAT\+?|PWR|POWER|\+V)([_\-.+]\w*|\d\w*)?$/i.test(leaf(n));
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true });
function renderPwr() {
  const sec = $("#pwrSec"), b = S.b, nets = Object.keys(S.netIdx), pwr = nets.filter(isPwr).sort(byName), gnd = nets.filter(isGnd).sort(byName);
  sec.hidden = S.mode !== "pin" || !!b.noNets || !pwr.length;
  if (sec.hidden) return;
  const ok = pwrAll[b.key] || {}, n = pwr.filter(x => ok[x]).length, chip = (x, cls) => `<button type="button" class="pnet${cls}" data-n="${esc(x)}">${esc(x)}</button>`;
  $("#pwrCnt").textContent = (n === pwr.length ? "✓ " : "") + `${n}/${pwr.length}`;
  $("#pwr").innerHTML = (gnd.length ? `<div class="hint">地：${gnd.map(g => chip(g, " gnd")).join(" ")}</div>` : '<div class="note" style="grid-column:auto">没找到名字像 GND 的网络，先确认哪个是地。</div>')
    + pwr.map(x => `<div class="prow${ok[x] ? " ok" : ""}"><input type="checkbox" data-n="${esc(x)}" ${ok[x] ? "checked" : ""} aria-label="${esc(x)} 已量过">${chip(x, "")}<span class="hint">${S.netIdx[x].length} 个焊盘</span></div>`).join("");
  $("#pwr").querySelectorAll("input").forEach(c => c.onchange = () => { const o = (pwrAll[b.key] ||= {}); c.checked ? (o[c.dataset.n] = 1) : delete o[c.dataset.n]; savePwr(); renderPwr(); });
  $("#pwr").querySelectorAll(".pnet").forEach(x => x.onclick = () => { showNet(x.dataset.n); showStage(); });
}
// highlight a whole net and frame all its pads
function showNet(net) { const x = (S.netIdx[net] || [])[0]; if (!x) return; if (S.mode !== "pin") setMode("pin"); pickPad(x.r, x.i, false); frameNet(); }

$("#q").addEventListener("input", e => {
  S.q = e.target.value; renderList();
  const q = S.q.trim().toUpperCase(); if (!q) return;
  const m = q.match(/^([A-Z_#]+\d+)[.\-·:](\w+)$/);
  if (m) { const p = S.pm[Object.keys(S.pm).find(r => r.toUpperCase() === m[1])]; const i = p ? p.pads.findIndex(pd => pd[0].toUpperCase() === m[2]) : -1;
    if (i >= 0) { if (S.mode !== "pin") setMode("pin"); pickPad(p.r, i, true); } return; }
  const p = S.b.parts.find(p => p.r.toUpperCase() === q);
  if (p) { pickPart(p.r, true); return; }
  const net = Object.keys(S.netIdx).find(n => n.toUpperCase() === q);
  if (net) showNet(net);
});
// Enter keeps the result, Esc clears it; both hand the keyboard back to the shortcuts
$("#q").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); else if (e.key === "Escape") { e.preventDefault(); e.target.blur(); $("#clr").click(); } });
$("#clr").onclick = () => { S.sel = null; S.cur = null; S.pad = null; $("#q").value = ""; S.q = ""; render(); renderList(); renderCard(); fitAll(); };

$("#copyBom").onclick = async () => {
  const b = S.b, rows = [["步骤", "名称", "封装", "LCSC", "MPN", "数量", "位号", "极性", "备注"]];
  for (const g of b.groups) rows.push([Enrich.STEPS[g.step][0], g.nm, g.fp, g.lcsc, g.mpn, g.refs.length, g.refs.join(","), { k1: "阴极", plus1: "正负", pin1: "1脚" }[g.pol] || "", g.note]);
  if (b.dnp.length) rows.push(["DNP", "不焊", "", "", "", b.dnp.length, b.dnp.join(","), "", ""]);
  const tsv = rows.map(r => r.map(x => String(x ?? "").replace(/[\t\n]/g, " ")).join("\t")).join("\n");
  try { await navigator.clipboard.writeText(tsv); toast("已复制，可直接粘贴到 Excel"); }
  catch (e) { const ta = document.createElement("textarea"); ta.value = tsv; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); toast("已复制，可直接粘贴到 Excel"); } catch (e2) { toast("浏览器不允许复制"); } ta.remove(); }
};
// destructive buttons: first click arms (label → 再点一次确认), second click within 3 s runs; arming another button disarms the first
let armed = null;
function disarm() { if (!armed) return; clearTimeout(armed.t); armed.btn.textContent = armed.label; armed = null; }
function twoStep(btn, fn) {
  if (armed && armed.btn === btn) { disarm(); fn(); return; }
  disarm(); armed = { btn, label: btn.textContent, t: setTimeout(disarm, 3000) }; btn.textContent = "再点一次确认";
}

// ---------- offline-first cloud sync ----------
const syncMeta = LS.get("syncMeta", {});
let syncTimer = null, syncing = false, syncAgain = false, lastSync = 0, syncError = "";
function updateSyncUI() {
  const c = Cloud.state(), btn = $("#syncBtn");
  btn.classList.remove("online", "busy", "error");
  let label = "本地保存", status = "板子、原理图和进度正在本机保存，离线也能使用。";
  if (!c.configured) status += " 要跨设备查看，请配置 Supabase 并登录。";
  else if (!c.email) { label = "登录云同步"; status = "云服务已配置。登录后，板子、原理图、进度和删除记录才会同步。"; }
  else if (syncing) { label = "正在同步"; btn.classList.add("busy"); status = `正在同步 ${c.email} 的文档…`; }
  else if (syncError) { label = "同步待重试"; btn.classList.add("error"); status = `已保留本机数据。同步失败：${syncError}`; }
  else { label = "云端已同步"; btn.classList.add("online"); status = `${c.email} · 云端同步已开启${lastSync ? `，最近同步 ${new Date(lastSync).toLocaleTimeString()}` : ""}。`; }
  $("#syncLabel").textContent = label; $("#cloudStatus").textContent = status;
  $("#cloudLogin").hidden = !!c.email; $("#cloudSigned").hidden = !c.email;
  $("#cloudAccount").textContent = c.email;
}
function persistSyncMeta() { LS.set("syncMeta", syncMeta); }
function markDirty(k) {
  if (k === "demo#builtin" || !syncDocument(k)) return;
  syncMeta[k] = { ...syncMeta[k], updated: new Date().toISOString(), dirty: true, deleted: false };
  persistSyncMeta(); scheduleSync();
}
function markDeleted(k) {
  if (k === "demo#builtin") delete syncMeta[k];
  else syncMeta[k] = { ...syncMeta[k], updated: new Date().toISOString(), dirty: true, deleted: true };
  persistSyncMeta(); scheduleSync();
}
function scheduleSync() {
  clearTimeout(syncTimer);
  if (Cloud.state().email) syncTimer = setTimeout(() => syncBoards(), 800);
}
function applyRemoteDocument(row) {
  const isSch = !!row.payload?.schematic, previousVer = row.payload?.schematic?.ver;
  const d = isSch ? normalizeSchematic(row.payload.schematic) : row.payload?.board;
  if (!d || d.key !== row.board_key) return false;
  if (isSch && (!Array.isArray(d.components) || !Array.isArray(d.shapes) || !Array.isArray(d.wires))) return false;
  if (!isSch && d.ver !== IMPORT_VER) return false;
  const list = isSch ? SCH.docs : S.boards, i = list.findIndex(x => x.key === d.key);
  if (i >= 0) list[i] = d; else list.push(d);
  if (!isSch) { doneAll[d.key] = row.payload.done || {}; pwrAll[d.key] = row.payload.pwr || {}; }
  syncMeta[d.key] = { updated: row.updated_at, dirty: isSch && d.ver !== previousVer, deleted: false };
  if (isSch) DB.del(d.key, "schSources");
  DB.put(d, isSch ? "schematics" : "boards"); return true;
}
function syncDocument(k) { return SCH.docs.find(d => d.key === k) || S.boards.find(b => b.key === k); }
async function syncBoards(manual = false) {
  if (syncing) { syncAgain = true; return; }
  if (!Cloud.state().email || navigator.onLine === false) { if (manual) toast("当前离线或尚未登录，数据已保存在本机"); updateSyncUI(); return; }
  syncing = true; syncError = ""; updateSyncUI();
  let changed = false;
  try {
    const rows = await Cloud.pull(), remote = new Map(rows.map(r => [r.board_key, r]));
    for (const row of rows) {
      const k = row.board_key, isSch = !!row.payload?.schematic || !row.payload?.board && k.startsWith("sch:"), local = syncDocument(k), m = syncMeta[k];
      const rt = Date.parse(row.updated_at) || 0, lt = Date.parse(m?.updated || "") || local?.added || 0;
      if (row.deleted) {
        if (local && rt >= lt) {
          if (isSch) { SCH.docs = SCH.docs.filter(d => d.key !== k); if (SCH.doc?.key === k) SCH.doc = null; }
          else { S.boards = S.boards.filter(b => b.key !== k); dropProgress(k); }
          DB.del(k, isSch ? "schematics" : "boards"); if (isSch) DB.del(k, "schSources"); changed = true;
        }
        if (!m?.dirty || rt >= lt) syncMeta[k] = { updated: row.updated_at, dirty: false, deleted: true };
        continue;
      }
      if (!local && m?.deleted && lt >= rt) continue;
      if (!local || rt > lt) changed = applyRemoteDocument(row) || changed;
      else if (rt < lt && !m?.dirty) syncMeta[k] = { ...m, updated: new Date(lt).toISOString(), dirty: true, deleted: false };
    }
    for (const d of [...S.boards, ...SCH.docs]) {
      if (d.key === "demo#builtin" || syncMeta[d.key]?.deleted) continue;
      if (!syncMeta[d.key]) syncMeta[d.key] = { updated: new Date(d.added || Date.now()).toISOString(), dirty: true, deleted: false };
      if (!remote.has(d.key)) syncMeta[d.key].dirty = true;
    }
    const out = [];
    for (const d of [...S.boards, ...SCH.docs]) {
      const m = syncMeta[d.key];
      if (d.key === "demo#builtin" || !m?.dirty || m.deleted) continue;
      const payload = d.kind === "schematic" ? { schematic: d } : { board: d, done: doneAll[d.key] || {}, pwr: pwrAll[d.key] || {} };
      out.push({ board_key: d.key, payload, updated_at: m.updated, deleted: false });
    }
    for (const [k, m] of Object.entries(syncMeta)) if (m.dirty && m.deleted) out.push({ board_key: k, payload: null, updated_at: m.updated, deleted: true });
    await Cloud.push(out);
    for (const row of out) if (syncMeta[row.board_key]?.updated === row.updated_at) syncMeta[row.board_key].dirty = false;
    LS.set("done", doneAll); LS.set("pwr", pwrAll); persistSyncMeta();
    lastSync = Date.now();
    if (manual) toast(`同步完成：${S.boards.filter(b => b.key !== "demo#builtin").length} 块板 · ${SCH.docs.length} 页原理图`);
  } catch (e) { syncError = e.message || String(e); if (manual) toast("同步失败：" + syncError, 6000); }
  finally {
    syncing = false; updateSyncUI();
    if (changed) {
      const key = S.b?.key;
      if (S.boards.length) { showApp(); openBoard(S.boards.some(b => b.key === key) ? key : S.boards[0].key); }
      else showEmpty();
      renderBoardList(); renderSchLibrary();
      if ($("#schDialog").open) openSchematic(SCH.doc?.key);
    }
    if (syncAgain) { syncAgain = false; scheduleSync(); }
  }
}

$("#resetProg").onclick = e => twoStep(e.currentTarget, () => { remember("清空进度"); doneAll[S.b.key] = {}; saveDone(); render(); renderList(); renderCard(); toast("已清空这块板的进度", 5000, undoAct); });
$("#rmAll").onclick = e => twoStep(e.currentTarget, () => {
  for (const b of S.boards) { markDeleted(b.key); DB.del(b.key); }
  S.boards = []; doneAll = {}; pwrAll = {}; LS.set("done", doneAll); LS.set("pwr", pwrAll); showNotes([]); showEmpty(); renderBoardList();
});
function removeBoard(k) {
  markDeleted(k); DB.del(k); S.boards = S.boards.filter(x => x.key !== k); dropProgress(k);
  if (!S.boards.length) showEmpty(); else if (!S.b || S.b.key === k) openBoard(S.boards[0].key); else renderTabs();
  renderBoardList();
}
$("#rmBoard").onclick = e => twoStep(e.currentTarget, () => { if (S.b) { removeBoard(S.b.key); toast("已删除当前板"); } });
// × on a tab: first click asks, second click deletes
function delStep(el, key) {
  if (el.classList.contains("armed")) { removeBoard(key); toast("已删除这块板"); return; }
  el.classList.add("armed"); el.textContent = "删除？"; el.title = "再点一次删除";
  setTimeout(() => { if (el.isConnected) { el.classList.remove("armed"); el.textContent = "×"; el.title = "删除这块板"; } }, 3000);
}

// ---------- board manager and cloud dialog ----------
function openDialog(id) { const d = $(id); if (!d.open) d.showModal(); }
document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => $("#" + b.dataset.close).close());
for (const d of document.querySelectorAll("dialog")) d.addEventListener("click", e => { if (e.target === d) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); } });
function renderBoardList() {
  const list = $("#boardList"); list.innerHTML = "";
  if (!S.boards.length) { list.innerHTML = '<p>还没有板子。点下面“导入板子”开始。</p>'; return; }
  for (const b of S.boards) {
    const item = document.createElement("div"); item.className = "board-item" + (S.b?.key === b.key ? " current" : "");
    const open = document.createElement("button"); open.type = "button"; open.className = "board-open";
    const n = b.groups.reduce((a, g) => a + g.refs.length, 0), done = Object.keys(doneAll[b.key] || {}).length;
    const name = document.createElement("b"), meta = document.createElement("span"); name.textContent = b.name; meta.textContent = `${b.sub || b.source} · ${done} / ${n} 已焊`;
    open.append(name, meta); open.onclick = () => { openBoard(b.key); $("#boardsDialog").close(); };
    const del = document.createElement("button"); del.type = "button"; del.className = "tbtn danger"; del.textContent = "删除";
    del.onclick = () => twoStep(del, () => { removeBoard(b.key); toast(`已删除 ${b.name}`); });
    item.append(open, del); list.appendChild(item);
  }
}
function showBoards() { disarm(); renderBoardList(); openDialog("#boardsDialog"); }
$("#boardsBtn").onclick = showBoards; $("#manageCurrent").onclick = showBoards;
$("#managerAdd").onclick = () => { $("#boardsDialog").close(); $("#inFiles").click(); };
$("#syncBtn").onclick = () => { const c = Cloud.state(); $("#cloudUrl").value = c.url || ""; $("#cloudKey").value = c.anonKey || ""; updateSyncUI(); openDialog("#cloudDialog"); };
$("#saveCloud").onclick = () => {
  try { Cloud.setConfig($("#cloudUrl").value, $("#cloudKey").value); syncError = ""; updateSyncUI(); toast("云服务设置已保存"); }
  catch (e) { toast(e.message, 5000); }
};
$("#sendCode").onclick = async e => {
  const btn = e.currentTarget; btn.disabled = true;
  try { const email = $("#cloudEmail").value; await Cloud.sendCode(email); $("#codeRow").hidden = false; $("#cloudCode").focus(); toast("验证码已发送，请查看邮箱"); }
  catch (e2) { toast("发送失败：" + e2.message, 6000); }
  finally { btn.disabled = false; }
};
$("#cloudSignIn").onclick = async e => {
  const btn = e.currentTarget; btn.disabled = true;
  try { await Cloud.signIn($("#cloudEmail").value, $("#cloudCode").value); syncError = ""; updateSyncUI(); toast("登录成功，正在同步板子"); await syncBoards(true); }
  catch (e2) { toast("登录失败：" + e2.message, 6000); }
  finally { btn.disabled = false; }
};
$("#cloudCode").addEventListener("keydown", e => { if (e.key === "Enter") $("#cloudSignIn").click(); });
$("#syncNow").onclick = () => syncBoards(true);
$("#cloudSignOut").onclick = async () => { try { await Cloud.signOut(); } catch (e) {} lastSync = 0; syncError = ""; updateSyncUI(); toast("已退出云同步，本机板子仍然保留"); };
window.addEventListener("online", scheduleSync);
document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleSync(); });
setInterval(scheduleSync, 60000);
updateSyncUI();

// ---------- keyboard ----------
document.addEventListener("keydown", e => {
  if (!S.b || document.querySelector("dialog[open]") || e.target.matches("input, select, textarea")) return;
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "Z") && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === "n" || k === "N" || k === "]") stepGroup(1, true);
  else if (k === "u" || k === "U") undo();
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
    t.innerHTML = `<span class="k">${esc(b.name)}</span><span class="s">${esc(b.sub ? b.sub + " · " : "")}${n} 个</span><span class="del" role="button" tabindex="0" title="删除这块板" aria-label="删除 ${esc(b.name)}">×</span>`;
    t.onclick = e => { if (e.target.closest(".del")) { e.stopPropagation(); delStep(e.target.closest(".del"), b.key); return; } openBoard(b.key); };
    t.onkeydown = e => { const d = e.target.closest(".del"); if (d && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopPropagation(); delStep(d, b.key); } };
    tabs.appendChild(t);
  }
  // the folder picker cannot select a zip, so files / zip get their own button (the only one on iPad / iPhone)
  const add = (k, s, input) => { const a = document.createElement("button"); a.type = "button"; a.className = "add"; a.innerHTML = `<span class="k">${k}</span><span class="s">${s}</span>`; a.onclick = () => $(input).click(); tabs.appendChild(a); };
  add("＋ 添加", IOS ? "文件 / zip / rar（文件夹先压缩）" : "文件 / zip / rar", "#inFiles");
  if (!IOS) add("＋ 文件夹", "整个工程目录", "#inDir");
}
function openBoard(key) {
  S.b = S.boards.find(b => b.key === key) || S.boards[0];
  S.sel = null; S.cur = null; S.pad = null; S.vb = null; S.vb2 = null; S.split = false; S.splitForce = false; S.rot = 0; $("#rotBtn").textContent = "⟳ 0°";
  S.pm = Object.fromEntries(S.b.parts.map(p => [p.r, p]));
  showNotes([...(S.flash || []), ...(S.b.notes || [])]);
  S.netIdx = {};
  for (const p of S.b.parts) p.pads.forEach((pd, i) => { if (pd[1]) (S.netIdx[pd[1]] ||= []).push({ r: p.r, i, n: pd[0], s: p.tht ? "T" : p.s }); });
  for (const n in S.netIdx) S.netIdx[n].sort((a, b) => Enrich.natcmp(a.r, b.r) || a.i - b.i);
  setSide("F");
  document.querySelectorAll("#sideSeg button").forEach(x => x.setAttribute("aria-pressed", x.dataset.side === "F"));
  LS.set("last", S.b.key);
  // search suggestions: designators, then net names
  $("#qlist").innerHTML = [...S.b.parts.filter(p => !p.skip || p.tp).map(p => p.r).sort(Enrich.natcmp), ...Object.keys(S.netIdx).sort(byName)].slice(0, 5000).map(v => `<option value="${esc(v)}">`).join("");
  renderTabs(); renderTps(); renderPwr(); render(); renderList(); renderCard();
  if (S.mode === "solder" && S.b.groups.length) { const done = doneOf(); const g = S.b.groups.find(g => !g.refs.every(r => done[r])) || S.b.groups[0]; selectGroup(g.id, false); }
}
function showApp() { $("#empty").hidden = true; $("#app").hidden = false; $("#tabs").hidden = false; }
function showEmpty() { $("#empty").hidden = false; $("#app").hidden = true; $("#tabs").hidden = true; S.b = null; }
window.addEventListener("resize", () => { if (S.b) visiblePanes().forEach(P => setVB(S[P.key], P)); });

(async () => {
  const [boards, schematics] = await Promise.all([DB.all(), DB.all("schematics")]);
  let saved = boards || [];
  SCH.docs = (schematics || []).filter(d => d.key && d.kind === "schematic" && Array.isArray(d.components) && Array.isArray(d.shapes)).map(d => {
    const oldVer = d.ver; d = normalizeSchematic(d);
    if (d.ver !== oldVer) { DB.put(d, "schematics"); markDirty(d.key); }
    return d;
  }).sort((a, b) => (a.added || 0) - (b.added || 0));
  renderSchLibrary();
  const stale = saved.filter(b => b.ver !== IMPORT_VER);
  if (stale.length) {
    for (const b of stale) { markDeleted(b.key); DB.del(b.key); }
    saved = saved.filter(b => b.ver === IMPORT_VER);
    const names = stale.filter(b => b.key !== "demo#builtin").map(b => b.name);
    if (names.length) S.flash = ([`· 之前用旧版本读入的 ${names.length} 块板（${names.slice(0, 8).join("、")}${names.length > 8 ? " 等" : ""}）已移除：导入规则更新了，旧结果可能不对。请点“＋ 添加”重新选择原来的文件夹。`]);
  }
  if (saved.length) {
    S.boards = saved.sort((a, b) => (a.added || 0) - (b.added || 0));
    showApp(); openBoard(LS.get("last", S.boards[0].key));
  } else {
    // first visit: open the built-in example so the page shows what it does
    $("#loadDemo").click(); toast("这是示例板。点右上角“＋ 添加”读入你自己的工程文件夹或生产文件。", 5000);
  }
  scheduleSync();
})();
