// OrCAD Capture .DSN design database (OLE2): every schematic page becomes one sheet with its cached symbols, wires,
// net aliases, power / off-page symbols and title block. Record layout after the reverse-engineering notes of
// OpenOrCadParser (MIT, github.com/Werni2A/OpenOrCadParser), re-implemented here. Tested on Capture 16.6–17.4 designs
// whose "Library" stream reports database version 3.2; other versions are attempted and flagged.
// Assumptions: 1 unit = 0.01 inch, y grows downwards; part / symbol location = top-left of the rotated body box;
// display-property offsets are relative to the location and not rotated; text anchors are the top-left of the text box.
globalThis.ImpOrcadDsn = (() => {
  const U = 0.254, f = n => Math.round(n * 10000) / 10000;
  const PAL = "ff8080 ffff80 80ff80 00ff80 80ffff 0080ff ff80c0 ff80ff ff0000 ffff00 80ff00 00ff40 00ffff 0080c0 8080c0 ff00ff 804040 ff8040 00ff00 008080 004080 8080ff 800040 ff0080 800000 ff8000 008000 008040 0000ff 0000a0 800080 8000ff 400000 804000 004000 004040 000080 000040 400040 400080 000000 808000 808040 808080 408080 c0c0c0 400040 ffffff".split(" ");
  const BODY = "#800000", INK = "#1f3a68", WIRE = "#167147", MISSING = "#c0392b";
  const color = (c, d) => c < 48 ? "#" + PAL[c] : d;
  const lineW = w => [0.15, 0.3, 0.6][w] ?? 0.2;
  const PRIMS = [40, 41, 42, 43, 44, 45, 46, 47, 48, 87], MAGIC = [0xff, 0xe4, 0x5c, 0x39];
  let dec;
  const decode = b => { try { dec ||= new TextDecoder("gb18030"); } catch { dec = new TextDecoder(); } return dec.decode(b); };
  function reader(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const R = { u8, pos: 0, end: u8.length,
      need(n) { if (n < 0 || R.pos + n > R.end) throw new Error(`数据越界（偏移 ${R.pos}）`); },
      b() { R.need(1); return u8[R.pos++]; },
      u16() { R.need(2); R.pos += 2; return dv.getUint16(R.pos - 2, true); },
      i16() { R.need(2); R.pos += 2; return dv.getInt16(R.pos - 2, true); },
      u32() { R.need(4); R.pos += 4; return dv.getUint32(R.pos - 4, true); },
      i32() { R.need(4); R.pos += 4; return dv.getInt32(R.pos - 4, true); },
      skip(n) { R.need(n); R.pos += n; },
      str() { const n = R.u16(); if (n === 0xffff) return ""; R.need(n + 1); if (u8[R.pos + n]) throw new Error(`字符串格式不对（偏移 ${R.pos - 2}）`); const s = decode(u8.subarray(R.pos, R.pos + n)); R.pos += n + 1; return s; },
      magic() { return MAGIC.every((m, i) => u8[R.pos + i] === m); } };
    return R;
  }
  // record head: (n-1) × [type u8][size u32][u32] then [type u8][count i16][(name, value) string ids], optional ff e4 5c 39 block
  function head(R, want) {
    const u8 = R.u8, p0 = R.pos, t = u8[p0];
    if (want && !want.includes(t)) throw new Error(`偏移 ${p0} 处应为记录 ${want.join("/")}，实际是 ${t}`);
    let n = 1; while (n < 10 && p0 + 9 * n + 3 <= R.end && u8[p0 + 9 * n] === t) n++;
    const stops = [];
    for (let i = 0; i < n - 1; i++) { R.pos = p0 + 9 * i + 1; const s = p0 + 9 * (i + 1) + R.u32(); if (s > R.end) { n = i + 1; break; } stops.push(s); }
    R.pos = p0 + 9 * (n - 1) + 1;
    const props = []; for (let k = R.i16(); k-- > 0;) props.push([R.u32(), R.u32()]);
    if (R.magic()) { R.skip(4); R.skip(R.u32()); }
    return { t, stops, end: stops.length ? Math.max(...stops) : -1, props };
  }
  const done = (R, h) => { if (h.end < 0) return; if (R.pos > h.end) throw new Error(`记录 ${h.t} 读过头（偏移 ${R.pos}）`); R.pos = h.end; };
  const checkpoint = (h, pos) => h.stops.reduce((m, s) => s >= pos && s < m ? s : m, Infinity);
  function disp(R) {
    const out = [];
    for (let n = R.u16(); n--;) { const h = head(R, [39]), d = { name: R.u32(), x: R.i16(), y: R.i16() }, rf = R.u16(); d.rot = rf >> 14; d.font = rf & 0x3fff; d.color = R.b(); R.b(); d.mode = R.b(); done(R, h); out.push(d); }
    return out;
  }
  function primitive(R, t, bad) {
    const at = R.pos, len = R.u32(), o = { t }; R.skip(4);
    const xy = () => [R.i32(), R.i32()], style = () => { o.ls = R.u32(); o.lw = R.u32(); }, fill = () => { o.fill = R.u32(); R.skip(4); };
    if (t === 40 || t === 41 || t === 43) { o.a = xy(); o.b = xy(); if (len >= 32) style(); if (len >= 40) fill(); }
    else if (t === 42) { o.a = xy(); o.b = xy(); o.s = xy(); o.e = xy(); if (len >= 48) style(); }
    else if (t === 44 || t === 45 || t === 87) { // header size differs between versions: pick the one that matches the point count
      const sizes = t === 44 ? [26, 18, 10] : [18, 10], h = sizes.find(h => h + 4 * (R.u8[at + h - 2] | R.u8[at + h - 1] << 8) === len) ?? sizes[0];
      if (h >= 18) style(); if (h >= 26) fill();
      o.p = []; for (let n = R.u16(); n--;) { const y = R.i16(); o.p.push([R.i16(), y]); }
    } else if (t === 46) { o.a = xy(); R.skip(16); o.font = R.u16(); R.skip(2); o.text = R.str(); }
    else { bad.push(t === 47 ? "嵌入图片" : `未知图元 ${t}`); o.skip = 1; }
    if (t !== 46) R.pos = at + len;
    if (R.magic()) { R.skip(4); R.skip(R.u32()); }
    return o;
  }
  function prims(R, h, bad) {
    const list = [];
    for (let n = R.u16(), i = 0; i < n; i++) {
      const t = R.b(); if (R.b() !== t || !PRIMS.includes(t)) throw new Error(`偏移 ${R.pos - 2} 处不是图元`);
      if (t === 48) { bad.push("符号矢量图元"); break; }
      list.push(primitive(R, t, bad));
      if (i + 1 < n) for (let k = 0; k < 64 && R.pos + 1 < R.end && !(R.u8[R.pos] === R.u8[R.pos + 1] && PRIMS.includes(R.u8[R.pos])); k++) R.pos++;
    }
    const cp = checkpoint(h, R.pos); let bb = null;
    if (cp < Infinity) { if (cp - R.pos >= 8) { R.pos = cp - 8; bb = [R.i16(), R.i16(), R.i16(), R.i16()]; } R.pos = cp; }
    return { list, bb };
  }
  function pin(R) {
    if (R.u8[R.pos] === 0) { R.pos++; return null; } // empty pin slot keeps the numbering
    const h = head(R, [26, 27]), p = { name: R.str(), s: [R.i32(), R.i32()], h: [R.i32(), R.i32()], shape: R.u16() };
    R.skip(2); p.type = R.u32(); R.skip(4); disp(R); done(R, h); return p;
  }
  // 24 part view, 34 port, 33 power, 35 off-page and 64 title-block symbols share one layout
  function symbol(R, bad) {
    const h = head(R, [24, 33, 34, 35, 64]), s = { t: h.t, name: R.str(), lib: R.str(), pins: [] };
    s.color = R.u32();
    const g = prims(R, h, bad); s.prims = g.list; s.bb = g.bb;
    for (let n = R.u16(); n--;) s.pins.push(pin(R));
    s.disp = disp(R);
    if (h.t === 24 && R.pos < h.end && R.magic()) { R.skip(4); R.skip(R.u32()); R.str(); R.str(); R.str(); R.str(); s.bits = R.b(); }
    done(R, h); return s;
  }
  function pkg(R) {
    const h = head(R, [31]), g = { name: R.str() }; R.str(); g.prefix = R.str(); R.str(); g.footprint = R.str(); g.dev = [];
    for (let n = R.u16(); n--;) {
      const q = head(R, [32]), d = { unit: R.str(), ref: R.str(), map: [] };
      for (let m = R.u16(); m--;) { if (R.u8[R.pos] === 0xff && R.u8[R.pos + 1] === 0xff) { R.skip(2); d.map.push(""); continue; } d.map.push(R.str()); R.skip(1); }
      done(R, q); g.dev.push(d);
    }
    done(R, h); return g;
  }
  function inst(R, want, bad) { // power / off-page / port / title block / page graphic instance
    const h = head(R, want), o = { t: h.t, props: h.props, inst: R.u32(), lib: R.u32() }; o.sym = R.str(); R.skip(4); // instance (net) name id, library id, symbol name
    const b = [R.i16(), R.i16(), R.i16(), R.i16()]; o.bb = [b[1], b[0], b[3], b[2]]; o.x = R.i16(); o.y = R.i16(); o.color = R.b(); o.ori = R.b() & 7; R.skip(2);
    o.disp = disp(R);
    if (R.b() === 2) { const g = head(R, [2]); R.str(); R.str(); R.skip(4); o.prims = prims(R, g, bad).list; done(R, g); }
    done(R, h); return o;
  }
  function part(R) { // placed pins carry the id of their net; the record ends with the unit (u16 index into the package's devices, A = 0)
    const h = head(R, [13]), o = { props: h.props, inst: R.u32(), lib: R.u32() }; o.sym = R.str(); R.skip(4);
    const b = [R.i16(), R.i16(), R.i16(), R.i16()]; o.bb = [b[1], b[0], b[3], b[2]]; o.x = R.i16(); o.y = R.i16(); o.color = R.b(); o.ori = R.b() & 7; R.skip(2);
    o.disp = disp(R); R.skip(1); o.ref = R.str(); o.value = R.u32(); R.skip(10);
    o.pins = []; for (let n = R.u16(); n--;) { const q = head(R, [16]), i = R.i16(), x = R.i16(), y = R.i16(), net = R.u32(); R.skip(4); disp(R); done(R, q); o.pins.push({ i: Math.abs(i), x, y, net }); }
    o.pkg = R.str(); if (h.end >= R.pos + 2) o.unit = R.u16(); done(R, h); return o;
  }
  function page(u8, bad) {
    const R = reader(u8); head(R, [10]);
    const pg = { name: R.str(), size: R.str() }, ps = R.pos; R.skip(24); pg.W = R.u32(); pg.H = R.u32(); R.pos = ps + 124; pg.metric = R.u32(); R.pos = ps + 156;
    const list = fn => { const a = []; for (let n = R.u16(); n--;) a.push(fn()); return a; };
    const blob = () => { const p0 = R.pos; R.b(); R.pos = p0 + 9 + R.u32(); };
    pg.blocks = list(() => inst(R, [65], bad)); list(blob); list(blob);
    pg.nets = new Map(); for (let n = R.u16(); n--;) { const s = R.str(); pg.nets.set(R.u32(), s); }
    pg.wires = list(() => {
      const h = head(R, [20, 21]); R.skip(4); const w = { bus: h.t === 21, id: R.u32(), color: R.u32(), a: [R.i32(), R.i32()], b: [R.i32(), R.i32()] }; R.skip(1);
      w.alias = list(() => { const q = head(R, [49]), a = { x: R.i32(), y: R.i32(), color: R.u32(), rot: R.u32() & 3 }; R.skip(4); a.name = R.str(); done(R, q); return a; });
      disp(R); w.lw = R.u32(); done(R, h); return w;
    });
    pg.parts = list(() => part(R)); pg.ports = list(() => inst(R, [23], bad));
    pg.globals = list(() => { const o = inst(R, [37], bad); R.skip(5); return o; });
    pg.offpage = list(() => { const o = inst(R, [38], bad); R.skip(5); return o; });
    pg.graphics = [];
    try {
      const skipped = list(() => { const h = head(R); if (h.end < 0) throw new Error("ERC"); done(R, h); }).length + list(() => { const h = head(R); if (h.end < 0) throw new Error("bus"); done(R, h); }).length;
      if (skipped) bad.push("ERC 标记 / 总线入口");
      pg.graphics = list(() => inst(R, null, bad));
    } catch { bad.push("页面上的部分自由图形"); }
    return pg;
  }
  function library(u8) {
    const R = reader(u8); let intro = ""; for (let i = 0; i < 32 && u8[i]; i++) intro += String.fromCharCode(u8[i]);
    R.pos = 32; const ver = [R.u16(), R.u16()]; R.skip(12);
    const fonts = []; for (let n = R.u16() - 1; n-- > 0;) { const o = R.pos; fonts.push(Math.abs(R.i32()) || 9); R.pos = o + 60; }
    R.skip(R.u16() * 2 + 8); for (let i = 0; i < 8; i++) R.str(); R.skip(156);
    const at = R.pos; let strs = [];
    try { for (let n = R.u32(); n--;) strs.push(R.str()); } catch { R.pos = at; strs = []; for (let n = R.u16(); n--;) strs.push(R.str()); }
    return { intro: intro.trim(), ver: ver.join("."), fonts, strs };
  }
  function sniff(u8) {
    if (!(u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0)) {
      const specctra = /^\s*\(\s*pcb[\s"]/i.test(new TextDecoder().decode(u8.subarray(0, 256)));
      return { ok: false, specctra, why: specctra ? "Specctra 布线文件（文本 .dsn），不是 OrCAD 原理图" : "不是 OLE2 复合文档，不像 OrCAD Capture 的 .DSN 原理图" };
    }
    let files; try { files = ImpAltium.cfb(u8); } catch (e) { return { ok: false, why: "OLE2 复合文档无法读取：" + e.message }; }
    if (!files.Library) return { ok: false, why: "OLE2 文档里没有 OrCAD 的 Library 数据流，不是 OrCAD Capture 设计" };
    let intro = ""; const lb = files.Library(); for (let i = 0; i < 32 && lb[i]; i++) intro += String.fromCharCode(lb[i]);
    if (/OrCAD Windows Library/.test(intro)) return { ok: false, why: "这是 OrCAD 符号库（OLB），不是原理图设计" };
    if (!/OrCAD Windows Design/.test(intro)) return { ok: false, why: `Library 数据流开头是“${intro.trim().slice(0, 30)}”，不是 OrCAD Capture 设计` };
    const pages = Object.keys(files).filter(k => /^Views\/[^/]+\/Pages\/[^/]+$/.test(k));
    if (!pages.length) return { ok: false, why: "OrCAD 设计里没有原理图页（Views/*/Pages）" };
    return { ok: true, files, pages };
  }
  function connect(doc, ids, names, pids, known) { // geometry like the Altium importer, plus OrCAD's own net ids and label names
    const { wires, pins, junctions, ports } = doc, p0 = wires.length, j0 = p0 + pins.length, c0 = j0 + junctions.length, total = c0 + ports.length;
    const up = Array.from({ length: total }, (_, i) => i), find = x => { while (up[x] !== x) x = up[x] = up[up[x]]; return x; }, join = (a, b) => { a = find(a); b = find(b); if (a !== b) up[b] = a; };
    const at = new Map(), eps = 0.012, key = p => p.map(x => Math.round(x / eps)).join(",");
    const add = (p, i) => { const k = key(p); if (at.has(k)) join(at.get(k), i); else at.set(k, i); };
    const onSeg = (p, a, b) => Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) < eps && p[0] >= Math.min(a[0], b[0]) - eps && p[0] <= Math.max(a[0], b[0]) + eps && p[1] >= Math.min(a[1], b[1]) - eps && p[1] <= Math.max(a[1], b[1]) + eps;
    const onWire = (p, i) => wires.forEach((w, k) => { if (onSeg(p, w.points[0], w.points[1])) join(k, i); });
    const byId = new Map(), byName = new Map();
    wires.forEach((w, i) => { w.points.forEach(p => add(p, i)); if (byId.has(ids[i])) join(byId.get(ids[i]), i); else byId.set(ids[i], i); });
    pins.forEach((p, i) => { add([p.ex, p.ey], p0 + i); onWire([p.ex, p.ey], p0 + i); });
    junctions.forEach((p, i) => { add(p, j0 + i); onWire(p, j0 + i); });
    ports.forEach((p, i) => { if (p.wire >= 0) join(p.wire, c0 + i); else { add([p.x, p.y], c0 + i); onWire([p.x, p.y], c0 + i); } const k = p.name.toUpperCase(); if (byName.has(k)) join(byName.get(k), c0 + i); else byName.set(k, c0 + i); });
    const groups = new Map(); for (let i = 0; i < total; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
    const auto = new Map(), uses = new Map(); // Capture names an unnamed net "N" + the id one of its pins carries: use it only if that name is in its saved net list and unique here
    for (const [r, g] of groups) { const hit = [...new Set(g.filter(i => i >= p0 && i < j0 && pids[i - p0]).map(i => "N" + pids[i - p0]))].filter(n => known.has(n)); if (hit.length === 1) { auto.set(r, hit[0]); uses.set(hit[0], (uses.get(hit[0]) || 0) + 1); } } // ids < 10000 are saved zero-padded ("N00627") and proved unreliable: left unnamed
    for (const [r, g] of groups) {
      const net = { name: "", wires: [], pins: [], ports: [], points: [] }, label = ["", ""];
      for (const i of g) {
        if (i < p0) { net.wires.push(i); net.points.push(...wires[i].points); label[0] ||= names.get(ids[i]) || ""; }
        else if (i < j0) { net.pins.push(i - p0); net.points.push([pins[i - p0].ex, pins[i - p0].ey]); }
        else if (i < c0) net.points.push(junctions[i - j0]);
        else { const p = ports[i - c0]; net.ports.push(i - c0); if (p.type === 17) net.name = p.name; else label[p.type === 25 ? 0 : 1] ||= p.name; net.points.push([p.x, p.y]); }
      }
      net.name ||= label[0] || label[1];
      if (!net.name && uses.get(auto.get(r)) === 1) net.name = auto.get(r);
      if (!net.wires.length && net.pins.length < 2 && !net.ports.length) continue;
      const k = doc.nets.length;
      for (const i of net.wires) wires[i].net = k;
      for (const i of net.pins) { pins[i].net = net.name; pins[i].netIndex = k; }
      for (const i of net.ports) ports[i].netIndex = k;
      if (net.wires.length || net.pins.length) doc.nets.push(net);
    }
  }
  function sheet(pg, ctx, no, count, bad, st) {
    const { lib, syms, pkgs } = ctx, S = i => lib.strs[i] ?? "";
    const width = f((pg.metric ? pg.W / 1000 : pg.W * 0.0254) || 420), height = f((pg.metric ? pg.H / 1000 : pg.H * 0.0254) || 297);
    const X = x => f(x * U), Y = y => f(y * U - height), P = p => [X(p[0]), Y(p[1])];
    const doc = { kind: "schematic", ver: 2, source: "OrCAD Capture DSN", file: "", title: "", width, height, shapes: [], texts: [], pins: [], wires: [], junctions: [], ports: [], components: [], nets: [], unsupported: [] };
    const { shapes, texts } = doc, fontMm = i => (lib.fonts[i - 1] || lib.fonts[0] || 9) * U;
    const find = (name, libName, types) => { const c = (syms.get(name) || []).filter(s => types.includes(s.t)); return c.find(s => s.lib === libName) || c[0] || null; }; // cache copies come first
    const place = (sym, x, y, ori) => { // mirror first, then rotate 90° steps counter-clockwise; location = top-left of the rotated body box
      const r = [[1, 0, 0, 1], [0, 1, -1, 0], [-1, 0, 0, -1], [0, -1, 1, 0]][ori & 3], m = ori & 4 ? -1 : 1, M = [r[0] * m, r[1], r[2] * m, r[3]];
      const ap = p => [M[0] * p[0] + M[1] * p[1], M[2] * p[0] + M[3] * p[1]];
      const bb = sym?.bb && [[sym.bb[0], sym.bb[1]], [sym.bb[2], sym.bb[3]], [sym.bb[0], sym.bb[3]], [sym.bb[2], sym.bb[1]]].map(ap);
      const tr = { M, ap, T: bb ? [x - Math.min(...bb.map(p => p[0])), y - Math.min(...bb.map(p => p[1]))] : [x, y] };
      tr.at = p => { const q = ap(p); return [tr.T[0] + q[0], tr.T[1] + q[1]]; };
      return tr;
    };
    const text = (x, y, value, size, rot, anchor, c, owner = -1) => texts.push({ x: f(x), y: f(y), text: value, size: f(size), rot, anchor, color: c, owner });
    const label = (x, y, value, font, rot, c, owner) => { const s = fontMm(font); text(X(x) + (rot === 1 ? s * 0.8 : rot === 3 ? s * 0.2 : 0), Y(y) + (rot & 1 ? 0 : s * 0.8), value, s, rot === 1 ? -90 : rot === 3 ? 90 : 0, rot === 1 ? "end" : "start", c, owner); };
    const line = (pts, c, fill, w, owner, close) => shapes.push(["M" + pts.map(P).map(q => q.join(" ")).join("L") + (close ? "Z" : ""), c, fill, w, owner]);
    function draw(list, tr, owner, c) {
      for (const p of list || []) {
        if (p.skip) continue;
        const w = lineW(p.lw), fill = p.fill === 0 ? c : "";
        if (p.t === 41) line([tr.at(p.a), tr.at(p.b)], c, "", w, owner);
        else if (p.t === 40) line([p.a, [p.b[0], p.a[1]], p.b, [p.a[0], p.b[1]]].map(tr.at), c, fill, w, owner, true);
        else if (p.t === 44 || p.t === 45) line(p.p.map(tr.at), c, p.t === 44 ? fill : "", w, owner, p.t === 44);
        else if (p.t === 42 || p.t === 43) {
          const cx = (p.a[0] + p.b[0]) / 2, cy = (p.a[1] + p.b[1]) / 2, rx = Math.abs(p.b[0] - p.a[0]) / 2 || 1e-6, ry = Math.abs(p.b[1] - p.a[1]) / 2 || 1e-6;
          const ang = q => Math.atan2((q[1] - cy) / ry, (q[0] - cx) / rx), s = p.t === 42 ? ang(p.s) : 0;
          const span = p.t === 42 ? ((s - ang(p.e)) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI : 2 * Math.PI, n = Math.max(4, Math.ceil(span / 0.12)), pts = [];
          for (let i = 0; i <= n; i++) { const a = s - span * i / n; pts.push(tr.at([cx + rx * Math.cos(a), cy + ry * Math.sin(a)])); }
          line(pts, c, p.t === 43 ? fill : "", w, owner, p.t === 43);
        } else if (p.t === 87) {
          const pts = [tr.at(p.p[0])];
          for (let i = 0; i + 3 < p.p.length; i += 3) for (let k = 1; k <= 12; k++) { const t = k / 12, u = 1 - t, q = [0, 1].map(j => u * u * u * p.p[i][j] + 3 * u * u * t * p.p[i + 1][j] + 3 * u * t * t * p.p[i + 2][j] + t * t * t * p.p[i + 3][j]); pts.push(tr.at(q)); }
          line(pts, c, "", w, owner);
        } else if (p.t === 46 && p.text) { const a = tr.at(p.a); p.text.split(/\r?\n/).forEach((s, i) => label(a[0], a[1] + i * (lib.fonts[p.font - 1] || 9), s, p.font, 0, c, owner)); }
      }
    }
    const props = list => Object.fromEntries(list.map(([a, b]) => [S(a), S(b)]));
    const shown = (d, name, val) => ["", val, `${name} = ${val}`, name, val ? `${name} = ${val}` : "", val][d.mode] ?? val;
    // parts (pids: OrCAD net id of every placed pin, parallel to doc.pins)
    const pids = [];
    for (const o of pg.parts) {
      const sym = find(o.sym, S(o.lib), [24]), pk = pkgs.get(o.pkg), ci = doc.components.length, ps = props(o.props), units = pk?.dev.length || 1;
      const k = ctx.units.get(o.ref) || 0, known = o.unit < units, u = units < 2 ? 0 : known ? o.unit : k, dev = pk?.dev[u] || pk?.dev[0]; ctx.units.set(o.ref, k + 1);
      if (units > 1 && !known) bad.push(`多单元器件 ${o.ref}：文件里没解出单元号，按放置顺序对应单元，引脚号可能对调`); // stored unit missing or out of range
      const tr = place(sym, o.x, o.y, o.ori);
      if (sym && o.pins.length) { // OrCAD also stores every placed pin hot spot: use it to check the transform
        const ok = () => o.pins.every(q => { const sp = sym.pins[q.i - 1]; if (!sp) return true; const a = tr.at(sp.h); return a[0] === q.x && a[1] === q.y; });
        if (!ok()) { const q = o.pins.find(q => sym.pins[q.i - 1]); if (q) { const a = tr.ap(sym.pins[q.i - 1].h); tr.T = [q.x - a[0], q.y - a[1]]; } st.fixed++; if (!ok()) st.mismatch++; }
      }
      const footprint = ps["PCB Footprint"] || pk?.footprint || ""; delete ps["PCB Footprint"];
      const comp = { index: ci, ref: o.ref, value: S(o.value), description: "", library: o.sym.replace(/\.(Normal|Convert)$/i, ""), footprint, origin: P(tr.T), part: Math.min(u, units - 1) + 1, partCount: units, properties: { ...ps, "Source Package": o.pkg, "Source Library": S(o.lib) }, pins: [], bb: null };
      doc.components.push(comp);
      const c = color(o.color, BODY), pts = [];
      if (sym) {
        draw(sym.prims, tr, ci, c);
        if (sym.bb) pts.push(tr.at([sym.bb[0], sym.bb[1]]), tr.at([sym.bb[2], sym.bb[3]]));
      } else {
        bad.push(`缺少符号 ${o.sym}（${o.ref}，画成占位框）`); st.missing++;
        const b = o.bb; line([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], MISSING, "#c0392b14", 0.25, ci, true); pts.push([b[0], b[1]], [b[2], b[3]]);
      }
      const nameOn = sym?.bits === undefined ? null : !!(sym.bits & 1), numOn = sym?.bits === undefined ? o.pins.length > 2 : !(sym.bits & 4);
      for (const q of o.pins) {
        const sp = sym?.pins[q.i - 1], hot = [q.x, q.y], base = sp ? tr.at(sp.s) : hot, number = dev?.map[q.i - 1] || sp?.name || String(q.i), name = sp?.name || "";
        const [x, y] = P(base), [ex, ey] = P(hot), dx = ex - x, dy = ey - y, o4 = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 2) : (dy < 0 ? 1 : 3);
        const showName = name && name !== number && (nameOn ?? true), showNum = numOn && (dx || dy);
        const pin = { index: doc.pins.length, owner: ci, number, name, description: "", electrical: sp?.type ?? 4, flags: o4 | (showName ? 8 : 0) | (showNum ? 16 : 0), color: 0, symbols: [sp && sp.shape & 2 ? 3 : 0, sp && sp.shape & 4 ? 1 : 0, 0, 0], x, y, ex, ey, net: "" };
        doc.pins.push(pin); pids.push(q.net); comp.pins.push(pin.index); pts.push(base, hot);
        const v = o4 === 1 || o4 === 3, s = 1.6, sx = Math.sign(dx), sy = Math.sign(dy);
        if (showNum) text((x + ex) / 2 + (v ? -0.4 : 0), (y + ey) / 2 + (v ? 0 : -0.4), number, s, v ? -90 : 0, "middle", c, ci);
        if (showName) text(x - sx * 0.8 + (v ? s * 0.35 : 0), y - sy * 0.8 + (v ? 0 : s * 0.35), name, s * 1.05, v ? -90 : 0, (v ? sy < 0 : sx > 0) ? "end" : "start", c, ci);
      }
      for (const d of o.disp) {
        const name = S(d.name), val = name === "Part Reference" ? o.ref : name === "Value" ? comp.value : ps[name] ?? (name === "PCB Footprint" ? footprint : ""), s = shown(d, name, val);
        if (s) label(o.x + d.x, o.y + d.y, s, d.font, d.rot, color(d.color, INK), ci);
      }
      const mm = pts.map(P); comp.bb = mm.length ? [Math.min(...mm.map(p => p[0])), Math.min(...mm.map(p => p[1])), Math.max(...mm.map(p => p[0])), Math.max(...mm.map(p => p[1]))] : [X(o.x), Y(o.y), X(o.x) + 2, Y(o.y) + 2];
      st.pins += o.pins.length; st.pinsOnSymbol += o.pins.filter(q => sym?.pins[q.i - 1] && tr.at(sym.pins[q.i - 1].h).join() === [q.x, q.y].join()).length;
    }
    // power, off-page connector and hierarchical port symbols
    for (const [list, types, type] of [[pg.globals, [33], 17], [pg.offpage, [35], 18], [pg.ports, [34], 18]]) for (const g of list) {
      const sym = find(g.sym, S(g.lib), types), tr = place(sym, g.x, g.y, g.ori), c = color(g.color, BODY), name = S(g.inst) || g.sym;
      if (sym) draw(sym.prims, tr, -1, c); else { bad.push(`缺少${type === 17 ? "电源" : "跨页 / 端口"}符号 ${g.sym}`); st.missing++; }
      const hot = sym?.pins[0] ? tr.at(sym.pins[0].h) : [g.x, g.y];
      doc.ports.push({ name, x: X(hot[0]), y: Y(hot[1]), type, style: 0, orientation: 0, color: c, netIndex: -1, drawn: !!sym });
      for (const d of g.disp) { const s = shown(d, S(d.name), name); if (s) label(g.x + d.x, g.y + d.y, s, d.font, d.rot, color(d.color, INK)); }
    }
    // title block: symbol graphics plus the page / design properties it displays
    for (const b of pg.blocks) {
      const sym = find(b.sym, S(b.lib), [64]), tr = place(sym, b.x, b.y, b.ori), ps = props(b.props);
      if (sym) draw(sym.prims, tr, -1, color(b.color, INK)); else bad.push("缺少标题栏符号");
      const known = { "Page Number": String(no), "Page Count": String(count), "Page Size": pg.size };
      for (const d of b.disp) { const name = S(d.name), s = shown(d, name, ps[name] ?? known[name] ?? ""); if (s) label(b.x + d.x, b.y + d.y, s, d.font, d.rot, color(d.color, INK)); }
      doc.title ||= ps.Title || "";
    }
    for (const g of pg.graphics) draw(g.prims, place(null, 0, 0, 0), -1, color(g.color, INK)); // free graphics are stored in page coordinates
    // wires, net aliases and computed junctions (Capture draws junction dots itself)
    const ids = [], ends = new Map(), k = p => p.join(",");
    for (const w of pg.wires) {
      doc.wires.push({ points: [P(w.a), P(w.b)], color: w.bus ? "#3b4cca" : color(w.color, WIRE), net: -1 }); ids.push(w.id);
      for (const p of [w.a, w.b]) ends.set(k(p), (ends.get(k(p)) || 0) + 1);
      for (const a of w.alias) {
        doc.ports.push({ name: a.name, x: X(a.x), y: Y(a.y), type: 25, style: 0, orientation: a.rot, color: color(a.color, INK), netIndex: -1, drawn: true, wire: doc.wires.length - 1 });
        text(X(a.x) + (a.rot & 1 ? -0.4 : 0), Y(a.y) - (a.rot & 1 ? 0 : 0.4), a.name, fontMm(1), a.rot & 1 ? -90 : 0, a.rot & 1 ? "end" : "start", color(a.color, INK));
      }
    }
    for (const q of pg.parts.flatMap(o => o.pins)) if (ends.has(k([q.x, q.y]))) ends.set(k([q.x, q.y]), ends.get(k([q.x, q.y])) + 1);
    for (const [s, n] of ends) {
      const p = s.split(",").map(Number), through = pg.wires.filter(w => (w.a[0] === w.b[0] ? p[0] === w.a[0] && p[1] > Math.min(w.a[1], w.b[1]) && p[1] < Math.max(w.a[1], w.b[1]) : w.a[1] === w.b[1] && p[1] === w.a[1] && p[0] > Math.min(w.a[0], w.b[0]) && p[0] < Math.max(w.a[0], w.b[0]))).length;
      if (n + 2 * through >= 3) doc.junctions.push(P(p));
    }
    connect(doc, ids, pg.nets, pids, ctx.netNames);
    return doc;
  }
  function parse(u8, fileName, stats) {
    const sn = sniff(u8); if (!sn.ok) throw new Error(sn.why);
    const { files } = sn, lib = library(files.Library()), all = [];
    const ctx = { lib, syms: new Map(), pkgs: new Map(), units: new Map(), netNames: new Set() }, add =s => { if (!ctx.syms.has(s.name)) ctx.syms.set(s.name, []); ctx.syms.get(s.name).push(s); };
    if (files.Cache) { // the design cache holds the library copies of every placed symbol and package; find their records by signature
      const u8c = files.Cache(), R = reader(u8c);
      for (let i = 0; i + 24 < u8c.length; i++) {
        const t = u8c[i]; if (![24, 31, 33, 34, 35, 64].includes(t) || u8c[i + 9] !== t || u8c[i + 5] | u8c[i + 6] | u8c[i + 7] | u8c[i + 8]) continue;
        R.pos = i; try { if (t === 31) { const g = pkg(R); if (!ctx.pkgs.has(g.name)) ctx.pkgs.set(g.name, g); } else add(symbol(R, all)); i = R.pos - 1; } catch { /* not a record start */ }
      }
    }
    for (const key of Object.keys(files).filter(k => k.startsWith("Packages/"))) {
      try { const R = reader(files[key]()); for (let n = R.u16(); n--;) { done(R, head(R, [6])); for (let m = R.u16(); m--;) add(symbol(R, all)); } const g = pkg(R); if (!ctx.pkgs.has(g.name)) ctx.pkgs.set(g.name, g); }
      catch { all.push(`封装 ${key.slice(9)}`); }
    }
    for (const key of Object.keys(files).filter(k => /^Views\/[^/]+\/Hierarchy\/Hierarchy$/.test(k))) { // Capture's own net names ([u16 length]"N<digits>"\0) confirm the "N" + id names of unnamed nets
      const u = files[key](); for (let i = 2; i < u.length; i++) { const n = u[i - 2]; if (u[i] !== 78 || u[i - 1] || n < 2 || u[i + n] !== 0) continue; let s = "N"; for (let j = 1; j < n && u[i + j] >= 48 && u[i + j] <= 57; j++) s += String.fromCharCode(u[i + j]); if (s.length === n) ctx.netNames.add(s); }
    }
    const order = []; // page order from each schematic folder's "Schematic" stream, else natural order
    for (const view of [...new Set(sn.pages.map(k => k.split("/")[1]))]) {
      const keys = sn.pages.filter(k => k.split("/")[1] === view); let names = [];
      try { const R = reader(files[`Views/${view}/Schematic`]()); head(R); R.str(); R.skip(4); for (let n = R.u16(); n--;) names.push(R.str()); } catch { names = []; }
      keys.sort((a, b) => ((names.indexOf(a.split("/")[3]) + 1 || 1e9) - (names.indexOf(b.split("/")[3]) + 1 || 1e9)) || a.localeCompare(b, undefined, { numeric: true }));
      order.push(...keys.map(k => ({ view, key: k, name: k.split("/")[3] })));
    }
    const docs = [], errors = [], stem = fileName.split("/").pop().replace(/\.[^.]+$/, ""), views = new Set(order.map(o => o.view)).size;
    order.forEach((o, i) => {
      const bad = [...all], st = { page: o.name, pins: 0, pinsOnSymbol: 0, fixed: 0, mismatch: 0, missing: 0 };
      try {
        const doc = sheet(page(files[o.key](), bad), ctx, i + 1, order.length, bad, st);
        doc.file = `${fileName}/${views > 1 ? o.view + "/" : ""}${o.name}`; doc.title = `${stem} · ${o.name}${doc.title ? " · " + doc.title : ""}`;
        if (lib.ver !== "3.2") bad.push(`数据库版本 ${lib.ver} 未经测试`);
        doc.unsupported = [...new Set(bad)]; docs.push(doc); stats?.push(st);
      } catch (e) { errors.push(`${o.name}：${e.message}`); }
    });
    if (!docs.length) throw new Error(`OrCAD Capture 设计（${lib.intro}，库版本 ${lib.ver}）的 ${order.length} 页原理图都无法解析：${errors[0] || "没有页面"}`);
    docs.errors = errors;
    return docs;
  }
  return { parse, sniff, _dbg: { reader, page, inst } };
})();
