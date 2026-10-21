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
  const v01 = (await run(["D:/ghost_work/cadence/V01_R9_Cadence_20260824/source_epro2/01_PCB源文件"], { quiet: true })).boards[0].board;
  cmpFly(v01, Tables.flyprobe(R(`${S}/v01_flyprobe.json`)), "嘉立创EDA .epro2 vs JLC flying probe (V01_R9) [nets renamed between revisions]");
  for (const f of ["HiFive1.B01", "eDP_adapter_dvt1"]) cmpBoards(ImpKiCad.parse(R(`${S}/altium/${f}.kicad_pcb`), f), ImpAltium.parse(new Uint8Array(fs.readFileSync(`${S}/altium/${f}.PcbDoc`)), f), `Altium .PcbDoc ${f} vs KiCad importer`);
})();
