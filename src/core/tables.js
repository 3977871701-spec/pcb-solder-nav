// Tabular inputs: BOM, pick-and-place (CPL / 坐标文件), IPC-D-356 netlist, JLC flying-probe JSON.
globalThis.Tables = (() => {
  const low = s => String(s ?? "").trim().toLowerCase();
  const findCol = (H, res) => { for (const re of res) { const i = H.findIndex(h => re.test(h)); if (i >= 0) return i; } return -1; };
  const splitRefs = s => String(s || "").split(/[,\s;，]+/).map(x => x.trim()).filter(Boolean).flatMap(expandRange);
  // "R1-R4" style ranges used by some BOMs
  function expandRange(t) {
    const m = t.match(/^([A-Za-z_]+)(\d+)[-~]\1?(\d+)$/);
    if (!m || +m[3] - +m[2] > 500 || +m[3] < +m[2]) return [t];
    return Array.from({ length: +m[3] - +m[2] + 1 }, (_, k) => m[1] + (+m[2] + k));
  }

  // ---------- BOM ----------
  function bom(rows) {
    for (let h = 0; h < Math.min(12, rows.length); h++) {
      const H = rows[h].map(low);
      const di = findCol(H, [/^(designators?|references?|refs?|refdes|ref des|位号|标号|元件位号|器件位号)$/, /^(designator|reference|位号)/]);
      if (di < 0) continue;
      const ci = findCol(H, [/^(comment|名称|注释)$/, /^(value|值|参数|规格)$/, /^(description|描述)$/]);
      const li = findCol(H, [/lcsc|jlcpcb|^jlc|supplier part|立创|商城编号|供应商编号/]);
      const mi = findCol(H, [/^(mpn|manufacturer part|manufacturer_part_number|mfr ?p\/?n|mfr part|partnumber|part number|型号|料号|厂家型号|制造商型号)/]);
      const fi = findCol(H, [/^(footprint|封装|package|pattern)$/]);
      const xi = findCol(H, [/^(dnp|populate|do not (populate|place)|不贴|贴片)$/]);
      if (ci < 0 && li < 0 && mi < 0) return null; // a CPL or something else
      const map = {};
      for (const r of rows.slice(h + 1)) {
        const refs = splitRefs(r[di]);
        if (!refs.length) continue;
        const dnpCell = xi >= 0 ? low(r[xi]) : "";
        const dnp = /^(dnp|yes|true|1|不贴|no ?pop|n\/?p)$/.test(dnpCell) || (H[xi] === "populate" && /^(no|false|0)$/.test(dnpCell));
        for (const d of refs) map[d] = { comment: ci >= 0 ? r[ci] || "" : "", lcsc: li >= 0 ? r[li] || "" : "", mpn: mi >= 0 ? r[mi] || "" : "", fp: fi >= 0 ? r[fi] || "" : "", dnp };
      }
      return Object.keys(map).length ? map : null;
    }
    return null;
  }

  // ---------- pick & place ----------
  const UNIT = { mm: 1, mil: 0.0254, inch: 25.4, in: 25.4 };
  function unitHint(s) {
    s = low(s);
    if (/\bmils?\b|\(mil\)|uunits\s*=\s*mils/.test(s)) return "mil";
    if (/\binch(es)?\b|\(in\)|uunits\s*=\s*inch/.test(s)) return "inch";
    if (/\bmm\b|millimet|\(mm\)|uunits\s*=\s*mm/.test(s)) return "mm";
    return null;
  }
  const num = v => { const m = String(v ?? "").replace(",", ".").match(/-?\d+(\.\d+)?(e-?\d+)?/i); return m ? +m[0] : NaN; };
  const sideOf = v => /^(b|bot|bottom|bottom ?layer|back|m|mirror(ed)?|yes|y|true|2|下|底|底层|反面|背面)$/.test(low(v)) ? "B" : "F";
  const isRef = v => /^[A-Za-z][A-Za-z_]*\d+[A-Za-z0-9_\-.]*$/.test(String(v || "").trim()) && !/^(x|y|r)\d*$/i.test(v);
  function tokens(line) { const out = []; const re = /"([^"]*)"|(\S+)/g; let m; while ((m = re.exec(line))) out.push(m[1] ?? m[2]); return out; }
  // returns {rows:[{ref,x,y,rot,side,val,fp,unit}], unit, explicit} or null
  function cpl(text, rowsIn) {
    const lines = text.split(/\r?\n/);
    let globalUnit = null;
    for (const l of lines.slice(0, 30)) { const u = unitHint(l); if (u && /unit|单位|uunits|dimension|坐标/i.test(l)) { globalUnit = u; break; } }
    const tryRows = rs => {
      for (let h = 0; h < Math.min(30, rs.length); h++) {
        const H = rs[h].map(low);
        const di = findCol(H, [/^(designator|ref|refdes|ref ?des|reference|位号|component_name|comp_name|标号)$/]);
        const xi = findCol(H, [/^(mid|center|centre|pos|cx|location|loc)[-_ ]?x/, /^x$/, /^x[-_ ]?(coord|coordinate|pos|position|\(mm\)|\(mil\))/, /^sym[_ ]?x$/, /^ref[-_ ]?x/, /^pad[-_ ]?x/, /^x[-_ ]?[(（]/]);
        const yi = findCol(H, [/^(mid|center|centre|pos|cy|location|loc)[-_ ]?y/, /^y$/, /^y[-_ ]?(coord|coordinate|pos|position|\(mm\)|\(mil\))/, /^sym[_ ]?y$/, /^ref[-_ ]?y/, /^pad[-_ ]?y/, /^y[-_ ]?[(（]/]);
        if (di < 0 || xi < 0 || yi < 0) continue;
        const ri = findCol(H, [/^(rot|rotation|angle|sym_rotate|角度|旋转)/]);
        const si = findCol(H, [/^(layer|side|tb|t\/b|mirror|sym_mirror|层|面|贴片面)/]);
        const vi = findCol(H, [/^(comment|val|value|值|注释)$/]);
        const fi = findCol(H, [/^(footprint|package|pattern|封装|sym_name|comp_package)$/]);
        const colUnit = unitHint(H[xi]) || globalUnit;
        const out = [];
        for (const r of rs.slice(h + 1)) {
          const ref = (r[di] || "").trim(); if (!ref || !Number.isFinite(num(r[xi])) || !Number.isFinite(num(r[yi]))) continue;
          const cellU = unitHint(String(r[xi]).replace(/[-\d.]/g, " "));
          out.push({ ref, x: num(r[xi]), y: num(r[yi]), rot: ri >= 0 ? num(r[ri]) || 0 : 0, side: si >= 0 ? sideOf(r[si]) : "F", val: vi >= 0 ? r[vi] || "" : "", fp: fi >= 0 ? r[fi] || "" : "", unit: cellU || colUnit });
        }
        if (out.length) return out;
      }
      return null;
    };
    let rows = rowsIn ? tryRows(rowsIn) : null;
    if (!rows) rows = tryRows(Files.csv(text));
    if (!rows) rows = tryRows(lines.map(tokens).filter(t => t.length));
    if (!rows) { // header-less "REF X Y ROT [SIDE]" (Allegro place_txt and similar)
      const out = [];
      for (const l of lines) {
        const t = tokens(l); if (t.length < 4 || !isRef(t[0])) continue;
        const x = num(t[1]), y = num(t[2]), r = num(t[3]); if (![x, y, r].every(Number.isFinite)) continue;
        const sideTok = t.slice(4).find(v => /^(t|b|top|bottom|m|yes|no|f|front|back)$/i.test(v));
        out.push({ ref: t[0], x, y, rot: r, side: sideTok ? sideOf(sideTok) : "F", val: "", fp: t.slice(4).find(v => !/^(t|b|top|bottom|m|yes|no|f|front|back)$/i.test(v)) || "", unit: globalUnit });
      }
      rows = out.length >= 2 ? out : null;
    }
    if (!rows) return null;
    const units = new Set(rows.map(r => r.unit).filter(Boolean));
    const unit = units.size === 1 ? [...units][0] : globalUnit;
    return { rows: rows.map(r => ({ ...r, x: r.x * UNIT[r.unit || unit || "mm"], y: r.y * UNIT[r.unit || unit || "mm"] })), unit: unit || "mm", explicit: !!unit };
  }

  // ---------- IPC-D-356(A) ----------
  // returns pads in mm, Y up (CAD frame): {ref, pin, net, x, y, w, h, rot, side:'F'|'B'|'T', hole, plated}
  function ipc356(text) {
    let scale = 0.0001 * 25.4; const alias = {}; const pads = [];
    for (const raw of text.split(/\r?\n/)) {
      const l = raw.replace(/\s+$/, "");
      if (/^P\s+UNITS\s+(CUST\s+1|SI)/i.test(l)) scale = 0.001;
      else if (/^P\s+UNITS\s+CUST\s*[02]?/i.test(l)) scale = 0.0001 * 25.4;
      else if (/^P\s+(NNAME\d+)\s+(.*)$/.test(l)) { const m = l.match(/^P\s+(NNAME\d+)\s+(.*)$/); alias[m[1]] = m[2].trim(); }
      if (!/^(317|327|367)/.test(l)) continue;
      const type = l.slice(0, 3);
      let net = l.slice(3, 17).trim(); net = alias[net] || net; if (/^N\/C$/i.test(net)) net = "";
      const ref = l.slice(20, 26).trim(), pin = l.slice(27, 31).trim();
      const rest = l.slice(31);
      const m = rest.match(/(?:D(\d+)([PU]))?A(\d\d)X([+-]?\d+)Y([+-]?\d+)(?:X(\d+)Y(\d+)R(\d+))?/);
      if (!m || !ref || /^VIA$/i.test(ref)) { if (m && /^VIA$/i.test(ref)) pads.push({ via: 1, net, x: +m[4] * scale, y: +m[5] * scale, hole: m[1] ? +m[1] * scale : 0 }); continue; }
      const acc = +m[3];
      pads.push({ ref, pin, net, x: +m[4] * scale, y: +m[5] * scale, w: m[6] ? +m[6] * scale : 0, h: m[7] ? +m[7] * scale : 0, rot: m[8] ? +m[8] : 0,
        side: type === "327" ? (acc > 1 ? "B" : "F") : "T", hole: m[1] ? +m[1] * scale : 0, plated: m[2] !== "U" && type !== "367" });
    }
    return pads.length ? pads : null;
  }

  // ---------- JLC / EasyEDA FlyingProbeTesting.json ----------
  function flyprobe(text) {
    let d; try { d = JSON.parse(text); } catch (e) { return null; }
    if (!d || !d.pins || !d.pins.fields) return null;
    const s = UNIT[low(d.lengthUnit) || "mil"] || 0.0254;
    const F = d.pins.fields, ix = k => F.indexOf(k);
    const pads = [];
    for (const r of d.pins.rows) {
      const name = String(r[ix("PIN_NAME")] ?? ""); const k = name.lastIndexOf("_");
      const ref = k > 0 ? name.slice(0, k) : name, pin = k > 0 ? name.slice(k + 1) : "";
      const lay = String(r[ix("LAYER")] ?? "T"), hole = +r[ix("HOLE_SIZE")] || 0;
      pads.push({ ref, pin, net: r[ix("NET_NAME")] || "", x: +r[ix("PIN_X")] * s, y: +r[ix("PIN_Y")] * s, w: +r[ix("PAD_SIZEX")] * s, h: +r[ix("PAD_SIZEY")] * s,
        rot: +r[ix("PAD_ANGLE")] || 0, shape: String(r[ix("PAD_SHAPE")] || "R"), side: hole > 0 ? "T" : (/^b/i.test(lay) ? "B" : "F"), hole: hole * s, plated: true });
    }
    const comps = [];
    if (d.components && d.components.fields) {
      const C = d.components.fields, cx = k => C.indexOf(k);
      for (const r of d.components.rows) comps.push({ ref: r[cx("COMPONENT_NAME")], side: /^b/i.test(r[cx("LAYER")]) ? "B" : "F", x: +r[cx("X_COORDINATE")] * s, y: +r[cx("Y_COORDINATE")] * s, rot: +r[cx("ANGLE")] || 0 });
    }
    return { pads, comps };
  }
  return { bom, cpl, ipc356, flyprobe, splitRefs, unitHint, UNIT };
})();
