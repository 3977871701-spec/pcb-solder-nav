// Altium Designer .PcbDoc importer (OLE compound file with Pcb 6 streams).
// Record layouts follow KiCad's Altium importer (pcbnew/pcb_io/altium/altium_parser_pcb.cpp).
globalThis.ImpAltium = (() => {
  const G = Geom;
  const U = 2.54e-6; // Altium internal unit: 1/10000 mil → mm

  // ---------- OLE compound file ----------
  function cfb(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(0, true) !== 0xE011CFD0) throw new Error("不是 Altium PcbDoc（OLE 复合文档）");
    const ss = 1 << dv.getUint16(30, true), mss = 1 << dv.getUint16(32, true);
    const nFat = dv.getUint32(44, true), dir0 = dv.getUint32(48, true), cutoff = dv.getUint32(56, true);
    const mfat0 = dv.getUint32(60, true), nMfat = dv.getUint32(64, true);
    let difat0 = dv.getUint32(68, true), nDifat = dv.getUint32(72, true);
    const off = s => (s + 1) * ss;
    const fatSectors = [];
    for (let i = 0; i < 109 && fatSectors.length < nFat; i++) fatSectors.push(dv.getUint32(76 + i * 4, true));
    while (nDifat-- > 0 && difat0 < 0xFFFFFFFA) { const o = off(difat0); for (let i = 0; i < ss / 4 - 1 && fatSectors.length < nFat; i++) fatSectors.push(dv.getUint32(o + i * 4, true)); difat0 = dv.getUint32(o + ss - 4, true); }
    const fat = new Uint32Array(fatSectors.length * ss / 4);
    fatSectors.forEach((s, k) => { const o = off(s); for (let i = 0; i < ss / 4; i++) fat[k * ss / 4 + i] = dv.getUint32(o + i * 4, true); });
    const chain = s => { const out = []; let guard = 0; while (s < 0xFFFFFFFA && guard++ < 1e7) { out.push(s); s = fat[s]; } return out; };
    const readChain = (s, size) => { const c = chain(s), out = new Uint8Array(c.length * ss); c.forEach((sec, i) => out.set(u8.subarray(off(sec), off(sec) + ss), i * ss)); return size !== undefined ? out.subarray(0, size) : out; };
    const dirBytes = readChain(dir0);
    const ddv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
    const ents = [];
    for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
      const nl = ddv.getUint16(o + 64, true); let name = "";
      for (let i = 0; i < Math.max(0, nl / 2 - 1); i++) name += String.fromCharCode(ddv.getUint16(o + i * 2, true));
      ents.push({ name, type: dirBytes[o + 66], left: ddv.getUint32(o + 68, true), right: ddv.getUint32(o + 72, true), child: ddv.getUint32(o + 76, true), start: ddv.getUint32(o + 116, true), size: ddv.getUint32(o + 120, true) });
    }
    const root = ents[0];
    const ministream = root ? readChain(root.start, root.size) : new Uint8Array(0);
    const mfat = []; for (const s of chain(mfat0).slice(0, nMfat || 1e9)) { const o = off(s); for (let i = 0; i < ss / 4; i++) mfat.push(dv.getUint32(o + i * 4, true)); }
    const readMini = (s, size) => { const out = new Uint8Array(size); let p = 0, guard = 0; while (s < 0xFFFFFFFA && p < size && guard++ < 1e7) { out.set(ministream.subarray(s * mss, s * mss + Math.min(mss, size - p)), p); p += mss; s = mfat[s]; } return out; };
    // walk the red-black tree into "Storage/Stream" paths
    const files = {};
    const walk = (id, prefix) => {
      if (id === 0xFFFFFFFF || id >= ents.length) return;
      const e = ents[id]; walk(e.left, prefix); walk(e.right, prefix);
      const path = prefix ? prefix + "/" + e.name : e.name;
      if (e.type === 2) files[path] = () => e.size < cutoff ? readMini(e.start, e.size) : readChain(e.start, e.size);
      else if (e.type === 1) walk(e.child, path);
    };
    walk(root.child, "");
    return files;
  }

  // ---------- record readers ----------
  const latin = new TextDecoder("windows-1252");
  function propsRecords(u8) {
    const out = [], dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let p = 0;
    while (p + 4 <= u8.length) {
      let len = dv.getUint32(p, true); p += 4; len &= 0x00ffffff; if (p + len > u8.length) break;
      const raw = u8.subarray(p, p + len); p += len;
      let s = latin.decode(raw).replace(/\0+$/, "");
      const o = {};
      for (const kv of s.split("|")) { const i = kv.indexOf("="); if (i > 0) o[kv.slice(0, i).trim().toUpperCase()] = kv.slice(i + 1); }
      for (const k of Object.keys(o)) if (k.startsWith("%UTF8%")) { try { o[k.slice(6)] = new TextDecoder().decode(Uint8Array.from(o[k], c => c.charCodeAt(0) & 255)); } catch (e) {} }
      out.push(o);
    }
    return out;
  }
  const unit = v => { if (v === undefined || v === "") return 0; const m = String(v).trim().match(/^(-?[\d.]+(?:e[-+]?\d+)?)\s*(mil|mm|in)?$/i); if (!m) return 0; const n = +m[1]; const u = (m[2] || "mil").toLowerCase(); return u === "mm" ? n : u === "in" ? n * 25.4 : n * 0.0254; };
  class Bin {
    constructor(u8) { this.u8 = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.p = 0; this.end = 0; }
    get left() { return this.u8.length - this.p; }
    u8r() { return this.u8[this.p++]; } u16() { const v = this.dv.getUint16(this.p, true); this.p += 2; return v; } u32() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
    i32() { const v = this.dv.getInt32(this.p, true); this.p += 4; return v; } f64() { const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
    skip(n) { this.p += n; }
    sub() { const len = this.u32(); this.end = this.p + len; return len; } // subrecord: uint32 length
    skipSub() { this.p = this.end; }
    pos() { const x = this.i32() * U, y = this.i32() * U; return [x, -y]; } // Altium is Y up → flip
    size() { return [this.i32() * U, this.i32() * U]; }
    str() { const n = this.u8r(); const s = latin.decode(this.u8.subarray(this.p, this.p + n)); this.p += n; return s; }
  }
  // pads: returns [{name, layer, net, comp, x, y, top:[w,h], shape, dir, hole, plated, radius%}]
  function readPads(u8) {
    const r = new Bin(u8), out = [];
    while (r.left > 5) {
      const type = r.u8r(); if (type !== 2) break;
      r.sub(); const name = r.str(); r.skipSub();
      for (let k = 0; k < 3; k++) { r.sub(); r.skipSub(); }
      const len5 = r.sub(), start5 = r.p;
      const layer = r.u8r(); r.u8r(); r.u8r();
      const net = r.u16(); r.skip(2); const comp = r.u16(); r.skip(4);
      const [x, y] = r.pos(); const top = r.size(); r.size(); const bot = r.size();
      const hole = r.i32() * U;
      const topShape = r.u8r(); r.u8r(); const botShape = r.u8r();
      const dir = r.f64(); const plated = r.u8r() !== 0;
      r.skipSub();
      let radius = null, altShape = null;
      if (r.left > 4) {
        const len6 = r.sub();
        if (len6 === 651 || len6 === 628) {
          r.skip(29 * 4 * 2 + 29 + 1); r.u8r(); r.i32(); r.f64(); r.skip(32 * 4 * 2 + 1);
          const alt = []; for (let i = 0; i < 32; i++) alt.push(r.u8r());
          const cr = []; for (let i = 0; i < 32; i++) cr.push(r.u8r());
          altShape = alt[0]; radius = cr[0];
        }
        r.skipSub();
      }
      out.push({ name, layer, net, comp, x, y, top: layer === 32 ? bot : top, shape: layer === 32 ? botShape : topShape, dir, hole, plated, altShape, radius });
      void len5; void start5;
    }
    return out;
  }
  // tracks / arcs (silk and copper)
  function readTracks(u8) {
    const r = new Bin(u8), out = [];
    while (r.left > 5) {
      const type = r.u8r(); if (type !== 4) break;
      r.sub(); const layer = r.u8r(); r.u8r(); r.u8r(); const net = r.u16(); r.u16(); const comp = r.u16(); r.skip(4);
      const a = r.pos(), b = r.pos(), w = r.i32() * U; r.skipSub();
      out.push({ layer, net, comp, pts: [a, b], w });
    }
    return out;
  }
  function readArcs(u8) {
    const r = new Bin(u8), out = [];
    while (r.left > 5) {
      const type = r.u8r(); if (type !== 1) break;
      r.sub(); const layer = r.u8r(); r.u8r(); r.u8r(); const net = r.u16(); r.u16(); const comp = r.u16(); r.skip(4);
      const c = r.pos(), rad = r.i32() * U, sa = r.f64(), ea = r.f64(), w = r.i32() * U; r.skipSub();
      // angles are counter-clockwise in Altium's Y-up frame; we already flipped Y, so walk clockwise in our frame
      const pts = []; let span = ((ea - sa) % 360 + 360) % 360; if (span === 0) span = 360;
      const n = Math.max(2, Math.ceil(span / 10));
      for (let k = 0; k <= n; k++) { const t = (sa + span * k / n) * Math.PI / 180; pts.push([c[0] + rad * Math.cos(t), c[1] - rad * Math.sin(t)]); }
      out.push({ layer, net, comp, pts, w });
    }
    return out;
  }
  function readVias(u8) {
    const r = new Bin(u8), out = [];
    while (r.left > 5) {
      const type = r.u8r(); if (type !== 3) break;
      r.sub(); r.skip(3); const net = r.u16(); r.skip(8); const p = r.pos(); const d = r.i32() * U; r.skipSub();
      out.push({ x: p[0], y: p[1], d, net });
    }
    return out;
  }

  // component comment text (shown as the part value): Texts6 records flagged isComment
  function readComments(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = {}; let p = 0;
    while (p + 9 < u8.length && u8[p] === 5) {
      p++; const l1 = dv.getUint32(p, true); p += 4; const s1 = p;
      const comp = dv.getUint16(s1 + 7, true), isComment = u8[s1 + 40] !== 0; p = s1 + l1;
      if (p + 4 > u8.length) break;
      const l2 = dv.getUint32(p, true); p += 4; const s2 = p; const tl = u8[s2];
      const txt = latin.decode(u8.subarray(s2 + 1, s2 + 1 + tl)); p = s2 + l2;
      if (isComment && comp !== 0xFFFF && !(comp in out)) out[comp] = txt;
    }
    return out;
  }
  function padPolys(pd) {
    const [w, h] = pd.top;
    let local;
    if (pd.altShape === 9 && pd.radius != null) local = G.rrect(w, h, Math.min(w, h) / 2 * pd.radius / 100);
    else if (pd.shape === 1) local = Math.abs(w - h) < 1e-6 ? G.circ(0, 0, w / 2) : G.rrect(w, h, Math.min(w, h) / 2, 6);
    else if (pd.shape === 3) { const c = Math.min(w, h) / 4, x = w / 2, y = h / 2; local = [[-x + c, -y], [x - c, -y], [x, -y + c], [x, y - c], [x - c, y], [-x + c, y], [-x, y - c], [-x, -y + c]]; }
    else local = G.rect(w, h);
    // direction is counter-clockwise in the Y-up frame → clockwise in ours
    return [local.map(([x, y]) => { const q = G.rotM(x, y, -pd.dir); return [q[0] + pd.x, q[1] + pd.y]; })];
  }

  // ASCII PcbDoc (Protel / Altium ASCII, also what 嘉立创EDA writes when exporting to Altium): one "|RECORD=…|K=V|…" per line
  function readAscii(text) {
    const rec = { comps: [], nets: [], pads: [], tracks: [], vias: [], board6: {}, comments: {} };
    const lay = v => { const s = String(v || "").toUpperCase(); return s === "TOP" ? 1 : s === "BOTTOM" ? 32 : s === "MULTILAYER" ? 74 : s === "TOPOVERLAY" ? 33 : s === "BOTTOMOVERLAY" ? 34 : -1; };
    const shp = v => { const s = String(v || "").toUpperCase(); return s === "ROUND" ? 1 : s === "OCTAGONAL" ? 3 : 2; };
    const idx = v => v === undefined || v === "" ? 0xFFFF : +v;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("|")) continue;
      const o = {}; for (const kv of line.split("|")) { const i = kv.indexOf("="); if (i > 0) o[kv.slice(0, i).trim().toUpperCase()] = kv.slice(i + 1); }
      const R = (o.RECORD || "").toUpperCase();
      if (R === "BOARD") rec.board6 = o;
      else if (R === "COMPONENT") rec.comps.push(o);
      else if (R === "NET") rec.nets.push(o.NAME || "");
      else if (R === "PAD") {
        const rr = (o.SHAPE || "").toUpperCase() === "ROUNDEDRECTANGLE";
        rec.pads.push({ name: o.NAME || "", layer: lay(o.LAYER), net: idx(o.NET), comp: idx(o.COMPONENT), x: unit(o.X), y: -unit(o.Y), top: [unit(o.XSIZE || o.TOPXSIZE), unit(o.YSIZE || o.TOPYSIZE)],
          shape: shp(o.SHAPE || o.TOPSHAPE), dir: +o.ROTATION || 0, hole: unit(o.HOLESIZE), plated: !/^false$/i.test(o.PLATED || "true"), altShape: rr ? 9 : null, radius: rr ? +(o.CORNERRADIUS || o.CRPERCENTAGE || 50) : null });
      } else if (R === "TRACK") rec.tracks.push({ layer: lay(o.LAYER), net: idx(o.NET), comp: idx(o.COMPONENT), pts: [[unit(o.X1), -unit(o.Y1)], [unit(o.X2), -unit(o.Y2)]], w: unit(o.WIDTH) });
      else if (R === "ARC") {
        const c = [unit(o.LOCATION_X || o.X), -unit(o.LOCATION_Y || o.Y)], rad = unit(o.RADIUS), sa = +o.STARTANGLE || 0, ea = +o.ENDANGLE || 0;
        let span = ((ea - sa) % 360 + 360) % 360; if (span === 0) span = 360; const n = Math.max(2, Math.ceil(span / 10)), pts = [];
        for (let k = 0; k <= n; k++) { const t = (sa + span * k / n) * Math.PI / 180; pts.push([c[0] + rad * Math.cos(t), c[1] - rad * Math.sin(t)]); }
        rec.tracks.push({ layer: lay(o.LAYER), net: idx(o.NET), comp: idx(o.COMPONENT), pts, w: unit(o.WIDTH) });
      } else if (R === "VIA") rec.vias.push({ x: unit(o.X), y: -unit(o.Y), d: unit(o.DIAMETER), net: idx(o.NET) });
      else if (R === "TEXT" && /^true$/i.test(o.COMMENT || o.ISCOMMENT || "") && o.COMPONENT !== undefined) rec.comments[+o.COMPONENT] = o.TEXT || "";
    }
    // components are referenced by order of appearance (ID when present)
    rec.comps = rec.comps.map((c, i) => ({ ...c, __i: c.ID !== undefined ? +c.ID : i }));
    return rec;
  }
  function readBinary(u8) {
    const fs = cfb(u8);
    const get = n => { const k = Object.keys(fs).find(p => p.toLowerCase() === n.toLowerCase()); return k ? fs[k]() : null; };
    const compsRaw = get("Components6/Data"); if (!compsRaw) throw new Error("PcbDoc 里没有 Components6（可能是 PcbLib 或旧版本格式）");
    let comments = {}; try { const t6 = get("Texts6/Data"); if (t6) comments = readComments(t6); } catch (e) { /* value text is optional */ }
    return {
      comps: propsRecords(compsRaw).map((c, i) => ({ ...c, __i: i })),
      nets: (get("Nets6/Data") ? propsRecords(get("Nets6/Data")) : []).map(o => o.NAME || ""),
      pads: get("Pads6/Data") ? readPads(get("Pads6/Data")) : [],
      tracks: (get("Tracks6/Data") ? readTracks(get("Tracks6/Data")) : []).concat(get("Arcs6/Data") ? readArcs(get("Arcs6/Data")) : []),
      vias: get("Vias6/Data") ? readVias(get("Vias6/Data")) : [],
      board6: get("Board6/Data") ? propsRecords(get("Board6/Data"))[0] || {} : {},
      comments,
    };
  }
  function parse(u8, fileName) {
    let rec;
    if (u8[0] === 0xD0 && u8[1] === 0xCF) rec = readBinary(u8);
    else { const head = latin.decode(u8.subarray(0, 64)); if (!/^\|RECORD=/i.test(head.trim())) throw new Error("不是 Altium PcbDoc（既不是二进制也不是 ASCII 格式）"); rec = readAscii(latin.decode(u8)); }
    const { comps, nets, pads, tracks, vias, board6, comments } = rec;
    const b = G.newBoard(), edgePts = [];
    // board outline from Board6 vertices
    const outl = [];
    for (let i = 0; board6["VX" + i] !== undefined; i++) {
      const v = [unit(board6["VX" + i]), -unit(board6["VY" + i])];
      if (+(board6["KIND" + i] || 0) !== 0 && outl.length) {
        const c = [unit(board6["CX" + i]), -unit(board6["CY" + i])], rad = unit(board6["R" + i]), sa = +board6["SA" + i] || 0, ea = +board6["EA" + i] || 0;
        let span = ((ea - sa) % 360 + 360) % 360; const n = Math.max(2, Math.ceil(span / 10));
        const arc = []; for (let k = 0; k <= n; k++) { const t = (sa + span * k / n) * Math.PI / 180; arc.push([c[0] + rad * Math.cos(t), c[1] - rad * Math.sin(t)]); }
        const prev = outl[outl.length - 1];
        if (Math.hypot(arc[0][0] - prev[0], arc[0][1] - prev[1]) > Math.hypot(arc[arc.length - 1][0] - prev[0], arc[arc.length - 1][1] - prev[1])) arc.reverse();
        outl.push(...arc);
      }
      outl.push(v);
    }
    if (outl.length > 2) { b.edges = G.polyD(outl); edgePts.push(...outl); }
    const tr = { F: [], B: [] }, silk = { F: [], B: [] }, csilk = {};
    for (const t of tracks) {
      const d = G.lineD(t.pts);
      if (t.layer === 1 || t.layer === 32) { if (t.comp === 0xFFFF) tr[t.layer === 1 ? "F" : "B"].push([t.w, d]); }
      else if (t.layer === 33 || t.layer === 34) { if (t.comp !== 0xFFFF) (csilk[t.comp] ||= []).push(d); else silk[t.layer === 33 ? "F" : "B"].push(d); }
    }
    b.tracks = { F: G.groupTracks(tr.F), B: G.groupTracks(tr.B) };
    b.silk = { F: silk.F.join(""), B: silk.B.join("") };
    b.vias = vias.map(v => [G.f3(v.x), G.f3(v.y), G.f3(v.d / 2)]);
    const padsByComp = {};
    for (const pd of pads) (padsByComp[pd.comp] ||= []).push(pd);
    comps.forEach(c => { const i = c.__i;
      const ref = c.SOURCEDESIGNATOR || c.DESIGNATOR || `?${i}`;
      const side = /^BOTTOM/i.test(c.LAYER || "") ? "B" : "F";
      const x = unit(c.X), y = -unit(c.Y);
      const list = padsByComp[i] || [];
      const recs = list.map(pd => {
        const kind = pd.layer === 74 || pd.hole > 0 ? (pd.plated ? 1 : 2) : 0;
        const holeD = pd.hole > 0 ? G.polyD(G.circ(pd.x, pd.y, pd.hole / 2, 20).reverse()) : "";
        return G.padRec(pd.name, pd.net !== 0xFFFF ? nets[pd.net] || "" : "", padPolys(pd), kind, holeD);
      });
      let bb = G.bboxOf(recs.flatMap(q => [[q[7][0], q[7][1]], [q[7][2], q[7][3]]]));
      if (!G.validBB(bb)) bb = [x - .5, y - .5, x + .5, y + .5];
      const p1 = recs.find(q => q[0] === "1");
      const props = { Description: c.SOURCEDESCRIPTION || "", LibRef: c.SOURCELIBREFERENCE || "" };
      b.parts.push({ r: ref, s: side, c: [G.f3(x), G.f3(y)], rot: +c.ROTATION || 0, bb: bb.map(G.f3), pads: recs, body: "", silk: (csilk[i] || []).join(""),
        val: comments[i] && !/^[.=]/.test(comments[i]) ? comments[i] : "", fp: c.PATTERN || "", props, sheet: "", p1: p1 ? [p1[4], p1[5]] : null, tht: recs.length && recs.every(q => q[3] !== 0) ? 1 : 0, dnp: 0, nobom: 0, libref: c.SOURCELIBREFERENCE || "" });
    });
    // free pads (test points, mounting holes) outside components
    (padsByComp[0xFFFF] || []).filter(pd => Math.min(pd.top[0], pd.top[1]) >= 0.15 || pd.hole > 0).forEach((pd, k) => {
      const kind = pd.layer === 74 || pd.hole > 0 ? (pd.plated ? 1 : 2) : 0;
      const rec = G.padRec("1", pd.net !== 0xFFFF ? nets[pd.net] || "" : "", padPolys(pd), kind);
      b.parts.push({ r: pd.name && /^[A-Za-z]+\d+$/.test(pd.name) ? pd.name : `PAD${k + 1}`, s: pd.layer === 32 ? "B" : "F", c: [rec[4], rec[5]], rot: 0, bb: rec[7].map(G.f3), pads: [rec], body: "", silk: "", val: "", fp: "PAD", props: {}, sheet: "", p1: null, tht: kind ? 1 : 0, dnp: 0, nobom: 1 });
    });
    return G.finishBoard(b, edgePts);
  }
  return { parse, cfb, propsRecords };
})();
