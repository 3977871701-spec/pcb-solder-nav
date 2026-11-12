// Browser integration test. Start Chrome with --remote-debugging-port=9222 and open index.html first.
const assert = require("assert"), fs = require("fs");
const delay = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const targets = await fetch("http://127.0.0.1:9222/json").then(r => r.json());
  const target = targets.find(t => t.type === "page" && t.url.includes("pcb-solder-nav"));
  if (!target) throw new Error("Open index.html in the Chrome debugging session first");
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
  async function screenshot(name) {
    await evaluate("scrollTo(0, 0)"); await delay(150);
    const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(name, Buffer.from(r.data, "base64"));
  }
  try {
    await send("Runtime.enable"); await send("Page.enable");
    await evaluate("(async () => { for (const b of await DB.all()) await DB.del(b.key); localStorage.clear(); })()");
    await send("Page.reload", { ignoreCache: true }); await delay(400);
    for (let i = 0; i < 50 && !(await evaluate("globalThis.Cloud && !!S.b")); i++) await delay(100);
    assert.equal(await evaluate("document.title"), "PCB 焊接导航");
    assert.equal(await evaluate("S.b.key"), "demo#builtin");
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await screenshot("psn-desktop.png");

    await evaluate(`(() => {
      globalThis.remoteRows = [];
      Cloud.state = () => ({ configured: true, email: "test@example.com", url: "", anonKey: "" });
      Cloud.pull = async () => structuredClone(remoteRows);
      Cloud.push = async rows => {
        for (const row of rows) {
          const i = remoteRows.findIndex(r => r.board_key === row.board_key);
          if (i >= 0) remoteRows[i] = structuredClone(row); else remoteRows.push(structuredClone(row));
        }
      };
    })()`);
    await evaluate(`ingest([{ path: "device-a/demo.kicad_pcb", size: DEMO.length, read: async () => new TextEncoder().encode(DEMO) }])`);
    const key = await evaluate("S.b.key");
    assert.ok(key.startsWith("device-a/"));
    await evaluate("syncBoards()");
    assert.equal(await evaluate(`remoteRows.find(r => r.board_key === ${JSON.stringify(key)}).deleted`), false);
    await evaluate(`doneAll[${JSON.stringify(key)}] = { C1: 1 }; saveDone(${JSON.stringify(key)}); syncBoards()`);
    assert.equal(await evaluate(`remoteRows.find(r => r.board_key === ${JSON.stringify(key)}).payload.done.C1`), 1);

    await evaluate(`(async () => {
      const k = ${JSON.stringify(key)};
      globalThis.secondDeviceCopy = structuredClone(S.boards.find(b => b.key === k));
      S.boards = S.boards.filter(b => b.key !== k); delete syncMeta[k]; await DB.del(k); dropProgress(k);
      await syncBoards();
    })()`);
    assert.equal(await evaluate(`S.boards.some(b => b.key === ${JSON.stringify(key)})`), true);
    assert.equal(await evaluate(`doneAll[${JSON.stringify(key)}].C1`), 1);

    await evaluate(`(async () => { removeBoard(${JSON.stringify(key)}); await syncBoards(); })()`);
    assert.equal(await evaluate(`remoteRows.find(r => r.board_key === ${JSON.stringify(key)}).deleted`), true);
    await evaluate(`(async () => {
      const k = ${JSON.stringify(key)}, row = remoteRows.find(r => r.board_key === k);
      S.boards.push(secondDeviceCopy); syncMeta[k] = { updated: secondDeviceCopy.added, dirty: false, deleted: false };
      await syncBoards();
    })()`);
    assert.equal(await evaluate(`S.boards.some(b => b.key === ${JSON.stringify(key)})`), false);
    await evaluate("syncBoards()");
    assert.equal(await evaluate(`S.boards.some(b => b.key === ${JSON.stringify(key)})`), false);

    await evaluate('$("#boardsBtn").click()');
    assert.equal(await evaluate('$("#boardsDialog").open'), true);
    assert.ok(await evaluate('$("#boardList").children.length >= 1'));
    await evaluate('$("#boardsDialog").close(); $("#syncBtn").click()');
    assert.equal(await evaluate('$("#cloudDialog").open'), true);
    await evaluate('$("#cloudDialog").close()');
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("document.documentElement.dataset.theme = 'light'");
    await screenshot("psn-mobile.png");
    assert.equal(errors.length, 0, errors.map(e => e.text).join("\n"));
    console.log("PASS browser: demo, real import, progress sync, second-device pull, synced deletion, dialogs, desktop/mobile rendering");
  } finally { ws.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
