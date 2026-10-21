// End-to-end: feed real folders / archives through Project.load and check the boards that come out.
// Usage: node test/e2e.js <path> [<path> ...]   (paths are folders or files; sample data is not in the repo)
const fs = require("fs"), path = require("path");
require("./harness.js");
function entriesOf(p) {
  const st = fs.statSync(p), base = path.basename(p), out = [];
  if (st.isFile()) return [{ path: base, size: st.size, read: async () => new Uint8Array(fs.readFileSync(p)) }];
  (function walk(dir, rel) {
    for (const n of fs.readdirSync(dir)) {
      const full = path.join(dir, n), r = rel + "/" + n, s = fs.statSync(full);
      if (s.isDirectory()) walk(full, r); else out.push({ path: r, size: s.size, read: async () => new Uint8Array(fs.readFileSync(full)) });
    }
  })(p, base);
  return out;
}
async function run(paths, { quiet = false } = {}) {
  const entries = paths.flatMap(entriesOf);
  const t0 = Date.now();
  const res = await Project.load(entries);
  if (!quiet) {
    console.log(`== ${paths.map(p => path.basename(p)).join(" + ")}  (${entries.length} files, ${Date.now() - t0} ms)`);
    for (const b of res.boards) {
      const B = b.board, pads = B.parts.reduce((s, p) => s + p.pads.length, 0), nets = new Set(B.parts.flatMap(p => p.pads.map(q => q[1]).filter(Boolean)));
      console.log(`  [${b.source}] ${b.name}  parts ${B.parts.length}, pads ${pads}, nets ${nets.size}, bottom ${B.parts.filter(p => p.s === "B").length}, bbox ${B.bbox.map(v => v.toFixed(1)).join(",")}, bom ${b.bomFile || "-"}${B.warn && B.warn.length ? "\n     warn: " + B.warn.join(" | ") : ""}`);
    }
    for (const n of res.notes) console.log("  note:", n);
    for (const e of res.errors) console.log("  ERROR:", e);
  }
  return res;
}
module.exports = { run, entriesOf };
if (require.main === module) run(process.argv.slice(2));
