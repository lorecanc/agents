"""
Generate / update layout contracts embedded in HTML skeleton files.

Reads index.json and regenerates skeleton HTML files with:
  - Contract comment (ASCII art dimensions + capacity estimates)
  - data-idx attributes on every placeholder
  - overflow:hidden; box-sizing:border-box; on every placeholder

Usage:
  python generate_contracts.py \
    --design-dir .opencode/office/slides/design/default-light/ \
    [--force]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from _skeleton_builder import (
    contract_already_embedded,
    generate_skeleton_html,
)


def regenerate_skeleton(
    layout_name: str,
    entry: dict[str, Any],
    *,
    reserved_areas: list[dict[str, Any]] | None = None,
    theme_fonts: dict[str, str] | None = None,
    force: bool = False,
) -> str | None:
    """Regenerate an HTML skeleton with embedded contract + data-idx.

    Args:
        layout_name: Safe layout key.
        entry: Layout entry from index.json (per-layout data).
        reserved_areas: Master-inherited elements (from index["master_elements"]).
        theme_fonts: Theme font family mapping (major/minor) from index.json.
        force: If True, regenerate even if contract already present.

    Returns the new HTML string, or None if no update needed.
    """
    layouts_dir = Path(entry.get("_layouts_dir", "."))
    html_path = layouts_dir / entry.get("file", "")

    if html_path.exists():
        existing = html_path.read_text("utf-8")
        if not force and contract_already_embedded(existing, layout_name):
            return None

    placeholders = entry.get("placeholders", [])
    bg_color = entry.get("bg_color")

    return generate_skeleton_html(
        layout_name=layout_name,
        placeholders=placeholders,
        bg_color=bg_color,
        reserved_areas=reserved_areas,
        immutable_shapes=entry.get("immutable_shapes"),
        theme_fonts=theme_fonts,
    )


def generate_contracts(
    design_dir: Path,
    *,
    force: bool = False,
) -> str:
    """Generate/update contracts for all layouts in a design system."""
    index_path = design_dir / "layouts" / "index.json"
    if not index_path.exists():
        return f"Error: index.json not found at {index_path}"

    index = json.loads(index_path.read_text("utf-8"))
    layouts = index.get("layouts", {})
    reserved_areas = index.get("master_elements", {}).get("reserved_areas")
    theme_fonts = index.get("theme_fonts")
    layouts_dir = design_dir / "layouts"
    total = len(layouts)

    updated = 0
    skipped = 0

    for safe_key, entry in layouts.items():
        entry["_layouts_dir"] = str(layouts_dir)
        html = regenerate_skeleton(safe_key, entry, reserved_areas=reserved_areas, theme_fonts=theme_fonts, force=force)
        if html is None:
            skipped += 1
            continue
        html_path = layouts_dir / entry.get("file", "")
        html_path.write_text(html, "utf-8")
        updated += 1

    lines = [
        f"Contracts generated for {updated}/{total} layouts",
        f"  {skipped} already up to date (skipped)",
        f"  Design dir: {design_dir}",
    ]
    return "\n".join(lines)


# ── CLI ──────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate layout contracts in HTML skeleton files."
    )
    parser.add_argument(
        "--design-dir", required=True,
        help="Path to design system directory (e.g. .opencode/office/slides/design/default-light/)"
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Regenerate all skeletons even if contracts already present"
    )
    args = parser.parse_args()
    print(generate_contracts(Path(args.design_dir), force=args.force))


if __name__ == "__main__":
    main()
