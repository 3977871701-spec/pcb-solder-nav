// Generate and verify a native AD SchLib. Set SCH_RAR to the supplied archive.
const assert = require("assert"), fs = require("fs");
for (const f of ["core/files", "core/geom", "core/rar", "import/altium", "import/altium_sch", "export/altium_schlib"]) require("../src/" + f + ".js");
function records(data) {
  const out = [], dv = new DataView(data.buffer, data.byteOffset, data.byteLength); let p = 0;
  while (p + 4 <= data.length) {
    const len = dv.getUint32(p, true) & 0xffffff, binary = data[p + 3] === 1; p += 4;
    assert.ok(p + len <= data.length, "record exceeds Data stream");
    const payload = data.subarray(p, p + len); out.push({ binary, payload }); p += len;
  }
  assert.equal(p, data.length, "trailing bytes in Data stream"); return out;
}
function textRecords(data) {
  return records(data).filter(r => !r.binary).map(r => {
    const b = new Uint8Array(r.payload.length + 4); new DataView(b.buffer).setUint32(0, r.payload.length, true); b.set(r.payload, 4);
    return ImpAltium.propsRecords(b)[0];
  });
}
function pin(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  assert.equal(dv.getInt32(0, true), 2);
  const descriptionLength = data[12], p = 13 + descriptionLength;
  const readString = at => { const n = data[at]; return { text: new TextDecoder().decode(data.subarray(at + 1, at + 1 + n)), next: at + 1 + n }; };
  const name = readString(p + 13), number = readString(name.next);
  return { part: dv.getInt16(5, true), flags: data[p + 2], length: dv.getInt16(p + 3, true), x: dv.getInt16(p + 5, true), y: dv.getInt16(p + 7, true), name: name.text, number: number.text };
}
(async () => {
  if (!process.env.SCH_RAR) { console.log("SKIP SchLib: set SCH_RAR to the local sample archive"); return; }
  const entries = Rar.list(new Uint8Array(fs.readFileSync(process.env.SCH_RAR))), docs = [];
  for (const e of entries) if (e.name.endsWith(".SchDoc")) docs.push(ImpAltiumSch.parse(await e.read(), e.name));
  assert.equal(docs.length, 3);
  const result = AltiumSchLib.build(docs);
  assert.equal(result.components, 177); assert.equal(result.pins, 424);
  assert.equal(result.data[0], 0xd0); assert.equal(result.data[1], 0xcf);
  const streams = ImpAltium.cfb(result.data), names = Object.keys(streams).filter(n => n.endsWith("/Data"));
  assert.equal(names.length, 177);
  const header = ImpAltium.propsRecords(streams.FileHeader())[0];
  assert.match(header.HEADER, /Schematic Library Editor Binary File Version 5\.0/);
  assert.equal(header.COMPCOUNT, "177"); assert.equal(header.LIBREF0, "S1_C903");
  assert.equal(header.FONTIDCOUNT, "3"); assert.equal(header.SIZE1, "9"); assert.equal(header.SIZE2, "7");
  const first = textRecords(streams["S1_C903/Data"]());
  assert.equal(first[0].LIBREFERENCE, "S1_C903");
  assert.equal(first.find(r => r.RECORD === "34").TEXT, "C?");
  assert.equal(first.find(r => r.NAME === "Comment").TEXT, "0.4uF");
  const line = first.find(r => r.RECORD === "6");
  assert.equal(line.COLOR, "16711680");
  assert.equal(line.LOCATIONCOUNT, "2");
  assert.ok(Math.abs(+line.X1 + +(line.X1_FRAC || 0) / 100000 - 23.37784) < 0.001);
  assert.ok(Math.abs(+line.Y1 + +(line.Y1_FRAC || 0) / 100000 - 18.66595) < 0.001);
  assert.ok(textRecords(streams["S3_IC902/Data"]()).filter(r => r.RECORD === "4").every(r => r.FONTID === "2"));
  let pinCount = 0;
  for (const name of names) for (const r of records(streams[name]())) if (r.binary) pinCount++;
  assert.equal(pinCount, 424);
  const firstPin = pin(records(streams["S1_C903/Data"]()).find(r => r.binary).payload);
  assert.deepEqual([firstPin.x, firstPin.y, firstPin.number, firstPin.name, firstPin.flags], [12, 29, "1", "+", 33]);
  const dualData = streams["JRC4558_DUAL/Data"]();
  assert.equal(textRecords(dualData)[0].PARTCOUNT, "3");
  assert.deepEqual([...new Set(records(dualData).filter(r => r.binary).map(r => pin(r.payload).part))].sort(), [1, 2]);
  const unicode = AltiumSchLib.build([{ file: "unicode", shapes: [], texts: [], pins: [], components: [{ index: 0, ref: "R1", library: "TEST_R", description: "测试电阻", value: "10K", origin: [0, 0], bb: [-2, -2, 2, 2], properties: { Manufacturer: "中文参数" }, pins: [] }] }]);
  const text = textRecords(ImpAltium.cfb(unicode.data)["TEST_R/Data"]());
  assert.equal(text[0].COMPONENTDESCRIPTION, "测试电阻");
  assert.equal(text.find(r => r.NAME === "Manufacturer").TEXT, "中文参数");
  if (process.env.SCHLIB_OUT) fs.writeFileSync(process.env.SCHLIB_OUT, result.data);
  console.log(`PASS native SchLib: ${result.components} unique symbols, ${pinCount} binary pins, ${result.data.length} bytes, Unicode parameters`);
})().catch(e => { console.error(e); process.exitCode = 1; });
