// File plumbing with no external libraries: text decoding, zip / gzip / tar / unix-compress (.Z), XML, CSV, XLSX.
globalThis.Files = (() => {
  // ---------- text ----------
  function decodeText(u8) {
    if (typeof u8 === "string") return u8;
    if (u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) return new TextDecoder("utf-8").decode(u8.subarray(3));
    if (u8[0] === 0xFF && u8[1] === 0xFE) return new TextDecoder("utf-16le").decode(u8.subarray(2));
    if (u8[0] === 0xFE && u8[1] === 0xFF) return new TextDecoder("utf-16be").decode(u8.subarray(2));
    // UTF-16 without BOM: every other byte is zero in ASCII-heavy text
    if (u8.length > 8 && u8[1] === 0 && u8[3] === 0 && u8[0] !== 0) return new TextDecoder("utf-16le").decode(u8);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(u8); }
    catch (e) { try { return new TextDecoder("gb18030").decode(u8); } catch (e2) { return new TextDecoder("latin1").decode(u8); } }
  }
  const startsWith = (u8, sig) => sig.every((b, i) => u8[i] === b);

  // ---------- compression ----------
  async function pipe(u8, fmt) {
    const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream(fmt));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  // pure-JS raw inflate (RFC 1951) for browsers without DecompressionStream / "deflate-raw" (Safari before iPadOS / iOS 16.4)
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CLORD = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  // canonical Huffman table: code counts per length + symbols in code order
  function huff(lens) {
    const count = new Uint16Array(16), offs = new Uint16Array(16), sym = new Uint16Array(lens.length);
    for (const l of lens) count[l]++;
    count[0] = 0;
    for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    for (let s = 0; s < lens.length; s++) if (lens[s]) sym[offs[lens[s]]++] = s;
    return { count, sym };
  }
  let FIXED = null;
  function inflateJS(src) {
    let pos = 0, bb = 0, bc = 0, op = 0, out = new Uint8Array(Math.max(1024, src.length * 4));
    const bad = () => { throw new Error("压缩数据损坏"); };
    const bits = n => { while (bc < n) { if (pos >= src.length) bad(); bb |= src[pos++] << bc; bc += 8; } const v = bb & ((1 << n) - 1); bb >>>= n; bc -= n; return v; };
    const room = n => { if (op + n <= out.length) return; const o = new Uint8Array(Math.max(out.length * 2, op + n)); o.set(out); out = o; };
    const decode = h => { let code = 0, first = 0, index = 0; for (let len = 1; len < 16; len++) { code |= bits(1); const c = h.count[len]; if (code - first < c) return h.sym[index + code - first]; index += c; first = (first + c) << 1; code <<= 1; } return bad(); };
    let last;
    do {
      last = bits(1); const type = bits(2);
      if (type === 0) { // stored: skip to the byte boundary (leftover bits are always from the current byte)
        bb = bc = 0; if (pos + 4 > src.length) bad();
        const len = src[pos] | (src[pos + 1] << 8); pos += 4; if (pos + len > src.length) bad();
        room(len); out.set(src.subarray(pos, pos + len), op); op += len; pos += len; continue;
      }
      let lit, dist;
      if (type === 1) {
        if (!FIXED) { const l = new Uint8Array(288).fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280); FIXED = [huff(l), huff(new Uint8Array(30).fill(5))]; }
        [lit, dist] = FIXED;
      } else if (type === 2) {
        const nl = bits(5) + 257, nd = bits(5) + 1, nc = bits(4) + 4, cl = new Uint8Array(19);
        for (let i = 0; i < nc; i++) cl[CLORD[i]] = bits(3);
        const ch = huff(cl), lens = new Uint8Array(nl + nd);
        for (let i = 0; i < nl + nd;) {
          const s = decode(ch);
          if (s < 16) { lens[i++] = s; continue; }
          let v = 0, rep;
          if (s === 16) { if (!i) bad(); v = lens[i - 1]; rep = 3 + bits(2); } else rep = s === 17 ? 3 + bits(3) : 11 + bits(7);
          if (i + rep > nl + nd) bad();
          while (rep--) lens[i++] = v;
        }
        lit = huff(lens.subarray(0, nl)); dist = huff(lens.subarray(nl));
      } else bad();
      for (;;) {
        let s = decode(lit);
        if (s < 256) { room(1); out[op++] = s; continue; }
        if (s === 256) break;
        s -= 257; if (s >= 29) bad();
        const len = LBASE[s] + bits(LEXT[s]), ds = decode(dist); if (ds >= 30) bad();
        const d = DBASE[ds] + bits(DEXT[ds]); if (d > op) bad();
        room(len); for (let k = 0; k < len; k++, op++) out[op] = out[op - d];
      }
    } while (!last);
    return out.slice(0, op);
  }
  // gzip member → its raw deflate body
  function gzBody(u8) {
    if (u8[0] !== 0x1f || u8[1] !== 0x8b || u8[2] !== 8) throw new Error("不是 gzip 数据");
    const fl = u8[3]; let p = 10;
    if (fl & 4) p += 2 + (u8[p] | (u8[p + 1] << 8));
    if (fl & 8) { while (u8[p]) p++; p++; }
    if (fl & 16) { while (u8[p]) p++; p++; }
    if (fl & 2) p += 2;
    return u8.subarray(p);
  }
  const hasDS = typeof DecompressionStream === "function";
  const inflateRaw = async u8 => { if (hasDS) try { return await pipe(u8, "deflate-raw"); } catch (e) { /* format not supported here: fall through */ } return inflateJS(u8); };
  const gunzip = async u8 => { if (hasDS) try { return await pipe(u8, "gzip"); } catch (e) { /* fall through */ } return inflateJS(gzBody(u8)); };

  // zip: returns [{name, size, read: async () => Uint8Array}]
  function unzip(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("zip 文件损坏或不是 zip");
    let count = dv.getUint16(eocd + 10, true), cd = dv.getUint32(eocd + 16, true);
    if (cd === 0xFFFFFFFF || count === 0xFFFF) { // zip64
      const loc = eocd - 20;
      if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) { const z64 = Number(dv.getBigUint64(loc + 8, true)); count = Number(dv.getBigUint64(z64 + 32, true)); cd = Number(dv.getBigUint64(z64 + 48, true)); }
    }
    const out = [];
    for (let k = 0, p = cd; k < count && dv.getUint32(p, true) === 0x02014b50; k++) {
      const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
      let csize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      let lho = dv.getUint32(p + 42, true);
      const nameBytes = u8.subarray(p + 46, p + 46 + nl);
      if (csize === 0xFFFFFFFF || size === 0xFFFFFFFF || lho === 0xFFFFFFFF) { // zip64 extra
        let e = p + 46 + nl; const end = e + xl;
        while (e < end) { const id = dv.getUint16(e, true), len = dv.getUint16(e + 2, true); if (id === 1) { let q = e + 4; if (size === 0xFFFFFFFF) { size = Number(dv.getBigUint64(q, true)); q += 8; } if (csize === 0xFFFFFFFF) { csize = Number(dv.getBigUint64(q, true)); q += 8; } if (lho === 0xFFFFFFFF) lho = Number(dv.getBigUint64(q, true)); } e += 4 + len; }
      }
      const name = (flags & 0x800) ? new TextDecoder().decode(nameBytes) : decodeText(nameBytes);
      p += 46 + nl + xl + cl;
      if (name.endsWith("/")) continue;
      const lnl = dv.getUint16(lho + 26, true), lxl = dv.getUint16(lho + 28, true), start = lho + 30 + lnl + lxl;
      const data = u8.subarray(start, start + csize);
      out.push({ name: name.replace(/\\/g, "/"), size, read: async () => method === 0 ? data : method === 8 ? inflateRaw(data) : Promise.reject(new Error("不支持的压缩方式 " + method)) });
    }
    return out;
  }
  // tar: returns [{name, size, read}]
  function untar(u8) {
    const out = []; let p = 0, longName = null, paxPath = null;
    const str = (a, b) => { let s = ""; for (let i = a; i < b && u8[i]; i++) s += String.fromCharCode(u8[i]); return s; };
    while (p + 512 <= u8.length) {
      if (u8[p] === 0) break;
      const name = str(p, p + 100), size = parseInt(str(p + 124, p + 136).trim() || "0", 8), type = String.fromCharCode(u8[p + 156] || 48);
      const prefix = str(p + 257, p + 263) === "ustar" ? str(p + 345, p + 500) : "";
      const body = u8.subarray(p + 512, p + 512 + size);
      if (type === "L") longName = new TextDecoder().decode(body).replace(/\0.*$/, "");
      else if (type === "x") { const m = new TextDecoder().decode(body).match(/\d+ path=([^\n]*)\n/); paxPath = m ? m[1] : null; }
      else if (type === "0" || type === "\0" || type === "7") {
        const full = paxPath || longName || (prefix ? prefix + "/" + name : name);
        out.push({ name: full, size, read: async () => body });
        longName = paxPath = null;
      } else { longName = paxPath = null; }
      p += 512 + Math.ceil(size / 512) * 512;
    }
    return out;
  }
  // unix compress (.Z, LZW) — ODB++ exporters often compress feature files this way
  function unZ(src) {
    if (src[0] !== 0x1f || src[1] !== 0x9d) throw new Error("not .Z");
    const maxbits = src[2] & 0x1f, block = (src[2] & 0x80) !== 0, maxmax = 1 << maxbits;
    const prefix = new Uint32Array(maxmax), suffix = new Uint8Array(maxmax), stack = new Uint8Array(maxmax);
    for (let i = 0; i < 256; i++) suffix[i] = i;
    const data = src.subarray(3), totalBits = data.length * 8, out = [];
    let nbits = 9, maxcode = (1 << nbits) - 1, mask = maxcode, free = block ? 257 : 256, pos = 0, origin = 0, oldcode = -1, finchar = 0;
    const align = () => { const g = nbits * 8; pos = origin + Math.ceil((pos - origin) / g) * g; origin = pos; };
    while (pos + nbits <= totalBits) {
      if (free > maxcode) { align(); nbits++; maxcode = nbits === maxbits ? maxmax : (1 << nbits) - 1; mask = (1 << nbits) - 1; if (pos + nbits > totalBits) break; }
      const byte = pos >> 3;
      let code = ((data[byte] | (data[byte + 1] << 8) | (data[byte + 2] << 16)) >> (pos & 7)) & mask; pos += nbits;
      if (oldcode === -1) { if (code >= 256) break; out.push(code); finchar = oldcode = code; continue; }
      if (code === 256 && block) { free = 257; align(); nbits = 9; maxcode = mask = (1 << nbits) - 1; oldcode = -1; continue; }
      const incode = code; let sp = maxmax;
      if (code >= free) { stack[--sp] = finchar; code = oldcode; }
      while (code >= 256) { stack[--sp] = suffix[code]; code = prefix[code]; }
      stack[--sp] = finchar = suffix[code];
      for (let i = sp; i < maxmax; i++) out.push(stack[i]);
      if (free < maxmax) { prefix[free] = oldcode; suffix[free] = finchar; free++; }
      oldcode = incode;
    }
    return Uint8Array.from(out);
  }

  // ---------- XML (attributes + text; enough for IPC-2581 and XLSX) ----------
  const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  const unesc = s => s.indexOf("&") < 0 ? s : s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? m));
  function xml(src) {
    const root = { n: "#root", a: {}, c: [], t: "" }, stack = [root];
    const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    const attrRe = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(src))) {
      const top = stack[stack.length - 1];
      if (m[1] !== undefined) top.t += m[1];
      else if (m[2]) { if (stack.length > 1) stack.pop(); }
      else if (m[3]) {
        const name = m[3].includes(":") ? m[3].split(":").pop() : m[3];
        const node = { n: name, a: {}, c: [], t: "" };
        if (m[4]) { let a; attrRe.lastIndex = 0; while ((a = attrRe.exec(m[4]))) { const k = a[1].includes(":") && !a[1].startsWith("xmlns") ? a[1].split(":").pop() : a[1]; node.a[k] = unesc(a[3] ?? a[4]); } }
        top.c.push(node);
        if (!m[5]) stack.push(node);
      } else if (m[6] !== undefined && stack.length > 1 && /\S/.test(m[6])) top.t += unesc(m[6]);
    }
    return root;
  }
  const X = {
    kid: (n, name) => n && n.c.find(x => x.n === name),
    kids: (n, name) => n ? n.c.filter(x => x.n === name) : [],
    find(n, name) { if (!n) return null; for (const c of n.c) { if (c.n === name) return c; const f = X.find(c, name); if (f) return f; } return null; },
    findAll(n, name, out = []) { if (!n) return out; for (const c of n.c) { if (c.n === name) out.push(c); X.findAll(c, name, out); } return out; },
    text(n) { return n ? n.t + n.c.map(X.text).join("") : ""; },
  };

  // ---------- CSV ----------
  function csv(text) {
    text = text.replace(/^﻿/, "");
    const first = text.slice(0, 2000).split(/\r?\n/).find(l => l.trim()) || "";
    const cnt = ch => (first.match(new RegExp("\\" + ch, "g")) || []).length;
    const delim = [",", "\t", ";"].sort((a, b) => cnt(b) - cnt(a))[0];
    const rows = []; let row = [], f = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"' && f.trim() === "") { q = true; f = ""; }
      else if (c === delim) { row.push(f); f = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
      else f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    return rows.map(r => r.map(x => x.trim())).filter(r => r.some(x => x));
  }
  // ---------- XLSX → rows of first sheet ----------
  async function xlsx(u8) {
    const entries = unzip(u8), get = async n => { const e = entries.find(x => x.name.toLowerCase() === n.toLowerCase()); return e ? decodeText(await e.read()) : null; };
    const ss = [];
    const sst = await get("xl/sharedStrings.xml");
    if (sst) for (const si of X.findAll(xml(sst), "si")) ss.push(X.findAll(si, "t").map(t => t.t).join(""));
    let sheetPath = "xl/worksheets/sheet1.xml";
    const wb = await get("xl/workbook.xml"), rels = await get("xl/_rels/workbook.xml.rels");
    if (wb && rels) { const s1 = X.find(xml(wb), "sheet"); const rid = s1 && (s1.a.id || s1.a["r:id"]); const rel = rid && X.findAll(xml(rels), "Relationship").find(r => r.a.Id === rid); if (rel) sheetPath = "xl/" + rel.a.Target.replace(/^\/?xl\//, "").replace(/^\//, ""); }
    const sh = await get(sheetPath); if (!sh) return [];
    const colIdx = r => { let n = 0; for (const ch of r.replace(/\d+/g, "")) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
    const rows = [];
    for (const r of X.findAll(xml(sh), "row")) {
      const row = [];
      for (const c of X.kids(r, "c")) {
        const t = c.a.t, v = X.kid(c, "v"), is = X.kid(c, "is");
        let val = t === "s" ? ss[+((v && v.t) || 0)] ?? "" : t === "inlineStr" ? X.findAll(is, "t").map(x => x.t).join("") : (v ? v.t : "");
        row[c.a.r ? colIdx(c.a.r) : row.length] = String(val ?? "").trim();
      }
      for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = "";
      if (row.some(x => x)) rows.push(row);
    }
    return rows;
  }
  return { decodeText, startsWith, inflateRaw, inflateJS, gunzip, unzip, untar, unZ, xml, X, csv, xlsx, unesc };
})();
