// Compare a parsed board with JLC flying-probe pins (absolute pad positions computed by EasyEDA itself).
function cmpFly(board, fly, label) {
  const byRef = {}; for (const q of fly.pads) (byRef[q.ref] ||= []).push(q);
  let worst = 0, at = "", n = 0, netBad = 0, ex = [];
  for (const p of board.parts) {
    const fq = byRef[p.r]; if (!fq) continue;
    for (const q of fq) {
      const c = p.pads.filter(z => z[0] === q.pin); if (!c.length) continue;
      const d = Math.min(...c.map(z => Math.hypot(z[4] - q.x, z[5] + q.y))); n++;
      if (d > worst) { worst = d; at = p.r + "." + q.pin; }
      if ((c[0][1] || "") !== (q.net || "")) { netBad++; if (ex.length < 4) ex.push(`${p.r}.${q.pin}:${c[0][1]}|${q.net}`); }
    }
  }
  console.log(`${worst < 0.01 && !netBad ? "PASS" : "FAIL"} ${label}: pads ${n}/${fly.pads.length}, max err ${worst.toFixed(4)}mm (${at}), net diff ${netBad} ${ex.join(" ")}`);
}
module.exports = { cmpFly };
