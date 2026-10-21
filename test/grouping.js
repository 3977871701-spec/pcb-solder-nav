// Geometry-only (Gerber + placement, no netlist) pad grouping accuracy against a trusted board.
const fs = require("fs");
const { run } = require("./e2e.js");
async function grouping(folder, truth, label) {
  const r = await run([folder], { quiet: true }); const B = r.boards.find(b => b.board.noNets)?.board || r.boards[0].board;
  let ok = 0, bad = [];
  for (const p of B.parts) {
    const t = truth.parts.find(q => q.r === p.r); if (!t || !t.pads.length) continue;
    const same = t.pads.length === p.pads.length && t.pads.every(q => p.pads.some(z => Math.hypot(z[4] - q[4], z[5] - q[5]) < 0.03));
    if (same) ok++; else bad.push(`${p.r}(${p.pads.length}/${t.pads.length})`);
  }
  console.log(`${label}: pad grouping correct ${ok}/${ok + bad.length}${bad.length ? "  wrong: " + bad.join(" ") : ""}`);
}
module.exports = { grouping };
if (require.main === module) (async () => {
  const S = process.env.SAMPLES, R = f => fs.readFileSync(f, "utf8");
  await grouping("D:/CZL00-E05", ImpIPC2581.parse(R(`${S}/e05/e05_ipc2581.xml`), "e05"), "CZL00-E05 (Allegro gerber + CPL)");
  await grouping("D:/czl00_layout/CZL00_PCB01_开发板_V1.1/嘉立创生产文件", ImpIPC2581.parse(R(`${S}/allegro_v11/v11_ipc2581.xml`), "v11"), "CZL00 PCB01 V1.1 (JLC gerber + CPL)");
  for (const b of ["gateway", "motor"]) await grouping(`${S}/kicad/${b}/fab2`, ImpKiCad.parse(R(`${S}/../golenz/${b}/${b}.kicad_pcb`), b), `golenz ${b} (KiCad gerber + pos)`);
})();
