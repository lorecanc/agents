#!/usr/bin/env python3
"""
render_comp_assets.py — Pre-rasterize composition decoration layers to PNG.

Generates gradient, pattern, and blurred orb PNGs for PPTX-compatible
slide export. Called by slide_compile_composition.ts during compilation.

Usage (stdin JSON):
  python3 render_comp_assets.py < commands.json

commands.json format:
  [
    { "type": "gradient", "output": "path.png", "width": 1280, "height": 720,
      "gradient_type": "linear", "angle": 135, "colors": ["#ff0000", "#00ff00"] },
    { "type": "gradient", "output": "path.png", "width": 1280, "height": 720,
      "gradient_type": "radial", "cx": 0.2, "cy": 0.5, "colors": ["#1a2a6c", "#b21f1f", "#fdbb2d"] },
    { "type": "pattern", "output": "path.png", "width": 1280, "height": 720,
      "pattern_type": "dots", "dot_size": 1, "spacing": 24, "color": "#2563eb", "opacity": 0.06 },
    { "type": "pattern", "output": "path.png", "width": 1280, "height": 720,
      "pattern_type": "diagonals", "line_width": 1, "spacing": 16, "color": "#2563eb", "opacity": 0.04 },
    { "type": "pattern", "output": "path.png", "width": 1280, "height": 720,
      "pattern_type": "crosses", "dot_size": 1, "spacing": 24, "offset": 12, "color": "#2563eb", "opacity": 0.05 },
    { "type": "orb", "output": "path.png",
      "diameter": 400, "blur_radius": 100, "color": "#2563eb", "opacity": 0.08 }
  ]
"""

import json
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFilter


def parse_hex(hex_color: str) -> tuple[int, int, int]:
    hex_color = hex_color.lstrip("#")
    return int(hex_color[0:2], 16), int(hex_color[2:4], 16), int(hex_color[4:6], 16)


def lerp_color(c1: tuple[int, int, int], c2: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return (
        round(c1[0] + (c2[0] - c1[0]) * t),
        round(c1[1] + (c2[1] - c1[1]) * t),
        round(c1[2] + (c2[2] - c1[2]) * t),
    )


def sample_gradient(colors: list[str], t: float) -> tuple[int, int, int]:
    """Sample a multi-stop gradient at position t (0.0 to 1.0)."""
    t = max(0.0, min(1.0, t))
    n = len(colors)
    if n <= 1:
        return parse_hex(colors[0]) if colors else (0, 0, 0)
    idx_float = t * (n - 1)
    idx = int(idx_float)
    frac = idx_float - idx
    if idx >= n - 1:
        return parse_hex(colors[-1])
    c1 = parse_hex(colors[idx])
    c2 = parse_hex(colors[idx + 1])
    return lerp_color(c1, c2, frac)


def render_gradient(cmd: dict) -> Image.Image:
    w = cmd["width"]
    h = cmd["height"]
    colors = cmd["colors"]
    gt = cmd.get("gradient_type", "linear")

    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    pixels = img.load()

    if gt == "linear":
        angle = cmd.get("angle", 90)
        rad = math.radians(angle)
        cx, cy = w / 2, h / 2
        # gradient line direction
        dx = math.cos(rad)
        dy = math.sin(rad)
        # compute max projection distance for normalization
        max_proj = 0.0
        min_proj = float("inf")
        projections = []
        for py in range(h):
            for px in range(w):
                vx = px - cx
                vy = py - cy
                proj = vx * dx + vy * dy
                min_proj = min(min_proj, proj)
                max_proj = max(max_proj, proj)
                projections.append((px, py, proj))
        prange = max_proj - min_proj
        if prange == 0:
            c = sample_gradient(colors, 0.5)
            draw = ImageDraw.Draw(img)
            draw.rectangle([(0, 0), (w, h)], fill=(*c, 255))
        else:
            for px, py, proj in projections:
                t = (proj - min_proj) / prange
                c = sample_gradient(colors, t)
                pixels[px, py] = (*c, 255)

    elif gt == "radial":
        cx_rel = cmd.get("cx", 0.5)
        cy_rel = cmd.get("cy", 0.5)
        center_x = w * cx_rel
        center_y = h * cy_rel
        max_dist = 0.0
        distances = []
        for py in range(h):
            for px in range(w):
                d = math.sqrt((px - center_x) ** 2 + (py - center_y) ** 2)
                max_dist = max(max_dist, d)
                distances.append((px, py, d))
        if max_dist == 0:
            c = sample_gradient(colors, 0.5)
            draw = ImageDraw.Draw(img)
            draw.rectangle([(0, 0), (w, h)], fill=(*c, 255))
        else:
            for px, py, d in distances:
                t = d / max_dist
                c = sample_gradient(colors, t)
                pixels[px, py] = (*c, 255)
    else:
        c = parse_hex(colors[0]) if colors else (0, 0, 0)
        draw = ImageDraw.Draw(img)
        draw.rectangle([(0, 0), (w, h)], fill=(*c, 255))

    return img


def render_pattern(cmd: dict) -> Image.Image:
    w = cmd["width"]
    h = cmd["height"]
    color = parse_hex(cmd["color"])
    opacity = cmd.get("opacity", 1.0)
    alpha = round(255 * opacity)
    pt = cmd.get("pattern_type", "dots")

    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if pt == "dots":
        dot_size = cmd.get("dot_size", 1)
        spacing = cmd.get("spacing", 24)
        for y in range(0, h, spacing):
            for x in range(0, w, spacing):
                draw.ellipse([x - dot_size, y - dot_size, x + dot_size, y + dot_size], fill=(*color, alpha))
    elif pt == "diagonals":
        line_width = cmd.get("line_width", 1)
        spacing = cmd.get("spacing", 16)
        for i in range(-w - h, w + h, spacing):
            draw.line([(i, 0), (i + h, h)], fill=(*color, alpha), width=line_width)
    elif pt == "crosses":
        dot_size = cmd.get("dot_size", 1)
        spacing = cmd.get("spacing", 24)
        offset = cmd.get("offset", spacing // 2)
        for y in range(0, h, spacing):
            for x in range(0, w, spacing):
                draw.ellipse([x - dot_size, y - dot_size, x + dot_size, y + dot_size], fill=(*color, alpha))
        for y in range(offset, h, spacing):
            for x in range(offset, w, spacing):
                draw.ellipse([x - dot_size, y - dot_size, x + dot_size, y + dot_size], fill=(*color, alpha))

    return img


def render_orb(cmd: dict) -> Image.Image:
    diameter = cmd["diameter"]
    blur_radius = cmd.get("blur_radius", 100)
    color = parse_hex(cmd["color"])
    opacity = cmd.get("opacity", 1.0)
    alpha = round(255 * opacity)

    img = Image.new("RGBA", (diameter, diameter), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    center = diameter // 2
    solid_radius = diameter // 4
    draw.ellipse(
        [center - solid_radius, center - solid_radius, center + solid_radius, center + solid_radius],
        fill=(*color, alpha),
    )

    img = img.filter(ImageFilter.GaussianBlur(radius=blur_radius))
    return img


def render_command(cmd: dict) -> Image.Image:
    t = cmd["type"]
    if t == "gradient":
        return render_gradient(cmd)
    elif t == "pattern":
        return render_pattern(cmd)
    elif t == "orb":
        return render_orb(cmd)
    else:
        raise ValueError(f"Unknown render type: {t}")


def main():
    raw = sys.stdin.read()
    commands = json.loads(raw)

    for cmd in commands:
        output = cmd["output"]
        out_dir = os.path.dirname(output)
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
        img = render_command(cmd)
        img.save(output, "PNG")

    print(f"Rendered {len(commands)} asset(s)")


if __name__ == "__main__":
    main()
