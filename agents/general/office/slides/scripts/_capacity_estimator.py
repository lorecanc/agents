"""
Capacity estimator for corporate template placeholders.

Computes realistic maximum character/word capacity per placeholder based on:
- Placeholder dimensions (width, height in px = pt for PPTX estimation)
- Font size (from text_style levels, or default per type)
- Insets from body_pr (or PPTX defaults: l=7.5pt, r=7.5pt, t=3.6pt, b=3.6pt)
- Line height ratio (1.2x font size)
- Average character width ratio (0.55x font_pt for proportional fonts)
- Average word length (6 chars for Italian)

Usage:
  python3 _capacity_estimator.py --layout content_two_paragraphs_&_subtitles_white
  python3 _capacity_estimator.py --all
  python3 _capacity_estimator.py --slide slide_05.html
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any


# ── Configurable constants ──────────────────────────────────────────

CHAR_WIDTH_RATIO: float = 0.55
"""Average character width as a fraction of font_pt (proportional font ~0.55)."""

LINE_HEIGHT_RATIO: float = 1.2
"""Default line spacing multiplier (PPTX default for body text)."""

AVG_WORD_LEN: float = 6.0
"""Average word length in chars including trailing space (Italian ~6, English ~5.5)."""

DEFAULT_INSETS_PT: dict[str, float] = {
    "left": 7.5,
    "right": 7.5,
    "top": 3.6,
    "bottom": 3.6,
}
"""PPTX default text frame insets (0.1 inch l/r, 0.05 inch t/b)."""

_DEFAULT_FONT_SIZES: dict[str, float] = {
    "TITLE": 28.0,
    "CTR_TITLE": 28.0,
    "SUBTITLE": 16.0,
    "BODY": 14.0,
    "VERTICAL_BODY": 14.0,
    "PICTURE": 12.0,
}


# ── Core estimation ─────────────────────────────────────────────────


def _get_insets(ph: dict[str, Any]) -> dict[str, float]:
    """Extract insets from placeholder text_style, falling back to PPTX defaults."""
    ts = ph.get("text_style", {})
    body_pr = ts.get("body_pr", {})
    insets = body_pr.get("insets_pt", {})
    if not insets:
        return dict(DEFAULT_INSETS_PT)
    return {
        "left": insets.get("left", DEFAULT_INSETS_PT["left"]),
        "right": insets.get("right", DEFAULT_INSETS_PT["right"]),
        "top": insets.get("top", DEFAULT_INSETS_PT["top"]),
        "bottom": insets.get("bottom", DEFAULT_INSETS_PT["bottom"]),
    }


def _get_font_size(ph: dict[str, Any]) -> float:
    """Get effective font size for a placeholder from text_style or default per type."""
    ts = ph.get("text_style", {})
    levels = ts.get("levels", {})
    lvl1 = levels.get("1", levels.get("0", {}))
    run = lvl1.get("run", {})
    fs = run.get("font_size_pt")
    if fs is not None:
        return float(fs)
    return _DEFAULT_FONT_SIZES.get(ph.get("type", "BODY"), 14.0)


def estimate_placeholder_capacity(
    ph: dict[str, Any],
    *,
    char_width_ratio: float = CHAR_WIDTH_RATIO,
    line_height_ratio: float = LINE_HEIGHT_RATIO,
    avg_word_len: float = AVG_WORD_LEN,
) -> dict[str, Any]:
    """Compute capacity for a single placeholder.

    Args:
        ph: Placeholder dict from index.json format (keys: type, w, h, text_style, ...)
        char_width_ratio: Average character width as fraction of font_pt
        line_height_ratio: Line spacing multiplier
        avg_word_len: Average characters per word (including trailing space)

    Returns:
        dict with usable_w_pt, usable_h_pt, font_pt, max_chars, max_words,
        insets_pt, char_width_ratio, line_height_ratio
    """
    w_px: float = float(ph.get("w", 0))
    h_px: float = float(ph.get("h", 0))
    font_pt: float = _get_font_size(ph)
    insets: dict[str, float] = _get_insets(ph)

    # Treat px as pt (PPTX placeholder dimensions in pt ≈ px at 1280x720 viewport)
    w_pt = w_px
    h_pt = h_px

    usable_w_pt = w_pt - insets.get("left", 0) - insets.get("right", 0)
    usable_h_pt = h_pt - insets.get("top", 0) - insets.get("bottom", 0)

    if usable_w_pt <= 0 or usable_h_pt <= 0 or font_pt <= 0:
        return {
            "font_pt": font_pt,
            "usable_w_pt": max(usable_w_pt, 0),
            "usable_h_pt": max(usable_h_pt, 0),
            "max_chars": 0,
            "max_words": 0,
            "insets_pt": insets,
            "char_width_ratio": char_width_ratio,
            "line_height_ratio": line_height_ratio,
        }

    chars_per_line = usable_w_pt / (font_pt * char_width_ratio)
    line_height_pt = font_pt * line_height_ratio
    max_lines = usable_h_pt / line_height_pt

    max_chars = int(chars_per_line * max_lines)
    max_words = int(max_chars / avg_word_len)

    return {
        "font_pt": round(font_pt, 1),
        "usable_w_pt": round(usable_w_pt, 1),
        "usable_h_pt": round(usable_h_pt, 1),
        "max_chars": max(max_chars, 0),
        "max_words": max(max_words, 0),
        "insets_pt": insets,
        "char_width_ratio": char_width_ratio,
        "line_height_ratio": line_height_ratio,
    }


# ── Convenience for formatting ──────────────────────────────────────


def format_capacity_hint(cap: dict[str, Any]) -> str:
    """Format a capacity estimate for body-type placeholders (words + chars)."""
    return f"~{cap['max_words']} words / ~{cap['max_chars']} chars @{cap['font_pt']:.0f}pt"


def format_short_hint(cap: dict[str, Any]) -> str:
    """Short capacity string for TITLE/SUBTITLE (chars-only)."""
    return f"~{cap['max_chars']} chars @{cap['font_pt']:.0f}pt"


# ── Layout-level estimation ─────────────────────────────────────────


def estimate_layout_capacity(
    layout_name: str,
    index_path: str | Path,
    **kwargs: Any,
) -> dict[str, Any]:
    """Estimate capacity for all placeholders in a named layout."""
    index_path = Path(index_path)
    if not index_path.exists():
        return {"error": f"Index not found: {index_path}", "placeholders": []}
    idx = json.loads(index_path.read_text(encoding="utf-8"))
    layouts = idx.get("layouts", {})
    layout = layouts.get(layout_name)
    if not layout:
        return {"error": f"Layout '{layout_name}' not found in index", "placeholders": []}
    placeholders = layout.get("placeholders", [])
    results = []
    for ph in placeholders:
        cap = estimate_placeholder_capacity(ph, **kwargs)
        cap["idx"] = ph.get("idx")
        cap["type"] = ph.get("type")
        cap["w"] = ph.get("w")
        cap["h"] = ph.get("h")
        results.append(cap)
    return {"layout": layout_name, "placeholders": results}


# ── HTML slide text counting ────────────────────────────────────────


def count_text_content(html_text: str) -> dict[int, dict[str, int]]:
    """Parse HTML slide and count characters per placeholder idx.

    Returns:
        {idx: {"chars": N, "words": N}} for each data-placeholder
    """
    counts: dict[int, dict[str, int]] = {}

    pattern = re.compile(
        r'<div[^>]*data-placeholder="([^"]*)"[^>]*data-idx="(\d+)"[^>]*>'
        r"(.*?)</div>",
        re.DOTALL,
    )
    for match in pattern.finditer(html_text):
        idx = int(match.group(2))
        content = match.group(3)

        text = re.sub(r"<[^>]+>", "", content)
        text = re.sub(r"<!--.*?-->", "", text)
        text = re.sub(r"\s+", " ", text).strip()

        chars = len(text)
        words = len(text.split()) if text else 0
        counts[idx] = {"chars": chars, "words": words}

    return counts


# ── ANSI formatting for terminal output ─────────────────────────────

def _status_ansi(status: str) -> str:
    if status == "OK":
        return "\033[32m\u2713\033[0m"  # green ✓
    if status == "WARN":
        return "\033[33m\u26a0\033[0m"  # yellow ⚠
    if status == "OVERFLOW":
        return "\033[31m\u2717\033[0m"  # red ✗ (multiply sign ✗)
    return status


def _pct_bar(pct: float, width: int = 20) -> str:
    filled = max(0, min(width, int(pct / 100 * width)))
    empty = width - filled
    color = "\033[32m" if pct <= 80 else "\033[33m" if pct <= 100 else "\033[31m"
    block_filled = "\u2588"
    block_empty = "\u2591"
    reset = "\033[0m"
    return f"{color}{block_filled * filled}{reset}{block_empty * empty}"


# ── CLI ─────────────────────────────────────────────────────────────


def _auto_detect_index() -> Path | None:
    candidates: list[Path] = []
    home = Path.home()
    config_glob = list(
        (home / ".config/opencode/office/slides/design").glob("*/layouts/index.json")
    )
    for c in candidates + config_glob:
        if c.exists():
            return c
    return None


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(
        description="Estimate placeholder text capacity from template data or filled HTML."
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--layout",
        help="Layout name from index.json (e.g. content_two_paragraphs_&_subtitles_white)",
    )
    group.add_argument("--all", action="store_true", help="Estimate all layouts in index.json")
    group.add_argument("--slide", help="Path to a filled HTML slide file to validate")
    parser.add_argument("--index", default=None, help="Path to index.json")
    args = parser.parse_args()

    index_path: Path | None = None
    if args.index:
        index_path = Path(args.index)
    else:
        index_path = _auto_detect_index()
    if not index_path:
        print(json.dumps({"error": "index.json not found. Use --index to specify."}))
        sys.exit(1)

    if args.layout:
        result = estimate_layout_capacity(args.layout, index_path)
        print(json.dumps(result, indent=2))

    elif args.all:
        idx = json.loads(Path(index_path).read_text(encoding="utf-8"))
        layouts = idx.get("layouts", {})
        all_results: dict[str, Any] = {}
        for name in sorted(layouts.keys()):
            all_results[name] = estimate_layout_capacity(name, index_path)
        print(json.dumps(all_results, indent=2))

    elif args.slide:
        slide_path = Path(args.slide)
        if not slide_path.exists():
            print(json.dumps({"error": f"Slide not found: {slide_path}"}))
            sys.exit(1)
        html = slide_path.read_text(encoding="utf-8")
        layout_match = re.search(r'data-layout="([^"]+)"', html)
        if not layout_match:
            print(json.dumps({"error": "No data-layout attribute found in slide HTML"}))
            sys.exit(1)
        layout_name = layout_match.group(1)
        cap_result = estimate_layout_capacity(layout_name, index_path)
        if "error" in cap_result:
            print(json.dumps(cap_result))
            sys.exit(1)
        counts = count_text_content(html)

        has_issues = False
        for ph in cap_result["placeholders"]:
            idx = ph.get("idx")
            actual = counts.get(idx, {"chars": 0, "words": 0})
            ph["actual_chars"] = actual["chars"]
            ph["actual_words"] = actual["words"]
            if ph["max_chars"] > 0:
                ph["pct"] = round(actual["chars"] / ph["max_chars"] * 100, 1)
            else:
                ph["pct"] = 0.0
            ph["status"] = (
                "OK" if ph["pct"] <= 80 else ("WARN" if ph["pct"] <= 100 else "OVERFLOW")
            )

            pct = ph["pct"]
            status_icon = _status_ansi(ph["status"])
            bar = _pct_bar(pct)

            actual_words = ph.get("actual_words", 0)
            max_words = ph.get("max_words", 0)
            actual_chars = ph.get("actual_chars", 0)
            max_chars = ph.get("max_chars", 0)
            font_pt = ph.get("font_pt", 0)
            ptype = ph.get("type", "?")
            hidx = ph.get("idx", "?")

            print(
                f"  {status_icon} {ptype:<10} idx={hidx:<2} "
                f"{actual_words:>4}w / {actual_chars:>4}ch of "
                f"{max_words}w / {max_chars}ch "
                f"({pct:>5.1f}%) {bar}"
            )

            if ph["status"] != "OK":
                has_issues = True

        if not has_issues:
            print(f"\n  {_status_ansi('OK')} All placeholders within capacity.\n")
        else:
            print(f"\n  {_status_ansi('OVERFLOW')} Some placeholders exceed or approach capacity.\n")


if __name__ == "__main__":
    main()
