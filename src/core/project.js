// Turns a pile of dropped files (folders, zips, mixed EDA outputs) into boards.
globalThis.Project = (() => {
  const SKIP = /(^|\/)(__MACOSX|\.history|\.git|node_modules|\.svn|\.venv|venv|site-packages|__pycache__|\.idea|\.vscode)(\/|$)|(^|\/)\._|(^|\/)~\$/;
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
    if (x === "eprj2" || x === "eprj") return { kind: "unsupported", why: "嘉立创EDA本地工程库（.eprj2）暂不能直接读，请在嘉立创EDA里用“文件 → 导出 → 工程”导出 .epro2 再拖进来" };
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
    if (x === "json" && /"docType"\s*:\s*"3"/.test(head) && /"shape"\s*:/.test(Files.decodeText(u8.subarray(0, 300000)))) return { kind: "easystd", text: () => Files.decodeText(u8) };
    if (/^(P  |C  )/m.test(head) && /^(317|327)/m.test(Files.decodeText(u8.subarray(0, 200000)))) return { kind: "ipc356", text: () => Files.decodeText(u8) };
    if (ImpGerber.isDrill(head) && !/%FS/.test(head)) return { kind: "drill", text: () => Files.decodeText(u8) };
    if (ImpGerber.isGerber(head) && (GERBER_EXT.test(x) || /%FS/.test(head))) return { kind: "gerber", text: () => Files.decodeText(u8), role: ImpGerber.role(e.path, head) };
    if (/^(csv|txt|tsv|pos|xy|mnt|place|plc|rep|lst)$/.test(x) || !x) return { kind: "table", text: () => Files.decodeText(u8) };
    return { kind: "ignore" };
  }

  // board name from its folder, skipping generic folder names like gerber/fab/output
  const GENERIC = /^(gerbers?|fab|fabrication|output|outputs?|out|cam|manufacturing|production|work|tmp|temp|release|smt|assembly|生产文件|嘉立创生产文件|打板|打板参考|制板文件|光绘)$/i;
  function niceName(d, fallback) {
    const parts = d.split("/").filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) if (!GENERIC.test(parts[i])) return parts[i].replace(/^gerber[_-]?/i, "") || parts[i];
    return stemOf(fallback || "board");
  }
  async function load(entries, onProgress = () => {}) {
    const files = await expand(entries);
    const errors = [], notes = [], skipped = {};
    const C = [];
    let i = 0;
    for (const f of files) {
      if (f.error) { errors.push(`${f.path}：${f.error}`); continue; }
      if (++i % 20 === 0) onProgress(`正在识别文件 ${i}/${files.length}`);
      const c = await classify(f);
      c.path = f.path; c.dir = dirOf(f.path); c.entry = f;
      if (c.kind === "unsupported") (skipped[c.why] ||= []).push(f.path);
      if (c.kind === "error") errors.push(`${f.path}：${c.why || "读取失败"}`);
      C.push(c);
    }
    for (const [why, list] of Object.entries(skipped)) notes.push(list.length === 1 ? `${list[0]}：${why}` : `跳过 ${list.length} 个文件（${list.slice(0, 2).map(baseOf).join("、")} 等）：${why}`);
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
    const noFoot = [];
    for (const [grp, list] of Object.entries(ee)) {
      try {
        const res = ImpEasyEDA.parseProject(list.map(c => ({ text: c.text(), name: c.path })));
        const proj = stemOf(grp || "easyeda").replace(/^ProPrj_/, "").replace(/_\d{4}-\d{2}-\d{2}$/, "");
        const good = res.filter(r => r.comps && r.padCoverage >= 0.5);
        for (const r of res) if (r.comps && r.padCoverage < 0.5) noFoot.push(r.src || grp); // PCB without its footprints (bare .epcb snapshot)
        for (const r of good) {
          const own = r.title && !/^PCB\d*$/i.test(r.title) ? r.title : stemOf(r.src || grp || "easyeda");
          add(r.board, { path: (r.src || grp) + "#" + (r.uuid || ""), name: good.length > 1 ? `${proj} · ${own}` : own, source: "嘉立创EDA专业版" });
        }
        designDirs.push(dirOf(list[0].path));
      } catch (err) { errors.push(`${grp}：${err.message}`); }
    }
    if (noFoot.length) notes.push(`${noFoot.length} 个嘉立创 PCB 文档缺少封装数据（例如 ${baseOf(noFoot[0])}），已跳过。请在嘉立创EDA里用“文件 → 导出 → 工程”导出完整的 .epro2 再拖进来。`);
    for (const c of C.filter(c => c.kind === "easystd")) {
      try { add(ImpEasyStd.parse(JSON.parse(c.text()), baseOf(c.path)), { path: c.path, name: stemOf(c.path).replace(/^PCB_(PCB_)?/, ""), source: "嘉立创EDA标准版" }); designDirs.push(c.dir); }
      catch (err) { errors.push(`${c.path}：${err.message}`); }
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
      // candidate placement files anywhere under the parent / grandparent folder: try each, keep the one that fits the copper best
      const allCpl = tables.filter(t => t.type === "cpl");
      let cands = [];
      for (const root of [d, dirOf(d), dirOf(dirOf(d))]) { cands = allCpl.filter(t => isAncestor(root, t.c.dir)); if (cands.length) break; if (root === "") break; }
      const hint = t => /cpl|pick|place|pnp|pos|-pos|坐标|centroid|xy|smt|mount|贴片/i.test(baseOf(t.c.path)) ? 0 : 0.25;
      const bomNear = near(d, tables.filter(t => t.type === "bom"));
      const bomMap = bomNear.length ? bomNear[0].bom : null;
      let b = null, cpl = null, bestScore = 1e9, bestT = null;
      for (const t of cands.slice(0, 8)) {
        const bb = ImpFab.build({ layers, holes, cpl: t.cpl, net, bom: bomMap });
        const score = (bb.align ? bb.align.res : 5) + hint(t) + (t.cpl.header ? 0 : 0.1);
        if (score < bestScore) { bestScore = score; b = bb; cpl = t.cpl; bestT = t; }
      }
      if (bestT && bestScore > 1.5 && !net) { b = null; cpl = null; bestT = null; } // nothing fits: better no placement than a wrong one
      if (bestT) usedTables.add(bestT);
      if (!b) b = ImpFab.build({ layers, holes, cpl: null, net, bom: bomMap });
      if (!b.parts.length) { notes.push(`${d || "根目录"}：找到 Gerber，但没有坐标文件或网表，无法确定器件。请一起拖入坐标文件（Pick and Place / CPL）。`); continue; }
      const parts = ["Gerber"]; if (cpl) parts.push("坐标文件"); if (net) parts.push(net.source);
      add(b, { path: d + "#fab", name: niceName(d, gl[0].path), source: parts.join(" + ") });
    }
    // CPL with no Gerber anywhere near it: placement-only board (only for files that clearly are placement lists)
    for (const t of tables.filter(t => t.type === "cpl" && !usedTables.has(t))) {
      if (!/cpl|pick|place|pnp|pos|坐标|centroid|\bxy\b|smt|贴片/i.test(baseOf(t.c.path))) continue; // only files named like placement lists
      const xs = t.cpl.rows.map(r => r.x), ys = t.cpl.rows.map(r => r.y);
      if (Math.max(...xs) - Math.min(...xs) > 600 || Math.max(...ys) - Math.min(...ys) > 600) continue; // not board coordinates
      const area = dirOf(t.c.dir);
      if (covered(t.c.dir) || gdirs.some(d => isAncestor(t.c.dir, d) || isAncestor(d, t.c.dir) || isAncestor(area, d))) continue;
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
    const rank = b => (b.path.endsWith("#fab") ? (b.board.noNets ? 0 : 1) : 2) - (/(^|\/)(work|tmp|temp|backup|old|review|snapshots?|sim)(\/|#|$)/i.test(b.path) ? 0.5 : 0);
    const keep = [];
    for (const b of boards.slice().sort((x, y) => rank(y) - rank(x))) {
      const s = sig(b);
      const dup = keep.find(k => { const t = sig(k); const common = [...s.refs].filter(r => t.refs.has(r)); return common.length >= 0.7 * Math.min(s.refs.size, t.refs.size) && Math.abs(s.w - t.w) < 2 && Math.abs(s.h - t.h) < 2 && samePlacement(s, t, common); });
      if (dup) { if (rank(b) < 2 && rank(dup) === 2) notes.push(`${b.path.replace(/#.*$/, "")}：和原生设计文件 ${baseOf(dup.path.replace(/#.*$/, ""))} 是同一块板，已使用原生文件`); continue; }
      keep.push(b);
    }
    // exact copies (same placement) collapse silently; different revisions with the same name get their folder appended
    const exact = new Set(), uniq = [];
    for (const b of keep) { const k = b.board.parts.map(p => p.r + ":" + p.c.join(",")).sort().join("|"); if (exact.has(k)) continue; exact.add(k); uniq.push(b); }
    const count = {}; for (const b of uniq) count[b.name] = (count[b.name] || 0) + 1;
    for (const b of uniq) if (count[b.name] > 1) { const dir = baseOf(dirOf(b.path.replace(/#.*$/, ""))); if (dir) b.name = `${b.name}（${dir}）`; }
    boards.length = 0; boards.push(...uniq.sort((x, y) => x.path.localeCompare(y.path)));

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
      // a BOM belongs to a board only if most of its designators exist on the board and it covers a good part of the board
      const real = Math.max(1, [...refs].filter(r => !/^(TP|MH|H|FID|MARK|PAD)\d/i.test(r)).length);
      const fit = t => { const keys = Object.keys(t.bom), hit = keys.filter(r => refs.has(r)).length; return hit >= 0.8 * keys.length && hit >= 0.5 * real ? hit : 0; };
      const pick = cands.filter(fit).sort((a, b) => fit(b) - fit(a))[0] || null;
      bd.bom = pick ? pick.bom : null; bd.bomFile = pick ? baseOf(pick.c.path) : "";
      if (!pick) { const fromCpl = tables.find(t => t.type === "bomFromCpl" && (t.c.dir === dd || isAncestor(dd, t.c.dir)) && fit(t)); if (fromCpl) { bd.bom = fromCpl.bom; bd.bomFile = baseOf(fromCpl.c.path); } }
    }
    if (!boards.length && !errors.length && !notes.length) notes.push("没有找到能识别的板子文件。支持：KiCad .kicad_pcb、IPC-2581、ODB++、嘉立创EDA专业版工程，或 Gerber + 坐标文件。");
    return { boards, errors, notes };
  }
  return { load, expand, classify };
})();
