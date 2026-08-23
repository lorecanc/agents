"""
Text style extraction from OOXML slide layout shapes.

Works on raw lxml elements to capture all text formatting from
a:bodyPr, a:lstStyle (per-level a:defRPr + paragraph props),
per-paragraph overrides, and per-run overrides.

Also handles master-level p:txStyles (title/body/other styles).

IMPORTANT — In OOXML, the "standard" color mapping defines how
tx1/tx2/bg1/bg2 reference the core theme scheme colours. Unless
a template provides an explicit <p:clrMap> override, the following
defaults apply (ECMA-376 §20.1.10.27):
  tx1 → dk1   tx2 → lt1   bg1 → lt1   bg2 → dk2
"""

from __future__ import annotations

import re
from typing import Any

from _ooxml_utils import NS, resolve_scheme


# ── Colour parser ──────────────────────────────────────────────────────

def _parse_color(
    element, theme_colors: dict[str, str]
) -> dict[str, Any] | None:
    if element is None:
        return None

    srgb = element.find("a:srgbClr", NS)
    if srgb is not None and srgb.get("val"):
        return {"hex": f"#{srgb.get('val')}"}

    scheme = element.find("a:schemeClr", NS)
    if scheme is not None and scheme.get("val"):
        sval = scheme.get("val")
        result: dict[str, Any] = {"scheme": sval}
        hex_val = resolve_scheme(sval, theme_colors)
        if hex_val:
            result["hex"] = hex_val
        return result

    sysc = element.find("a:sysClr", NS)
    if sysc is not None and sysc.get("lastClr"):
        return {"hex": f"#{sysc.get('lastClr')}"}

    return None


# ── Font name parser ───────────────────────────────────────────────────

def _parse_font_name(element) -> str | None:
    if element is None:
        return None
    return element.get("typeface") or None


# ── Spacing / line-spacing helpers ─────────────────────────────────────

def _parse_line_spacing(element) -> dict[str, Any] | None:
    if element is None:
        return None
    pct = element.find("a:spcPct", NS)
    if pct is not None:
        return {"percent": round(int(pct.get("val", "100000")) / 1000, 1)}
    pts = element.find("a:spcPts", NS)
    if pts is not None:
        return {"points": round(int(pts.get("val", "0")) / 100, 1)}
    return None


def _parse_spacing(element) -> dict[str, Any] | None:
    if element is None:
        return None
    pct = element.find("a:spcPct", NS)
    if pct is not None:
        return {"percent": round(int(pct.get("val", "0")) / 1000, 1)}
    pts = element.find("a:spcPts", NS)
    if pts is not None:
        return {"points": round(int(pts.get("val", "0")) / 100, 1)}
    return None


def _parse_bullet(element) -> dict[str, Any] | None:
    if element is None:
        return None
    bu_none = element.find("a:buNone", NS)
    if bu_none is not None:
        return None
    bu_char = element.find("a:buChar", NS)
    if bu_char is not None:
        result: dict[str, Any] = {"type": "char", "char": bu_char.get("char")}
        bu_font = element.find("a:buFont", NS)
        if bu_font is not None and bu_font.get("typeface"):
            result["font"] = bu_font.get("typeface")
        return result
    bu_auto = element.find("a:buAutoNum", NS)
    if bu_auto is not None:
        return {"type": "autoNum", "style": bu_auto.get("type")}
    return None


# ── Default-run-properties parser ──────────────────────────────────────

def _parse_def_rpr(
    rpr_el, theme_colors: dict[str, str]
) -> dict[str, Any]:
    """Parse a:defRPr or a:rPr element."""
    result: dict[str, Any] = {}

    sz = rpr_el.get("sz")
    if sz:
        result["font_size_pt"] = round(int(sz) / 100, 1)

    b = rpr_el.get("b")
    if b is not None:
        result["bold"] = b == "1"

    i = rpr_el.get("i")
    if i is not None:
        result["italic"] = i == "1"

    u = rpr_el.get("u")
    if u is not None:
        result["underline"] = u if u not in ("none", "0", "false") else False

    strike = rpr_el.get("strike")
    if strike is not None:
        result["strikethrough"] = strike in ("1", "sngStrike")

    kern = rpr_el.get("kern")
    if kern:
        result["kerning_pt"] = round(int(kern) / 100, 1)

    cap = rpr_el.get("cap")
    if cap:
        result["capitalization"] = cap

    baseline = rpr_el.get("baseline")
    if baseline:
        result["baseline_pt"] = round(int(baseline) / 1000, 1)

    solid_fill = rpr_el.find("a:solidFill", NS)
    if solid_fill is not None:
        color = _parse_color(solid_fill, theme_colors)
        if color:
            result["color"] = color

    latin = rpr_el.find("a:latin", NS)
    fn = _parse_font_name(latin)
    if fn:
        result["font_name"] = fn

    ea = rpr_el.find("a:ea", NS)
    fn = _parse_font_name(ea)
    if fn:
        result["font_name_ea"] = fn

    cs = rpr_el.find("a:cs", NS)
    fn = _parse_font_name(cs)
    if fn:
        result["font_name_cs"] = fn

    spc = rpr_el.find("a:spc", NS)
    if spc is not None and spc.get("val"):
        result["char_spacing_pt"] = round(int(spc.get("val")) / 100, 1)

    return result


# ── Main extraction ────────────────────────────────────────────────────

def extract_text_style(
    shape_element,
    theme_colors: dict[str, str],
) -> dict[str, Any] | None:
    """Extract full text styling from a shape's ``p:txBody`` element.

    Returns a dict with:
      - **body_pr**  — anchor, insets (in pt), text_direction, wrap, columns
      - **levels**   — per-level (1-9) ``paragraph`` + ``run`` default props
      - **paragraphs** — list of {level, alignment_override, margin_left_pt,
        indent_pt, runs: [{text, is_field?, overrides, lang}]}

    Returns ``None`` when the shape has no ``p:txBody``.
    """
    txBody = shape_element.find("p:txBody", NS)
    if txBody is None:
        return None

    result: dict[str, Any] = {}

    # ── bodyPr ───────────────────────────────────────
    body_pr_el = txBody.find("a:bodyPr", NS)
    if body_pr_el is not None:
        body: dict[str, Any] = {}
        for attr, prop_key in [
            ("anchor", "anchor"),
            ("vert", "text_direction"),
            ("wrap", "wrap"),
        ]:
            v = body_pr_el.get(attr)
            if v:
                body[prop_key] = v

        insets: dict[str, float] = {}
        for attr, prop_key in [
            ("lIns", "left"), ("tIns", "top"), ("rIns", "right"), ("bIns", "bottom")]:
            v = body_pr_el.get(attr)
            if v is not None:
                insets[prop_key] = round(int(v) / 12700, 1)
        if insets:
            body["insets_pt"] = insets

        nc = body_pr_el.get("numCol")
        if nc and int(nc) > 1:
            body["columns"] = int(nc)
            sc = body_pr_el.get("spcCol")
            if sc:
                body["column_spacing_pt"] = round(int(sc) / 12700, 1)

        if body:
            result["body_pr"] = body

    # ── lstStyle (per-level defaults) ────────────────
    lst_style_el = txBody.find("a:lstStyle", NS)
    levels: dict[str, dict[str, Any]] = {}
    if lst_style_el is not None:
        for lvl_idx in range(1, 10):
            lvl_el = lst_style_el.find(f"a:lvl{lvl_idx}pPr", NS)
            if lvl_el is None:
                continue
            lvl_data: dict[str, Any] = {}

            # ── Paragraph-level properties ──────────
            pp: dict[str, Any] = {}
            algn = lvl_el.get("algn")
            if algn:
                pp["alignment"] = algn  # l, ctr, r, just
            for attr, prop_key in [
                ("marL", "margin_left_pt"),
                ("marR", "margin_right_pt"),
                ("indent", "indent_pt"),
            ]:
                v = lvl_el.get(attr)
                if v:
                    pp[prop_key] = round(int(v) / 12700, 1)

            ls_el = lvl_el.find("a:lnSpc", NS)
            ls = _parse_line_spacing(ls_el)
            if ls is not None:
                pp["line_spacing"] = ls

            for tag, key in [("a:spcBef", "space_before"), ("a:spcAft", "space_after")]:
                el = lvl_el.find(tag, NS)
                sp = _parse_spacing(el)
                if sp is not None:
                    pp[key] = sp

            bullet = _parse_bullet(lvl_el)
            if bullet is not None:
                pp["bullet"] = bullet

            dt = lvl_el.get("defTabSz")
            if dt:
                pp["default_tab_size_pt"] = round(int(dt) / 12700, 1)

            if pp:
                lvl_data["paragraph"] = pp

            # ── Default run properties ───────────────
            def_rpr = lvl_el.find("a:defRPr", NS)
            if def_rpr is not None:
                rp = _parse_def_rpr(def_rpr, theme_colors)
                if rp:
                    lvl_data["run"] = rp

            if lvl_data:
                levels[str(lvl_idx)] = lvl_data

    if levels:
        result["levels"] = levels

    # ── Paragraphs & runs ────────────────────────────
    paragraphs: list[dict[str, Any]] = []
    for p_el in txBody.findall("a:p", NS):
        para: dict[str, Any] = {}

        p_pr = p_el.find("a:pPr", NS)
        if p_pr is not None:
            lvl = p_pr.get("lvl")
            if lvl is not None:
                para["level"] = int(lvl)
            for attr, prop_key in [
                ("algn", "alignment"),
                ("marL", "margin_left_pt"),
                ("indent", "indent_pt"),
            ]:
                v = p_pr.get(attr)
                if v:
                    para[prop_key] = v if attr == "algn" else round(int(v) / 12700, 1)

        runs: list[dict[str, Any]] = []

        for r_el in p_el.findall("a:r", NS):
            run: dict[str, Any] = {}
            t_el = r_el.find("a:t", NS)
            if t_el is not None and t_el.text is not None:
                run["text"] = t_el.text
            r_pr = r_el.find("a:rPr", NS)
            if r_pr is not None:
                overrides = _parse_def_rpr(r_pr, theme_colors)
                if overrides:
                    run["overrides"] = overrides
                lang = r_pr.get("lang")
                if lang:
                    run["lang"] = lang
            if run:
                runs.append(run)

        for fld_el in p_el.findall("a:fld", NS):
            t_el = fld_el.find("a:t", NS)
            text = t_el.text if (t_el is not None and t_el.text) else ""
            runs.append({"text": text, "is_field": True})

        # endParaRPr
        end_rpr = p_el.find("a:endParaRPr", NS)
        if end_rpr is not None:
            para["end_para_overrides"] = _parse_def_rpr(end_rpr, theme_colors)

        para["runs"] = runs
        paragraphs.append(para)

    if paragraphs:
        result["paragraphs"] = paragraphs

    if not result:
        return None
    return result


# ── Paragraph-level run defaults in lstStyle ───────────────────────────

def extract_lst_style_defaults(
    shape_element,
    theme_colors: dict[str, str],
    level: int = 1,
) -> dict[str, Any]:
    """Convenience: return the merged ``paragraph + run`` defaults
    for *level* from ``a:lstStyle``."""
    txBody = shape_element.find("p:txBody", NS)
    if txBody is None:
        return {}
    lst_style = txBody.find("a:lstStyle", NS)
    if lst_style is None:
        return {}

    lvl_el = lst_style.find(f"a:lvl{level}pPr", NS)
    if lvl_el is None:
        return {}

    result: dict[str, Any] = {}
    algn = lvl_el.get("algn")
    if algn:
        result["alignment"] = algn

    def_rpr = lvl_el.find("a:defRPr", NS)
    if def_rpr is not None:
        rp = _parse_def_rpr(def_rpr, theme_colors)
        if rp:
            result.update(rp)

    return result


# ── Master p:txStyles extraction ───────────────────────────────────────

def extract_master_text_styles(
    master_xml: bytes,
    theme_colors: dict[str, str],
) -> dict[str, Any]:
    """Extract ``p:txStyles`` from the slide master XML.

    Returns a dict with keys ``title``, ``body``, ``other``, each containing
    per-level (1-9) entries with ``paragraph`` and ``run`` defaults.
    """
    from lxml import etree

    root = etree.fromstring(master_xml)
    tx_styles = root.find(".//p:txStyles", NS)
    if tx_styles is None:
        return {}

    result: dict[str, Any] = {}

    for section_name in ("titleStyle", "bodyStyle", "otherStyle"):
        section = tx_styles.find(f"p:{section_name}", NS)
        if section is None:
            continue

        section_key = section_name.replace("Style", "")
        section_data: dict[str, dict[str, Any]] = {}

        for child in section:
            local = child.tag.split("}", 1)[-1] if "}" in child.tag else child.tag
            m = re.match(r"lvl(\d+)pPr", local)
            if not m:
                continue
            lvl_num = m.group(1)

            lvl_data: dict[str, Any] = {}

            pp: dict[str, Any] = {}
            algn = child.get("algn")
            if algn:
                pp["alignment"] = algn
            for attr, prop_key in [
                ("marL", "margin_left_pt"),
                ("marR", "margin_right_pt"),
                ("indent", "indent_pt"),
            ]:
                v = child.get(attr)
                if v:
                    pp[prop_key] = round(int(v) / 12700, 1)

            ls_el = child.find("a:lnSpc", NS)
            ls = _parse_line_spacing(ls_el)
            if ls is not None:
                pp["line_spacing"] = ls

            for tag, pkey in [("a:spcBef", "space_before"), ("a:spcAft", "space_after")]:
                el = child.find(tag, NS)
                sp = _parse_spacing(el)
                if sp is not None:
                    pp[pkey] = sp

            bullet = _parse_bullet(child)
            if bullet is not None:
                pp["bullet"] = bullet

            dt = child.get("defTabSz")
            if dt:
                pp["default_tab_size_pt"] = round(int(dt) / 12700, 1)

            if pp:
                lvl_data["paragraph"] = pp

            def_rpr = child.find("a:defRPr", NS)
            if def_rpr is not None:
                rp = _parse_def_rpr(def_rpr, theme_colors)
                if rp:
                    lvl_data["run"] = rp

            if lvl_data:
                section_data[lvl_num] = lvl_data

        if section_data:
            result[section_key] = section_data

    return result
