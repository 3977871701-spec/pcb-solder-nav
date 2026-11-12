// Cadence Allegro binary .brd importer (database formats 16.0 – 19.0, file magic 0x0013xxxx – 0x0016xxxx).
// Block layouts and version-dependent fields follow the format notes of KiCad's Allegro importer
// (pcbnew/pcb_io/allegro, FORMAT.md); this is an independent implementation, no code copied.
globalThis.ImpAllegro = (() => {
  const G = Geom;
  // file magic (lowest byte masked) → database format, numbered like KiCad's FMT_VER so conditions read "v >= 172"
  const FORMATS = { 0x00130000: 160, 0x00130200: 161, 0x00130400: 162, 0x00130500: 162, 0x00130C00: 164, 0x00131000: 165, 0x00131500: 166,
    0x00140400: 172, 0x00140500: 172, 0x00140600: 172, 0x00140700: 172, 0x00140900: 174, 0x00140E00: 174, 0x00141500: 175, 0x00150000: 180, 0x00150200: 181, 0x00160100: 190 };
  const TESTED = new Set([166, 172, 174, 181, 190]); // formats checked against real boards; the others are parsed from the documented layouts
  const fmtName = v => `${Math.floor(v / 10)}.${v % 10}`;
  const hex = n => "0x" + (n >>> 0).toString(16).padStart(8, "0");
  const FALLBACK = "请在 Allegro 里导出 IPC-2581（File → Export → IPC 2581）再拖进来";

  // is this an Allegro database? → { ok, v, name } when readable, { ok: false, why } for Allegro versions we can't read, null otherwise
  function sniff(u8) {
    if (!u8 || u8.length < 0x400) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), magic = dv.getUint32(0, true), v = FORMATS[(magic & 0xFFFFFF00) >>> 0];
    if (v) return { ok: true, v, name: fmtName(v), magic };
    if (dv.getUint32(4, true) !== 3 || dv.getUint32(12, true) !== 3 || dv.getUint32(8, true) > 2) return null;
    const major = magic >>> 16, top = magic >>> 24;
    if (major <= 0x12 || (top >= 0x0F && top <= 0x12 && !(magic & 0x00FF0000)))
      return { ok: false, magic, why: `这是 Allegro 16.0 之前的老版本 .brd（文件标识 ${hex(magic)}），格式不同，读不了。请用 Allegro 16 以上版本打开另存，或${FALLBACK.slice(1)}` };
    return { ok: false, magic, why: `未知的 Allegro 数据库版本（文件标识 ${hex(magic)}，可能比本工具认识的 19.0 格式更新），读不了。${FALLBACK}` };
  }

  // ---------- binary reader ----------
  const utf8 = new TextDecoder("utf-8", { fatal: true }), gbk = new TextDecoder("gb18030");
  const decode = b => { try { return utf8.decode(b); } catch (e) { return gbk.decode(b); } };
  class Rd {
    constructor(u8, p = 0) { this.u8 = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.p = p; this.d8 = new DataView(new ArrayBuffer(8)); }
    b() { if (this.p >= this.u8.length) throw new RangeError("文件提前结束"); return this.u8[this.p++]; }
    h() { const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
    w() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
    i() { const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
    f() { this.d8.setUint32(0, this.w()); this.d8.setUint32(4, this.w()); return this.d8.getFloat64(0); } // double kept as two LE words, high word first
    sk(n) { if (n < 0 || this.p + n > this.u8.length) throw new RangeError("块长度越界"); this.p += n; return 0; }
    ws(n) { const a = []; for (let k = 0; k < n; k++) a.push(this.w()); return a; }
    is(n) { const a = []; for (let k = 0; k < n; k++) a.push(this.i()); return a; }
    ly() { return [this.b(), this.b()]; } // [class, subclass]
    str(n) { const s = this.p, e0 = s + n; if (e0 > this.u8.length) throw new RangeError("字符串越界"); let e = s; while (e < e0 && this.u8[e]) e++; this.p = (e0 + 3) & ~3; return decode(this.u8.subarray(s, e)); } // fixed field, padded to 4 bytes
  }

  // ---------- file header ----------
  const LISTS = ["x04", "x06", "x0C", "shapes", "x14", "nets", "x1C", "x24_28", "u1", "x2B", "x03_30", "x0A", "x1D", "u2", "x38", "x2C", "x0C_2", "u3", "x35", "x36", "u4", "u5", "x0A_2"];
  function header(r, v) {
    const H = { magic: r.w() }; r.sk(16); H.objects = r.w(); r.sk(8);
    if (v < 180) r.sk(28); else { r.sk(8); H.x27 = r.w(); r.sk(8); H.nStr = r.w(); r.sk(4 + 36); } // V18 moved the 0x27 end and string count up here
    H.ll = {}; for (const n of v >= 180 ? [...LISTS, "x03_2"] : LISTS) H.ll[n] = { tail: r.w(), head: r.w() };
    r.sk(v >= 181 ? 36 : 4);
    H.verStr = r.str(60); r.sk(8); r.sk(v < 180 ? 68 : 36);
    H.units = r.b(); r.sk(7);
    if (v < 180) { r.sk(4); H.x27 = r.w(); }
    r.sk(4); if (v < 180) H.nStr = r.w();
    r.sk(212); H.div = r.w(); r.sk(4 * (v >= 181 ? 102 : 110));
    H.layerMap = []; for (let k = 0; k < 25; k++) H.layerMap.push([r.w(), r.w()]);
    return H;
  }

  // ---------- object blocks: one reader per type, fields in file order, "v >= 172 && …" marks version-dependent fields ----------
  // A block is [type byte][3 bytes][fields…]; the type byte is consumed before these run. Fields named _x are read only to skip them.
  const font = r => [r.b(), r.b(), r.b(), r.b()]; // text properties: [font (1-based into the 0x36/0x08 table), flags, alignment 1 left / 2 right / 3 centre, reversal 0 straight / 1, 3 mirrored]
  const BLK = {
    0x01: (r, v) => ({ _a: r.sk(1), _b: r.b(), sub: r.b(), key: r.w(), next: r.w(), _c: r.sk(8), _d: v >= 172 && r.sk(4), width: r.w(), x0: r.i(), y0: r.i(), x1: r.i(), y1: r.i(), cx: r.f(), cy: r.f(), rad: r.f(), bb: r.is(4) }), // arc
    0x03: (r, v) => { // property field
      const o = { _a: r.sk(1), code: r.h(), key: r.w(), next: r.w(), _b: v >= 172 && r.sk(4), sub: r.b(), _c: r.b(), size: r.h(), _d: v >= 172 && r.sk(4) }, s = o.sub;
      if (s === 0x65) {} else if (s === 0x64 || s === 0x66 || s === 0x67 || s === 0x6A) o.val = r.w(); else if (s === 0x69) o.val = r.ws(2);
      else if ([0x68, 0x6B, 0x6D, 0x6E, 0x6F, 0x71, 0x73, 0x78].includes(s)) o.val = r.str(o.size);
      else if (s === 0x6C) { const n = r.w(); if (n > 1e6) throw new Error("0x03/6C 计数异常"); r.sk(4 * n); }
      else if (s === 0x70 || s === 0x74) { const a = r.h(), b = r.h(); r.sk(b + 4 * a); }
      else if (s === 0xF6) r.sk(80);
      else if (o.size === 4 || o.size === 8) r.sk(o.size);
      else throw new Error(`未知的 0x03 子类型 0x${s.toString(16)}`);
      return o; },
    0x04: (r, v) => ({ _a: r.sk(3), key: r.w(), next: r.w(), net: r.w(), conn: r.w(), _b: v >= 174 && r.sk(4) }), // net assignment
    0x05: (r, v) => ({ _a: r.sk(1), ly: r.ly(), key: r.w(), next: r.w(), na: r.w(), _b: r.sk(32), _c: v >= 172 && r.sk(8), seg: r.w(), _d: r.sk(8) }), // track
    0x06: (r, v) => ({ _a: r.sk(3), key: r.w(), next: r.w(), dev: r.w(), sym: r.w(), inst: r.w(), _b: r.sk(8), fields: r.w(), _c: v >= 172 && r.sk(4) }), // component (device)
    0x07: (r, v) => ({ _a: r.sk(3), key: r.w(), next: r.w(), _b: v >= 172 && r.sk(12), fpInst: r.w(), _c: v < 172 && r.sk(4), ref: r.w(), _d: r.sk(12), pad: r.w() }), // component instance
    0x08: (r, v) => ({ _a: r.sk(3), key: r.w(), _b: v >= 172 && r.sk(4), _c: v < 172 && r.sk(4), next: r.w(), _d: v >= 172 && r.sk(4), pinName: r.w(), _e: v >= 172 && r.sk(4), _f: r.sk(4) }), // pin number
    0x09: (r, v) => ({ _a: r.sk(3), key: r.w(), _b: r.sk(16), _c: v >= 172 && r.sk(4), _d: r.sk(20), _e: v >= 174 && r.sk(4) }),
    0x0A: (r, v) => ({ _a: r.sk(3), key: r.w(), next: r.w(), _b: r.sk(4), _c: v >= 172 && r.sk(4), _d: r.sk(52), _e: v >= 174 && r.sk(4) }), // DRC marker
    0x0C: (r, v) => ({ _a: r.sk(3), key: r.w(), next: r.w(), _b: r.sk(8), _c: r.sk(v < 172 ? 4 : 12), _d: r.sk(4), _e: v >= 180 && r.sk(4), _f: r.sk(28), _g: v >= 174 && v < 180 && r.sk(4) }), // pin definition
    0x0D: (r, v) => ({ _a: r.sk(3), key: r.w(), name: r.w(), next: r.w(), _b: v >= 174 && r.sk(4), x: r.i(), y: r.i(), ps: r.w(), _c: r.sk(4), _d: v >= 172 && r.sk(4), _e: r.sk(4), rot: r.w() }), // pad in footprint-local space
    0x0E: (r, v) => ({ _a: r.sk(1), ly: r.ly(), key: r.w(), next: r.w(), _b: r.sk(16), _c: v >= 172 && r.sk(8), c: r.is(4), _d: r.sk(12), rot: r.w() }), // rectangle
    0x0F: (r, v) => ({ _a: r.sk(3), key: r.w(), _b: r.sk(4), _c: v >= 174 && r.sk(4), _d: r.sk(v < 190 ? 32 : 4), next: v >= 172 ? r.w() : 0, _e: r.sk(12) }), // function slot (19.0: name moved to a string pointer)
    0x10: (r, v) => ({ _a: r.sk(3), key: r.w(), _b: v >= 172 && r.sk(4), _c: r.sk(4), _d: v >= 174 && r.sk(4), _e: r.sk(20) }), // function instance
    0x11: (r, v) => ({ _a: r.sk(3), key: r.w(), name: r.w(), next: r.w(), _b: r.sk(8), _c: v >= 174 && r.sk(4) }), // pin name
    0x12: (r, v) => ({ _a: r.sk(3), key: r.w(), _b: r.sk(16), _c: v >= 165 && r.sk(4), _d: v >= 174 && r.sk(4) }),
    0x14: (r, v) => ({ _a: r.sk(1), ly: r.ly(), key: r.w(), next: r.w(), _b: r.sk(8), _c: v >= 172 && r.sk(4), seg: r.w(), _d: r.sk(8) }), // graphics container
    0x15: (r, v) => ({ _a: r.sk(3), key: r.w(), next: r.w(), _b: r.sk(8), _c: v >= 172 && r.sk(4), width: r.w(), x0: r.i(), y0: r.i(), x1: r.i(), y1: r.i() }), // line segment (also 0x16, 0x17)
    0x1A: r => ({ _a: r.sk(3), key: r.w(), _b: r.sk(80) }),
    0x1B: (r, v) => ({ _a: r.sk(3), key: r.w(), next: r.w(), name: r.w(), _b: r.sk(4), _c: v >= 172 && r.sk(4), _d: r.sk(36) }), // net
    0x1C: (r, v) => { // padstack: header, then fixed technical-layer slots, then [antipad, thermal, pad, (keepout)] per copper layer
      const o = { _a: r.b(), n: r.b(), start: r.b(), key: r.w(), next: r.w(), name: r.w() };
      if (v < 172) Object.assign(o, { drill: r.w(), _b: r.sk(20), _c: r.b(), flags: r.b(), _d: r.sk(4), layers: (r.sk(4), r.h()), _e: r.sk(20), slotX: r.w(), slotY: r.w(), _f: r.sk(4), _g: v >= 165 && r.sk(4) });
      else Object.assign(o, { _b: r.sk(12), _c: r.b(), _d: r.b(), flags: r.b(), _e: r.sk(13), layers: r.h(), _f: r.sk(18), drill: r.w(), _g: r.sk(8), slotX: r.w(), slotY: r.w(), _h: r.sk(24 + 84), _i: v >= 180 && r.sk(32) });
      if (o.layers > 256) throw new Error("焊盘层数异常");
      o.fixed = v < 165 ? 10 : v < 172 ? 11 : 21; o.per = v < 172 ? 3 : 4;
      const n = o.fixed + o.layers * o.per; o.comps = [];
      for (let k = 0; k < n; k++) {
        const c = { t: r.b(), _a: r.sk(3), _b: v >= 172 && r.sk(4), w: r.i(), h: r.i(), z1: v >= 172 ? r.i() : 0, ox: r.i(), oy: r.i() };
        if (v >= 172) { r.sk(4); c.shape = r.w(); } else { c.shape = r.w(); if (k < n - 1) r.sk(4); } // before 17.2 the last slot has no trailing word
        o.comps.push(c);
      }
      r.sk(4 * o.n * (v < 172 ? 8 : 10)); return o; },
    0x1D: (r, v) => { r.sk(3); const o = { key: r.w(), next: r.w() }; r.sk(8); const a = r.h(), b = r.h(); r.sk(b * (v === 161 ? 48 : 56) + a * 256 + (v >= 172 ? 4 : 0)); return o; }, // constraint set
    0x1E: (r, v) => { r.sk(3); const o = { key: r.w(), next: r.w() }; if (v >= 161) r.sk(4); r.sk(4); const n = r.w(); r.str(n); if (v >= 172) r.sk(4); return o; }, // SI model
    0x1F: (r, v) => { r.sk(3); const o = { key: r.w(), next: r.w() }; r.sk(14); const n = r.h(); r.sk(v >= 175 ? n * 384 + 8 : v >= 172 ? n * 280 + 8 : v >= 162 ? n * 280 + 4 : n * 240 + 4); return o; },
    0x20: (r, v) => ({ _a: r.sk(3), key: r.w(), next: r.w(), _b: r.sk(28), _c: v >= 174 && r.sk(40) }),
    0x21: r => { r.sk(3); const size = r.w(), key = r.w(); if (size < 12) throw new Error("0x21 块长度异常"); r.sk(size - 12); return { key }; }, // sized blob
    0x22: (r, v) => ({ _a: r.sk(3), key: r.w(), _b: v >= 172 && r.sk(4), _c: r.sk(32) }),
    0x23: (r, v) => ({ _a: r.sk(3), key: r.w(), next: r.w(), _b: r.sk(56), _c: v >= 164 && r.sk(16), _d: v >= 174 && r.sk(4) }), // ratsnest line
    0x24: (r, v) => ({ _a: r.sk(1), ly: r.ly(), key: r.w(), next: r.w(), _b: r.sk(8), _c: v >= 172 && r.sk(4), c: r.is(4), _d: r.sk(12), rot: r.w() }), // rectangle
    0x26: (r, v) => ({ _a: r.sk(3), key: r.w(), _b: r.sk(4), _c: v >= 172 && r.sk(4), _d: r.sk(8), _e: v >= 174 && r.sk(4) }),
    0x27: (r, v, H) => { if (!(H.x27 - 1 > r.p)) throw new Error("0x27 块结束位置异常"); r.p = H.x27 - 1; return {}; }, // runs up to an offset stored in the header
    0x28: (r, v) => ({ _a: r.sk(1), ly: r.ly(), key: r.w(), next: r.w(), ptr1: r.w(), _b: r.sk(4), _c: v >= 172 && r.sk(8), _d: r.sk(8), voids: r.w(), seg: r.w(), _e: r.sk(8), _f: v >= 172 && r.sk(4), _g: r.sk(4), _h: v < 172 && r.sk(4), c: r.is(4) }), // polygon shape; voids = first 0x34 cut-out of a copper fill
    0x29: r => ({ _a: r.sk(3), key: r.w(), _b: r.sk(48) }),
    0x2A: (r, v) => { r.sk(1); const n = r.h(); if (v >= 174) r.sk(4); const names = []; for (let k = 0; k < n; k++) { if (v < 165) { names.push(r.str(32)); r.sk(4); } else { names.push(r.w()); r.sk(8); } } return { names, key: r.w() }; }, // layer list
    0x2B: (r, v) => ({ _a: r.sk(3), key: r.w(), name: r.w(), _b: r.sk(20), next: r.w(), inst: r.w(), _c: r.sk(12), fields: r.w(), _d: r.sk(12), _e: v >= 164 && r.sk(4), _f: v >= 172 && r.sk(4) }), // footprint definition
    0x2C: (r, v) => ({ _a: r.sk(3), key: r.w(), next: r.w(), _b: v >= 172 && r.sk(12), _c: r.sk(4), _d: v < 172 && r.sk(4), _e: r.sk(16) }),
    0x2D: (r, v) => { // placed footprint
      const o = { _a: r.b(), layer: r.b(), _b: r.b(), key: r.w(), next: r.w(), _c: v >= 172 && r.sk(4), inst16: v < 172 ? r.w() : 0, _d: r.sk(4), _e: v >= 172 && r.sk(4), _f: r.sk(4), rot: r.w(), x: r.i(), y: r.i() };
      o.inst = v >= 172 ? r.w() : o.inst16; Object.assign(o, { gfx: r.w(), pad: r.w(), text: r.w(), asm: r.w(), areas: r.w(), _g: r.sk(8) }); return o; },
    0x2E: (r, v) => ({ _a: r.sk(3), key: r.w(), next: r.w(), _b: r.sk(24), _c: v >= 172 && r.sk(4) }),
    0x2F: r => ({ _a: r.sk(3), key: r.w(), _b: r.sk(24) }),
    0x30: (r, v) => ({ _a: r.sk(1), ly: r.ly(), key: r.w(), next: r.w(), _b: v >= 172 && r.sk(8), fa: v >= 172 && font(r), _d: v >= 172 && r.sk(4), _e: v >= 174 && r.sk(4), sg: r.w(), _f: r.sk(4), fb: v < 172 && font(r), _h: v >= 172 && r.sk(4), x: r.i(), y: r.i(), _i: r.sk(4), rot: r.w(), _j: v < 172 && r.sk(4), _k: v >= 181 && r.sk(4) }), // text
    0x31: (r, v) => { r.sk(1); const o = { sl: r.h(), key: r.w() }; r.sk(4); o.x = r.i(); o.y = r.i(); r.sk(2); const n = r.h(); if (v >= 174) r.sk(4); o.s = r.str(n); return o; }, // text string
    0x32: (r, v) => ({ _a: r.sk(1), ly: r.ly(), key: r.w(), next: r.w(), net: r.w(), _b: r.sk(4), _c: v >= 172 && r.sk(4), nextInFp: r.w(), _d: r.sk(8), pad: r.w(), _e: r.sk(8), pin: r.w(), _f: r.sk(4), _g: v >= 172 && r.sk(4), _h: r.sk(8), c: r.is(4) }), // placed pad; c = its board bounding box
    0x33: (r, v) => ({ _a: r.sk(1), ly: r.ly(), key: r.w(), next: r.w(), net: r.w(), _b: r.sk(4), _c: v >= 172 && r.sk(4), _d: r.sk(4), _e: v >= 172 && r.sk(4), x: r.i(), y: r.i(), _f: r.sk(4), ps: r.w(), _g: r.sk(32) }), // via
    0x34: (r, v) => ({ _a: r.sk(1), ly: r.ly(), key: r.w(), next: r.w(), _b: r.sk(4), _c: v >= 172 && r.sk(4), _d: r.sk(4), seg: r.w(), _e: r.sk(8) }), // keepout
    0x35: r => { r.sk(3); const next = r.w(); r.sk(112); return { next, key: r.w() }; }, // log file names
    0x36: (r, v) => { // definition tables: fixed-size items, the item kind is in the header
      r.sk(1); const code = r.h(), o = { key: r.w(), next: r.w() }; if (v >= 172) r.sk(4);
      const num = r.w(), count = r.w(); r.sk(8); if (v >= 174) r.sk(4);
      if (num > 1e6 || count > num) throw new Error("0x36 计数异常");
      const size = { 0x02: 32 + 56 + (v >= 164 ? 12 : 0) + (v >= 172 ? 8 : 0), 0x03: (v >= 172 ? 64 : 32) + (v >= 174 ? 4 : 0), 0x05: 28 + (v >= 175 ? 4 : 0), 0x06: 8 + (v < 172 ? 200 : 0),
        0x08: 32 + (v >= 174 && v < 190 ? 4 : 0) + (v >= 172 ? 32 : 0), 0x0B: 1016, 0x0C: 232, 0x0D: 200, 0x0F: 20, 0x10: 108 + (v >= 180 ? 4 : 0), 0x12: 1052 }[code];
      if (size === undefined) throw new Error(`未知的 0x36 表类型 0x${code.toString(16)}`);
      if (code === 0x08) { o.fonts = []; for (let k = 0; k < num; k++) { const s = r.p; r.sk(8); const h = r.w(), w = r.w(); if (v >= 174 && v < 190) r.sk(4); const cs = r.w(); r.sk(8); o.fonts.push({ h, w, cs, sw: r.w() }); r.p = s; r.sk(size); } } // text blocks: char height, width, spacing, stroke
      else r.sk(num * size); return o; },
    0x37: (r, v) => { r.sk(3); const o = { key: r.w() }; r.sk(4); o.next = r.w(); const cap = r.w(), n = r.w(); r.sk(4); if (v >= 174) r.sk(4); if (n > cap) throw new Error("0x37 计数异常"); r.sk(4 * cap); return o; }, // pointer array
    0x38: (r, v) => ({ _a: r.sk(3), key: r.w(), next: r.w(), _b: r.sk(4), _c: r.sk(v < 166 ? 20 : 8), _d: r.sk(28), _e: v >= 174 && r.sk(4) }), // film
    0x39: r => ({ _a: r.sk(3), key: r.w(), _b: r.sk(52) }),
    0x3A: (r, v) => ({ _a: r.sk(3), key: r.w(), next: r.w(), _b: r.sk(4), _c: v >= 174 && r.sk(4) }),
    0x3B: (r, v) => { r.sk(3); const n = r.w(); r.sk(168); if (v >= 172) r.sk(4); r.str(n); return {}; }, // named property
    0x3C: (r, v) => { r.sk(3); const o = { key: r.w() }; if (v >= 174) r.sk(4); const n = r.w(); if (n > 1e6) throw new Error("0x3C 计数异常"); r.sk(4 * n); return o; },
    0x3E: r => ({ _a: r.sk(3), key: r.w(), _b: r.sk(36) }),
  };
  BLK[0x16] = BLK[0x17] = BLK[0x15];

  // whole file → { v, H, str(id), byKey, blocks }. Throws a readable error when the stream does not decode cleanly.
  function read(u8) {
    const id = sniff(u8);
    if (!id) throw new Error("不是 Cadence Allegro 的 .brd 文件");
    if (!id.ok) throw new Error(id.why);
    const v = id.v, what = `Allegro ${id.name} 格式（文件标识 ${hex(id.magic)}）`;
    let r = new Rd(u8), t = -1, at = 0;
    try {
      const H = header(r, v);
      if (!(H.div > 0) || ![1, 2, 3, 4, 5].includes(H.units)) throw new Error("文件头里的单位无法识别");
      const S = new Map(); r.p = 0x1200; // string table at a fixed offset: [u32 id][zero-terminated text, padded to 4 bytes]
      for (let k = 0; k < H.nStr; k++) { const sid = r.w(), s = r.p; let e = s; while (e < u8.length && u8[e]) e++; if (e >= u8.length) throw new RangeError("字符串表越界"); S.set(sid, decode(u8.subarray(s, e))); r.p = (e + 4) & ~3; }
      const blocks = [], byKey = new Map();
      while (r.p < u8.length) {
        at = r.p; t = u8[at];
        if (t === 0) { for (let q = at; q < u8.length; q++) if (u8[q]) throw new Error(`第 ${blocks.length} 个对象之后数据错位`); break; } // only zero padding may follow
        const f = BLK[t]; if (!f || (at & 3)) throw new Error(`遇到无法识别的对象 0x${t.toString(16)}（偏移 ${hex(at)}）`);
        r.p = at + 1; const o = f(r, v, H); o.t = t; blocks.push(o); if (o.key) byKey.set(o.key, o);
      }
      return { v, name: id.name, H, S, str: k => S.get(k) ?? "", byKey, blocks, tested: TESTED.has(v) };
    } catch (e) { throw new Error(`${what}解析失败：${e instanceof RangeError ? "数据越界（文件不完整或已损坏）" : e.message}${t >= 0 ? `（对象类型 0x${t.toString(16)}，偏移 ${hex(at)}）` : ""}。${FALLBACK}`); }
  }

  // ---------- board model ----------
  const UNIT = { 1: 0.0254, 2: 25.4, 3: 1, 4: 10, 5: 0.001 }; // mils, inch, mm, cm, µm
  function parse(u8, fileName) {
    const db = read(u8);
    let b;
    try { b = build(db, fileName); } catch (e) { throw new Error(`Allegro ${db.name} 格式的 ${fileName || ".brd"} 转换失败：${e.message}。${FALLBACK}`); }
    if (!b.parts.length) throw new Error(`Allegro ${db.name} 格式的 ${fileName || ".brd"} 里没有读到已放置的器件（可能是封装库或空板）`);
    return b;
  }
  function build(db, fileName) {
    const { v, H, str, byKey, blocks } = db;
    const sc = UNIT[H.units] / H.div, P = (x, y) => [x * sc, -y * sc]; // Allegro is y-up → flip
    const chain = (head, stop, nx = "next") => { const out = [], seen = new Set(); for (let k = head; k && k !== stop && !seen.has(k) && out.length < 1e6; ) { const b = byKey.get(k); if (!b) break; seen.add(k); out.push(b); k = b[nx]; } return out; };
    const warn = [];
    if (!db.tested) warn.push(`这个 Allegro 文件是 ${db.name} 格式，本工具只用 16.6 / 17.4 / 18.1 / 19.0 格式的板子实测过，请对照原设计核对位置和网络`);
    // net of a pad / track / via: through a 0x04 assignment, or a direct 0x1B net
    const netOf = k => { let b = byKey.get(k); if (b && b.t === 0x04) b = byKey.get(b.net); return b && b.t === 0x1B ? str(b.name) : ""; };
    // one line (0x15–0x17) or arc (0x01) segment → points in board mm, null for anything else
    function segPts(s, tol) {
      if (s.t >= 0x15 && s.t <= 0x17) return [P(s.x0, s.y0), P(s.x1, s.y1)];
      if (s.t !== 0x01) return null;
      const a = P(s.x0, s.y0), e = P(s.x1, s.y1), c = P(s.cx, s.cy), rr = Math.hypot(a[0] - c[0], a[1] - c[1]), t0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
      let sw = Math.atan2(e[1] - c[1], e[0] - c[0]) - t0;
      if (s.sub & 0x40) { if (sw <= 1e-9) sw += 2 * Math.PI; } else if (sw >= -1e-9) sw -= 2 * Math.PI; // bit 6 = sweep direction (angle grows in the y-down frame)
      if (s.x0 === s.x1 && s.y0 === s.y1) sw = 2 * Math.PI; // full circle
      const step = tol ? Math.min(Math.PI / 4, Math.max(Math.PI / 36, 2 * Math.acos(Math.max(0, 1 - tol / Math.max(rr, 1e-9))))) : Math.PI / 18; // tol = allowed chord deviation in mm (pours), else 10° steps
      const n = Math.max(tol ? 1 : 2, Math.ceil(Math.abs(sw) / step)), pts = [a];
      for (let k = 1; k <= n; k++) pts.push([c[0] + rr * Math.cos(t0 + sw * k / n), c[1] + rr * Math.sin(t0 + sw * k / n)]);
      return pts;
    }
    // a chain of segments → [[polyline points], …]; a gap starts a new run, the first block that is not a segment ends the chain
    function runs(head, tol) {
      const out = [], seen = new Set(); let cur = null, last = null;
      for (let k = head; k && !seen.has(k); ) {
        const s = byKey.get(k), pts = s && segPts(s, tol); if (!pts) break; seen.add(k);
        if (!cur || Math.hypot(pts[0][0] - last[0], pts[0][1] - last[1]) > 1e-4) out.push(cur = [pts[0]]);
        cur.push(...pts.slice(1)); last = pts[pts.length - 1]; k = s.next;
      }
      return out;
    }
    const pathOf = list => list.map(p => G.lineD(p)).join("");
    // geometry of a graphics item: 0x14 container, 0x28 shape, 0x24 / 0x0E rectangle, 0x34 keepout
    function itemRuns(b) {
      if (b.t === 0x14 || b.t === 0x28 || b.t === 0x34) return runs(b.seg);
      if (b.t === 0x24 || b.t === 0x0E) { // corners, rotated about the first one
        const [x0, y0, x1, y1] = b.c, a = (b.rot || 0) / 1000 * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
        const q = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]].map(([x, y]) => P(x0 + (x - x0) * cs - (y - y0) * sn, y0 + (x - x0) * sn + (y - y0) * cs));
        return [q];
      }
      return [];
    }
    const lay = (b, cl, ...subs) => b.ly && b.ly[0] === cl && subs.includes(b.ly[1]);

    // copper layers: ETCH class layer list from the header layer map (index = class code)
    const etchList = byKey.get((H.layerMap[6] || [])[1]);
    let nCu = etchList && etchList.t === 0x2A ? etchList.names.length : 0;
    if (!nCu) nCu = 1 + blocks.reduce((m, t) => t.t === 0x05 && t.ly[0] === 6 ? Math.max(m, t.ly[1]) : m, 0);

    // ---- board outline, board-level silkscreen ----
    const b = G.newBoard(), edgePts = [], gfx = [];
    for (const ll of ["x24_28", "shapes", "x14"]) for (const g of chain(H.ll[ll].head, H.ll[ll].tail)) gfx.push(g); // no spread: big boards list >100k items
    let edge = gfx.filter(g => lay(g, 0x01, 0xEA)); // BOARD GEOMETRY / OUTLINE
    if (!edge.length) edge = gfx.filter(g => lay(g, 0x01, 0xFD)); // … or DESIGN_OUTLINE
    const edgeRuns = edge.flatMap(itemRuns);
    b.edges = edgeRuns.map(p => G.polyD(p.length > 2 && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 1e-4 ? p.slice(0, -1) : p)).join("");
    for (const p of edgeRuns) for (const q of p) edgePts.push(q);
    const silkSide = g => lay(g, 0x01, 0xF1) || lay(g, 0x07, 0xF4) ? "F" : lay(g, 0x01, 0xF0) || lay(g, 0x07, 0xF3) ? "B" : null; // board silkscreen / autosilk
    const silk = { F: [], B: [] };
    for (const g of gfx) { const s = silkSide(g); if (s) silk[s].push(pathOf(itemRuns(g))); }
    b.silk = { F: silk.F.join(""), B: silk.B.join("") };

    // ---- tracks and vias ----
    const tr = { F: [], B: [] };
    for (const t of blocks) {
      if (t.t !== 0x05 || t.ly[0] !== 6) continue;
      const side = t.ly[1] === 0 ? "F" : t.ly[1] === nCu - 1 ? "B" : null; if (!side) continue;
      const net = netOf(t.na);
      for (const s of chain(t.seg, 0)) { const pts = segPts(s); if (!pts) break; tr[side].push([s.width * sc, G.lineD(pts), net]); }
    }
    b.tracks = { F: G.groupTracks(tr.F), B: G.groupTracks(tr.B) };

    // ---- copper pours on the outer layers: the etched fill of each shape (what Allegro plots; KiCad boards show their filled polygons too),
    // not the user-drawn BOUNDARY outline. A fill points at its net assignment; its voids (0x34 chain) are cut-outs, drawn even-odd ----
    const closeRing = p => p.length > 2 && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 1e-4 ? p.slice(0, -1) : p;
    const padSyms = new Set(); for (const o of blocks) if (o.t === 0x1C) for (const c of o.comps) if (c.shape) padSyms.add(c.shape); // custom pad outlines are ETCH shapes too
    const po = { F: [], B: [] };
    for (const s of blocks) {
      if (s.t !== 0x28 || s.ly[0] !== 6 || padSyms.has(s.key)) continue;
      const na = byKey.get(s.ptr1), side = s.ly[1] === 0 ? "F" : s.ly[1] === nCu - 1 ? "B" : null;
      if (!side || !na || na.t !== 0x04) continue; // copper kept inside footprint definitions points elsewhere
      const heads = [s.seg]; for (let k = s.voids, n = 0; k && n < 1e5; n++) { const o = byKey.get(k); if (!o || o.t !== 0x34) break; heads.push(o.seg); k = o.next; }
      const d = heads.flatMap(h => runs(h, 0.02)).map(closeRing).filter(p => p.length > 2).map(G.polyD).join("");
      if (d) po[side].push([d, netOf(s.ptr1)]);
    }
    b.pours = { F: G.groupPours(po.F), B: G.groupPours(po.B) };

    // ---- padstacks ----
    const firstCu = ps => { for (let li = 0; li < ps.layers; li++) { const c = ps.comps[ps.fixed + li * ps.per + 2]; if (c && c.t) return c; } return null; };
    const unknownShapes = new Set(), untested = {};
    // shapes drawn from the format description only (no real board with them was available to check against): name per Allegro code
    const UNTESTED = { 0x03: "八边形", 0x04: "十字形", 0x07: "菱形", 0x0A: "五边形", 0x0F: "六边形", 0x10: "六边形", 0x12: "三角形", 0x19: "环形", 0x1C: "倒角矩形", 0x1E: "正多边形" };
    // pad copper outline(s) in padstack units around the pad origin, y up; several rings fill even-odd (donut)
    function padShape(ps) {
      const c = firstCu(ps); if (!c) return null;
      const w = Math.abs(c.w), h = Math.abs(c.h), m = Math.min(w, h), x = w / 2, y = h / 2;
      const chamf = k => [[-x + k, -y], [x - k, -y], [x, -y + k], [x, y - k], [x - k, y], [-x + k, y], [-x, y - k], [-x, -y + k]];
      let rings;
      switch (c.t) {
        case 0x02: rings = [Math.abs(w - h) < 1 ? G.circ(0, 0, x) : G.rrect(w, h, m / 2, 6)]; break; // circle
        case 0x05: rings = [G.rect(w, w)]; break; // square
        case 0x06: rings = [G.rect(w, h)]; break; // rectangle
        case 0x0B: case 0x0C: rings = [G.rrect(w, h, m / 2, 6)]; break; // oblong
        case 0x1B: rings = [G.rrect(w, h, c.z1 > 0 ? c.z1 : m / 4)]; break; // rounded rectangle, z1 = corner radius
        case 0x1C: rings = [chamf(c.z1 > 0 ? Math.min(c.z1, m / 2) : m / 4)]; break; // chamfered rectangle, z1 = chamfer
        case 0x03: rings = [chamf(m * (1 - Math.SQRT1_2))]; break; // octagon
        case 0x07: rings = [[[0, -y], [x, 0], [0, y], [-x, 0]]]; break; // diamond: corners on the box edges
        case 0x04: { const a = m / 6; rings = [[[-x, -a], [-a, -a], [-a, -y], [a, -y], [a, -a], [x, -a], [x, a], [a, a], [a, y], [-a, y], [-a, a], [-x, a]]]; break; } // cross, arms a third of the smaller side
        case 0x12: rings = [[[0, y], [x, -y], [-x, -y]]]; break; // triangle, apex up
        case 0x0A: rings = [[[0, y], [x, y / 3], [x * 2 / 3, -y], [-x * 2 / 3, -y], [-x, y / 3]]]; break; // pentagon, apex up
        case 0x0F: { const k = Math.min(x, h / (2 * Math.sqrt(3))); rings = [[[-x, 0], [-x + k, y], [x - k, y], [x, 0], [x - k, -y], [-x + k, -y]]]; break; } // hexagon, corners on the x axis
        case 0x10: { const k = Math.min(y, w / (2 * Math.sqrt(3))); rings = [[[0, -y], [x, -y + k], [x, y - k], [0, y], [-x, y - k], [-x, -y + k]]]; break; } // hexagon, corners on the y axis
        case 0x19: rings = h > 0 && h < w ? [G.circ(0, 0, x, 32), G.circ(0, 0, h / 2, 32)] : [G.circ(0, 0, x, 32)]; break; // donut: outer diameter w, inner diameter h
        case 0x1E: { const n = c.z1 >= 3 && c.z1 <= 64 ? c.z1 : 8; rings = [Array.from({ length: n }, (_, k) => [x * Math.cos(Math.PI / 2 + 2 * Math.PI * k / n), y * Math.sin(Math.PI / 2 + 2 * Math.PI * k / n)])]; break; } // n-sided polygon, side count taken from z1
        case 0x16: { const sh = byKey.get(c.shape), rr = sh && sh.t === 0x28 ? runs(sh.seg).map(q => closeRing(q).map(([px, py]) => [px / sc, -py / sc])).filter(q => q.length > 2) : []; if (rr.length) { rings = rr; break; } } // shape symbol: its own outline(s)
        // falls through
        default: unknownShapes.add(c.t); rings = [G.rect(w, h)];
      }
      if (UNTESTED[c.t]) untested[UNTESTED[c.t]] = (untested[UNTESTED[c.t]] || 0) + 1;
      return rings.map(q => q.map(([px, py]) => [px + c.ox, py + c.oy]));
    }
    function drillOf(ps) { // [w, h] in padstack units, 0 when SMD
      let dw = ps.slotY > 0 ? ps.slotX : ps.drill, dh = ps.slotY > 0 ? ps.slotY : dw;
      const c = firstCu(ps); if (dw !== dh && c && (Math.abs(c.h) > Math.abs(c.w)) !== (dh > dw)) [dw, dh] = [dh, dw]; // slots are stored long side first
      return dw > 0 && ps.layers > 1 ? [dw, dh] : null;
    }

    // ---- silkscreen text, board-level and per placed footprint. Record [text, x, y, char height, rotation° counter-clockwise,
    // justification "l" | "c" | "r", mirrored 0/1, run length] in board mm; x, y = baseline point at the justification, as Allegro stores it ----
    const fonts = (chain(H.ll.x36.head, H.ll.x36.tail).find(o => o.fonts) || {}).fonts || []; // text blocks, numbered from 1
    const TXT_SILK = { 0x01: [0xF1, 0xF0], 0x02: [0xFB, 0xFA], 0x07: [0xF4, 0xF3], 0x09: [0xF7, 0xF6], 0x0D: [0xFB, 0xFA] }; // [top, bottom] silkscreen subclass of board geometry, component value, autosilk, package geometry, ref des
    const texts = { F: [], B: [] }, seenText = new Set();
    function addText(t) {
      const sl = t.t === 0x30 && TXT_SILK[t.ly[0]], side = sl ? (t.ly[1] === sl[0] ? "F" : t.ly[1] === sl[1] ? "B" : null) : null; if (!side) return;
      const g = byKey.get(t.sg), s = g && g.t === 0x31 ? g.s : "", pr = t.fa || t.fb, fd = fonts[pr[0] - 1]; if (!s.trim() || !fd) return;
      const q = P(t.x, t.y), rec = [s, G.f3(q[0]), G.f3(q[1]), G.f3(fd.h * sc), G.f3(((t.rot / 1000) % 360 + 360) % 360), pr[2] === 2 ? "r" : pr[2] === 3 ? "c" : "l", pr[3] & 1, G.f3((s.length * fd.w + (s.length - 1) * fd.cs) * sc)];
      const k = side + rec.join("\u0001"); if (!seenText.has(k)) { seenText.add(k); texts[side].push(rec); } // the same text on two silkscreen subclasses (autosilk copies) once
    }
    // footprint definitions keep template texts ("REF", "U*") in their field chain; every other silkscreen text is on the board
    // (in the header text list, a placed footprint's text chain, or hung on a placed pad)
    const tmpl = new Set();
    for (const o of blocks) if (o.t === 0x2B) for (let k = o.fields, n = 0; k && k !== o.key && n < 1e5; n++) { const f = byKey.get(k); if (!f || (f.t !== 0x03 && f.t !== 0x30)) break; tmpl.add(k); k = f.next; }
    for (const t of blocks) if (t.t === 0x30 && !tmpl.has(t.key)) addText(t);

    // ---- footprints ----
    const devOf = {}; // 0x07 instance → its 0x06 component (device type, value)
    for (const c of chain(H.ll.x06.head, H.ll.x06.tail)) {
      const fields = chain(c.fields, 0).filter(f => f.t === 0x03);
      const val = (fields.find(f => f.code === 0x02 && typeof f.val === "string") || {}).val || "";
      for (const i of chain(c.inst, c.key)) if (i.t === 0x07) devOf[i.key] = { dev: str(c.dev), val };
    }
    let noRef = 0;
    for (const def of chain(H.ll.x2B.head, H.ll.x2B.tail)) {
      const fp = str(def.name);
      for (const inst of chain(def.inst, def.key)) {
        if (inst.t !== 0x2D) continue;
        const ci = byKey.get(inst.inst), ref = ci && ci.t === 0x07 ? str(ci.ref) : "", dv = ci ? devOf[ci.key] || {} : {};
        const side = inst.layer ? "B" : "F", a = inst.rot / 1000, ar = a * Math.PI / 180, cs = Math.cos(ar), sn = Math.sin(ar), mx = inst.layer ? -1 : 1;
        // footprint-local (y up) → board: mirror for the bottom side, rotate counter-clockwise, then place
        const T = (x, y) => { x *= mx; return P(inst.x + x * cs - y * sn, inst.y + x * sn + y * cs); };
        const recs = [];
        for (const pp of chain(inst.pad, inst.key, "nextInFp")) {
          const pd = byKey.get(pp.pad), ps = pd && byKey.get(pd.ps); if (!pd || pd.t !== 0x0D || !ps || ps.t !== 0x1C) continue;
          const pa = pd.rot / 1000 * Math.PI / 180, pc = Math.cos(pa), pn = Math.sin(pa);
          const toB = ([x, y]) => T(pd.x + x * pc - y * pn, pd.y + x * pn + y * pc);
          const dr = drillOf(ps), shape = padShape(ps);
          if (!shape && !dr) continue; // no copper and no hole
          const kind = dr ? (ps.flags & (v < 172 ? 0x01 : 0x20) ? 1 : 2) : 0; // plated flag moved in 17.2
          const hole = dr ? (dr[0] === dr[1] ? G.circ(0, 0, dr[0] / 2, 20) : G.rrect(dr[0], dr[1], Math.min(...dr) / 2, 6)).map(toB) : null;
          const polys = shape ? shape.map(q => q.map(toB)) : [hole];
          recs.push(G.padRec(str(pd.name), kind === 2 ? "" : netOf(pp.net), polys, kind, hole && shape && shape.length < 2 ? G.polyD(hole.slice().reverse()) : "")); // a donut's inner ring is its hole
        }
        if (!recs.length && !ref) continue; // logos, dimensions, drawing symbols
        // outline graphics are stored on the board already placed
        const own = [...chain(inst.gfx, inst.key), ...chain(inst.areas, inst.key), ...chain(inst.asm, inst.key)];
        const pick = (...subs) => own.filter(g => lay(g, 0x09, ...subs)).flatMap(itemRuns);
        const silkRuns = pick(side === "F" ? 0xF7 : 0xF6), body = pick(side === "F" ? 0xFD : 0xFC), place = pick(side === "F" ? 0xFB : 0xFA);
        let bb = G.bboxOf(place.length ? place.flat() : recs.flatMap(q => [[q[7][0], q[7][1]], [q[7][2], q[7][3]]]).concat(body.flat()));
        const c0 = P(inst.x, inst.y);
        if (!G.validBB(bb)) bb = [c0[0] - .5, c0[1] - .5, c0[0] + .5, c0[1] + .5];
        const p1 = recs.find(q => q[0] === "1") || recs.find(q => q[0] === "A1");
        b.parts.push({ r: ref || `${fp || "MECH"}-${++noRef}`, s: side, c: c0.map(G.f3), rot: ((a % 360) + 360) % 360, bb: bb.map(G.f3), pads: recs, body: pathOf(body), silk: pathOf(silkRuns),
          val: dv.val || "", fp, props: dv.dev ? { Device: dv.dev } : {}, sheet: "", p1: p1 ? [p1[4], p1[5]] : null, tht: recs.length && recs.every(q => q[3] !== 0) ? 1 : 0, dnp: 0, nobom: ref ? 0 : 1 });
      }
    }
    for (const t of blocks) {
      if (t.t !== 0x33) continue;
      const ps = byKey.get(t.ps), c = ps && ps.t === 0x1C && firstCu(ps), q = P(t.x, t.y);
      b.vias.push([G.f3(q[0]), G.f3(q[1]), G.f3(c ? Math.max(Math.abs(c.w), Math.abs(c.h)) * sc / 2 : 0.15), netOf(t.net)]);
    }
    if (unknownShapes.size) warn.push(`有 ${unknownShapes.size} 种焊盘形状（Allegro 代码 ${[...unknownShapes].map(t => "0x" + t.toString(16)).join("、")}）按矩形画出，尺寸是外框`);
    const ut = Object.entries(untested); if (ut.length) warn.push(`${ut.map(([k, n]) => `${n} 个${k}焊盘`).join("、")}是按格式说明画的，这种形状还没有用真实板子核对过，请对照原设计`);
    b.texts = texts; b.warn = warn; b.file = fileName;
    return G.finishBoard(b, edgePts);
  }
  return { parse, read, sniff };
})();
