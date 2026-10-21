// Regression suite over local sample data (not shipped in the repo).
// Set SAMPLES to the folder holding the reference dumps and exported samples.
const fs = require("fs");
const { compare } = require("./harness.js");
const { cmpBoards } = require("./cmp_boards.js");
const { cmpFly } = require("./flyprobe_cmp.js");
const { run } = require("./e2e.js");
const S = process.env.SAMPLES;
const R = f => fs.readFileSync(f, "utf8");
(async () => {
  for (const b of ["gateway", "motor"]) {
    compare(ImpKiCad.parse(R(`${S}/../golenz/${b}/${b}.kicad_pcb`), b), `${S}/../${b}.json`, { label: `KiCad .kicad_pcb ${b}` });
    compare(ImpIPC2581.parse(R(`${S}/kicad/${b}/${b}-ipc2581.xml`), b), `${S}/../${b}.json`, { label: `IPC-2581 (KiCad) ${b}` });
    compare((await run([`${S}/kicad/${b}/${b}-odb.tgz`], { quiet: true })).boards[0].board, `${S}/../${b}.json`, { label: `ODB++ (KiCad) ${b}` });
    compare((await run([`${S}/kicad/${b}/fab`], { quiet: true })).boards[0].board, `${S}/../${b}.json`, { label: `Gerber+pos+IPC-356 (KiCad) ${b} [net names: IPC-356 upper-cases/truncates]` });
  }
  const al = ImpIPC2581.parse(R(`${S}/allegro_v11/v11_ipc2581.xml`), "v11");
  const ee = ImpEasyEDA.parseProject([R(`${S}/lceda/CZL00_PCB01_DEV_V1.1.epru`)])[0].board;
  cmpBoards(al, ee, "嘉立创EDA .epru vs Allegro IPC-2581 (CZL00 V1.1)");
  cmpBoards(al, (await run([`${S}/fabset_v11`], { quiet: true })).boards[0].board, "Gerber+CPL+IPC-356 (Allegro) vs Allegro IPC-2581");
  const v01 = (await run([`${S}/v01_epro2`], { quiet: true })).boards[0].board;
  cmpFly(v01, Tables.flyprobe(R(`${S}/v01_flyprobe.json`)), "嘉立创EDA .epro2 vs JLC flying probe (V01_R9) [nets renamed between revisions]");
  for (const f of ["HiFive1.B01", "eDP_adapter_dvt1"]) cmpBoards(ImpKiCad.parse(R(`${S}/altium/${f}.kicad_pcb`), f), ImpAltium.parse(new Uint8Array(fs.readFileSync(`${S}/altium/${f}.PcbDoc`)), f), `Altium .PcbDoc ${f} vs KiCad importer`);
})();
// extra Altium boards (binary PcbDoc) and EasyEDA Standard self-consistency
(async () => {
  for (const f of ["fx1", "fx2", "fx3"]) {
    const p = `${S}/altium2/${f}.PcbDoc`; if (!fs.existsSync(p)) continue;
    cmpBoards(ImpKiCad.parse(R(`${S}/altium2/${f}.kicad_pcb`), f), Enrich.enrich(ImpAltium.parse(new Uint8Array(fs.readFileSync(p)), f), null), `Altium .PcbDoc ${f} vs KiCad importer`);
  }
  const std = `${S}/easystd.json`;
  if (fs.existsSync(std)) {
    const obj = JSON.parse(R(std)), b = ImpEasyStd.parse(obj, "std"), K = 0.254;
    const pads = b.parts.flatMap(p => p.pads.map(q => ({ net: q[1], x: q[4], y: q[5], sz: q[6] })));
    let same = 0, other = 0;
    for (const s of obj.shape) { const f = s.split("~"); if (f[0] !== "TRACK" || !(f[2] === "1" || f[2] === "2") || !f[3]) continue; const n = f[4].trim().split(/\s+/).map(Number);
      for (const [x, y] of [[n[0] * K, n[1] * K], [n[n.length - 2] * K, n[n.length - 1] * K]]) { const on = pads.filter(p => Math.hypot(p.x - x, p.y - y) < p.sz / 2 + 0.15); if (!on.length) continue; if (on.some(p => p.net === f[3])) same++; else other++; } }
    console.log(`${other === 0 && same > 0 ? "PASS" : "FAIL"} 嘉立创EDA标准版 self-consistency: track ends on same-net pads ${same}, on other-net pads ${other}`);
  }
})();
