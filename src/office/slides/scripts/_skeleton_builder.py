"""
Shared skeleton-building utilities used by both analyze_slide_master.py
and generate_contracts.py. Contains: background colour mapping, layout
classification, capacity estimation, contract-comment formatting,
placeholder-div generation, and the canonical HTML template builder.

*Text style integration* — when a placeholder, immutable shape, or reserved
area carries a ``text_style`` dict (extracted from ``p:txBody`` XML),
the skeleton HTML includes inline CSS that reflects the actual font size,
colour, alignment, bold/italic, and vertical anchor of the template.
"""

from __future__ import annotations

import html
import re
from typing import Any, NamedTuple
from urllib.parse import urlparse

from _capacity_estimator import (
    estimate_placeholder_capacity,
    format_capacity_hint,
    format_short_hint,
)

# ---------------------------------------------------------------------------
# Viewport constants — change here and everywhere updates automatically
# ---------------------------------------------------------------------------

SLIDE_WIDTH_PX: int = 1280
SLIDE_HEIGHT_PX: int = 720

# ---------------------------------------------------------------------------
# SVG path: only M/Z/L/H/V/C/S/Q/T/A commands + numeric tokens
# ---------------------------------------------------------------------------

_SVG_PATH_RE = re.compile(r"^[MmZzLlHhVvCcSsQqTtAa0-9\s,.\-+eE]*$")

# Allowed URI schemes for logo_src / image attributes
_SAFE_URI_SCHEMES = frozenset({"", "https", "http", "data"})

# Theme fonts (set by generate_skeleton_html) for resolving +mj-lt / +mn-lt
_THEME_FONTS: dict[str, str] = {}


def _resolve_theme_font_ref(fn: str) -> str | None:
    if not fn or not fn.startswith("+"):
        return fn
    base = fn[1:].lower()
    if base.startswith("mj-"):
        return _THEME_FONTS.get("major") or fn
    if base.startswith("mn-"):
        return _THEME_FONTS.get("minor") or fn
    return fn


class SvgParts(NamedTuple):
    element: str
    view_box: str


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _safe_layout_name(name: str) -> str:
    """Normalise a layout name to a safe ASCII identifier used in HTML attributes
    and contract tags.

    Example: ``"Back Cover/Dark"`` -> ``"back_cover_dark"``
    """
    return name.lower().replace(" ", "_").replace("/", "_")


def _safe_img_src(src: str) -> str:
    """Validate and HTML-escape an image ``src`` URI.

    Returns an empty string when the URI scheme is not in the allow-list or
    when the path contains traversal sequences that escape the project
    directory (e.g. ``/../`` or ``..%2f``).
    """
    if not src:
        return ""
    parsed = urlparse(src)
    if parsed.scheme not in _SAFE_URI_SCHEMES:
        return ""
    # Allow simple "../" at the start (relative parent), reject traversal
    # patterns inside the path (e.g. "/../" or encoded variants)
    _decoded = src.replace("%2e%2e", "..").replace("%2E%2E", "..")
    if re.search(r"/\.\./", _decoded) or re.search(r"\\\.\.\\", _decoded):
        return ""
    return html.escape(src, quote=True)


def _validate_svg_path(path_d: str) -> str | None:
    """Return ``path_d`` unchanged when it contains only valid SVG path data,
    otherwise return ``None``.

    Rejects any string that includes characters outside the SVG path grammar
    (e.g. ``<``, ``>``, ``"`` which would break SVG injection).
    """
    if _SVG_PATH_RE.match(path_d):
        return path_d
    return None


def _unpack_geom(d: dict[str, Any], source: str = "") -> tuple[float, float, float, float]:
    """Unpack ``x``, ``y``, ``w``, ``h`` from a shape dict with a clear error
    when any key is missing.
    """
    try:
        return d["x"], d["y"], d["w"], d["h"]
    except KeyError as exc:
        label = f" in {source!r}" if source else ""
        raise ValueError(f"Shape missing geometry key {exc}{label}") from exc


# ---------------------------------------------------------------------------
# Layout classification
# ---------------------------------------------------------------------------

# Ordered list of (name_prefix, category) rules evaluated before structural
# analysis.  Source: Open XML ST_PlaceholderType enum + bespoke naming
# conventions.  More specific prefixes must appear before less specific ones.
_NAME_PREFIX_RULES: list[tuple[str, str]] = [
    ("key_figures", "key_figures"),
    ("key ",        "key_figures"),
    ("team",        "team"),
    ("toc",         "table_of_contents"),
    ("table_of_contents", "table_of_contents"),
    ("map",         "map"),
    ("case_study",  "case_study"),
    ("case ",       "case_study"),
    ("quote",       "quote"),
    ("back_cover",  "back_cover"),
    ("back ",       "back_cover"),
    ("sub-cover",   "back_cover"),
]


def classify_layout(layout_name: str, placeholders: list[dict[str, Any]]) -> str:
    """Classify a layout based on its name prefix and content placeholder pattern.

    Evaluation order:
    1. Empty placeholder list -> ``blank``.
    2. Name-prefix rules (see ``_NAME_PREFIX_RULES``).
    3. Structural rules based on placeholder type set / counts.
    """
    types = sorted(p["type"] for p in placeholders)
    name_lower = layout_name.lower()

    if not types:
        return "blank"

    # --- Name-prefix dispatch ---
    for prefix, category in _NAME_PREFIX_RULES:
        if name_lower.startswith(prefix):
            return category

    # --- Structural dispatch ---
    type_set = set(types)

    if type_set in ({"CTR_TITLE"}, {"CTR_TITLE", "SUBTITLE"}):
        return "title_centered"
    if type_set == {"TITLE"}:
        return "title_left"
    if type_set == {"TITLE", "SUBTITLE"}:
        return "title_left_subtitle"

    body_count = types.count("BODY")
    has_picture = bool(type_set & {"PICTURE", "OBJECT", "BITMAP"})
    has_title = "TITLE" in type_set

    if has_title and body_count == 1 and not has_picture:
        return "content_1col"
    if has_title and body_count == 2 and not has_picture:
        return "content_2col"
    if has_title and body_count >= 3 and not has_picture:
        return "content_multicol"
    if has_title and body_count >= 1 and has_picture:
        return "content_text_image"
    if not has_title and body_count == 1:
        return "body_only_1col"
    if not has_title and body_count == 2:
        return "body_only_2col"
    if has_title and body_count == 0 and not has_picture:
        return "title_only"

    return "generic"


# ---------------------------------------------------------------------------
# Background colour -> category label
# ---------------------------------------------------------------------------

def _relative_luminance(r: float, g: float, b: float) -> float:
    """WCAG 2.0 relative luminance (sRGB linearised)."""
    def _linear(c: float) -> float:
        c_s = c / 255.0
        return c_s / 12.92 if c_s <= 0.03928 else ((c_s + 0.055) / 1.055) ** 2.4
    return 0.2126 * _linear(r) + 0.7152 * _linear(g) + 0.0722 * _linear(b)


def bg_hex_to_category(hex_str: str | None) -> str:
    """Classify a 6-char RGB hex background as ``"light"`` or ``"dark"``
    using WCAG relative luminance.

    Returns ``"unknown"`` when *hex_str* is missing, malformed, or too short.
    """
    if not hex_str:
        return "unknown"

    h = hex_str.upper().lstrip("#")

    if len(h) != 6:
        return "unknown"

    try:
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except ValueError:
        return "unknown"

    return "dark" if _relative_luminance(r, g, b) < 0.183 else "light"


def _rects_overlap(
    ax: float, ay: float, aw: float, ah: float,
    bx: float, by: float, bw: float, bh: float,
) -> bool:
    """Return ``True`` when two axis-aligned rectangles intersect."""
    return ax < bx + bw and ax + aw > bx and ay < by + bh and ay + ah > by


def _effective_bg_at(
    x: float, y: float, w: float, h: float,
    slide_bg_category: str,
    immutable_shapes: list[dict[str, Any]],
) -> str:
    """Determine whether the effective background behind a given rectangle is
    ``"light"`` or ``"dark"``, checking overlapping immutable shapes with
    solid fills in z-order (last overlapping shape wins).

    Falls back to *slide_bg_category* when no overlapping solid-fill shape is
    found or when the category cannot be determined.
    """
    effective = slide_bg_category
    for sh in immutable_shapes:
        if not _rects_overlap(x, y, w, h, sh["x"], sh["y"], sh["w"], sh["h"]):
            continue
        fill_info = sh.get("fill")
        if not fill_info:
            continue
        if isinstance(fill_info, dict):
            if fill_info.get("type") != "solid":
                continue
            color = fill_info.get("color", "")
        elif isinstance(fill_info, str):
            color = fill_info
        else:
            continue
        if color:
            cat = bg_hex_to_category(color)
            if cat != "unknown":
                effective = cat
    return effective


# ---------------------------------------------------------------------------
# Text-style helpers
# ---------------------------------------------------------------------------

# Maps Open XML ST_TextAnchoringType values to CSS flexbox align-items values.
_VERT_ANCHOR_MAP: dict[str, str] = {
    "t":    "flex-start",
    "ctr":  "center",
    "b":    "flex-end",
    "dist": "space-between",
    "just": "space-between",
}

# Maps Open XML ST_TextAlignType values to CSS text-align values.
_ALIGN_MAP: dict[str, str] = {
    "l":        "left",
    "ctr":      "center",
    "r":        "right",
    "just":     "justify",
    "dist":     "justify",
    "thaiDist": "justify",
}


def _build_run_css_parts(run: dict[str, Any]) -> list[str]:
    """Convert a run-level style dict to a list of CSS ``property:value`` strings."""
    parts: list[str] = []
    fs = run.get("font_size_pt")
    if fs:
        parts.append(f"font-size:{fs}pt")
    color_info = run.get("color", {})
    hex_c = color_info.get("hex") or color_info.get("resolved_hex")
    if hex_c:
        # hex_c is an internal resolved value — escape defensively
        parts.append(f"color:{html.escape(str(hex_c), quote=True)}")
    if run.get("bold") is True:
        parts.append("font-weight:bold")
    if run.get("italic") is True:
        parts.append("font-style:italic")
    fn = run.get("font_name")
    if fn:
        resolved = _resolve_theme_font_ref(fn)
        if resolved and not resolved.startswith("+"):
            parts.append(f"font-family:'{html.escape(str(resolved), quote=True)}',sans-serif")
    return parts


def _build_container_css(text_style: dict[str, Any] | None) -> str:
    """Generate inline CSS for a container ``<div>`` from a ``text_style`` dict.

    Reads ``body_pr`` (anchor / insets) and the first level's run + paragraph
    defaults.  Falls back gracefully when data is missing.

    Previously named ``_get_text_style_inline_css``.
    """
    if not text_style:
        return ""

    parts: list[str] = []

    # Body properties
    body = text_style.get("body_pr", {})
    anchor = body.get("anchor")
    if anchor:
        parts.append("display:flex")
        parts.append(f"align-items:{_VERT_ANCHOR_MAP.get(anchor, anchor)}")

    insets = body.get("insets_pt", {})
    if insets:
        for side, css_prop in (
            ("left",   "padding-left"),
            ("right",  "padding-right"),
            ("top",    "padding-top"),
            ("bottom", "padding-bottom"),
        ):
            val = insets.get(side)
            if val is not None and val != 0:
                parts.append(f"{css_prop}:{val}pt")

    # First level defaults
    levels = text_style.get("levels", {})
    lvl1 = levels.get("1") or levels.get("0") or {}

    run = lvl1.get("run", {})
    parts.extend(_build_run_css_parts(run))

    pp = lvl1.get("paragraph", {})
    algn_raw = pp.get("alignment")
    if algn_raw:
        css_align = _ALIGN_MAP.get(algn_raw, algn_raw)
        if css_align != "left":
            if anchor:
                jc_map = {
                    "center":  "center",
                    "right":   "flex-end",
                    "left":    "flex-start",
                    "justify": "flex-start",
                }
                parts.append(f"justify-content:{jc_map.get(css_align, css_align)}")
            parts.append(f"text-align:{css_align}")

    return ";".join(parts)


def _build_run_css(text_style: dict[str, Any] | None) -> str:
    """Generate inline CSS for a ``<span>`` element (run-level properties only).

    Used by ``assemble_from_template.py`` which reads inline styles from
    ``<span>`` elements and applies them to PPTX runs.  The container DIV's
    inline styles are intentionally NOT read for run-level properties.

    Previously named ``_get_run_style_inline_css``.
    """
    if not text_style:
        return ""
    levels = text_style.get("levels", {})
    lvl1 = levels.get("1") or levels.get("0") or {}
    run = lvl1.get("run", {})
    return ";".join(_build_run_css_parts(run))


def _get_text_style_summary(text_style: dict[str, Any] | None) -> str:
    """Return a compact one-line summary of the text style for the contract comment."""
    if not text_style:
        return ""
    levels = text_style.get("levels", {})
    lvl1 = levels.get("1", levels.get("0", {}))
    run = lvl1.get("run", {})
    pp = lvl1.get("paragraph", {})

    tokens: list[str] = []
    fs = run.get("font_size_pt")
    if fs:
        tokens.append(f"{fs}pt")
    if run.get("bold") is True:
        tokens.append("bold")
    if run.get("italic") is True:
        tokens.append("italic")

    color_info = run.get("color", {})
    hex_c = color_info.get("hex") or color_info.get("resolved_hex")
    scheme_c = color_info.get("scheme")
    if hex_c:
        tokens.append(str(hex_c))
    if scheme_c:
        tokens.append(f"({scheme_c})")

    algn_raw = pp.get("alignment")
    if algn_raw:
        tokens.append(_ALIGN_MAP.get(algn_raw, algn_raw))

    fn = run.get("font_name")
    if fn:
        tokens.append(str(fn))

    return " " + " ".join(tokens)


# ---------------------------------------------------------------------------
# Capacity estimation
# ---------------------------------------------------------------------------

def _capacity_estimate(ph: dict[str, Any]) -> str:
    """Return a human-readable capacity hint for a placeholder.

    Uses the shared ``_capacity_estimator`` module for precise font-size-aware
    estimates.  BODY/VERTICAL_BODY shows words + chars; TITLE/SUBTITLE shows
    chars; other types (PICTURE, etc.) show units.
    """
    ph_type = ph["type"]
    cap = estimate_placeholder_capacity(ph)

    if ph_type in ("BODY", "VERTICAL_BODY"):
        return format_capacity_hint(cap)
    if ph_type in ("TITLE", "CTR_TITLE", "SUBTITLE"):
        return format_short_hint(cap)
    return f"~{cap['max_chars']} units"


# ---------------------------------------------------------------------------
# Contract comment builders
# ---------------------------------------------------------------------------

def build_contract_comment(
    layout_name: str,
    category: str,
    placeholders: list[dict[str, Any]],
    *,
    reserved_areas: list[dict[str, Any]] | None = None,
    immutable_shapes: list[dict[str, Any]] | None = None,
) -> str:
    """Build the HTML comment block containing the layout contract."""
    safe_name = _safe_layout_name(layout_name)
    lines: list[str] = [
        f"CONTRACT: {safe_name}",
        f"Category: {category}",
        f"Viewport: {SLIDE_WIDTH_PX}x{SLIDE_HEIGHT_PX}",
        "",
    ]

    for ph in placeholders:
        idx = ph.get("idx", "?")
        ptype = ph["type"]
        x, y, w, h = _unpack_geom(ph, source=f"placeholder idx={idx}")
        cap = _capacity_estimate(ph)
        style_summary = _get_text_style_summary(ph.get("text_style"))
        default_text = ph.get("default_text", "")
        text_desc = f' "{default_text}"' if default_text else ""
        lines.append(
            f"CONTENT  idx={idx:<3} {ptype:<16} ({x:>4},{y:>4})"
            f"  {w:>4}x{h:>4}px  {cap}{style_summary}{text_desc}"
        )

    if reserved_areas:
        lines.append("")
        for ra in reserved_areas:
            ptype = ra["type"]
            x, y, w, h = _unpack_geom(ra, source=f"reserved {ptype}")
            text = ra.get("text", "")
            desc = f' "{text}"' if text else ""
            lines.append(
                f"RESERVED       {ptype:<16} ({x:>4},{y:>4})"
                f"  {w:>4}x{h:>4}px{desc} (in slide master, do not fill)"
            )

    if immutable_shapes:
        lines.append("")
        for sh in immutable_shapes:
            shape_label = sh.get("shape_type", "shape")
            sub = sh.get("subtype", "")
            label = f"{shape_label}/{sub}" if sub else shape_label
            x, y, w, h = _unpack_geom(sh, source=f"immutable {label}")
            fill = sh.get("fill", "")
            text = sh.get("text", "")
            desc_parts: list[str] = []
            if fill:
                desc_parts.append(f"fill={fill}")
            if text:
                desc_parts.append(f'text="{text}"')
            desc = " " + " ".join(desc_parts) if desc_parts else ""
            lines.append(
                f"IMMUTABLE      {label:<16} ({x:>4},{y:>4})"
                f"  {w:>4}x{h:>4}px{desc} (decoration, do not fill)"
            )

    return "\n".join(f"  {line}" for line in lines)


def build_contract_tag(
    layout_name: str,
    category: str,
    placeholders: list[dict[str, Any]],
    *,
    reserved_areas: list[dict[str, Any]] | None = None,
    immutable_shapes: list[dict[str, Any]] | None = None,
) -> str:
    """Build the complete HTML contract comment tag."""
    body = build_contract_comment(
        layout_name, category, placeholders,
        reserved_areas=reserved_areas,
        immutable_shapes=immutable_shapes,
    )
    return f"  <!--\n{body}\n  -->"


# ---------------------------------------------------------------------------
# Contract presence check
# ---------------------------------------------------------------------------

def contract_already_embedded(html_text: str, layout_name: str) -> bool:
    """Return True when the contract comment for *layout_name* is already
    present in *html_text*.
    """
    safe_name = _safe_layout_name(layout_name)
    return f"CONTRACT: {safe_name}" in html_text


# ---------------------------------------------------------------------------
# Shared positioned-div builder (eliminates duplication across three callers)
# ---------------------------------------------------------------------------

def _build_positioned_div(
    tag_attrs: str,
    x: float,
    y: float,
    w: float,
    h: float,
    text_style: dict[str, Any] | None,
    *,
    inner_content: str = "",
    extra_base_style: str = "",
) -> str:
    """Return a ``<div>`` string with absolute positioning and optional text-style CSS.

    Args:
        tag_attrs:       Additional ``key="value"`` attribute pairs inserted
                         after ``<div``.  Values must already be HTML-escaped
                         by the caller.
        x, y, w, h:     Pixel geometry.
        text_style:      Optional text-style dict; drives container CSS.
        inner_content:   Pre-built, already-escaped HTML for the div body.
        extra_base_style: Extra CSS appended to the base positional style
                          (e.g. ``background:#fff;``).
    """
    base_style = (
        f"position:absolute;left:{x}px;top:{y}px;width:{w}px;height:{h}px;"
        f"overflow:hidden;box-sizing:border-box;{extra_base_style}"
    )
    container_css = _build_container_css(text_style)
    style = base_style + container_css
    return f'  <div {tag_attrs} style="{style}">{inner_content}</div>'


# ---------------------------------------------------------------------------
# Placeholder div builder
# ---------------------------------------------------------------------------

def build_placeholder_divs(
    placeholders: list[dict[str, Any]],
    *,
    immutable_shapes: list[dict[str, Any]] | None = None,
    slide_bg_category: str = "unknown",
) -> list[str]:
    """Build placeholder ``<div>`` elements with text-style-driven inline CSS.

    When a placeholder has ``text_style``, the div gets font-size, colour,
    alignment, and vertical-anchor styling that mirrors the template.
    Default text is rendered inside styled ``<span>`` elements.

    When ``immutable_shapes`` is provided, each placeholder gets a
    ``data-placeholder-bg`` attribute (``"light"`` / ``"dark"``) computed
    from the effective background behind it — overlapping solid-fill
    immutable shapes are used to detect split/patterned layouts.
    """
    result: list[str] = []
    for ph in placeholders:
        label = ph["type"]
        idx = ph.get("idx", 0)
        x, y, w, h = _unpack_geom(ph, source=f"placeholder idx={idx}")

        container_css = _build_container_css(ph.get("text_style"))
        default_text = ph.get("default_text", "")
        span_css = _build_run_css(ph.get("text_style"))

        if default_text and container_css:
            span_style = f' style="{span_css}"' if span_css else ""
            inner = f'\n    <span{span_style}>{html.escape(default_text)}</span>\n  '
        else:
            # Safe: label is a controlled internal type string (e.g. "BODY"),
            # but escape defensively in case upstream data is unexpected.
            inner = f"\n    <!-- {html.escape(label)} content -->\n  "

        eff_bg = (
            _effective_bg_at(x, y, w, h, slide_bg_category, immutable_shapes)
            if immutable_shapes
            else slide_bg_category
        )
        tag_attrs = (
            f'data-placeholder="{html.escape(label, quote=True)}" '
            f'data-idx="{html.escape(str(idx), quote=True)}" '
            f'data-placeholder-bg="{html.escape(eff_bg, quote=True)}"'
        )
        result.append(_build_positioned_div(tag_attrs, x, y, w, h, ph.get("text_style"), inner_content=inner))
    return result


# ---------------------------------------------------------------------------
# Reserved-area div builder
# ---------------------------------------------------------------------------

def build_reserved_divs(
    reserved_areas: list[dict[str, Any]],
    *,
    layout_logo_src: str = "",
) -> list[str]:
    """Build ``<div>`` elements for slide-master-inherited reserved areas.

    FOOTER and SLIDE_NUMBER divs carry text-style CSS from the master.

    When *layout_logo_src* is provided and the reserved area is of type
    LOGO, the layout-level logo image replaces the slide-master one.  This
    preserves the correct logo variant (light/dark) that was authored on
    the layout rather than always falling back to the master logo.
    """
    result: list[str] = []
    for ra in reserved_areas:
        ptype = ra["type"]
        x, y, w, h = _unpack_geom(ra, source=f"reserved {ptype}")

        tag_attrs = f'data-reserved="{html.escape(ptype, quote=True)}"'
        logo_src = layout_logo_src if ptype == "LOGO" and layout_logo_src else ra.get("logo_src", "")

        if logo_src:
            safe_src = _safe_img_src(logo_src)
            if safe_src:
                inner = f'\n    <img src="{safe_src}" alt="logo" style="width:100%;height:100%;">\n  '
            else:
                inner = "\n    <!-- logo: invalid src omitted -->\n  "
            result.append(_build_positioned_div(tag_attrs, x, y, w, h, ra.get("text_style"), inner_content=inner))
        else:
            text = ra.get("text", "")
            span_css = _build_run_css(ra.get("text_style"))
            span_style = f' style="{span_css}"' if span_css else ""
            inner = f"<span{span_style}>{html.escape(text)}</span>" if text else ""
            result.append(_build_positioned_div(tag_attrs, x, y, w, h, ra.get("text_style"), inner_content=inner))
    return result


# ---------------------------------------------------------------------------
# SVG colour helpers
# ---------------------------------------------------------------------------

def _color_info_to_svg(info: Any, add_hash: bool = True) -> str:
    """Extract an SVG-compatible colour value from fill/stroke info.

    Accepts both the new dict format (``{"type": "solid", "color": "#E50001"}``)
    and the legacy string format (``"E50001"``).
    """
    if info is None:
        return ""
    if isinstance(info, str):
        normalised = info if info.startswith("#") else f"#{info}"
        return normalised if add_hash else info
    if isinstance(info, dict):
        if info.get("type") == "noFill":
            return "none"
        color = info.get("color", "")
        return color if color.startswith("#") else (f"#{color}" if color else "")
    return ""


def _fill_to_svg(fill_info: Any) -> str:
    """Extract an SVG-compatible fill value from an ``immutable_shapes`` fill field."""
    return _color_info_to_svg(fill_info, add_hash=True)


def _stroke_to_svg(stroke_info: Any) -> str:
    """Extract an SVG ``stroke`` attribute value from stroke info."""
    return _color_info_to_svg(stroke_info, add_hash=True)


def _stroke_width_to_svg(stroke_info: Any) -> str:
    """Extract an SVG ``stroke-width`` attribute value as a string."""
    if not isinstance(stroke_info, dict):
        return ""
    w = stroke_info.get("width")
    return str(w) if w is not None else ""


def _stroke_width_to_svg_numeric(stroke_info: Any) -> float:
    """Extract stroke width as a float (default ``1.0``)."""
    if not isinstance(stroke_info, dict):
        return 1.0
    w = stroke_info.get("width")
    return float(w) if w is not None else 1.0


# ---------------------------------------------------------------------------
# SVG element builder for immutable shapes
# ---------------------------------------------------------------------------

def _build_inner_svg_element(sh: dict[str, Any]) -> SvgParts | None:
    """Return an ``SvgParts`` named tuple for a vector shape, or ``None`` when
    the shape has no usable / safe geometry.

    Security:
    - ``path_d`` is validated against ``_SVG_PATH_RE`` to prevent SVG injection.
    - ``svg_snippet`` is treated as trusted internal data (generated by the
      PPTX extractor, not user-supplied text); it is inserted verbatim.  If
      the upstream source ever becomes untrusted, sanitise it here with a
      library such as ``bleach`` or ``lxml``.
    """
    geometry = sh.get("geometry", {})
    if not geometry:
        return None

    w, h = sh["w"], sh["h"]
    svg_fill = _fill_to_svg(sh.get("fill"))
    svg_stroke = _stroke_to_svg(sh.get("stroke"))
    svg_sw = _stroke_width_to_svg(sh.get("stroke"))

    def _attrs(extra: str = "") -> str:
        parts: list[str] = []
        if svg_fill:
            parts.append(f'fill="{html.escape(svg_fill, quote=True)}"')
        if svg_stroke:
            parts.append(f'stroke="{html.escape(svg_stroke, quote=True)}"')
        if svg_sw:
            parts.append(f'stroke-width="{html.escape(svg_sw, quote=True)}"')
        if extra:
            parts.append(extra)
        return " ".join(parts)

    # Freeform path — validate before embedding
    path_d = geometry.get("path")
    if path_d:
        safe_path = _validate_svg_path(str(path_d))
        if safe_path is not None:
            pw = geometry.get("path_w", w * 1000)
            path_h = geometry.get("path_h", h * 1000)
            attrs = _attrs()
            return SvgParts(f'<path d="{safe_path}" {attrs}/>', f"0 0 {pw} {path_h}")
        # Path failed validation — skip this shape entirely
        return None

    # Preset geometry with SVG snippet (trusted internal source)
    svg_snippet = geometry.get("svg_snippet")
    if svg_snippet:
        g_attrs = _attrs()
        geometry_inner = f'<g {g_attrs}>{svg_snippet}</g>' if g_attrs else svg_snippet
        return SvgParts(geometry_inner, f"0 0 {w} {h}")

    return None


# ---------------------------------------------------------------------------
# Immutable-shape div / SVG builder
# ---------------------------------------------------------------------------

def build_immutable_divs(immutable_shapes: list[dict[str, Any]]) -> list[str]:
    """Build SVG or ``<div>`` elements for non-placeholder decorative shapes.

    Shapes with usable geometry (preset or custGeom) are rendered as inline
    SVG.  All others fall back to a plain coloured ``<div>`` (legacy behaviour).

    Immutable shapes that contain text render that text with any extracted
    text-style CSS.
    """
    result: list[str] = []
    for sh in immutable_shapes:
        shape_type = sh.get("shape_type", "shape")
        subtype = sh.get("subtype", "")
        x, y, w, h = _unpack_geom(sh, source=f"immutable {shape_type}")
        label = f"{shape_type}/{subtype}" if subtype else shape_type
        safe_label = html.escape(label, quote=True)

        # --- Image rendering path (PICTURE shapes) ---
        image_src = sh.get("image_src", "")
        if image_src:
            web_compatible = sh.get("web_compatible", True)
            safe_src = _safe_img_src(image_src)
            if safe_src and web_compatible:
                result.append(
                    f'  <img data-immutable data-shape="{safe_label}" '
                    f'src="{safe_src}" alt=""'
                    f' style="position:absolute;left:{x}px;top:{y}px;'
                    f'width:{w}px;height:{h}px;object-fit:contain;">'
                )
            else:
                dims = f"{w:.0f}×{h:.0f}px"
                reason = "image missing" if not safe_src else f"image format ({safe_src.rsplit('.', 1)[-1]}) not web-compatible"
                result.append(
                    f'  <div data-immutable data-shape="{safe_label}" '
                    f'style="position:absolute;left:{x}px;top:{y}px;'
                    f'width:{w}px;height:{h}px;overflow:hidden;box-sizing:border-box;'
                    f'background:#f0f0f0;border:1px dashed #ccc;">'
                    f'<span style="font-size:10px;color:#999;">{reason} [{dims}]</span></div>'
                )
            continue

        # --- SVG rendering path ---
        svg_parts = _build_inner_svg_element(sh)
        if svg_parts:
            inner, view_box = svg_parts.element, svg_parts.view_box

            # Build transform list (rotation + flips)
            transforms: list[str] = []
            rotation = sh.get("rotation", 0)
            if rotation:
                cx, cy = w / 2, h / 2
                transforms.append(f"rotate({rotation},{cx},{cy})")
            fliph = sh.get("flip_h", False)
            flipv = sh.get("flip_v", False)
            if fliph or flipv:
                sx = -1 if fliph else 1
                sy = -1 if flipv else 1
                cx, cy = w / 2, h / 2
                transforms.append(
                    f"translate({cx},{cy}) scale({sx},{sy}) translate({-cx},{-cy})"
                )
            transform_attr = (
                f' transform="{" ".join(transforms)}"' if transforms else ""
            )

            geometry_inner = (
                f'<g{transform_attr}>{inner}</g>' if transform_attr else inner
            )

            # Text content inside the SVG (outside the transform group)
            text = sh.get("text", "")
            if text:
                text_css = _build_run_css(sh.get("text_style"))
                safe_css = html.escape(text_css, quote=True)
                geometry_inner += (
                    f'<text x="50%" y="50%" text-anchor="middle" '
                    f'dominant-baseline="central" style="{safe_css}">'
                    f"{html.escape(text)}</text>"
                )

            # Ensure non-zero SVG dimensions for degenerate line shapes
            svg_w = w
            svg_h = h
            svg_vb = view_box
            if shape_type == "line":
                min_px = max(1, _stroke_width_to_svg_numeric(sh.get("stroke")))
                vb_parts = svg_vb.split()
                if svg_w == 0 and svg_h > 0 and len(vb_parts) == 4:
                    svg_w = min_px
                    svg_vb = f"0 0 {svg_w} {vb_parts[3]}"
                elif svg_h == 0 and svg_w > 0 and len(vb_parts) == 4:
                    svg_h = min_px
                    svg_vb = f"0 0 {vb_parts[2]} {svg_h}"

            result.append(
                f'  <svg data-immutable data-shape="{safe_label}"'
                f' style="position:absolute;left:{x}px;top:{y}px;'
                f'width:{svg_w}px;height:{svg_h}px;overflow:hidden;display:block;"'
                f' viewBox="{html.escape(svg_vb, quote=True)}">'
                f"{geometry_inner}</svg>"
            )
            continue

        # --- Fallback: plain <div> (legacy) ---
        fill_info = sh.get("fill", "")
        extra_style = ""
        if fill_info:
            bg_fill = _fill_to_svg(fill_info)
            if bg_fill:
                extra_style = f"background:{html.escape(bg_fill, quote=True)};"

        tag_attrs = f'data-immutable data-shape="{safe_label}"'
        text = sh.get("text", "")
        span_css = _build_run_css(sh.get("text_style"))
        span_style = f' style="{span_css}"' if span_css else ""
        inner = f"<span{span_style}>{html.escape(text)}</span>" if text else ""
        result.append(
            _build_positioned_div(
                tag_attrs, x, y, w, h, sh.get("text_style"),
                inner_content=inner,
                extra_base_style=extra_style,
            )
        )
    return result


# ---------------------------------------------------------------------------
# Per-layout background style builder
# ---------------------------------------------------------------------------

def _build_slide_bg_style(bg_hex: str | None, category: str) -> str:
    """Return a ``<style>`` block that applies the actual background hex colour
    for browser preview (no theme-variable dependency).

    When *bg_hex* is valid the style uses the literal colour.  When missing or
    invalid it falls back to theme variables (``"unknown"`` category).
    """
    # ── Resolve the CSS background value ──────────────────────────
    if bg_hex and category != "unknown":
        hex_clean = bg_hex.strip("#")
        if len(hex_clean) == 6:
            text_color = "#fff" if category == "dark" else "#111"
            bg_rule = f"background:#{hex_clean}; color:{text_color};"
        else:
            bg_rule = "background:var(--color-bg); color:var(--color-text-primary);"
    else:
        bg_rule = "background:var(--color-bg); color:var(--color-text-primary);"
        category = "unknown"

    return f"""\
    <style>
      .slide-layout[data-bg="{category}"] {{ {bg_rule} }}
      .slide-layout {{
        position:relative;
        width:{SLIDE_WIDTH_PX}px;
        height:{SLIDE_HEIGHT_PX}px;
        box-sizing:border-box;
      }}
      [data-placeholder] {{
        outline:1px dashed rgba(0,0,0,0.2);
        outline-offset:-1px;
      }}
      .slide-layout[data-bg="dark"] [data-placeholder]:not([data-placeholder-bg]) {{
        outline-color:rgba(255,255,255,0.2);
      }}
      [data-placeholder-bg="dark"] {{
        outline-color:rgba(255,255,255,0.2);
      }}
    </style>"""


def generate_skeleton_html(
    layout_name: str,
    placeholders: list[dict[str, Any]],
    *,
    bg_color: str | None = None,
    reserved_areas: list[dict[str, Any]] | None = None,
    immutable_shapes: list[dict[str, Any]] | None = None,
    theme_fonts: dict[str, str] | None = None,
) -> str:
    """Generate an HTML skeleton for a slide layout with positioned placeholders,
    reserved master-inherited elements, and immutable decorative shapes.

    All user-supplied string values are HTML-escaped before insertion.
    The ``<style>`` block is placed in ``<head>`` to produce valid HTML.
    """
    global _THEME_FONTS
    if theme_fonts:
        _THEME_FONTS = theme_fonts

    safe_name = _safe_layout_name(layout_name)
    category = classify_layout(layout_name, placeholders)
    bg_category = bg_hex_to_category(bg_color) if bg_color else "unknown"
    bg_style = _build_slide_bg_style(bg_color, bg_category)

    # ── Deduplicate: remove layout-level logo pictures that overlap the
    # master's reserved LOGO area (otherwise the same logo renders twice).
    # Before removing them, extract the layout-level logo source so the
    # LOGO reserved area can use the correct variant (light/dark) that was
    # authored for this layout, instead of always falling back to the
    # master logo.
    _shapes = list(immutable_shapes or [])
    layout_logo_src = ""
    if _shapes and reserved_areas:
        logo_ra = next((ra for ra in reserved_areas if ra["type"] == "LOGO"), None)
        if logo_ra:
            lx, ly, lw, lh = logo_ra["x"], logo_ra["y"], logo_ra["w"], logo_ra["h"]
            # Capture the first layout-level logo picture that overlaps the
            # master LOGO area (the template author put it there for a reason).
            for sh in _shapes:
                if (
                    sh.get("shape_type") == "picture"
                    and sh.get("image_src")
                    and _rects_overlap(sh["x"], sh["y"], sh["w"], sh["h"], lx, ly, lw, lh)
                ):
                    layout_logo_src = sh["image_src"]
                    break
            _shapes = [
                sh for sh in _shapes
                if not (
                    sh.get("shape_type") == "picture"
                    and _rects_overlap(sh["x"], sh["y"], sh["w"], sh["h"], lx, ly, lw, lh)
                )
            ]

    contract_tag = build_contract_tag(
        layout_name, category, placeholders,
        reserved_areas=reserved_areas,
        immutable_shapes=_shapes,
    )
    ph_divs = build_placeholder_divs(
        placeholders,
        immutable_shapes=_shapes,
        slide_bg_category=bg_category,
    )
    reserved_divs = build_reserved_divs(reserved_areas or [], layout_logo_src=layout_logo_src)
    immutable_divs = build_immutable_divs(_shapes)

    all_divs = "\n".join(immutable_divs + ph_divs + reserved_divs)

    # Escape values used inside HTML attributes
    safe_name_attr = html.escape(safe_name, quote=True)
    safe_bg_attr = html.escape(bg_category, quote=True)
    # safe_name used in <title> as text content (not an attribute)
    safe_name_title = html.escape(safe_name)

    return (
        f"<!DOCTYPE html>\n"
        f'<html lang="en">\n'
        f"<head>\n"
        f'  <meta charset="utf-8">\n'
        f'  <link rel="stylesheet" href="./_theme.css">\n'
        f"  <!-- Styling provided by _theme.css and _preset.css -->\n"
        f"{bg_style}\n"
        f"  <title>Layout: {safe_name_title}</title>\n"
        f"</head>\n"
        f'<body style="width:{SLIDE_WIDTH_PX}px;height:{SLIDE_HEIGHT_PX}px;'
        f'margin:0;padding:0;overflow:hidden;display:flex;">\n'
        f"{contract_tag}\n"
        f'  <section class="slide-layout"'
        f' data-layout="{safe_name_attr}"'
        f' data-bg="{safe_bg_attr}">\n'
        f"{all_divs}\n"
        f"  </section>\n"
        f"</body>\n"
        f"</html>\n"
    )