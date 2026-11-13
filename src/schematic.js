// Schematic library UI. Parsed sheets are stored in a separate IndexedDB store.
const SCH = { docs: [], doc: null, selection: null, net: -1, vb: null, labels: true, grid: true };
const schSvg = $("#schSvg");
function normalizeSchematic(d) {
  if (d?.kind !== "schematic" || d.ver !== 1) return d;
  const rgb = c => /^#[\da-f]{6}$/i.test(c || "") ? "#" + c.slice(5, 7) + c.slice(3, 5) + c.slice(1, 3) : c;
  return { ...d, ver: 2,
    shapes: d.shapes.map(s => [s[0], rgb(s[1]), rgb(s[2]), ...s.slice(3)]),
    wires: d.wires.map(w => ({ ...w, color: rgb(w.color) })),
    texts: d.texts.map(t => ({ ...t, color: rgb(t.color) })),
    ports: d.ports.map(p => ({ ...p, color: rgb(p.color) })),
  };
}
function setSchVB(v) { SCH.vb = v; schSvg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`); }
function schFit() { if (SCH.doc) setSchVB({ x: -5, y: -SCH.doc.height - 5, w: SCH.doc.width + 10, h: SCH.doc.height + 10 }); }
function schContent() {
  const d = SCH.doc; if (!d) return;
  const pts = d.wires.flatMap(w => w.points);
  for (const c of d.components) if (c.bb) pts.push([c.bb[0], c.bb[1]], [c.bb[2], c.bb[3]]);
  for (const p of d.ports) pts.push([p.x, p.y]);
  if (!pts.length) return schFit();
  const bb = Geom.bboxOf(pts);
  // content that already fills most of the sheet: show the whole sheet, so labels at the edge and the title block are not cut off
  if (bb[2] - bb[0] + 36 >= d.width * .75 && bb[3] - bb[1] + 36 >= d.height * .75) schFit(); else schFrame(bb, 18, 50);
}
function schFrame(bb, pad = 7, min = 20) {
  const w = Math.max(min, bb[2] - bb[0] + pad * 2), h = Math.max(min, bb[3] - bb[1] + pad * 2);
  setSchVB({ x: (bb[0] + bb[2]) / 2 - w / 2, y: (bb[1] + bb[3]) / 2 - h / 2, w, h });
}
function schZoom(factor, x, y) {
  if (!SCH.doc) return;
  const v = SCH.vb, r = schSvg.getBoundingClientRect(), s = Math.min(r.width / v.w, r.height / v.h);
  const px = x ?? r.width / 2, py = y ?? r.height / 2;
  const wx = v.x + (px - (r.width - v.w * s) / 2) / s, wy = v.y + (py - (r.height - v.h * s) / 2) / s;
  const w = Math.max(1, Math.min(SCH.doc.width * 2, v.w / factor)), k = w / v.w;
  setSchVB({ x: wx - (wx - v.x) * k, y: wy - (wy - v.y) * k, w, h: v.h * k });
}
function schText(parent, t, color) {
  const e = el("text", { x: t.x, y: t.y, "font-size": t.size, fill: color || t.color || "#263b35", "text-anchor": t.anchor || "start", transform: t.rot ? `rotate(${t.rot} ${t.x} ${t.y})` : "" }, parent);
  e.textContent = t.text;
}
function renderSchSheet(fit = false) {
  schSvg.innerHTML = "";
  const d = SCH.doc;
  $("#schEmpty").hidden = !!d;
  $("#schSheetTools").hidden = !d;
  $("#schExportLib").disabled = !d;
  $("#schExportDoc").disabled = !d;
  $("#schExportDoc").hidden = !!d && !/Altium/i.test(d.source || ""); // only AD sheets keep their original file
  if (!d) { $("#schInspector").innerHTML = "<p>导入 AD .SchDoc、OrCAD .DSN 或 zip / rar 工程包后，可以在这里查看原理图。</p>"; return; }
  $("#schTitle").textContent = d.title;
  $("#schMeta").textContent = `${d.components.length} 个器件 · ${d.pins.length} 个引脚 · ${d.nets.filter(n => n.name).length} 个命名网络`;
  const defs = el("defs", {}, schSvg), pattern = el("pattern", { id: "schGrid", width: 2.54, height: 2.54, patternUnits: "userSpaceOnUse" }, defs);
  el("path", { d: "M2.54 0H0V2.54", fill: "none", stroke: "#dce4de", "stroke-width": 0.12 }, pattern);
  el("rect", { x: 0, y: -d.height, width: d.width, height: d.height, fill: "#fffdfa" }, schSvg);
  const grid = el("rect", { x: 0, y: -d.height, width: d.width, height: d.height, fill: "url(#schGrid)", "pointer-events": "none" }, schSvg); grid.toggleAttribute("hidden", !SCH.grid);
  el("rect", { x: 0, y: -d.height, width: d.width, height: d.height, fill: "none", stroke: "#98a79d", "stroke-width": 0.3, "pointer-events": "none" }, schSvg);
  const wg = el("g", {}, schSvg);
  d.wires.forEach((w, i) => {
    const p = el("path", { d: Geom.lineD(w.points), fill: "none", stroke: w.color || "#167147", "stroke-width": 0.35, "stroke-linecap": "round", "stroke-linejoin": "round", class: "sch-wire", "data-wire": i }, wg);
    p.addEventListener("click", e => { if (schMoved) return; e.stopPropagation(); selectSchNet(w.net); });
  });
  const sg = el("g", {}, schSvg);
  for (const [path, c, fill, w] of d.shapes) el("path", { d: path, fill: fill || "none", stroke: c, "stroke-width": w, "stroke-linecap": "round", "stroke-linejoin": "round" }, sg);
  const pg = el("g", {}, schSvg);
  for (const p of d.pins) el("path", { d: `M${p.x} ${p.y}L${p.ex} ${p.ey}`, fill: "none", stroke: "#3d4740", "stroke-width": 0.3 }, pg);
  for (const p of d.junctions) el("circle", { cx: p[0], cy: p[1], r: 0.7, fill: "#17693c" }, pg);
  for (const p of d.ports) {
    const g = el("g", { transform: `translate(${p.x} ${p.y}) rotate(${p.type === 17 ? (3 - p.orientation) * 90 : 0})`, class: "sch-port", "data-port": d.ports.indexOf(p) }, pg);
    if (p.drawn) el("circle", { r: 1.2, fill: "transparent" }, g); // symbol graphics are already in d.shapes (OrCAD)
    else if (p.type === 18) {
      el("path", { d: "M0 0L3 -3H20V3H3Z", fill: "#fff4ad", stroke: p.color, "stroke-width": 0.3 }, g);
    } else if (p.style === 4) el("path", { d: "M0 0L-3 5H3Z", fill: "none", stroke: p.color, "stroke-width": 0.35 }, g);
    else if (p.style === 2 || p.style === 5 || p.style === 6) el("path", { d: "M0 0V3M-4 3H4M-2.5 4.5H2.5M-1 6H1", fill: "none", stroke: p.color, "stroke-width": 0.35 }, g);
    else el("path", { d: "M0 0V4M-4 4H4M0 8L-3 4H3Z", fill: "none", stroke: p.color, "stroke-width": 0.35 }, g);
    el("title", {}, g).textContent = p.name;
    g.addEventListener("click", e => { if (schMoved) return; e.stopPropagation(); selectSchNet(p.netIndex); });
  }
  const tg = el("g", { class: "sch-labels" }, schSvg); tg.toggleAttribute("hidden", !SCH.labels);
  for (const t of d.texts) schText(tg, t);
  const hits = el("g", {}, schSvg);
  d.components.forEach((c, i) => {
    const b = c.bb, g = el("g", { class: "sch-component", "data-component": i }, hits);
    el("rect", { x: b[0] - 2, y: b[1] - 2, width: Math.max(3, b[2] - b[0] + 4), height: Math.max(3, b[3] - b[1] + 4), fill: "transparent" }, g);
    el("title", {}, g).textContent = `${c.ref} ${c.value}`;
    g.addEventListener("click", e => { if (schMoved) return; e.stopPropagation(); selectSchComponent(i); });
  });
  renderSchSelection();
  if (fit) schContent();
}
function renderSchSelection() {
  schSvg.querySelectorAll(".sch-selection").forEach(e => e.remove());
  const d = SCH.doc; if (!d) return;
  const g = el("g", { class: "sch-selection", "pointer-events": "none" }, schSvg);
  if (SCH.selection?.type === "component") {
    const b = d.components[SCH.selection.index]?.bb; if (b) el("rect", { x: b[0] - 2, y: b[1] - 2, width: b[2] - b[0] + 4, height: b[3] - b[1] + 4, fill: "#cf1f6310", stroke: "#cf1f63", "stroke-width": 1.4, "vector-effect": "non-scaling-stroke" }, g);
  }
  if (SCH.net >= 0) {
    const n = d.nets[SCH.net]; if (!n) return;
    for (const i of n.wires) el("path", { d: Geom.lineD(d.wires[i].points), fill: "none", stroke: "#8a3fe0", "stroke-width": 1.5, "vector-effect": "non-scaling-stroke", "stroke-linecap": "round", "stroke-linejoin": "round" }, g);
    for (const i of n.pins) { const p = d.pins[i]; el("circle", { cx: p.ex, cy: p.ey, r: 2, fill: "none", stroke: "#8a3fe0", "stroke-width": 1.4, "vector-effect": "non-scaling-stroke" }, g); }
  }
}
function schDetailRow(parent, name, value) {
  const dt = document.createElement("dt"); dt.textContent = name;
  const dd = document.createElement("dd"); dd.textContent = value; parent.append(dt, dd);
}
function selectSchComponent(i, frame = true) {
  const c = SCH.doc?.components[i]; if (!c) return;
  SCH.selection = { type: "component", index: i }; SCH.net = -1;
  const box = $("#schInspector"); box.innerHTML = "";
  const h = document.createElement("h3"); h.textContent = c.ref;
  const value = document.createElement("p"); value.className = "sch-value"; value.textContent = c.value || "未填写值";
  const dl = document.createElement("dl");
  if (c.description) schDetailRow(dl, "说明", c.description);
  if (c.footprint) schDetailRow(dl, "封装", c.footprint);
  schDetailRow(dl, "符号", c.library);
  for (const [k, v] of Object.entries(c.properties)) if (v && k !== "Comment" && k !== "SourceDesignator" && k !== "Designator") schDetailRow(dl, k, v);
  box.append(h, value, dl);
  const nets = [...new Set(c.pins.map(i => SCH.doc.pins[i].net).filter(Boolean))];
  if (nets.length) {
    const p = document.createElement("p"); p.textContent = "相关网络"; box.appendChild(p);
    const row = document.createElement("div"); row.className = "row";
    for (const name of nets) { const b = document.createElement("button"); b.className = "tbtn"; b.textContent = name; b.onclick = () => selectSchNet(SCH.doc.nets.findIndex(n => n.name === name)); row.appendChild(b); }
    box.appendChild(row);
  }
  renderSchSelection(); if (frame) schFrame(c.bb);
}
function selectSchNet(i) {
  const n = SCH.doc?.nets[i]; if (!n) return;
  SCH.net = i; SCH.selection = { type: "net", index: i };
  const box = $("#schInspector"); box.innerHTML = "";
  const h = document.createElement("h3"); h.textContent = n.name || `未命名网络 ${i + 1}`;
  const p = document.createElement("p"); p.textContent = `${n.pins.length} 个器件引脚 · ${n.ports.length} 个网络标号`;
  const dl = document.createElement("dl");
  for (const pi of n.pins) {
    const pin = SCH.doc.pins[pi], c = SCH.doc.components[pin.owner];
    schDetailRow(dl, `${c?.ref || "器件"}.${pin.number}`, pin.name || "未命名引脚");
  }
  if (!n.pins.length) schDetailRow(dl, "连接", "该标号没有直接连接到器件引脚");
  box.append(h, p, dl); renderSchSelection();
  if (n.points.length) schFrame(Geom.bboxOf(n.points), 15, 50);
}
function schSearch() {
  const q = $("#schSearch").value.trim().toLocaleLowerCase(), list = $("#schSearchResults"); list.innerHTML = "";
  if (!SCH.doc || !q) return;
  const hits = [];
  SCH.doc.components.forEach((c, i) => { if (`${c.ref} ${c.value} ${c.description} ${c.footprint} ${Object.values(c.properties).join(" ")}`.toLocaleLowerCase().includes(q)) hits.push({ name: c.ref, sub: c.value || c.description, type: "component", index: i }); });
  SCH.doc.nets.forEach((n, i) => { if (n.name && n.name.toLocaleLowerCase().includes(q)) hits.push({ name: n.name, sub: `${n.pins.length} 个引脚 · 网络`, type: "net", index: i }); });
  for (const h of hits.slice(0, 60)) {
    const b = document.createElement("button"); b.type = "button";
    const name = document.createElement("b"), sub = document.createElement("span"); name.textContent = h.name; sub.textContent = h.sub;
    b.append(name, sub); b.onclick = () => h.type === "component" ? selectSchComponent(h.index) : selectSchNet(h.index); list.appendChild(b);
  }
  if (!hits.length) list.innerHTML = "<p>没有找到匹配的器件或网络。</p>";
  else if (hits.length > 60) { const p = document.createElement("p"); p.textContent = `共 ${hits.length} 项，仅显示前 60 项，请细化搜索。`; list.appendChild(p); }
}
function renderSchLibrary() {
  const list = $("#schLibraryList"); list.innerHTML = "";
  for (const d of SCH.docs) {
    const item = document.createElement("div"); item.className = "sch-library-item" + (SCH.doc?.key === d.key ? " current" : "");
    const open = document.createElement("button"); open.type = "button"; open.className = "sch-sheet-open";
    const name = document.createElement("b"), meta = document.createElement("span"); name.textContent = d.title; meta.textContent = `${d.components.length} 器件 · ${d.file.split("/").pop()}`;
    open.append(name, meta); open.onclick = () => openSchematic(d.key);
    const del = document.createElement("button"); del.type = "button"; del.className = "tbtn danger"; del.textContent = "删除"; del.title = `删除 ${d.title}`;
    del.onclick = () => twoStep(del, () => { removeSchematic(d.key); toast(`已删除原理图 ${d.title}`); });
    item.append(open, del); list.appendChild(item);
  }
  $("#schCount").textContent = `${SCH.docs.length} 页`;
  $("#schTopCount").textContent = `${SCH.docs.length} 页`;
}
function openSchematic(key) {
  SCH.doc = SCH.docs.find(d => d.key === key) || SCH.docs[0] || null;
  SCH.selection = null; SCH.net = -1; SCH.vb = null;
  $("#schSearch").value = ""; $("#schSearchResults").innerHTML = "";
  $("#schInspector").innerHTML = SCH.doc ? "<p>点击图中的器件或导线查看详情。也可以搜索位号、参数或网络名称。</p>" : "<p>点“导入原理图”选择 AD .SchDoc、OrCAD .DSN 文件或工程压缩包。</p>";
  renderSchLibrary(); renderSchSheet(true);
}
function showSchematics() { disarm(); if (!SCH.doc && SCH.docs.length) openSchematic(SCH.docs[0].key); renderSchLibrary(); openDialog("#schDialog"); if (SCH.doc) requestAnimationFrame(schContent); }
function removeSchematic(k) {
  markDeleted(k); DB.del(k, "schematics"); DB.del(k, "schSources"); SCH.docs = SCH.docs.filter(d => d.key !== k);
  if (SCH.doc?.key === k) openSchematic(SCH.docs[0]?.key); else renderSchLibrary();
}
function ingestSchematics(docs, roots) {
  const added = new Set();
  for (const d of docs) {
    d.key = "sch:" + d.file;
    const i = SCH.docs.findIndex(x => x.key === d.key); d.added = i >= 0 ? SCH.docs[i].added : Date.now();
    if (i >= 0) SCH.docs[i] = d; else SCH.docs.push(d);
    const source = d.adData; delete d.adData;
    if (source) DB.put({ key: d.key, name: d.file.split("/").pop(), data: source }, "schSources");
    DB.put(d, "schematics"); markDirty(d.key); added.add(d.key);
  }
  for (const d of SCH.docs.filter(d => [...roots].some(r => d.file.startsWith(r + "/")) && !added.has(d.key))) removeSchematic(d.key);
  $("#schTopCount").textContent = `${SCH.docs.length} 页`;
  return added.size;
}
function schDownload(data, name) {
  const url = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
  const a = document.createElement("a"); a.href = url; a.download = name.replace(/[\\/:*?"<>|]/g, "_"); a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
$("#schBtn").onclick = showSchematics;
$("#schAdd").onclick = () => $("#inFiles").click();
$("#schFit").onclick = schFit; $("#schContentBtn").onclick = schContent; $("#schZoomIn").onclick = () => schZoom(1.3); $("#schZoomOut").onclick = () => schZoom(1 / 1.3);
$("#schSearch").addEventListener("input", schSearch);
$("#schClear").onclick = () => { $("#schSearch").value = ""; $("#schSearchResults").innerHTML = ""; SCH.selection = null; SCH.net = -1; renderSchSelection(); };
$("#schLabels").onclick = e => { SCH.labels = !SCH.labels; e.currentTarget.setAttribute("aria-pressed", SCH.labels); schSvg.querySelector(".sch-labels")?.toggleAttribute("hidden", !SCH.labels); };
$("#schGridBtn").onclick = e => { SCH.grid = !SCH.grid; e.currentTarget.setAttribute("aria-pressed", SCH.grid); schSvg.querySelector('[fill="url(#schGrid)"]')?.toggleAttribute("hidden", !SCH.grid); };
$("#schExportLib").onclick = () => {
  try {
    const result = AltiumSchLib.build(SCH.docs), root = (SCH.doc?.file.split("/")[0] || "SchematicSymbols").replace(/\.(zip|rar|schdoc|dsn)$/i, "");
    schDownload(result.data, root + ".SchLib"); toast(`已导出 SchLib：${result.components} 个符号，${result.pins} 个引脚`);
  } catch (e) { toast("导出 SchLib 失败：" + e.message, 6000); }
};
$("#schExportDoc").onclick = async e => {
  const d = SCH.doc, btn = e.currentTarget; if (!d) return; btn.disabled = true;
  try {
    const source = await DB.get(d.key, "schSources");
    if (!source?.data) { toast("本机没有这份原始文件。请重新导入 .SchDoc 或原压缩包后再下载；SchLib 仍可导出。", 6000); return; }
    schDownload(source.data, source.name || d.file.split("/").pop()); toast("已下载原始 SchDoc，文件内容未修改");
  } finally { btn.disabled = !SCH.doc; }
};
schSvg.addEventListener("wheel", e => { if (!SCH.doc) return; e.preventDefault(); const r = schSvg.getBoundingClientRect(); schZoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
const schPtrs = new Map(); let schMoved = false, schDown = null;
schSvg.addEventListener("pointerdown", e => { if (!schPtrs.size) { schDown = { x: e.clientX, y: e.clientY }; schMoved = false; } else schMoved = true; schPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); schSvg.setPointerCapture(e.pointerId); });
schSvg.addEventListener("pointermove", e => {
  if (!schPtrs.has(e.pointerId) || !SCH.doc) return;
  const prev = schPtrs.get(e.pointerId), cur = { x: e.clientX, y: e.clientY };
  if (schDown && Math.hypot(cur.x - schDown.x, cur.y - schDown.y) > 5) schMoved = true;
  if (schPtrs.size === 1 && SCH.vb) {
    const r = schSvg.getBoundingClientRect(), s = Math.min(r.width / SCH.vb.w, r.height / SCH.vb.h);
    setSchVB({ ...SCH.vb, x: SCH.vb.x - (cur.x - prev.x) / s, y: SCH.vb.y - (cur.y - prev.y) / s });
  } else if (schPtrs.size === 2) {
    const other = [...schPtrs.entries()].find(([id]) => id !== e.pointerId)[1], a = Math.hypot(prev.x - other.x, prev.y - other.y), b = Math.hypot(cur.x - other.x, cur.y - other.y), r = schSvg.getBoundingClientRect();
    if (a) schZoom(b / a, (cur.x + other.x) / 2 - r.left, (cur.y + other.y) / 2 - r.top);
  }
  schPtrs.set(e.pointerId, cur);
});
schSvg.addEventListener("pointerup", e => { schPtrs.delete(e.pointerId); if (!schPtrs.size) setTimeout(() => { schMoved = false; }, 0); });
schSvg.addEventListener("pointercancel", e => schPtrs.delete(e.pointerId));
schSvg.addEventListener("click", e => { if (schMoved) { e.stopPropagation(); e.preventDefault(); } });
