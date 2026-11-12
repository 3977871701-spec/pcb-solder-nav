// AD schematic parser regression test. Set SCH_SAMPLES to a folder with the three supplied SchDoc files.
const assert = require("assert"), fs = require("fs"), path = require("path");
for (const f of ["core/files", "core/geom", "import/altium", "import/altium_sch"]) require("../src/" + f + ".js");
const dir = process.env.SCH_SAMPLES;
if (!dir) { console.log("SKIP Altium SchDoc: set SCH_SAMPLES to the local sample folder"); process.exit(0); }
const cases = [
  ["01_AC_DC.SchDoc", "AC-DC 整流滤波（图5-3）", 31, 69],
  ["02_Main_DC_DC.SchDoc", "主电源高压 DC-DC（图5-5）", 80, 200],
  ["03_Auxiliary.SchDoc", "副电源（图5-7）", 67, 155],
];
(async () => {
  for (const [name, title, count, pinCount] of cases) {
    const doc = ImpAltiumSch.parse(new Uint8Array(fs.readFileSync(path.join(dir, name))), name);
    assert.equal(doc.title, title);
    assert.equal(doc.ver, 2);
    assert.equal(doc.shapes[0][1], "#0000ff");
    assert.equal(doc.components.length, count);
    assert.equal(doc.pins.length, pinCount);
    assert.equal(doc.components.reduce((n, c) => n + c.pins.length, 0), pinCount);
    assert.ok(doc.components.every(c => c.ref && c.bb.every(Number.isFinite)));
    assert.ok(doc.pins.every(p => [p.x, p.y, p.ex, p.ey].every(Number.isFinite)));
    assert.ok(doc.nets.some(n => /^(GND|HV_RETURN)$/.test(n.name) && n.pins.length > 0));
    assert.ok(doc.pins.filter(p => p.netIndex >= 0).length > pinCount * 0.6);
    console.log(`PASS ${name}: ${count} components, ${pinCount} pins, ${doc.nets.filter(n => n.name).length} named nets, ${doc.components.filter(c => !c.footprint).length} unassigned footprints in source`);
  }
  const doc = ImpAltiumSch.parse(new Uint8Array(fs.readFileSync(path.join(dir, "03_Auxiliary.SchDoc"))), "03_Auxiliary.SchDoc");
  assert.equal(doc.components[0].footprint, "AXIAL-0.4");
  assert.equal(doc.components[0].properties.LCSC, "C173063");
  const ascii = "|HEADER=Protel for Windows - Schematic Capture Binary File Version 5.0\n|RECORD=31|USECUSTOMSHEET=T|CUSTOMX=500|CUSTOMY=400|FONTIDCOUNT=1|SIZE1=10|FONTNAME1=Times New Roman\n|RECORD=1|INDEXINSHEET=1|CURRENTPARTID=1|LIBREFERENCE=TEST_R1\n|RECORD=34|OWNERINDEX=1|TEXT=R1|FONTID=1\n";
  assert.equal(ImpAltiumSch.parse(new TextEncoder().encode(ascii), "ascii.SchDoc").components[0].ref, "R1");
  console.log("PASS ASCII SchDoc");
})().catch(e => { console.error(e); process.exitCode = 1; });
