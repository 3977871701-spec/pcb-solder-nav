// Test helpers: load the browser modules into Node and compare a parsed board with a pcbnew reference dump.
const fs = require("fs"), path = require("path");
const SRC = path.join(__dirname, "..", "src");
const ORDER = ["core/geom.js", "core/files.js", "core/tables.js", "import/kicad.js", "import/ipc2581.js", "import/easyeda.js", "import/easyeda_std.js", "import/gerber.js", "import/fab.js", "import/odb.js", "import/altium.js", "core/project.js", "enrich.js"];
for (const f of ORDER) if (fs.existsSync(path.join(SRC, f))) require(path.join(SRC, f));

// reference: JSON written by test/pcbnew_dump.py  → {fps:[{ref, side, pads:[{n, net, poly:[[[x,y]...]]}]}]}
function compare(board, refJson, { tolPos = 0.02, label = "" } = {}) {
  const ref = JSON.parse(fs.readFileSync(refJson, "utf8"));
  let n = 0, worst = 0, worstAt = "", sizeWorst = 0, netBad = [], missingParts = [], missingPads = [], sideBad = [];
  const parts = Object.fromEntries(board.parts.map(p => [p.r, p]));
  for (const rf of ref.fps) {
    if (!rf.pads.length) continue;
    const p = parts[rf.ref]; if (!p) { missingParts.push(rf.ref); continue; }
    if (p.s !== rf.side) sideBad.push(rf.ref);
    const used = new Set();
    for (const rp of rf.pads) {
      const pts = rp.poly.flat(); if (!pts.length) continue;
      const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const sz = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      let best = -1, bd = 1e9;
      p.pads.forEach((q, i) => { if (used.has(i)) return; const d = Math.hypot(q[4] - cx, q[5] - cy) + (q[0] === rp.n ? 0 : 0.5); if (d < bd) { bd = d; best = i; } });
      if (best < 0) { missingPads.push(rf.ref + "." + rp.n); continue; }
      used.add(best); const q = p.pads[best];
      const d = Math.hypot(q[4] - cx, q[5] - cy); n++;
      if (d > worst) { worst = d; worstAt = rf.ref + "." + rp.n; }
      sizeWorst = Math.max(sizeWorst, Math.abs(q[6] - sz));
      if (q[0] !== rp.n && rp.n) netBad.push(`${rf.ref}.${rp.n}≠pin${q[0]}`);
      else if ((q[1] || "") !== (rp.net || "")) netBad.push(`${rf.ref}.${rp.n}:${q[1]}≠${rp.net}`);
    }
  }
  const ok = !missingParts.length && !missingPads.length && worst <= tolPos && !netBad.length && !sideBad.length;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: parts ${board.parts.length}, pads checked ${n}, max pos err ${worst.toFixed(4)}mm (${worstAt}), max size err ${sizeWorst.toFixed(4)}, ` +
    `net/pin mismatch ${netBad.length}${netBad.length ? " " + netBad.slice(0, 5).join(" ") : ""}, missing parts ${missingParts.length}${missingParts.length ? " " + missingParts.slice(0, 6).join(",") : ""}, missing pads ${missingPads.length}, side mismatch ${sideBad.length}`);
  return ok;
}
module.exports = { compare };
