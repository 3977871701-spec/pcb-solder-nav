// Turns a parsed board into a soldering plan: names, polarity, solder steps, groups.
globalThis.Enrich = (() => {
  const STEPS = {
    1: ["细间距芯片 / 连接器", "QFN、DFN、LGA、BGA、QFP、TSSOP、FPC/Type-C 座。先焊，周围空旷好操作。锡膏 + 热风枪或加热台，认准 1 脚。"],
    2: ["三极管 / MOS / 晶振 / SOIC", "SOT、SOIC、SOP、晶振、功率封装。认准 1 脚；4 脚晶振转 90° 会把晶体脚接到地。"],
    3: ["0201 / 0402 阻容感", "最小的被动件，无极性。一种值焊完再换下一种，避免混料。"],
    4: ["0603 阻容感", "无极性。"],
    5: ["有极性器件", "二极管、LED、电解/钽电容。按卡片里的方向提示放，焊前对一下丝印。双向 TVS 无极性。"],
    6: ["0805 及以上 / 电感 / 其他贴片", "体积较大，散热快，烙铁温度可适当调高。"],
    7: ["按键 / 开关 / 电池座 / 其他机械件", "塑料件怕热，放在贴片最后快速焊完。"],
    8: ["底面贴片", "顶面焊完再翻面焊。翻面时垫高，别压到顶面器件。"],
    9: ["插件（最后焊）", "排针、排母、端子、编码器等。从元件面插入，另一面焊接。"],
  };
  const FINE = /QFN|DFN|LGA|BGA|WSON|VSON|USON|XSON|TSON|(^|[^A-Z])SON|QFP|TSSOP|MSOP|SSOP|CSP|LQFN|VQFN|FH\d|FPC|FFC|USB[_-]?C|Type-?C|P0\.[345]\d*mm/i;
  const MID = /SOT|SOIC|(^|_)SOP|ESOP|HSOP|SC-?70|SC-?88|Crystal|Oscillator|TO-2|DPAK|D2PAK|PowerPAK|SMA|SMB|SMC|MELF/i;
  const pkg = fp => (fp.match(/(?:^|[^0-9])(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)(?![0-9])/) || [])[1] || "";
  const isTP = p => /^TP\d/i.test(p.r) || /TestPoint|TESTPOINT/i.test(p.fp) || (p.fp === "PAD" && p.pads.length <= 1);
  const nothing = p => p.r.startsWith("#") || /^\?/.test(p.r) || /Fiducial|MountingHole|Logo|NetTie|^MTG|^MH\d/i.test(p.fp) || /^(FID|MARK|MH|H)\d+$/i.test(p.r) && p.pads.length <= 1 || (!p.pads.some(q => q[3] !== 2) && !p.nopin);
  const lcscOf = p => p.props.LCSC || p.props["LCSC Part"] || p.props["LCSC Part #"] || p.props["JLCPCB Part #"] || p.props.lcsc_id || p.props["LCSC#"] || "";
  function prettyFp(fp) {
    let m = fp.match(/Pin(Header|Socket)_(\d+)x(\d+)_P([\d.]+)mm_(\w+)/);
    if (m) return `${m[1] === "Header" ? "排针" : "排母"} ${m[2]}×${+m[3]} ${m[4]}mm ${/^Horiz/.test(m[5]) ? "弯" : "直"}`;
    if (/RotaryEncoder/i.test(fp)) return "旋转编码器 " + (fp.match(/EC\d+\w*/) || [""])[0];
    if (/Potentiometer/i.test(fp)) return "电位器 " + (fp.match(/RK\d+\w*|3296\w*|RV\d+\w*/) || [""])[0];
    if (/TerminalBlock/i.test(fp)) return "接线端子 " + ((fp.match(/1x(\d+)/) || [])[1] ? fp.match(/1x(\d+)/)[1] + "P" : "");
    if (/USB/i.test(fp)) return fp.replace(/_/g, " ");
    return fp;
  }
  const mpnOf = p => p.props.MPN || p.props.Partnumber || p.props["Manufacturer_Part_Number"] || p.props["Manufacturer Part Number"] || p.props.PN || "";

  function polarity(p, name) {
    const r = p.r.toUpperCase(), fp = p.fp;
    if (/^(D|LED|ZD|TVS|VD)\d/.test(r) || /^LED/.test(r)) {
      if (/-BI\b|_BI\b|Bidir/i.test(fp) || /\d(\.\d)?C?A\b/.test(name) && /^(SM|P\d|ESD|TVS)/i.test(name)) return "none-bi";
      return p.pads.filter(q => q[3] !== 2).length >= 2 ? "k1" : "";
    }
    if (/^C\d/.test(r) && /CP_|Elec|Tantal|CASE-[A-E]|_Pol|POL/i.test(fp + " " + name)) return "plus1";
    if (/^(BT|BAT|BZ|LS)\d/.test(r)) return "plus1";
    if (/^(U|IC|Q|VT|T\d|Y|X|OSC|MOD)/.test(r)) return p.pads.filter(q => q[3] !== 2).length > 2 ? "pin1" : "";
    if (/^(J|P|CN|CON|USB|FPC)\d/.test(r) && !p.tht && FINE.test(fp)) return "pin1";
    return "";
  }
  function step(p) {
    if (p.tht) return 9;
    if (p.s === "B") return 8;
    const r = p.r.toUpperCase(), fp = p.fp;
    if (FINE.test(fp)) return 1;
    if (/^(D|LED|ZD|TVS|VD)\d/.test(r) || /^LED/.test(r) || p.pol === "plus1") return 5;
    if (MID.test(fp) && !/^(R|C|L|FB)\d/.test(r)) return 2;
    if (/^(SW|K|S|BT|BAT|BZ|RV|VR|ENC)\d/.test(r)) return 7;
    const k = pkg(fp);
    if (/^(R|C|L|FB|RN|CN)\d/.test(r) || k) {
      if (k === "01005" || k === "0201" || k === "0402") return 3;
      if (k === "0603") return 4;
      return 6;
    }
    if (/^(J|P|CN|CON|USB)\d/.test(r)) return 7;
    return 6;
  }
  const ROLE = [
    [/(^|[._\[])dec/, "去耦"], [/c_in\b|c_in\[/, "输入电容"], [/c_out_bulk/, "输出储能"], [/c_out/, "输出电容"], [/c_vm_hf/, "电机电源高频去耦"],
    [/c_vm/, "电机电源电容"], [/c_vcc/, "逻辑电源电容"], [/c_aux/, "VAUX 电容"], [/fb_top/, "反馈分压(上)"], [/fb_bot/, "反馈分压(下)"],
    [/r_top/, "分压(上)"], [/r_bot/, "分压(下)"], [/r_mid/, "分压(中)"], [/c_x/, "晶振负载电容"], [/xtal|crystal/, "晶振"], [/\bmcu\b/, "MCU"],
    [/flash/, "Flash"], [/nrst|reset/, "复位"], [/boot/, "BOOT"], [/vdda/, "模拟电源去耦"], [/(^|\.)l$/, "电感"], [/q_p\b/, "P-MOS 开关"],
    [/q_n\b/, "N-MOS 驱动"], [/enable_pulldown/, "使能下拉"], [/gate_pullup/, "栅极上拉"], [/pullup|r_pu\b/, "上拉"], [/pulldown|r_pd/, "下拉"],
    [/tvs/, "TVS 保护"], [/esd/, "ESD 保护"], [/r_led|led/, "LED"], [/r_d[mp]\b/, "USB 串阻"], [/sense/, "采样"], [/bulk/, "储能电容"],
    [/r_chain/, "梯形电阻链"], [/r_leg/, "支路电阻"], [/r_term/, "终端电阻"], [/\.sw\b|\.sw\[/, "按键/开关"], [/\.enc$/, "编码器"], [/\.pot$/, "电位器"],
    [/\.jp$/, "跳线"], [/\.j$/, "接口"], [/\.u$/, "芯片"], [/imu/, "IMU"], [/charger/, "充电"], [/buck|boost/, "DC-DC"], [/efuse/, "电子保险丝"],
  ];
  function fnOf(p) {
    const addr = p.props.atopile_address || "";
    const out = [];
    if (addr) {
      const role = (ROLE.find(([re]) => re.test(addr.toLowerCase())) || [])[1];
      out.push(role ? `${role}（${addr}）` : addr);
    }
    if (p.sheet && p.sheet !== "/") out.push("原理图页 " + p.sheet);
    const desc = p.props.Description || p.props.description || "";
    if (desc && desc.length < 80) out.push(desc);
    return out.join(" · ");
  }
  const natkey = r => { const m = String(r).match(/^([A-Za-z_#]+)(\d+)(.*)$/); return m ? [m[1].toUpperCase(), +m[2], m[3]] : [String(r), 0, ""]; };
  const natcmp = (a, b) => { const x = natkey(a), y = natkey(b); return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0); };

  // board = parsed board; bomMap = { ref: {comment,lcsc,mpn} } or null
  function enrich(board, bomMap) {
    const groups = new Map(), dnp = [];
    for (const p of board.parts) {
      const b = bomMap && bomMap[p.r];
      if (!p.fp && b && b.fp) p.fp = b.fp; // pick-and-place files often lack the footprint; the BOM has it
      const mpn = (b && b.mpn) || mpnOf(p), lcsc = (b && b.lcsc) || lcscOf(p);
      let nm = (b && b.comment) || (p.val && p.val !== "~" ? p.val : "") || mpn || prettyFp(p.fp);
      if (p.val && mpn && !(b && b.comment) && !nm.includes(mpn) && /^(U|IC|Q|D|Y|X)/.test(p.r)) nm = p.val === "~" ? mpn : `${p.val}`;
      let note = "";
      const m = nm.match(/[（(]([^()（）]*?(需|缺货|确认|DNP|不贴|注意|自供|代购)[^()（）]*)[)）]/);
      if (m) { note = m[1]; nm = nm.replace(m[0], "").trim() || nm; }
      p.nm = nm; p.lcsc = lcsc; p.mpn = mpn; p.note = note;
      if (b && b.dnp) p.dnp = 1;
      p.tp = isTP(p) ? 1 : 0;
      p.skip = (p.tp || p.nobom || nothing(p)) ? 1 : 0;
      p.pol = p.skip ? "" : polarity(p, nm);
      p.fn = fnOf(p);
      p.nets = [...new Set(p.pads.map(q => q[1]).filter(Boolean))].sort();
      if (p.skip) continue;
      if (p.dnp) { dnp.push(p.r); continue; }
      const st = step(p), key = st + "|" + nm + "|" + p.fp;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { step: st, nm, fp: p.fp, lcsc, mpn, refs: [], pol: p.pol, note });
      g.refs.push(p.r);
      if (note && !g.note) g.note = note;
    }
    const gl = [...groups.values()];
    gl.forEach(g => g.refs.sort(natcmp));
    gl.sort((a, b) => a.step - b.step || natkey(a.refs[0])[0].localeCompare(natkey(b.refs[0])[0]) || b.refs.length - a.refs.length || natcmp(a.refs[0], b.refs[0]));
    gl.forEach((g, i) => g.id = "g" + i);
    board.groups = gl; board.dnp = dnp.sort(natcmp);
    return board;
  }
  return { enrich, STEPS, natcmp };
})();
