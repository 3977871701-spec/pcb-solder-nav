// RAR 5 reader (the default format since WinRAR 5): stored and compressed files, all four filters, solid archives, CRC32 check.
// Decoder follows the public UnRAR algorithm (unpack50.cpp). RAR 4, encrypted and multi-volume archives are reported, not read.
globalThis.Rar = (() => {
  const SIG4 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00], SIG5 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
  const has = (u8, sig) => sig.every((b, i) => u8[i] === b);
  const isRar = u8 => has(u8, SIG4) || has(u8, SIG5);
  const bad = (why = "RAR 数据损坏") => { throw new Error(why); };
  let CRC = null;
  function crc32(u8) {
    if (!CRC) { CRC = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; } }
    let c = -1; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  // ---------- LZ decoder ----------
  const NC = 306, DC = 64, DCX = 80, LDC = 16, RC = 44, BC = 20;
  // canonical Huffman decode table (UnRAR MakeDecodeTables, without the quick lookup)
  function huff(lens, off, n) {
    const cnt = new Uint32Array(16), len = new Uint32Array(16), pos = new Uint32Array(16), num = new Uint16Array(n);
    for (let i = 0; i < n; i++) cnt[lens[off + i] & 15]++;
    cnt[0] = 0;
    for (let i = 1, up = 0; i < 16; i++) { up += cnt[i]; len[i] = up << (16 - i); up *= 2; pos[i] = pos[i - 1] + cnt[i - 1]; }
    const cp = pos.slice();
    for (let i = 0; i < n; i++) { const l = lens[off + i] & 15; if (l) num[cp[l]++] = i; }
    return { len, pos, num, n };
  }
  function applyFilter(d, at, f) {
    const n = Math.min(f.len, d.length - at); if (at < 0 || n <= 0) return;
    if (f.type === 1 || f.type === 2) { // x86 CALL / JMP: absolute → relative addresses; "at" = bytes of this file before the block
      const cmp2 = f.type === 2 ? 0xe9 : 0xe8, FS = 0x1000000;
      for (let cur = 0; cur + 4 < n;) {
        const b = d[at + cur++];
        if (b !== 0xe8 && b !== cmp2) continue;
        const q = at + cur, off = (at + cur) % FS, addr = (d[q] | d[q + 1] << 8 | d[q + 2] << 16 | d[q + 3] << 24) >>> 0;
        let v = null;
        if (addr & 0x80000000) { if (((addr + off) & 0x80000000) === 0) v = addr + FS; }
        else if (((addr - FS) & 0x80000000) !== 0) v = addr - off;
        if (v !== null) { d[q] = v; d[q + 1] = v >>> 8; d[q + 2] = v >>> 16; d[q + 3] = v >>> 24; }
        cur += 4;
      }
    } else if (f.type === 3) { // ARM BL
      for (let cur = 0; cur + 3 < n; cur += 4) {
        const q = at + cur; if (d[q + 3] !== 0xeb) continue;
        const o = d[q] + d[q + 1] * 0x100 + d[q + 2] * 0x10000 - Math.floor((at + cur) / 4);
        d[q] = o; d[q + 1] = o >>> 8; d[q + 2] = o >>> 16;
      }
    } else if (f.type === 0) { // delta: channels were stored one after another
      const src = d.slice(at, at + n); let sp = 0;
      for (let c = 0; c < f.ch; c++) { let prev = 0; for (let dp = c; dp < n; dp += f.ch) d[at + dp] = prev = (prev - src[sp++]) & 255; }
    }
  }
  // one decoder per archive: in solid archives the window, tables and distance history carry over to the next file
  function decoder() {
    let win = new Uint8Array(1 << 20), wp = 0, old = [0, 0, 0, 0], lastLen = 0, tabs = null;
    const room = n => { if (wp + n <= win.length) return; const w = new Uint8Array(Math.max(win.length * 2, wp + n)); w.set(win.subarray(0, wp)); win = w; };
    return function unpack(src, size, ver, solid) {
      if (!solid) { wp = 0; old = [0, 0, 0, 0]; lastLen = 0; tabs = null; }
      if (!src.length) { if (size > 0) bad(); return new Uint8Array(0); } // empty file in a solid archive: no stream, state carries on
      const inp = new Uint8Array(src.length + 16); inp.set(src);
      let ia = 0, ib = 0;
      const gb = () => (((inp[ia] << 16) | (inp[ia + 1] << 8) | inp[ia + 2]) >>> (8 - ib)) & 0xffff;
      const gb32 = () => ((((inp[ia] << 24) | (inp[ia + 1] << 16) | (inp[ia + 2] << 8) | inp[ia + 3]) << ib) | (inp[ia + 4] >>> (8 - ib))) >>> 0;
      const add = n => { n += ib; ia += n >> 3; ib = n & 7; };
      const dec = t => {
        const bf = gb() & 0xfffe; let bits = 15;
        for (let i = 1; i < 15; i++) if (bf < t.len[i]) { bits = i; break; }
        add(bits);
        const p = t.pos[bits] + ((bf - t.len[bits - 1]) >>> (16 - bits));
        return t.num[p < t.n ? p : 0];
      };
      const dc = ver === 1 ? DCX : DC;
      const readTables = () => {
        const bl = new Uint8Array(BC);
        for (let i = 0; i < BC; i++) {
          const l = gb() >>> 12; add(4);
          if (l !== 15) { bl[i] = l; continue; }
          let z = gb() >>> 12; add(4);
          if (!z) bl[i] = 15; else { z += 2; while (z-- > 0 && i < BC) bl[i++] = 0; i--; }
        }
        const bt = huff(bl, 0, BC), n = NC + dc + LDC + RC, t = new Uint8Array(n);
        for (let i = 0; i < n;) {
          const x = dec(bt);
          if (x < 16) { t[i++] = x; continue; }
          let k; if (x === 16 || x === 18) { k = (gb() >>> 13) + 3; add(3); } else { k = (gb() >>> 9) + 11; add(7); }
          if (x < 18) { if (!i) bad(); while (k-- > 0 && i < n) { t[i] = t[i - 1]; i++; } }
          else while (k-- > 0 && i < n) t[i++] = 0;
        }
        tabs = { ld: huff(t, 0, NC), dd: huff(t, NC, dc), ldd: huff(t, NC + dc, LDC), rd: huff(t, NC + dc + LDC, RC) };
      };
      let bStart = 0, bSize = 0, bBits = 0, last = false;
      const blockHeader = () => {
        add((8 - ib) & 7);
        const fl = gb() >>> 8; add(8);
        const nb = ((fl >> 3) & 3) + 1; if (nb === 4) bad();
        const sum = gb() >>> 8; add(8);
        let sz = 0; for (let i = 0; i < nb; i++) { sz += (gb() >>> 8) << (i * 8); add(8); }
        if (((0x5a ^ fl ^ sz ^ (sz >>> 8) ^ (sz >>> 16)) & 0xff) !== sum) bad();
        bStart = ia; bSize = sz; bBits = (fl & 7) + 1; last = !!(fl & 0x40);
        if (fl & 0x80) readTables(); else if (!tabs) bad();
      };
      const slotLen = s => { if (s < 8) return 2 + s; const lb = (s >> 2) - 1, l = 2 + ((4 | (s & 3)) << lb) + (gb() >>> (16 - lb)); add(lb); return l; };
      const copy = (len, dist) => { room(len); for (let k = 0; k < len; k++, wp++) win[wp] = wp >= dist ? win[wp - dist] : 0; };
      const fdata = () => { const nb = (gb() >>> 14) + 1; add(2); let v = 0; for (let i = 0; i < nb; i++) { v += (gb() >>> 8) * 2 ** (8 * i); add(8); } return v; };
      const start = wp, filters = [];
      blockHeader();
      for (;;) {
        // past the end of the current block: read the next one, or stop after the last
        let done = false;
        while (ia > bStart + bSize - 1 || (ia === bStart + bSize - 1 && ib >= bBits)) { if (last) { done = true; break; } blockHeader(); }
        if (done) break;
        if (ia > src.length + 4) bad();
        const m = dec(tabs.ld);
        if (m < 256) { room(1); win[wp++] = m; continue; }
        if (m >= 262) {
          let len = slotLen(m - 262), dist = 1, db = 0;
          const ds = dec(tabs.dd);
          if (ds < 4) dist += ds; else { db = (ds >> 1) - 1; dist += (2 | (ds & 1)) * 2 ** db; }
          if (db >= 4) { if (db > 4) { if (db > 36) bad(); dist += (gb32() >>> (36 - db)) * 16; add(db - 4); } dist += dec(tabs.ldd); }
          else if (db > 0) { dist += gb() >>> (16 - db); add(db); }
          if (dist > 0x100) { len++; if (dist > 0x2000) { len++; if (dist > 0x40000) len++; } }
          old[3] = old[2]; old[2] = old[1]; old[1] = old[0]; old[0] = dist;
          lastLen = len; copy(len, dist); continue;
        }
        if (m === 256) { // filter record: applies to output that may not be decoded yet
          const at = wp + fdata(); let len = fdata(); if (len > 0x400000) len = 0;
          const type = gb() >>> 13; add(3);
          let ch = 0; if (type === 0) { ch = (gb() >>> 11) + 1; add(5); }
          filters.push({ at, len, type, ch }); continue;
        }
        if (m === 257) { if (lastLen) copy(lastLen, old[0]); continue; }
        const k = m - 258, dist = old[k];
        for (let i = k; i > 0; i--) old[i] = old[i - 1];
        old[0] = dist;
        const len = slotLen(dec(tabs.rd)); lastLen = len; copy(len, dist);
      }
      if (size >= 0 && wp - start !== size) bad();
      const out = win.slice(start, wp);
      for (const f of filters) applyFilter(out, f.at - start, f);
      return out;
    };
  }

  // ---------- archive headers ----------
  // returns [{name, size, read: async () => Uint8Array}] like Files.unzip
  function list(u8) {
    if (has(u8, SIG4)) bad("这是老版本 RAR（RAR4）格式，浏览器里解不了：请用 WinRAR 5 以上重新压缩，或改成 zip");
    if (!has(u8, SIG5)) bad("不是 RAR 文件");
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), files = [];
    let p = 8;
    const vint = () => { let v = 0, m = 1, b; do { if (p >= u8.length) bad("RAR 文件不完整"); b = u8[p++]; v += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return v; };
    while (p + 7 < u8.length) {
      p += 4; // header CRC
      const hsize = vint(), hstart = p, type = vint(), flags = vint();
      const extra = flags & 1 ? vint() : 0, dsize = flags & 2 ? vint() : 0, hend = hstart + hsize;
      if (flags & 0x18) bad("这是分卷压缩包（.part1.rar 等），请合成一个文件或改成 zip");
      if (type === 1 && vint() & 1) bad("这是分卷压缩包（.part1.rar 等），请合成一个文件或改成 zip");
      if (type === 4) bad("压缩包设了密码，浏览器里解不了");
      if (type === 5) break;
      if (type === 2) {
        const ff = vint(), size = vint(); vint();
        if (ff & 2) p += 4;
        const crc = ff & 4 ? dv.getUint32(p, true) : null; if (ff & 4) p += 4;
        const ci = vint(); vint();
        const nl = vint(), name = new TextDecoder().decode(u8.subarray(p, p + nl));
        let enc = false;
        for (let q = hend - extra; q < hend;) { p = q; const rs = vint(), r0 = p; if (vint() === 1) enc = true; q = r0 + rs; }
        if (!(ff & 1)) files.push({ name: name.replace(/\\/g, "/"), size: ff & 8 ? -1 : size, crc, ver: ci & 0x3f, solid: !!(ci & 0x40), method: (ci >> 7) & 7, enc, data: u8.subarray(hend, hend + dsize) });
      }
      p = hend + dsize;
    }
    // compressed files decode in archive order; a solid file needs every compressed file before it back to the last non-solid one
    const unpack = decoder(); let at = -1;
    const lz = files.map((f, i) => f.method ? i : -1).filter(i => i >= 0);
    function get(i) {
      const f = files[i];
      if (f.enc) bad("压缩包里的文件设了密码，浏览器里解不了");
      if (f.ver > 1) bad("这个 RAR 用了更新的压缩算法，请改成 zip");
      let out;
      if (!f.method) out = f.data.slice();
      else {
        let k = lz.indexOf(i), s = k;
        while (s > 0 && files[lz[s]].solid) s--;
        let from = at >= 0 && lz.indexOf(at) >= s && lz.indexOf(at) < k ? lz.indexOf(at) + 1 : s;
        for (let j = from; j <= k; j++) { const g = files[lz[j]]; out = unpack(g.data, g.size, g.ver, j > s && g.solid); at = lz[j]; }
      }
      if (f.crc != null && crc32(out) !== f.crc) bad("RAR 解压校验失败（CRC 不符），文件可能损坏");
      return out;
    }
    return files.map((f, i) => ({ name: f.name, size: f.size, read: async () => get(i) }));
  }
  return { isRar, list, crc32 };
})();
