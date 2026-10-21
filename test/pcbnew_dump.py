# Reference dump for tests: run with KiCad's Python —  python pcbnew_dump.py board.kicad_pcb out.json
import sys, json, math
import pcbnew

MM = 1e-6

def pt(p):
    return [round(p.x * MM, 4), round(p.y * MM, 4)]

def shape_to_geo(s):
    t = s.GetShape()
    w = round(s.GetWidth() * MM, 3)
    if t == pcbnew.SHAPE_T_SEGMENT:
        return {"t": "l", "a": pt(s.GetStart()), "b": pt(s.GetEnd()), "w": w}
    if t == pcbnew.SHAPE_T_RECTANGLE:
        return {"t": "r", "a": pt(s.GetStart()), "b": pt(s.GetEnd()), "w": w, "f": bool(s.IsSolidFill())}
    if t == pcbnew.SHAPE_T_CIRCLE:
        return {"t": "c", "c": pt(s.GetCenter()), "r": round(s.GetRadius() * MM, 4), "w": w, "f": bool(s.IsSolidFill())}
    if t == pcbnew.SHAPE_T_ARC:
        return {"t": "a", "a": pt(s.GetStart()), "m": pt(s.GetArcMid()), "b": pt(s.GetEnd()), "w": w}
    if t == pcbnew.SHAPE_T_POLY:
        out = []
        ps = s.GetPolyShape()
        for i in range(ps.OutlineCount()):
            o = ps.Outline(i)
            out.append([pt(o.CPoint(j)) for j in range(o.PointCount())])
        return {"t": "p", "pts": out, "w": w, "f": bool(s.IsSolidFill())}
    return None

def pad_poly(pad, layer):
    # polygon of pad outline in board coordinates
    try:
        poly = pcbnew.SHAPE_POLY_SET()
        pad.TransformShapeToPolygon(poly, layer, 0, 5000, pcbnew.ERROR_INSIDE)
        res = []
        for i in range(poly.OutlineCount()):
            o = poly.Outline(i)
            res.append([pt(o.CPoint(j)) for j in range(o.PointCount())])
        return res
    except Exception as e:
        return None

board = pcbnew.LoadBoard(sys.argv[1])
out = {"edges": [], "fps": [], "silk": {"F": [], "B": []}, "tracks": {"F": [], "B": []}}
for d in board.GetDrawings():
    if d.GetLayer() == pcbnew.Edge_Cuts and isinstance(d, pcbnew.PCB_SHAPE):
        g = shape_to_geo(d)
        if g: out["edges"].append(g)

for t in board.GetTracks():
    if t.GetClass() == "PCB_TRACK":
        L = "F" if t.GetLayer() == pcbnew.F_Cu else ("B" if t.GetLayer() == pcbnew.B_Cu else None)
        if L:
            out["tracks"][L].append([*pt(t.GetStart()), *pt(t.GetEnd()), round(t.GetWidth() * MM, 3)])

for fp in board.GetFootprints():
    side = "B" if fp.IsFlipped() else "F"
    cu = pcbnew.B_Cu if side == "B" else pcbnew.F_Cu
    pads = []
    for p in fp.Pads():
        on = p.IsOnLayer(cu)
        th = p.GetAttribute() in (pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH)
        if not on and not th:
            continue
        poly = pad_poly(p, cu if on else (pcbnew.F_Cu if p.IsOnLayer(pcbnew.F_Cu) else pcbnew.B_Cu))
        pads.append({"n": p.GetNumber(), "net": p.GetNetname(), "poly": poly,
                     "th": th, "pos": pt(p.GetPosition())})
    silk = []
    fab = []
    crt = []
    for g in fp.GraphicalItems():
        if not isinstance(g, pcbnew.PCB_SHAPE):
            continue
        ly = g.GetLayer()
        geo = shape_to_geo(g)
        if not geo: continue
        if ly in (pcbnew.F_SilkS, pcbnew.B_SilkS): silk.append(geo)
        elif ly in (pcbnew.F_Fab, pcbnew.B_Fab): fab.append(geo)
        elif ly in (pcbnew.F_CrtYd, pcbnew.B_CrtYd): crt.append(geo)
    bb = fp.GetBoundingBox(False)
    fields = {}
    for f in fp.GetFields():
        fields[f.GetName()] = f.GetText()
    out["fps"].append({
        "ref": fp.GetReference(), "val": fp.GetValue(), "side": side,
        "pos": pt(fp.GetPosition()), "rot": round(fp.GetOrientationDegrees(), 2),
        "fp": str(fp.GetFPID().GetLibItemName()),
        "dnp": bool(fp.IsDNP()), "nobom": bool(fp.IsExcludedFromBOM()),
        "smd": bool(fp.GetAttributes() & pcbnew.FP_SMD), "tht": bool(fp.GetAttributes() & pcbnew.FP_THROUGH_HOLE),
        "bbox": [*pt(bb.GetOrigin()), *pt(bb.GetEnd())],
        "pads": pads, "silk": silk, "fab": fab, "crt": crt,
        "fields": {k: v for k, v in fields.items() if k not in ("Reference", "Value", "Footprint")},
    })
for d in board.GetDrawings():
    ly = d.GetLayer()
    if ly in (pcbnew.F_SilkS, pcbnew.B_SilkS) and isinstance(d, pcbnew.PCB_SHAPE):
        g = shape_to_geo(d)
        if g: out["silk"]["F" if ly == pcbnew.F_SilkS else "B"].append(g)
json.dump(out, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)
print(len(out["fps"]), len(out["edges"]))
