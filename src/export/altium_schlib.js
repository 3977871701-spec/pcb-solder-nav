// Native Altium SchLib writer: OLE2/CFB, text primitives and binary pins.
globalThis.AltiumSchLib = (() => {
  const U = 0.254, END = 0xfffffffe, FREE = 0xffffffff, FAT = 0xfffffffd, NONE = 0xffffffff;
  const uid = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return ("PSN" + (h >>> 0).toString(36).toUpperCase()).slice(0, 8).padEnd(8, "X"); };
  const bgr = c => { const m = /^#?([\da-f]{6})$/i.exec(c || ""); return m ? parseInt(m[1].slice(0, 2), 16) | parseInt(m[1].slice(2, 4), 16) << 8 | parseInt(m[1].slice(4), 16) << 16 : 0; };
  const lineWidth = w => w >= 0.9 ? 3 : w >= 0.4 ? 2 : w >= 0.2 ? 1 : 0;
  function propertyBytes(props) {
    const chunks = [], ascii = s => Array.from(s, c => c.charCodeAt(0) & 255);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === "") continue;
      const s = String(value).replace(/\|/g, "\x8e"), k = key.replace(/^%UTF8%/, "");
      chunks.push(124);
      if (/[^\x00-\x7f]/.test(s) && key !== "HEADER") chunks.push(...ascii("%UTF8%" + k + "="), ...new TextEncoder().encode(s), 124, 124, 124, ...ascii(k + "="), ...Array.from(s, () => 63));
      else chunks.push(...ascii(k + "="), ...ascii(s));
    }
    chunks.push(0); return new Uint8Array(chunks);
  }
  function frame(payload, binary = false) {
    const out = new Uint8Array(payload.length + 4), dv = new DataView(out.buffer);
    dv.setUint32(0, payload.length | (binary ? 0x01000000 : 0), true); out.set(payload, 4); return out;
  }
  const textRecord = o => frame(propertyBytes(o));
  const concat = parts => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let p = 0; for (const b of parts) { out.set(b, p); p += b.length; } return out; };
  function coord(o, key, value) {
    const v = Math.round(value * 100000) / 100000, i = Math.trunc(v), f = Math.round((v - i) * 100000);
    if (i) o[key] = i; if (f) o[key + "_FRAC"] = f;
  }
  function pathPoints(d) {
    const tokens = d.match(/[a-z]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) || [], out = [];
    let i = 0, p = [0, 0], points = [];
    const flush = () => { if (points.length > 1) out.push(points); points = []; };
    const nums = n => tokens.slice(i, i += n).map(Number);
    while (i < tokens.length) {
      const op = tokens[i++];
      if (op === "Z" || op === "z") { flush(); continue; }
      if (op === "M" || op === "L") { const q = nums(2); if (op === "M") flush(); p = q; points.push(q); }
      else if (op === "C") { const q = nums(6); if (points.length !== 1) points.push(p); points.push(...q.reduce((a, v, j) => j % 2 ? a : [...a, [v, q[j + 1]]], [])); p = q.slice(4); flush(); }
      else if (op === "a") {
        const [rx0, ry0, deg, large, sweep, dx, dy] = nums(7), x2 = p[0] + dx, y2 = p[1] + dy;
        let rx = Math.abs(rx0), ry = Math.abs(ry0); if (!rx || !ry) { points.push([x2, y2]); p = [x2, y2]; continue; }
        const phi = deg * Math.PI / 180, co = Math.cos(phi), si = Math.sin(phi), ax = (p[0] - x2) / 2, ay = (p[1] - y2) / 2;
        const x1 = co * ax + si * ay, y1 = -si * ax + co * ay, lambda = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry); if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
        const den = rx * rx * y1 * y1 + ry * ry * x1 * x1, sign = large !== sweep ? 1 : -1;
        const k = sign * Math.sqrt(Math.max(0, (rx * rx * ry * ry - den) / den)), cx1 = k * rx * y1 / ry, cy1 = -k * ry * x1 / rx;
        const cx = co * cx1 - si * cy1 + (p[0] + x2) / 2, cy = si * cx1 + co * cy1 + (p[1] + y2) / 2;
        const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
        const start = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
        let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
        if (!sweep && delta > 0) delta -= Math.PI * 2; if (sweep && delta < 0) delta += Math.PI * 2;
        const n = Math.max(2, Math.ceil(Math.abs(delta) * 12 / Math.PI));
        for (let j = 1; j <= n; j++) { const a = start + delta * j / n, x = rx * Math.cos(a), y = ry * Math.sin(a); points.push([cx + co * x - si * y, cy + si * x + co * y]); }
        p = [x2, y2];
      } else if (/^[A-Z]$/.test(op)) { p = nums(op === "C" ? 6 : 2).slice(-2); points.push(p); }
    }
    flush(); return out;
  }
  class Bytes {
    constructor() { this.a = []; }
    u8(v) { this.a.push(v & 255); }
    u16(v) { this.u8(v); this.u8(v >> 8); }
    i16(v) { this.u16(v); }
    u32(v) { this.u16(v); this.u16(v >> 16); }
    str(s) { const b = Array.from(s || "", c => /[\x00-\x7f]/.test(c) ? c.charCodeAt(0) : 63); this.u8(b.length); this.a.push(...b); }
    done() { return new Uint8Array(this.a); }
  }
  function pinRecord(p, origin, part = 1) {
    const b = new Bytes(), dx = p.ex - p.x, dy = p.y - p.ey;
    const orientation = Math.abs(dx) >= Math.abs(dy) ? dx >= 0 ? 0 : 2 : dy >= 0 ? 1 : 3;
    const flags = ((p.flags ?? 0x20) & 0xfc) | orientation;
    b.u32(2); b.u8(0); b.i16(part); b.u8(0);
    for (let i = 0; i < 4; i++) b.u8(p.symbols?.[i] || 0);
    b.str(p.description || ""); b.u8(1); b.u8(p.electrical ?? 4); b.u8(flags);
    b.i16(Math.round(Math.hypot(dx, dy) / U)); b.i16(Math.round((p.x - origin[0]) / U)); b.i16(Math.round((origin[1] - p.y) / U));
    b.u32(p.color || 0); b.str(p.name); b.str(p.number); b.str(""); b.str("|&|"); b.str("");
    return frame(b.done(), true);
  }
  function symbol(comp, source, names) {
    const baseOrigin = comp.origin || [(comp.bb[0] + comp.bb[2]) / 2, (comp.bb[1] + comp.bb[3]) / 2], units = source.units || [{ comp, source }];
    let origin = baseOrigin;
    const name = comp.library || comp.ref, records = [], pinCount = units.reduce((n, u) => n + u.comp.pins.length, 0);
    const addText = o => { if (![44, 46, 48].includes(+o.RECORD)) o.UNIQUEID ||= uid(source + "/" + name + "/" + records.length); records.push(textRecord(o)); };
    const pos = (o, x, y) => { coord(o, "LOCATION.X", (x - origin[0]) / U); coord(o, "LOCATION.Y", (origin[1] - y) / U); };
    const fontId = size => size < 2.1 ? 2 : size < 2.25 ? 1 : 3;
    addText({ RECORD: 1, LIBREFERENCE: name, COMPONENTDESCRIPTION: comp.description, PARTCOUNT: Math.max(2, ...units.map(u => u.comp.partCount || 2)), DISPLAYMODECOUNT: 1, INDEXINSHEET: -1, OWNERPARTID: -1, CURRENTPARTID: 1, LIBRARYPATH: "*", SOURCELIBRARYNAME: "*", SHEETPARTFILENAME: "*", TARGETFILENAME: "*", DESIGNITEMID: name, ALLPINCOUNT: pinCount, AREACOLOR: 11599871, COLOR: 128, PARTIDLOCKED: "T" });
    let slot = 0;
    for (const unit of units) {
      origin = unit.comp.origin || baseOrigin;
      for (const [d, c, fill, w, owner] of unit.source.shapes) {
        if (owner !== unit.comp.index) continue;
        for (const pts of pathPoints(d)) {
          const bezier = pts.length === 4 && /C/i.test(d), o = { RECORD: bezier ? 5 : fill ? 7 : 6, ISNOTACCESIBLE: "T", OWNERPARTID: unit.comp.part || 1, LOCATIONCOUNT: pts.length };
          if (slot) o.INDEXINSHEET = slot; slot++;
          pts.forEach((p, i) => { coord(o, "X" + (i + 1), (p[0] - origin[0]) / U); coord(o, "Y" + (i + 1), (origin[1] - p[1]) / U); });
          o.COLOR = bgr(c); if (fill) { o.AREACOLOR = bgr(fill); o.ISSOLID = "T"; } if (lineWidth(w)) o.LINEWIDTH = lineWidth(w); addText(o);
        }
      }
      for (const pi of unit.comp.pins) records.push(pinRecord(unit.source.pins[pi], origin, unit.comp.part || 1)); slot += unit.comp.pins.length;
      for (const t of unit.source.texts) {
        if (t.owner !== unit.comp.index || t.text === unit.comp.ref || t.text === unit.comp.value) continue;
        const o = { RECORD: 4, OWNERPARTID: unit.comp.part || 1, COLOR: bgr(t.color), FONTID: fontId(t.size), TEXT: t.text };
        if (slot) o.INDEXINSHEET = slot; slot++;
        pos(o, t.x, t.y); if (t.rot) o.ORIENTATION = t.anchor === "end" ? 3 : 1; else if (t.anchor === "end") o.ORIENTATION = 2; addText(o);
      }
    }
    origin = baseOrigin;
    const reference = { RECORD: 34, INDEXINSHEET: -1, OWNERPARTID: -1, COLOR: 8388608, FONTID: 1, TEXT: comp.ref.replace(/\d+[A-Za-z]*$/, "") + "?", NAME: "Designator", READONLYSTATE: 1, JUSTIFICATION: 1 };
    pos(reference, origin[0], comp.bb[1] - 4); addText(reference);
    const comment = { RECORD: 41, INDEXINSHEET: -1, OWNERPARTID: -1, COLOR: 8388608, FONTID: 1, TEXT: comp.value || "*", NAME: "Comment", JUSTIFICATION: 1 };
    pos(comment, origin[0], comp.bb[3] + 4); addText(comment);
    for (const [key, value] of Object.entries(comp.properties || {})) {
      if (!value || ["Comment", "SourceDesignator", "SourceFigure", "PCBFootprintStatus", "ReviewNotes", "Designator", "PinUniqueId"].includes(key)) continue;
      const o = { RECORD: 41, OWNERPARTID: -1, ISHIDDEN: "T", TEXT: value, NAME: key }; if (slot) o.INDEXINSHEET = slot; slot++; addText(o);
    }
    if (comp.footprint) {
      const list = records.length; addText({ RECORD: 44 });
      const model = records.length; addText({ RECORD: 45, OWNERINDEX: list, INDEXINSHEET: -1, MODELNAME: comp.footprint, MODELTYPE: "PCBLIB", DATAFILECOUNT: 1, MODELDATAFILEENTITY0: comp.footprint, MODELDATAFILEKIND0: "PCBLib", ISCURRENT: "T" });
      addText({ RECORD: 46, OWNERINDEX: model }); addText({ RECORD: 48, OWNERINDEX: model });
    } else addText({ RECORD: 44 });
    names.add(name); return { name, description: comp.description, data: concat(records), count: records.length, pins: pinCount };
  }
  function directoryEntry(e) {
    const b = new Uint8Array(128), dv = new DataView(b.buffer), name = e.name || "";
    for (let i = 0; i < Math.min(31, name.length); i++) dv.setUint16(i * 2, name.charCodeAt(i), true);
    dv.setUint16(64, (Math.min(31, name.length) + (name ? 1 : 0)) * 2, true); b[66] = e.type || 0; b[67] = e.black ? 1 : 0;
    dv.setUint32(68, e.left ?? NONE, true); dv.setUint32(72, e.right ?? NONE, true); dv.setUint32(76, e.child ?? NONE, true);
    dv.setUint32(116, e.start ?? END, true); dv.setUint32(120, e.size || 0, true); return b;
  }
  function cfb(streams) {
    const entries = [{ name: "Root Entry", type: 5, children: [] }];
    for (const [path, data] of Object.entries(streams)) {
      const parts = path.split("/"); let parent = entries[0];
      for (let i = 0; i < parts.length - 1; i++) {
        let child = parent.children.find(e => e.name === parts[i]);
        if (!child) { child = { name: parts[i], type: 1, children: [] }; entries.push(child); parent.children.push(child); }
        parent = child;
      }
      const file = { name: parts.at(-1), type: 2, children: [], data, size: data.length, start: END }; entries.push(file); parent.children.push(file);
    }
    entries.forEach((e, i) => e.id = i);
    const small = entries.filter(e => e.type === 2 && e.size < 4096), miniFat = [], chunks = [];
    let miniCount = 0;
    for (const e of small) {
      e.start = miniCount;
      for (let p = 0; p < e.size; p += 64) { const b = new Uint8Array(64); b.set(e.data.subarray(p, Math.min(p + 64, e.size))); chunks.push(b); miniFat.push(++miniCount); }
      if (miniCount) miniFat[e.start + Math.ceil(e.size / 64) - 1] = END;
    }
    const miniStream = concat(chunks), regular = entries.filter(e => e.type === 2 && e.size >= 4096);
    const regularSectors = regular.reduce((n, e) => n + Math.ceil(e.size / 512), 0), dirSectors = Math.ceil(entries.length * 128 / 512), miniFatSectors = Math.ceil(miniFat.length * 4 / 512), miniStreamSectors = Math.ceil(miniStream.length / 512);
    let fatCount = 1;
    for (;;) { const n = Math.ceil((fatCount + dirSectors + miniFatSectors + miniStreamSectors + regularSectors) / 128); if (n === fatCount) break; fatCount = n; }
    const fat = new Uint32Array(fatCount * 128); fat.fill(FREE);
    const chain = (start, count, marker) => { for (let i = 0; i < count; i++) fat[start + i] = i === count - 1 ? END : start + i + 1; if (count) return start; return marker; };
    let sector = fatCount;
    const dirStart = sector; chain(dirStart, dirSectors, END); sector += dirSectors;
    const miniFatStart = sector; chain(miniFatStart, miniFatSectors, END); sector += miniFatSectors;
    const miniStreamStart = sector; chain(miniStreamStart, miniStreamSectors, END); sector += miniStreamSectors;
    for (const e of regular) { e.start = sector; chain(sector, Math.ceil(e.size / 512), END); sector += Math.ceil(e.size / 512); }
    for (let i = 0; i < fatCount; i++) fat[i] = FAT;
    const link = list => {
      if (!list.length) return NONE;
      const sorted = list.slice().sort((a, b) => a.name.length - b.name.length || (a.name.toUpperCase() < b.name.toUpperCase() ? -1 : 1));
      const make = (a, b, depth) => { if (a >= b) return NONE; const m = (a + b) >> 1, e = sorted[m]; e.left = make(a, m, depth + 1); e.right = make(m + 1, b, depth + 1); e.black = depth === 0; return e.id; };
      return make(0, sorted.length, 0);
    };
    for (const e of entries) e.child = link(e.children);
    const root = entries[0]; root.start = miniStreamStart; root.size = miniStream.length;
    const dir = concat(entries.map(directoryEntry)), out = new Uint8Array((sector + 1) * 512), dv = new DataView(out.buffer);
    [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].forEach((v, i) => out[i] = v);
    dv.setUint16(24, 0x003e, true); dv.setUint16(26, 3, true); dv.setUint16(28, 0xfffe, true); dv.setUint16(30, 9, true); dv.setUint16(32, 6, true);
    dv.setUint32(44, fatCount, true); dv.setUint32(48, dirStart, true); dv.setUint32(56, 4096, true);
    dv.setUint32(60, miniFatStart, true); dv.setUint32(64, miniFatSectors, true); dv.setUint32(68, END, true); dv.setUint32(72, 0, true);
    for (let i = 0; i < 109; i++) dv.setUint32(76 + i * 4, i < fatCount ? i : FREE, true);
    for (let i = 0; i < fat.length; i++) out[512 + i * 4] = fat[i] & 255, out[513 + i * 4] = fat[i] >> 8 & 255, out[514 + i * 4] = fat[i] >> 16 & 255, out[515 + i * 4] = fat[i] >> 24 & 255;
    out.set(dir, (dirStart + 1) * 512); out.set(new Uint8Array(new Uint32Array(miniFat).buffer), (miniFatStart + 1) * 512); if (miniStream.length) out.set(miniStream, (miniStreamStart + 1) * 512);
    for (const e of regular) out.set(e.data, (e.start + 1) * 512);
    return out;
  }
  function build(docs) {
    if (!docs.length) throw new Error("没有可导出的原理图");
    const symbols = [], names = new Set(), groups = new Map();
    for (const doc of docs) for (const c of doc.components) {
      const key = c.library || c.ref;
      if (!groups.has(key)) groups.set(key, { comp: c, source: doc, units: [] });
      groups.get(key).units.push({ comp: c, source: doc });
    }
    for (const g of groups.values()) {
      const s = symbol(g.comp, { ...g.source, units: g.units }, names);
      s.partCount = Math.max(2, ...g.units.map(u => u.comp.partCount || 2)); symbols.push(s);
    }
    const header = { HEADER: "Protel for Windows - Schematic Library Editor Binary File Version 5.0", WEIGHT: symbols.reduce((n, s) => n + s.count, 0) + 1, MINORVERSION: 9, UNIQUEID: uid(symbols.map(s => s.name).join("/")), FONTIDCOUNT: 3, SIZE1: 9, FONTNAME1: "Times New Roman", SIZE2: 7, FONTNAME2: "Times New Roman", SIZE3: 10, FONTNAME3: "Times New Roman", USEMBCS: "T", ISBOC: "T", SHEETSTYLE: 9, BORDERON: "T", SHEETNUMBERSPACESIZE: 12, AREACOLOR: 16317695, SNAPGRIDON: "T", SNAPGRIDSIZE: 10, VISIBLEGRIDON: "T", VISIBLEGRIDSIZE: 10, CUSTOMX: 18000, CUSTOMY: 18000, USECUSTOMSHEET: "T", REFERENCEZONESON: "T", DISPLAY_UNIT: 0, COMPCOUNT: symbols.length };
    symbols.forEach((s, i) => { header["LIBREF" + i] = s.name; if (s.description) header["COMPDESCR" + i] = s.description; header["PARTCOUNT" + i] = s.partCount; });
    const streams = { FileHeader: frame(propertyBytes(header)), Storage: textRecord({ HEADER: "Icon storage." }) };
    for (const s of symbols) { if (s.name.length > 31) throw new Error(`符号名过长，无法在旧版 AD 存储中创建：${s.name}`); streams[s.name + "/Data"] = s.data; }
    return { data: cfb(streams), components: symbols.length, pins: symbols.reduce((n, s) => n + s.pins, 0) };
  }
  return { build };
})();
