// Compare two parsed boards of the same design that may use different origins: aligns by median component offset,
// then checks every pad (matched by pin number) after alignment.
function cmpBoards(a, b, label) {
  const A = Object.fromEntries(a.parts.map(p => [p.r, p])), B = Object.fromEntries(b.parts.map(p => [p.r, p]));
  const dupl = new Set(b.parts.filter(p => p.origRef).map(p => p.origRef)); // ambiguous: designator used several times in the design
  const common = Object.keys(A).filter(r => !dupl.has(r) && B[r] && A[r].pads.length && B[r].pads.length);
  const pc = p => { const xs = p.pads.map(q => q[4]), ys = p.pads.map(q => q[5]); return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]; };
  const dx = [], dy = [];
  for (const r of common) { const ca = pc(A[r]), cb = pc(B[r]); dx.push(cb[0] - ca[0]); dy.push(cb[1] - ca[1]); }
  const med = v => v.slice().sort((x, y) => x - y)[v.length >> 1];
  const ox = med(dx), oy = med(dy);
  let worst = 0, at = "", n = 0, netBad = 0, sideBad = [], netEx = [];
  for (const r of common) {
    if (A[r].s !== B[r].s) sideBad.push(r);
    for (const q of A[r].pads) {
      const cands = B[r].pads.filter(z => z[0] === q[0]); if (!cands.length) continue;
      const d = Math.min(...cands.map(z => Math.hypot(z[4] - q[4] - ox, z[5] - q[5] - oy))); n++;
      if (d > worst) { worst = d; at = r + "." + q[0]; }
      const z = cands[0]; if ((z[1] || "") !== (q[1] || "")) { netBad++; if (netEx.length < 4) netEx.push(`${r}.${q[0]}:${q[1]}|${z[1]}`); }
    }
  }
  console.log(`${worst < 0.03 && !sideBad.length ? "PASS" : "FAIL"} ${label}: common parts ${common.length}/${a.parts.length}/${b.parts.length}, offset ${ox.toFixed(3)},${oy.toFixed(3)}, pads ${n}, max err ${worst.toFixed(4)} (${at}), net diff ${netBad} ${netEx.join(" ")}, side diff ${sideBad.length} ${sideBad.slice(0, 5).join(",")}`);
  return { ox, oy, worst };
}
module.exports = { cmpBoards };
