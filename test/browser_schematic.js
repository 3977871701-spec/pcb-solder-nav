// End-to-end AD schematic test. Start Chrome on port 9223 and set SCH_RAR to the supplied archive.
const assert = require("assert"), fs = require("fs");
const delay = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  if (!process.env.SCH_RAR) throw new Error("Set SCH_RAR to the local .rar sample");
  const targets = await fetch("http://127.0.0.1:9223/json").then(r => r.json());
  const target = targets.find(t => t.type === "page" && t.url.includes("pcb-solder-nav/index.html"));
  if (!target) throw new Error("Open index.html in the Chrome debugging session on port 9223 first");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(), errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  async function evaluate(expression) {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async function waitFor(expression) {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await delay(60); }
    throw new Error("Timeout: " + expression);
  }
  async function screenshot(name) {
    await delay(180);
    const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(name, Buffer.from(r.data, "base64"));
  }
  const mockCloud = `(() => {
    globalThis.remoteRows = globalThis.remoteRows || [];
    Cloud.state = () => ({ configured: true, email: "test@example.com", url: "", anonKey: "" });
    Cloud.pull = async () => structuredClone(remoteRows);
    Cloud.push = async rows => { for (const row of rows) { const i = remoteRows.findIndex(r => r.board_key === row.board_key); if (i >= 0) remoteRows[i] = structuredClone(row); else remoteRows.push(structuredClone(row)); } };
  })()`;
  try {
    await send("Runtime.enable"); await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await send("Page.reload", { ignoreCache: true });
    await waitFor("globalThis.Cloud && typeof SCH !== 'undefined' && !!S.b");
    await evaluate(`(async () => { for (const b of await DB.all()) await DB.del(b.key); for (const d of await DB.all("schematics")) await DB.del(d.key, "schematics"); localStorage.clear(); SCH.docs = []; renderSchLibrary(); })()`);
    await evaluate(mockCloud);
    const bytes = fs.readFileSync(process.env.SCH_RAR).toString("base64");
    await evaluate(`ingest([{ path: "电源原理图.rar", size: ${bytes.length}, read: async () => Uint8Array.from(atob("${bytes}"), c => c.charCodeAt(0)) }])`);
    assert.equal(await evaluate("SCH.docs.length"), 3);
    assert.equal(await evaluate("SCH.doc.title"), "AC-DC 整流滤波（图5-3）");
    assert.equal(await evaluate('$("#schDialog").open'), true);
    assert.equal(await evaluate('$("#schLibraryList").children.length'), 3);
    assert.equal(await evaluate('DB.all("schematics").then(x => x.length)'), 3);
    assert.equal(await evaluate("SCH.docs.reduce((n, d) => n + d.pins.length, 0)"), 424);
    assert.equal(await evaluate('SCH.docs[0].components[0].properties.SourceDesignator'), "C903");
    assert.equal(await evaluate('SCH.docs[2].components[0].footprint'), "AXIAL-0.4");
    await evaluate("syncBoards()");
    await waitFor('remoteRows.filter(r => r.payload?.schematic).length === 3');
    const cloudRows = await evaluate("remoteRows");
    assert.equal(await evaluate('remoteRows.every(r => !r.payload.schematic.adData)'), true);
    await evaluate("openSchematic(SCH.docs[0].key); schFit()");
    assert.equal(await evaluate("SCH.doc.shapes[0][1]"), "#0000ff");
    assert.deepEqual(await evaluate(`(() => { const d = structuredClone(SCH.doc); d.ver = 1; d.shapes[0][1] = "#ff0000"; const n = normalizeSchematic(d); return [n.ver, n.shapes[0][1], d.shapes[0][1]]; })()`), [2, "#0000ff", "#ff0000"]);
    assert.ok(Math.abs(await evaluate("SCH.vb.w") - await evaluate("SCH.doc.width + 10")) < 0.001);
    await evaluate('$("#schContentBtn").click()');
    assert.ok(await evaluate("SCH.vb.w") < await evaluate("SCH.doc.width"));
    assert.match(await evaluate('schSvg.querySelector(".sch-port").getAttribute("transform")'), /rotate\(0\)/);
    await screenshot("psn-sch-desktop.png");
    await evaluate("openSchematic(SCH.docs[2].key); schContent()");
    await screenshot("psn-sch-aux.png");
    await evaluate('openSchematic(SCH.docs[1].key); $("#schSearch").value = "T901"; schSearch()');
    assert.ok(await evaluate('$("#schSearchResults").children.length >= 1'));
    await evaluate('$("#schSearchResults button").click()');
    assert.ok((await evaluate('$("#schInspector").textContent')).includes("T901"));
    assert.ok(await evaluate('!!schSvg.querySelector(".sch-selection")'));
    const vbWidth = await evaluate("SCH.vb.w");
    await evaluate("schZoom(1.5)");
    assert.ok(await evaluate("SCH.vb.w") < vbWidth);
    await evaluate('$("#schLabels").click()');
    assert.equal(await evaluate('schSvg.querySelector(".sch-labels").hasAttribute("hidden")'), true);
    await evaluate('$("#schLabels").click(); openSchematic(SCH.docs[1].key); selectSchNet(SCH.doc.nets.findIndex(n => n.name === "GND"))');
    assert.ok((await evaluate('$("#schInspector").textContent')).includes("29 个器件引脚"));
    await screenshot("psn-sch-net.png");
    const downloadDir = fs.mkdtempSync(require("path").join(process.cwd(), ".sch-download-"));
    await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
    const waitDownload = async ext => {
      for (let i = 0; i < 50; i++) { const files = fs.readdirSync(downloadDir), name = files.find(f => f.endsWith(ext)); if (name && !files.some(f => f.endsWith(".crdownload"))) return require("path").join(downloadDir, name); await delay(100); }
      throw new Error("Download timeout: " + ext);
    };
    await evaluate('$("#schExportLib").click()');
    const libFile = await waitDownload(".SchLib"), libData = fs.readFileSync(libFile);
    assert.equal(libData[0], 0xd0); assert.equal(libData[1], 0xcf);
    require("../src/core/geom.js"); require("../src/import/altium.js"); require("../src/core/rar.js");
    const streams = ImpAltium.cfb(libData), header = ImpAltium.propsRecords(streams.FileHeader())[0];
    assert.equal(header.COMPCOUNT, "177");
    assert.equal(Object.keys(streams).filter(n => n.endsWith("/Data")).length, 177);
    await evaluate("openSchematic(SCH.docs[0].key); schFit()");
    await evaluate('$("#schExportDoc").click()');
    const docFile = await waitDownload(".SchDoc"), docData = fs.readFileSync(docFile);
    const sourceEntry = Rar.list(new Uint8Array(fs.readFileSync(process.env.SCH_RAR))).find(e => e.name.endsWith("01_AC_DC.SchDoc"));
    assert.equal(Buffer.compare(docData, Buffer.from(await sourceEntry.read())), 0, "SchDoc must be byte-identical to the original");
    fs.rmSync(downloadDir, { recursive: true, force: true });
    await send("Page.reload", { ignoreCache: true });
    await waitFor("typeof SCH !== 'undefined' && SCH.docs.length === 3");
    assert.equal(await evaluate('SCH.docs[0].title'), "AC-DC 整流滤波（图5-3）");
    await evaluate(`globalThis.remoteRows = ${JSON.stringify(cloudRows)}`);
    await evaluate(mockCloud);
    await evaluate('(async () => { globalThis.staleSchematic = structuredClone(SCH.docs[0]); for (const d of SCH.docs) { delete syncMeta[d.key]; await DB.del(d.key, "schematics"); } SCH.docs = []; SCH.doc = null; await syncBoards(); })()');
    assert.equal(await evaluate("SCH.docs.length"), 3);
    const deleted = await evaluate("SCH.docs[0].key");
    await evaluate(`(async () => { removeSchematic(${JSON.stringify(deleted)}); await syncBoards(); })()`);
    await waitFor(`remoteRows.find(r => r.board_key === ${JSON.stringify(deleted)})?.deleted === true`);
    assert.equal(await evaluate("SCH.docs.length"), 2);
    assert.equal(await evaluate('DB.all("schematics").then(x => x.length)'), 2);
    await evaluate(`(async () => { const d = staleSchematic; SCH.docs.push(d); syncMeta[d.key] = { updated: new Date(d.added).toISOString(), dirty: false, deleted: false }; await syncBoards(); })()`);
    assert.equal(await evaluate("SCH.docs.length"), 2);
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("showSchematics(); openSchematic(SCH.docs[0].key); schFit()");
    await screenshot("psn-sch-mobile.png");
    assert.equal(await evaluate('$("#schDialog").getBoundingClientRect().width'), 390);
    assert.equal(errors.length, 0, errors.map(e => e.exception?.description || e.text).join("\n"));
    console.log("PASS schematic browser: actual RAR, 3 sheets, 424 pins, UTF-8, search, network, zoom, native SchLib, byte-identical SchDoc, reload, cloud pull, cross-device deletion, mobile");
  } finally { ws.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
