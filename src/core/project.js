// Turns a pile of dropped files (folders, zips, mixed EDA outputs) into boards.
globalThis.Project = (() => {
  const SKIP = /(^|\/)(__MACOSX|\.history|\.git|node_modules|\.svn)(\/|$)|(^|\/)\._|(^|\/)~\$/;
  const dirOf = p => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  const baseOf = p => p.split("/").pop();
  const stemOf = p => baseOf(p).replace(/\.[^.]+$/, "");
  const ext = p => (baseOf(p).match(/\.([^.]+)$/) || ["", ""])[1].toLowerCase();
  const isAncestor = (a, d) => a === "" || d === a || d.startsWith(a + "/");
  const GERBER_EXT = /^(gbr|ger|gtl|gbl|gts|gbs|gtp|gbp|gto|gbo|gko|gm\d*|gml|gd\d*|g\d+|gp\d+|art|pho|gbx|cmp|sol|stc|sts|plc|pls|crc|crs|outline)$/;

  async function expand(entries, depth = 0) {
    const out = [];
    for (const e of entries) {
      if (SKIP.test(e.path)) continue;
      const x = ext(e.path);
      if (/^(zip|epro|epro2|tgz|tar|gz|odb)$/.test(x) && depth < 4) {
        try { // decide by content, not by extension (KiCad writes zip data into ".tgz" files, for example)
          let u8 = await e.read();
          if (u8[0] === 0x1f && u8[1] === 0x8b) u8 = await Files.gunzip(u8);
          const isTarData = u8.length > 262 && String.fromCharCode(...u8.subarray(257, 262)) === "ustar";
          const list = (u8[0] === 0x50 && u8[1] === 0x4b) ? Files.unzip(u8) : isTarData ? Files.untar(u8) : null;
          if (!list) { out.push(e); continue; }
          const base = e.path.replace(/\.(zip|epro2?|tgz|tar\.gz|tar|gz|odb)$/i, "") + "/";
          out.push(...await expand(list.map(z => ({ path: base + z.name, read: z.read, size: z.size, inArchive: e.path })), depth + 1));
          continue;
        } catch (err) { out.push({ path: e.path, read: e.read, error: "无法解压：" + err.message }); continue; }
      }
      out.push(e);
    }
    return out;
  }

  // read a small head of each file to decide what it is
  async function classify(e) {
    const x = ext(e.path), name = baseOf(e.path).toLowerCase();
    if (e.error) return { kind: "error" };
    if (x === "kicad_pcb") return { kind: "kicad" };
    if (x === "pcbdoc") return { kind: "altium" };
    if (x === "brd" || x === "mcm" || x === "sip") return { kind: "unsupported", why: "Cadence Allegro .brd 是加密的二进制格式，请导出 IPC-2581（File → Export → IPC 2581）或 Gerber + 坐标 + IPC-356" };
    if (x === "pcb" && /pads/i.test(name)) return { kind: "unsupported", why: "PADS 原文件请先导出 IPC-2581 或 ODB++" };
    if (/^(xls|doc|docx|pdf|png|jpg|jpeg|webp|step|stp|wrl|dxf|dwg|kicad_sch|kicad_pro|kicad_prl|schdoc|prjpcb|dsn|olb|lib|bak|log|jrl)$/.test(x)) return { kind: "ignore" };
    if (/(^|\/)(steps\/[^/]+\/|matrix\/matrix)/i.test(e.path)) return { kind: "odb" };
    if (/(^|\/)(fonts|symbols|misc|wheels|ext)\/[^/]*$/i.test(e.path) && /\/(fonts|symbols|misc)\//i.test(e.path)) return { kind: "ignore" };
    const size = e.size ?? 0;
    if (size > 80e6) return { kind: "ignore" };
    let u8;
    try { u8 = await e.read(); } catch (err) { return { kind: "error", why: err.message }; }
    if (x === "xlsx") return { kind: "xlsx", u8 };
    const headBytes = u8.subarray(0, 8192);
    const head = Files.decodeText(headBytes);
    if (/^\s*\{"type":"DOCHEAD"/.test(head)) return { kind: "easyeda", text: () => Files.decodeText(u8) };
    if (/<IPC-2581[\s>]/.test(head)) return { kind: "ipc2581", text: () => Files.decodeText(u8) };
    if (/^\s*\(kicad_pcb/.test(head)) return { kind: "kicad", text: () => Files.decodeText(u8) };
    if (x === "json" && /"lengthUnit"|FlyingProbe/i.test(head + name)) return { kind: "fly", text: () => Files.decodeText(u8) };
    if (/^(P  |C  )/m.test(head) && /^(317|327)/m.test(Files.decodeText(u8.subarray(0, 200000)))) return { kind: "ipc356", text: () => Files.decodeText(u8) };
    if (ImpGerber.isDrill(head) && !/%FS/.test(head)) return { kind: "drill", text: () => Files.decodeText(u8) };
    if (ImpGerber.isGerber(head) && (GERBER_EXT.test(x) || /%FS/.test(head))) return { kind: "gerber", text: () => Files.decodeText(u8), role: ImpGerber.role(e.path, head) };
    if (/^(csv|txt|tsv|pos|xy|mnt|place|plc|rep|lst)$/.test(x) || !x) return { kind: "table", text: () => Files.decodeText(u8) };
    return { kind: "ignore" };
  }

  async function load(entries, onProgress = () => {}) {
    const files = await expand(entries);
    const errors = [], notes = [];
    const C = [];
    let i = 0;
    for (const f of files) {
      if (f.error) { errors.push(`${f.path}：${f.error}`); continue; }
      if (++i % 20 === 0) onProgress(`正在识别文件 ${i}/${files.length}`);
      const c = await classify(f);
      c.path = f.path; c.dir = dirOf(f.path); c.entry = f;
      if (c.kind === "unsupported") notes.push(`${f.path}：${c.why}`);
      if (c.kind === "error") errors.push(`${f.path}：${c.why || "读取失败"}`);
      C.push(c);
    }
    // tables → BOM / CPL
    const tables = [];
    for (const c of C.filter(c => c.kind === "table" || c.kind === "xlsx")) {
      try {
        let rows, text = "";
        if (c.kind === "xlsx") rows = await Files.xlsx(c.u8); else { text = c.text(); rows = Files.csv(text); }
        const cpl = Tables.cpl(text, rows);
        if (cpl && cpl.rows.length >= 1) { tables.push({ type: "cpl", c, cpl }); const bom = Tables.bom(rows); if (bom) tables.push({ type: "bomFromCpl", c, bom }); continue; }
        const bom = Tables.bom(rows); if (bom) tables.push({ type: "bom", c, bom });
      } catch (err) { /* not a table we understand */ }
    }
    const boards = [];
    const designDirs = [];
    const add = (board, meta) => { boards.push({ board, ...meta }); };

    // ---- native design files ----
    for (const c of C.filter(c => c.kind === "kicad")) {
      try { const t = c.text ? c.text() : Files.decodeText(await c.entry.read()); add(ImpKiCad.parse(t, baseOf(c.path)), { path: c.path, name: stemOf(c.path), source: "KiCad PCB" }); designDirs.push(c.dir); }
      catch (err) { errors.push(`${c.path}：${err.message}`); }
    }
    for (const c of C.filter(c => c.kind === "ipc2581")) {
      try {
        const t = c.text(); const b = ImpIPC2581.parse(t, baseOf(c.path));
        const sw = (t.match(/<SoftwarePackage[^>]*name="([^"]+)"/) || [])[1] || "";
        add(b, { path: c.path, name: stemOf(c.path).replace(/[_-]?ipc[_-]?2581$/i, "") || stemOf(c.path), source: "IPC-2581" + (sw ? `（${sw}）` : "") }); designDirs.push(c.dir);
      } catch (err) { errors.push(`${c.path}：${err.message}`); }
    }
    for (const c of C.filter(c => c.kind === "altium")) {
      try { add(ImpAltium.parse(await c.entry.read(), baseOf(c.path)), { path: c.path, name: stemOf(c.path), source: "Altium PcbDoc" }); designDirs.push(c.dir); }
      catch (err) { errors.push(`${c.path}：${err.message}`); }
    }
    // EasyEDA: group docs by archive / directory
    const ee = {};
    for (const c of C.filter(c => c.kind === "easyeda")) (ee[c.entry.inArchive || c.dir] ||= []).push(c);
    for (const [grp, list] of Object.entries(ee)) {
      try {
        const res = ImpEasyEDA.parseProject(list.map(c => c.text()));
        for (const r of res) {
          if (!r.board.parts.length) continue;
          const nameBase = stemOf(list.find(c => /\.(epru|epcb)$/i.test(c.path))?.path || grp || "easyeda");
          if (r.board.parts.every(p => !p.pads.length)) notes.push(`${grp || nameBase}：只有 PCB 文档，缺少封装数据。请在嘉立创EDA里用“文件 → 导出 → 工程（.epro）”导出完整工程再拖进来。`);
          add(r.board, { path: grp + "#" + (r.uuid || ""), name: res.length > 1 ? `${nameBase}-${r.title || r.uuid}` : nameBase, source: "嘉立创EDA专业版" });
        }
        designDirs.push(dirOf(list[0].path));
      } catch (err) { errors.push(`${grp}：${err.message}`); }
    }
    // ODB++
    if (globalThis.ImpODB) {
      const roots = {};
      for (const c of C.filter(c => c.kind === "odb")) { const m = c.path.match(/^(.*?)(?:^|\/)(?:steps\/|matrix\/matrix)/i); if (m) (roots[m[1].replace(/\/$/, "")] ||= []).push(c); }
      for (const [root, list] of Object.entries(roots)) {
        if (!list.some(c => /eda\/data(\.z)?$/i.test(c.path))) continue;
        try { const b = await ImpODB.parse(list.map(c => ({ path: root ? c.path.slice(root.length + 1) : c.path, read: c.entry.read }))); add(b, { path: root, name: baseOf(root.replace(/\/odb$/i, "")) || "odb", source: "ODB++" }); designDirs.push(dirOf(root)); }
        catch (err) { errors.push(`${root}：${err.message}`); }
      }
    }

    // ---- manufacturing groups (Gerber / CPL / netlist) ----
    const covered = d => designDirs.some(dd => isAncestor(dd, d) && d.split("/").length - dd.split("/").length <= 2);
    const near = (d, list) => { // same dir, then ancestors, then siblings
      const same = list.filter(t => t.c.dir === d); if (same.length) return same;
      for (let a = d; a !== ""; a = dirOf(a)) { const up = list.filter(t => t.c.dir === dirOf(a)); if (up.length) return up; }
      const sib = list.filter(t => dirOf(t.c.dir) === dirOf(d)); return sib;
    };
    const gerbers = C.filter(c => c.kind === "gerber"), drills = C.filter(c => c.kind === "drill");
    const nets = C.filter(c => c.kind === "ipc356" || c.kind === "fly");
    const gdirs = [...new Set(gerbers.map(c => c.dir))];
    const usedTables = new Set();
    for (const d of gdirs) {
      if (covered(d)) continue;
      const gl = gerbers.filter(c => c.dir === d);
      const layers = {};
      for (const c of gl) { if (!c.role || c.role === "other" || c.role === "cuIn") continue; if (c.role === "drill") continue; if (!layers[c.role]) { try { layers[c.role] = ImpGerber.parse(c.text()); } catch (err) { errors.push(`${c.path}：${err.message}`); } } }
      if (!layers.cuF && !layers.cuB) continue;
      const holes = [];
      for (const c of drills.filter(c => c.dir === d || isAncestor(d, c.dir))) { try { const pl = /npth|non.?plated/i.test(c.path) ? false : /pth|plated/i.test(c.path) ? true : null; holes.push(...ImpGerber.drill(c.text()).map(h => ({ ...h, plated: h.plated ?? pl ?? true }))); } catch (err) { /* ignore */ } }
      for (const c of gl.filter(c => c.role === "drill")) { try { holes.push(...ImpGerber.drill(c.text())); } catch (e) {} }
      const nt = near(d, nets.map(c => ({ c })));
      let net = null;
      for (const t of nt) { try { if (t.c.kind === "fly") { const f = Tables.flyprobe(t.c.text()); if (f) { net = { pads: f.pads, comps: f.comps, source: "飞针测试文件" }; break; } } else { const p = Tables.ipc356(t.c.text()); if (p) { net = { pads: p, source: "IPC-356" }; break; } } } catch (e) {} }
      const cpls = near(d, tables.filter(t => t.type === "cpl"));
      const cpl = cpls.length ? cpls[0].cpl : null;
      cpls.forEach(t => usedTables.add(t));
      const bomNear = near(d, tables.filter(t => t.type === "bom"));
      const b = ImpFab.build({ layers, holes, cpl, net, bom: bomNear.length ? bomNear[0].bom : null });
      if (!b.parts.length) { notes.push(`${d || "根目录"}：找到 Gerber，但没有坐标文件或网表，无法确定器件。请一起拖入坐标文件（Pick and Place / CPL）。`); continue; }
      const nm = baseOf(d) || stemOf(gl[0].path);
      const parts = ["Gerber"]; if (cpl) parts.push("坐标文件"); if (net) parts.push(net.source);
      add(b, { path: d + "#fab", name: nm.replace(/^gerber[_-]?/i, "") || nm, source: parts.join(" + ") });
    }
    // CPL with no Gerber next to it: placement-only board
    for (const t of tables.filter(t => t.type === "cpl" && !usedTables.has(t))) {
      if (covered(t.c.dir) || gdirs.some(d => isAncestor(t.c.dir, d) || isAncestor(d, t.c.dir))) continue;
      const nt = near(t.c.dir, nets.map(c => ({ c })));
      let net = null; for (const n of nt) { try { net = n.c.kind === "fly" ? (x => x && { pads: x.pads, comps: x.comps })(Tables.flyprobe(n.c.text())) : { pads: Tables.ipc356(n.c.text()) }; if (net && net.pads) break; } catch (e) {} }
      const b = ImpFab.build({ layers: {}, holes: [], cpl: t.cpl, net });
      b.warn.unshift("只有坐标文件，没有 Gerber：器件按坐标画成方框");
      add(b, { path: t.c.path, name: stemOf(t.c.path), source: "坐标文件" + (net ? " + 网表" : "") });
    }

    // ---- drop duplicates: the same design as Gerber next to its source file, or the same Gerbers twice (folder + zip) ----
    const sig = b => { const B = b.board; return { refs: new Set(B.parts.map(p => p.r)), pos: Object.fromEntries(B.parts.map(p => [p.r, p.c])), w: B.bbox[2] - B.bbox[0], h: B.bbox[3] - B.bbox[1] }; };
    // same board = most shared designators sit at the same place (after allowing for a different origin)
    const samePlacement = (s, t, common) => {
      const dx = common.map(r => t.pos[r][0] - s.pos[r][0]).sort((a, b) => a - b), dy = common.map(r => t.pos[r][1] - s.pos[r][1]).sort((a, b) => a - b);
      const ox = dx[dx.length >> 1], oy = dy[dy.length >> 1];
      const hit = common.filter(r => Math.hypot(t.pos[r][0] - s.pos[r][0] - ox, t.pos[r][1] - s.pos[r][1] - oy) < 0.6).length;
      return hit >= 0.7 * common.length;
    };
    const rank = b => b.path.endsWith("#fab") ? (b.board.noNets ? 0 : 1) : 2;
    const keep = [];
    for (const b of boards.slice().sort((x, y) => rank(y) - rank(x))) {
      const s = sig(b);
      const dup = keep.find(k => { const t = sig(k); const common = [...s.refs].filter(r => t.refs.has(r)); return common.length >= 0.7 * Math.min(s.refs.size, t.refs.size) && Math.abs(s.w - t.w) < 2 && Math.abs(s.h - t.h) < 2 && samePlacement(s, t, common); });
      if (dup) { if (rank(b) < 2 && rank(dup) === 2) notes.push(`${b.path.replace(/#.*$/, "")}：和原生设计文件 ${baseOf(dup.path.replace(/#.*$/, ""))} 是同一块板，已使用原生文件`); continue; }
      keep.push(b);
    }
    boards.length = 0; boards.push(...keep.sort((x, y) => x.path.localeCompare(y.path)));

    // ---- attach BOMs ----
    const boms = tables.filter(t => t.type === "bom");
    for (const bd of boards) {
      const d = dirOf(bd.path.replace(/#.*$/, "")) || bd.path.replace(/#.*$/, "");
      const dd = bd.path.includes("#fab") ? bd.path.replace(/#fab$/, "") : dirOf(bd.path);
      let cands = near(dd, boms);
      if (!cands.length) cands = boms.filter(t => isAncestor(t.c.dir, dd));
      const stem = (bd.name || "").toLowerCase();
      cands.sort((a, b) => (baseOf(b.c.path).toLowerCase().includes(stem) - baseOf(a.c.path).toLowerCase().includes(stem)));
      const refs = new Set(bd.board.parts.map(p => p.r));
      const pick = cands.find(t => Object.keys(t.bom).filter(r => refs.has(r)).length >= Math.min(3, refs.size)) || null;
      bd.bom = pick ? pick.bom : null; bd.bomFile = pick ? baseOf(pick.c.path) : "";
      if (!pick) { const fromCpl = tables.find(t => t.type === "bomFromCpl" && (t.c.dir === dd || isAncestor(dd, t.c.dir))); if (fromCpl) { bd.bom = fromCpl.bom; bd.bomFile = baseOf(fromCpl.c.path); } }
    }
    if (!boards.length && !errors.length && !notes.length) notes.push("没有找到能识别的板子文件。支持：KiCad .kicad_pcb、IPC-2581、ODB++、嘉立创EDA专业版工程，或 Gerber + 坐标文件。");
    return { boards, errors, notes };
  }
  return { load, expand, classify };
})();
