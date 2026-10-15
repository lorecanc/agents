"""
Validate that HTML slide content does not overflow placeholder bounds.

Two modes:
  --browser (default): Uses Playwright to render the slide at 1280x720 and
    checks each [data-placeholder] div for scroll overflow.
  --static: Uses the capacity estimator to compare text length vs
    estimated capacity per placeholder (no browser needed).

Usage:
  python validate_bounds.py --slide slide_01.html              # Playwright
  python validate_bounds.py --static --slide slide_01.html     # static

Exit code 0 = all placeholders fit / within capacity
Exit code 1 = one or more placeholders overflow
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


# ── Static mode imports (lazy) ─────────────────────────────────────

def _import_capacity_estimator():
    """Lazy import to avoid dependency when running in browser mode."""
    from _capacity_estimator import (
        estimate_layout_capacity,
        count_text_content,
    )
    return estimate_layout_capacity, count_text_content


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


# ── ANSI helpers ───────────────────────────────────────────────────

def _status_ansi(status: str) -> str:
    if status == "OK":
        return "\033[32m\u2713\033[0m"
    if status == "WARN":
        return "\033[33m\u26a0\033[0m"
    if status == "OVERFLOW":
        return "\033[31m\u2717\033[0m"
    return status


def _pct_bar(pct: float, width: int = 20) -> str:
    filled = max(0, min(width, int(pct / 100 * width)))
    empty = width - filled
    color = "\033[32m" if pct <= 80 else "\033[33m" if pct <= 100 else "\033[31m"
    return f"{color}{'\u2588' * filled}\033[0m{'\u2591' * empty}"


# ── Static validation ──────────────────────────────────────────────

def validate_static(slide_path: Path, index_path: Path | None = None) -> dict[str, Any]:
    """Validate slide content against estimated capacity (no browser)."""
    if index_path is None:
        detected = _auto_detect_index()
        if detected:
            index_path = detected
        else:
            return {"ok": False, "error": "index.json not found. Use --index to specify.", "placeholders": [], "overflows": []}

    html = slide_path.read_text(encoding="utf-8")
    layout_match = re.search(r'data-layout="([^"]+)"', html)
    if not layout_match:
        return {"ok": False, "error": "No data-layout attribute found in slide HTML", "placeholders": [], "overflows": []}

    layout_name = layout_match.group(1)
    estimate_layout_capacity, count_text_content = _import_capacity_estimator()
    cap_result = estimate_layout_capacity(layout_name, index_path)
    if "error" in cap_result:
        return {"ok": False, "error": cap_result["error"], "placeholders": [], "overflows": []}

    counts = count_text_content(html)
    results = []
    overflows = []

    for ph in cap_result["placeholders"]:
        idx = ph.get("idx")
        actual = counts.get(idx, {"chars": 0, "words": 0})
        ph["actual_chars"] = actual["chars"]
        ph["actual_words"] = actual["words"]
        if ph["max_chars"] > 0:
            pct = round(actual["chars"] / ph["max_chars"] * 100, 1)
        else:
            pct = 0.0
        ph["pct"] = pct

        if pct <= 80:
            status = "OK"
        elif pct <= 100:
            status = "WARN"
        else:
            status = "OVERFLOW"
        ph["status"] = status

        results.append(ph)

        if status != "OK":
            overflows.append({
                "idx": idx,
                "type": ph.get("type"),
                "pct": pct,
                "actual_chars": actual["chars"],
                "max_chars": ph["max_chars"],
                "suggestion": (
                    f"reduce by ~{actual['chars'] - ph['max_chars']} chars"
                    if pct > 100
                    else f"at {pct}% capacity — consider reducing"
                ),
            })

    return {
        "ok": len(overflows) == 0,
        "layout": layout_name,
        "placeholders": results,
        "overflows": overflows,
    }


# ── Browser mode (Playwright) ──────────────────────────────────────

def validate_browser(slide_path: Path) -> dict:
    """Validate that all data-placeholder content fits within bounds using Playwright."""
    abs_path = slide_path.resolve()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return {
            "ok": False,
            "error": "playwright not installed. Run: pip install playwright && playwright install chromium",
            "placeholders": [],
            "overflows": [],
        }

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.goto(f"file://{abs_path}", wait_until="networkidle", timeout=15000)

        results = page.evaluate("""() => {
            const placeholders = document.querySelectorAll('[data-placeholder]');
            const results = [];
            const overflows = [];

            for (const ph of placeholders) {
                const type = ph.getAttribute('data-placeholder') || '?';
                const idx = ph.getAttribute('data-idx') || '?';
                const rect = ph.getBoundingClientRect();
                const overflowY = Math.max(0, ph.scrollHeight - ph.clientHeight);
                const overflowX = Math.max(0, ph.scrollWidth - ph.clientWidth);

                const entry = {
                    type: type,
                    idx: idx,
                    left: Math.round(rect.left),
                    top: Math.round(rect.top),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                    scrollWidth: Math.round(ph.scrollWidth),
                    scrollHeight: Math.round(ph.scrollHeight),
                    overflowX: Math.round(overflowX),
                    overflowY: Math.round(overflowY),
                    ok: overflowX <= 1 && overflowY <= 1,
                };

                results.push(entry);

                if (!entry.ok) {
                    const suggestion = entry.overflowY > 0
                        ? `reduce content by ~${Math.round(entry.overflowY / 14)} lines`
                        : `reduce horizontal content by ~${Math.round(entry.overflowX / 8)} chars`;
                    overflows.push({
                        idx: idx,
                        type: type,
                        overflowX: entry.overflowX,
                        overflowY: entry.overflowY,
                        suggestion: suggestion,
                    });
                }
            }

            return { placeholders: results, overflows: overflows };
        }""")

        browser.close()

    ok = len(results["overflows"]) == 0
    return {
        "ok": ok,
        "placeholders": results["placeholders"],
        "overflows": results["overflows"],
    }


# ── CLI ────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Validate HTML slide content bounds per-placeholder."
    )
    parser.add_argument("--slide", required=True, help="Path to HTML slide file")
    parser.add_argument("--static", action="store_true",
                        help="Static capacity check (no Playwright)")
    parser.add_argument("--index", default=None,
                        help="Path to index.json (auto-detected if omitted)")
    parser.add_argument("--json", action="store_true",
                        help="Output JSON (default for --browser, optional for --static)")
    args = parser.parse_args()

    slide_path = Path(args.slide)
    if not slide_path.exists():
        msg = f"Slide not found: {slide_path}"
        print(json.dumps({"ok": False, "error": msg}))
        sys.exit(1)

    if args.static:
        index_path = Path(args.index) if args.index else None
        result = validate_static(slide_path, index_path)

        if args.json:
            print(json.dumps(result, indent=2))
        else:
            print(f"\n  Slide: {slide_path.name}")
            layout_name_result = result.get("layout", "?")
            if not layout_name_result and result.get("placeholders"):
                layout_name_result = result["placeholders"][0].get("layout", "?")
            print(f"  Layout: {layout_name_result}")
            print()
            has_issues = False
            for ph in result.get("placeholders", []):
                pct = ph.get("pct", 0)
                status_icon = _status_ansi(ph.get("status", "?"))
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

                if ph.get("status") != "OK":
                    has_issues = True

            if not has_issues:
                print(f"\n  {_status_ansi('OK')} All placeholders within capacity.\n")
            else:
                print(f"\n  {_status_ansi('OVERFLOW')} Some placeholders exceed or approach capacity.\n")
    else:
        result = validate_browser(slide_path)
        print(json.dumps(result, indent=2))

    if not result.get("ok", False):
        sys.exit(1)


if __name__ == "__main__":
    main()
