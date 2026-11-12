// Altium Designer .SchDoc: embedded symbols, text, wires and connectivity.
globalThis.ImpAltiumSch = (() => {
  const U = 0.254, f = n => Math.round(n * 10000) / 10000;
  const hidden = r => r.ISHIDDEN === "T";
  const color = n => { const v = +(n || 0) & 0xffffff; return "#" + [v & 255, v >> 8 & 255, v >> 16 & 255].map(x => x.toString(16).padStart(2, "0")).join(""); };
  const width = n => [0.12, 0.254, 0.508, 1.016][+n || 0] || 0.12;
  function coord(r, k) { return f((+(r[k] || 0) + +(r[k + "_FRAC"] || 0) / 100000) * U); }
  function point(r, x = "LOCATION.X", y = "LOCATION.Y") { return [coord(r, x), -coord(r, y)]; }
  function points(r, x = "X", y = "Y") {
    const out = [];
    for (let i = 1, n = Math.min(10000, +(r.LOCATIONCOUNT || 0)); i <= n; i++) out.push([coord(r, x + i), -coord(r, y + i)]);
    return out;
  }
  const path = (p, close) => p.length ? "M" + p.map(q => q.map(f).join(" ")).join("L") + (close ? "Z" : "") : "";
  const text = (x, y, value, size, rot, anchor, c, owner = -1) => ({ x: f(x), y: f(y), text: value, size: f(size), rot, anchor, color: c, owner });
  function orientText(p, value, font, c, owner = -1) {
    const o = +(p.ORIENTATION || 0);
    return text(p[0], p[1], value, font.size * 0.92, o === 1 || o === 3 ? -90 : 0, o >= 2 ? "end" : "start", c || p.COLOR, owner);
  }
  function arc(r) {
    const [cx, cy] = point(r), rx = coord(r, "RADIUS"), ry = coord(r, "SECONDARYRADIUS") || rx;
    const a = +(r.STARTANGLE || 0), b = +(r.ENDANGLE || 0);
    let span = ((b - a) % 360 + 360) % 360; if (!span) span = 360;
    const n = Math.max(2, Math.ceil(span / 3)), pts = [];
    for (let i = 0; i <= n; i++) { const t = (a + span * i / n) * Math.PI / 180; pts.push([cx + rx * Math.cos(t), cy - ry * Math.sin(t)]); }
    return path(pts);
  }
  function rect(r, radius) {
    const a = point(r), b = point(r, "CORNER.X", "CORNER.Y");
    const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(a[0] - b[0]), h = Math.abs(a[1] - b[1]);
    if (!radius) return path([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true);
    return path(Geom.rrect(w, h, Math.min(coord(r, "CORNERXRADIUS"), w / 2, h / 2)).map(p => [p[0] + x + w / 2, p[1] + y + h / 2]), true);
  }
  function unionFind(n) {
    const p = Array.from({ length: n }, (_, i) => i);
    const find = x => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
    return { find, join(a, b) { a = find(a); b = find(b); if (a !== b) p[b] = a; } };
  }
  function connectivity(doc) {
    const { wires, pins, junctions, ports } = doc;
    const total = wires.length + pins.length + junctions.length + ports.length, uf = unionFind(total);
    const p0 = wires.length, j0 = p0 + pins.length, c0 = j0 + junctions.length;
    const at = new Map(), eps = 0.012;
    const key = p => p.map(x => Math.round(x / eps)).join(",");
    const addPoint = (p, i) => { const k = key(p); if (at.has(k)) uf.join(at.get(k), i); else at.set(k, i); };
    const onSeg = (p, a, b) => Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) < eps && p[0] >= Math.min(a[0], b[0]) - eps && p[0] <= Math.max(a[0], b[0]) + eps && p[1] >= Math.min(a[1], b[1]) - eps && p[1] <= Math.max(a[1], b[1]) + eps;
    wires.forEach((w, i) => { w.points.forEach(p => addPoint(p, i)); });
    const joinOnWire = (p, id) => { for (let i = 0; i < wires.length; i++) { const q = wires[i].points; for (let j = 1; j < q.length; j++) if (onSeg(p, q[j - 1], q[j])) { uf.join(id, i); break; } } };
    pins.forEach((p, i) => { addPoint([p.ex, p.ey], p0 + i); joinOnWire([p.ex, p.ey], p0 + i); });
    junctions.forEach((p, i) => { addPoint(p, j0 + i); joinOnWire(p, j0 + i); });
    const byName = new Map();
    ports.forEach((p, i) => {
      addPoint([p.x, p.y], c0 + i); joinOnWire([p.x, p.y], c0 + i);
      const k = (p.name || "").toUpperCase(); if (!k) return;
      if (byName.has(k)) uf.join(byName.get(k), c0 + i); else byName.set(k, c0 + i);
    });
    const groups = new Map();
    for (let i = 0; i < total; i++) { const root = uf.find(i); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(i); }
    doc.nets = [];
    for (const ids of groups.values()) {
      const net = { name: "", wires: [], pins: [], ports: [], points: [] };
      for (const i of ids) {
        if (i < p0) { net.wires.push(i); wires[i].net = doc.nets.length; net.points.push(...wires[i].points); }
        else if (i < j0) { net.pins.push(i - p0); net.points.push([pins[i - p0].ex, pins[i - p0].ey]); }
        else if (i < c0) net.points.push(junctions[i - j0]);
        else { const p = ports[i - c0]; net.ports.push(i - c0); net.name ||= p.name; net.points.push([p.x, p.y]); }
      }
      if (!net.wires.length && net.pins.length < 2 && !net.ports.length) continue;
      for (const i of net.pins) { pins[i].net = net.name; pins[i].netIndex = doc.nets.length; }
      for (const i of net.ports) ports[i].netIndex = doc.nets.length;
      if (net.wires.length || net.pins.length) doc.nets.push(net);
    }
  }
  function records(u8) {
    if (u8[0] === 0xd0 && u8[1] === 0xcf) {
      const files = ImpAltium.cfb(u8), key = Object.keys(files).find(k => k.toLowerCase() === "fileheader");
      if (!key) throw new Error("没有找到 SchDoc 的 FileHeader 数据流");
      return ImpAltium.propsRecords(files[key]());
    }
    const text = Files.decodeText(u8);
    if (!/\|RECORD=31\|/i.test(text)) throw new Error("不是 Altium 二进制或 ASCII SchDoc");
    return text.split(/\r?\n/).filter(l => /^\s*\|/.test(l)).map(l => {
      const b = new TextEncoder().encode(l), record = new Uint8Array(b.length + 4);
      new DataView(record.buffer).setUint32(0, b.length, true); record.set(b, 4);
      return ImpAltium.propsRecords(record)[0];
    }).filter(Boolean);
  }
  function parse(u8, fileName) {
    const rs = records(u8);
    if (!/Schematic Capture/i.test(rs[0]?.HEADER || "")) throw new Error("不是 Altium SchDoc 原理图");
    const objects = rs.slice(1), sheet = objects.find(r => +r.RECORD === 31);
    if (!sheet) throw new Error("SchDoc 里没有图纸记录，可能是 SchLib 符号库");
    const ownerOf = i => { const r = objects[i]; return r && +r.RECORD !== 1 && +r.OWNERINDEX > 0 && +r.OWNERINDEX < i ? +r.OWNERINDEX : -1; };
    const comps = new Map(), shapes = [], texts = [], pins = [], wires = [], junctions = [], ports = [];
    const fonts = {};
    for (let i = 1; i <= +(sheet.FONTIDCOUNT || 1); i++) fonts[i] = { name: sheet["FONTNAME" + i] || "Times New Roman", size: +sheet["SIZE" + i] * U || 2.54 };
    const doc = { kind: "schematic", ver: 2, source: "Altium Designer SchDoc", file: fileName, title: "", width: 0, height: 0, shapes, texts, pins, wires, junctions, ports, components: [], nets: [], unsupported: [] };
    const sizes = [[1150, 760], [1550, 1110], [2230, 1570], [3150, 2230], [4460, 3150], [950, 750], [1500, 950], [2000, 1500], [3200, 2000], [4200, 3200], [1100, 850], [1400, 850], [1700, 1100], [990, 790], [1540, 990], [2060, 1560], [3260, 2060], [4280, 3280]];
    let sz = sheet.USECUSTOMSHEET === "T" ? [+sheet.CUSTOMX || 1150, +sheet.CUSTOMY || 760] : sizes[+sheet.SHEETSTYLE || 0];
    if (+sheet.WORKSPACEORIENTATION === 1) sz = [sz[1], sz[0]];
    doc.width = sz[0] * U; doc.height = sz[1] * U;
    const componentOwner = i => { let o = ownerOf(i); for (let n = 0; o >= 0 && n < 20 && +objects[o]?.RECORD !== 1; n++) o = ownerOf(o); return o; };
    for (let i = 0; i < objects.length; i++) {
      const r = objects[i], type = +r.RECORD, owner = type === 45 ? componentOwner(i) : ownerOf(i), ci = comps.get(owner)?.index ?? -1;
      if (type === 1) {
        const c = { index: doc.components.length, ref: "", value: "", description: r.COMPONENTDESCRIPTION || "", library: r.LIBREFERENCE || r.DESIGNITEMID || "", footprint: "", origin: point(r), part: +(r.CURRENTPARTID || 1), partCount: +(r.PARTCOUNT || 2), properties: {}, pins: [], bb: null };
        comps.set(i, { ...c, part: +(r.CURRENTPARTID || 1), display: +(r.DISPLAYMODE || 0) }); doc.components.push(c); continue;
      }
      const parent = comps.get(owner);
      if (parent && ci >= 0 && ((+r.OWNERPARTID > 0 && +r.OWNERPARTID !== parent.part) || +(r.OWNERPARTDISPLAYMODE || 0) !== parent.display)) continue;
      const c = +(r.COLOR || 0), fill = r.ISSOLID === "T" && r.TRANSPARENT !== "T" ? color(r.AREACOLOR) : "";
      if (type === 45 && parent && r.MODELTYPE === "PCBLIB" && (r.ISCURRENT === "T" || !doc.components[ci].footprint)) doc.components[ci].footprint = r.MODELNAME || "";
      if (type === 41) {
        if (r.TEXT && r.NAME === "Title" && owner <= 0) doc.title = r.TEXT;
        if (parent && r.TEXT) {
          const comp = doc.components[ci]; comp.properties[r.NAME || "参数"] = r.TEXT;
          if (r.NAME === "Comment") comp.value = r.TEXT;
          if (r.NAME === "SourceDesignator" && !comp.ref) comp.ref = r.TEXT;
        }
      }
      if (hidden(r)) continue;
      if (type === 6 || type === 7 || type === 26 || type === 27 || type === 37 || type === 218) {
        const pts = type === 37 ? [point(r), point(r, "CORNER.X", "CORNER.Y")] : points(r);
        if (type === 27) wires.push({ points: pts, color: color(c), net: -1 });
        else shapes.push([path(pts, type === 7), color(c), fill, width(r.LINEWIDTH), ci]);
      } else if ([5, 8, 9, 10, 11, 12, 13, 14, 15].includes(type)) {
        let d = "";
        if (type === 5) { const p = points(r); d = p.length === 4 ? `M${p[0].join(" ")}C${p.slice(1).map(q => q.join(" ")).join(" ")}` : path(p); }
        else if (type === 13) d = path([point(r), point(r, "CORNER.X", "CORNER.Y")]);
        else if (type === 8) { const p = point(r), rx = coord(r, "RADIUS"), ry = coord(r, "SECONDARYRADIUS") || rx; d = `M${f(p[0] - rx)} ${f(p[1])}a${rx} ${ry} 0 1 0 ${f(rx * 2)} 0a${rx} ${ry} 0 1 0 ${f(-rx * 2)} 0Z`; }
        else if (type === 10 || type === 14 || type === 15) d = type === 15 ? (() => { const p = point(r), w = coord(r, "XSIZE"), h = coord(r, "YSIZE"); return path([[p[0], p[1]], [p[0] + w, p[1]], [p[0] + w, p[1] + h], [p[0], p[1] + h]], true); })() : rect(r, type === 10);
        else d = arc(r);
        shapes.push([d, color(c), fill, width(r.LINEWIDTH), ci]);
      } else if (type === 2 && parent) {
        const p = point(r), o = +(r.PINCONGLOMERATE || 0) & 3, len = coord(r, "PINLENGTH");
        const end = [p[0] + (o === 0 ? len : o === 2 ? -len : 0), p[1] + (o === 1 ? -len : o === 3 ? len : 0)];
        const pin = { index: pins.length, owner: ci, number: r.DESIGNATOR || "", name: r.NAME || "", description: r.DESCRIPTION || "", electrical: +(r.ELECTRICAL ?? 4), flags: +(r.PINCONGLOMERATE || 0), color: +(r.COLOR || 0), symbols: [r.SYMBOL_INNEREDGE, r.SYMBOL_OUTEREDGE, r.SYMBOL_INNER, r.SYMBOL_OUTER].map(v => +(v || 0)), x: p[0], y: p[1], ex: end[0], ey: end[1], net: "" };
        pins.push(pin); doc.components[ci].pins.push(pin.index);
        const font = fonts[+(r.FONTID || sheet.SYSTEMFONT || 1)] || fonts[1];
        if (+r.PINCONGLOMERATE & 16 && pin.number) texts.push(text(end[0] + (o === 0 ? 0.8 : o === 2 ? -0.8 : 1.8), end[1] + (o === 1 ? 0.8 : o === 3 ? -0.8 : 0), pin.number, font.size * 0.78, o === 1 || o === 3 ? -90 : 0, o === 2 ? "end" : "start", c, ci));
        if (+r.PINCONGLOMERATE & 8 && pin.name) texts.push(text(end[0] + (o === 0 ? -2 : o === 2 ? 2 : 0), end[1] + (o === 1 ? -2 : o === 3 ? 2 : 0), pin.name, font.size * 0.82, o === 1 || o === 3 ? -90 : 0, o === 0 ? "end" : "start", c, ci));
      } else if ([4, 25, 32, 33, 34, 41, 43, 226].includes(type) && r.TEXT) {
        const font = fonts[+(r.FONTID || sheet.SYSTEMFONT || 1)] || fonts[1];
        const t = orientText(point(r), r.SHOWNAME === "T" && r.NAME ? r.NAME + " = " + r.TEXT : r.TEXT, font, c, ci); texts.push(t);
        if (type === 34 && parent) doc.components[ci].ref = r.TEXT;
        if (type === 25) ports.push({ name: r.TEXT, x: t.x, y: t.y, type, orientation: +(r.ORIENTATION || 0), color: color(c), netIndex: -1 });
      } else if ((type === 17 || type === 18) && (r.TEXT || r.NAME)) {
        const p = point(r); ports.push({ name: r.TEXT || r.NAME, x: p[0], y: p[1], type, style: +(r.STYLE || 0), orientation: +(r.ORIENTATION || 0), color: color(c), netIndex: -1 });
        if (type === 17 && r.SHOWNETNAME !== "F" || type === 18) texts.push(text(p[0] + 3, p[1] - 2, r.TEXT || r.NAME, (fonts[+(r.FONTID || 2)] || fonts[1]).size, 0, "start", c));
      } else if (type === 29) junctions.push(point(r));
      else if (type === 22) { const p = point(r); shapes.push([path([[p[0] - 2, p[1] - 2], [p[0] + 2, p[1] + 2]]) + path([[p[0] - 2, p[1] + 2], [p[0] + 2, p[1] - 2]]), color(255), "", 0.3, ci]); }
      else if (type === 28 && r.TEXT) {
        const p = point(r), font = fonts[+(r.FONTID || 1)] || fonts[1];
        r.TEXT.split("~1").forEach((s, j) => texts.push(text(p[0], p[1] + j * font.size, s, font.size, 0, "start", c, ci)));
        if (r.SHOWBORDER === "T" || fill) shapes.push([rect(r), color(c), fill, width(r.LINEWIDTH), ci]);
      } else if (type === 30) doc.unsupported.push("嵌入图片");
    }
    const bb = {};
    const grow = (i, p) => { if (i < 0) return; (bb[i] ||= [Infinity, Infinity, -Infinity, -Infinity]); Geom.bboxOf([p], bb[i]); };
    for (const [d, , , , i] of shapes) { const nums = d.match(/-?\d+(?:\.\d+)?/g) || []; for (let j = 0; j + 1 < nums.length; j += 2) grow(i, [+nums[j], +nums[j + 1]]); }
    for (const p of pins) { grow(p.owner, [p.x, p.y]); grow(p.owner, [p.ex, p.ey]); }
    for (const c of doc.components) { c.ref ||= c.library.replace(/^[^_]*_/, "") || `器件 ${c.index + 1}`; c.value ||= c.description.replace(/^.*?:\s*/, ""); c.bb = bb[c.index] || [0, 0, 10, 10]; }
    connectivity(doc);
    doc.title ||= fileName.replace(/\.[^.]+$/, "");
    if (doc.unsupported.length) doc.unsupported = [...new Set(doc.unsupported)];
    return doc;
  }
  return { parse };
})();
