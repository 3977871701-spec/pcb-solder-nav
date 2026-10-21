// Bundles src/ into the single-file index.html (no dependencies). Usage: node build.js
const fs = require("fs"), path = require("path");
const SRC = path.join(__dirname, "src");
const MODULES = ["core/geom.js", "core/files.js", "core/tables.js", "import/kicad.js", "import/ipc2581.js", "import/easyeda.js",
  "import/gerber.js", "import/fab.js", "import/odb.js", "import/altium.js", "core/project.js", "enrich.js", "app.js"];
const js = MODULES.map(f => `// ===== ${f} =====\n` + fs.readFileSync(path.join(SRC, f), "utf8").replace(/<\/script/gi, "<\/script")).join("\n");
let html = fs.readFileSync(path.join(SRC, "shell.html"), "utf8");
html = html.replace("/*__MODULES__*/", () => js);
if (!/^<!doctype/i.test(html)) html = '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' + html.replace(/<meta name="claude:viewport-fit-sides"[^>]*>\n?/, "");
fs.writeFileSync(path.join(__dirname, "index.html"), html);
console.log("index.html", (html.length / 1024).toFixed(0) + " KB");
