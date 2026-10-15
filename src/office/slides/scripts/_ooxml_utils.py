"""
Shared OOXML utilities — namespace map, scheme colour resolution, EMU conversion.

Used by ``_text_style_extractor``, ``_vector_shape_extractor``, and
``analyze_slide_master`` to avoid duplicating constants and helpers.
"""

from __future__ import annotations

# ── XML namespace map (lxml) ───────────────────────────────────────────

_DML_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
_PML_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
_R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

NS: dict[str, str] = {"a": _DML_NS, "p": _PML_NS, "r": _R_NS}

# ── Scheme colour → theme token mapping (ECMA-376 §20.1.10.27) ────────

_SCHEME_TO_THEME: dict[str, str] = {
    "dk1": "dk1", "lt1": "lt1", "dk2": "dk2", "lt2": "lt2",
    "accent1": "accent1", "accent2": "accent2", "accent3": "accent3",
    "accent4": "accent4", "accent5": "accent5", "accent6": "accent6",
    "hlink": "hlink", "folHlink": "folHlink",
    "tx1": "dk1",   # Text 1  → Dark 1
    "tx2": "lt1",   # Text 2  → Light 1
    "bg1": "lt1",   # Bg  1   → Light 1
    "bg2": "dk2",   # Bg  2   → Dark 2
    "phClr": "phClr",
}


def resolve_scheme(scheme_val: str, theme_colors: dict[str, str]) -> str | None:
    """Resolve an OOXML scheme colour value to a concrete hex colour."""
    token = _SCHEME_TO_THEME.get(scheme_val, scheme_val)
    return theme_colors.get(token)


# ── EMU conversion ─────────────────────────────────────────────────────

def emu_to_px(emu: int) -> int:
    """Convert EMU → pixels at 96 DPI (1 inch = 914400 EMU)."""
    return round(emu / 914400 * 96)


def emu_to_pt(emu: int | None) -> float | None:
    """Convert EMU → points (1 pt = 12700 EMU)."""
    if emu is None:
        return None
    return round(emu / 12700, 1)
