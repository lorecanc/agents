from __future__ import annotations
import base64, binascii, hashlib, hmac, mimetypes, re
from io import BytesIO
from pathlib import Path
from typing import Dict, Optional
from urllib.parse import parse_qs, urlsplit, urlunsplit
from urllib.request import Request, url2pathname, urlopen
from bs4.element import Tag
from cairosvg import svg2png
from docx.shared import Pt
from html_docx_css import _parse_length_to_pt
from html_docx_selectors import _compute_style_map

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif"}
_DEFAULT_MAX_IMAGE_WIDTH_PT = 400.0
_SHA256_RE = re.compile(r"\A[0-9a-fA-F]{64}\Z")
_MD5_RE = re.compile(r"\A[0-9a-fA-F]{32}\Z")


def verify_image_digest(
    data: bytes, expected_sha256: str | None = None, expected_md5: str | None = None
) -> bool:
    if expected_sha256 is not None:
        if not isinstance(expected_sha256, str) or not _SHA256_RE.fullmatch(expected_sha256):
            return False
        if not hmac.compare_digest(hashlib.sha256(data).hexdigest(), expected_sha256.lower()):
            return False
    if expected_md5 is not None:
        if not isinstance(expected_md5, str) or not _MD5_RE.fullmatch(expected_md5):
            return False
        if not hmac.compare_digest(hashlib.md5(data).hexdigest(), expected_md5.lower()):
            return False
    return True


def _image_digests(
    src: str, expected_sha256: str | None, expected_md5: str | None
) -> tuple[str | None, str | None]:
    parsed = urlsplit(src)
    query = parse_qs(parsed.query, keep_blank_values=True)
    fragment = parse_qs(parsed.fragment, keep_blank_values=True)

    def from_url(name: str) -> str | None:
        for params in (query, fragment):
            value = next((values[-1] for key, values in params.items() if key.lower() == name), None)
            if value is not None:
                return value
        return None

    if expected_sha256 is None:
        expected_sha256 = from_url("sha256")
    if expected_md5 is None:
        expected_md5 = from_url("md5")
    return expected_sha256, expected_md5


def _local_image_path(src: str) -> str:
    raw = src.split("#", 1)[0].split("?", 1)[0]
    parsed = urlsplit(raw)
    if parsed.scheme.lower() == "file":
        return url2pathname(parsed.path)
    return raw


def _is_image_path(src: str) -> bool:
    return Path(_local_image_path(src)).suffix.lower() in _IMAGE_EXTENSIONS


def embed_local_images(html: str, base_dir: Path) -> str:
    def _encode(
        src: str, expected_sha256: str | None = None, expected_md5: str | None = None
    ) -> str | None:
        if src.startswith("data:") or src.startswith("file://"):
            return None
        expected_sha256, expected_md5 = _image_digests(src, expected_sha256, expected_md5)
        if src.startswith("http://") or src.startswith("https://"):
            try:
                parsed = urlsplit(src)
                request_url = urlunsplit(parsed._replace(fragment=""))
                req = Request(request_url, headers={"User-Agent": "docs-agent"})
                with urlopen(req, timeout=20) as response:
                    data = response.read()
                if (expected_sha256 is not None or expected_md5 is not None) and not verify_image_digest(
                    data, expected_sha256, expected_md5
                ):
                    return None
                mime, _ = mimetypes.guess_type(parsed.path)
                mime = mime or "image/png"
                return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
            except Exception:
                return None
        local_src = _local_image_path(src)
        if not _is_image_path(local_src):
            return None
        img_path = (base_dir / local_src).resolve()
        if not img_path.exists():
            return None
        data = img_path.read_bytes()
        if (expected_sha256 is not None or expected_md5 is not None) and not verify_image_digest(
            data, expected_sha256, expected_md5
        ):
            return None
        mime, _ = mimetypes.guess_type(str(img_path))
        mime = mime or "image/png"
        return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"

    def replace_img_tag(match: re.Match) -> str:
        tag = match.group(0)
        src_match = re.search(r"""\bsrc\s*=\s*(?:(['"])(.*?)\1|([^\s>]+))""", tag, re.IGNORECASE)
        if not src_match:
            return tag

        def attribute(name: str) -> str | None:
            attr_match = re.search(
                rf"""\b{re.escape(name)}(?:\s*=\s*(?:(['"])(.*?)\1|([^\s>]+)))?""",
                tag,
                re.IGNORECASE,
            )
            if not attr_match:
                return None
            return attr_match.group(2) if attr_match.group(1) else (attr_match.group(3) or "")

        quote, src = src_match.group(1), src_match.group(2) if src_match.group(1) else src_match.group(3)
        data_uri = _encode(src, attribute("data-sha256"), attribute("data-md5"))
        if not data_uri:
            return tag
        quote = quote or '"'
        return f"{tag[:src_match.start()]}src={quote}{data_uri}{quote}{tag[src_match.end():]}"

    html = re.sub(r"<img\b[^>]*>", replace_img_tag, html, flags=re.IGNORECASE)

    def replace_src(match: re.Match) -> str:
        preceding_html = html[:match.start()].lower()
        if preceding_html.rfind("<img") > preceding_html.rfind(">"):
            return match.group(0)
        quote, src = match.group(1), match.group(2)
        data_uri = _encode(src)
        return f"src={quote}{data_uri}{quote}" if data_uri else match.group(0)

    def replace_css_url(match: re.Match) -> str:
        quote, src = match.group(1), match.group(2)
        data_uri = _encode(src)
        return f"url({quote}{data_uri}{quote})" if data_uri else match.group(0)

    def replace_href(match: re.Match) -> str:
        attr, quote, src = match.group(1), match.group(2), match.group(3)
        data_uri = _encode(src)
        return f"{attr}={quote}{data_uri}{quote}" if data_uri else match.group(0)

    html = re.sub(r'src=(["\'])((?!data:|https?://|file://)[^"\']+)\1', replace_src, html)
    html = re.sub(r'src=(["\'])(https?://[^"\']+)\1', replace_src, html)
    html = re.sub(r"url\(([\"']?)((?!data:|file://)[^\"')>\s]+)\1\)", replace_css_url, html)
    html = re.sub(r'(href|xlink:href|data)=(["\'])((?!data:|https?://|file://|#)[^"\']+)\2', replace_href, html)
    return html


def _add_svg_run(paragraph, node: Tag, parent_style: Dict[str, str]) -> None:
    style = node.get("style", "") or ""
    m = re.search(r"width\s*:\s*([\d.]+\s*(?:pt|px|em|rem)?)", style, re.IGNORECASE)
    width_pt = _parse_length_to_pt(m.group(1)) if m else None
    output_width = max(100, int((width_pt or 54) * (96 / 72) * 2))
    svg_xml = _svg_node_to_xml(node, output_width)
    try:
        png_bytes = svg2png(bytestring=svg_xml.encode("utf-8"))
    except Exception:
        return
    run = paragraph.add_run()
    _add_picture_safe(run, BytesIO(png_bytes), width_pt, None)


def _svg_node_to_xml(node: Tag, output_width: int) -> str:
    vb = node.get("viewbox", "")
    parts = re.split(r"[\s,]+", vb.strip())
    if len(parts) == 4:
        try:
            vb_w, vb_h = float(parts[2]), float(parts[3])
            aspect = vb_h / vb_w if vb_w else 1.0
        except ValueError:
            aspect = 1.0
    else:
        aspect = 1.0
    output_height = max(1, int(output_width * aspect))
    ns = node.get("xmlns", "http://www.w3.org/2000/svg")
    children_xml = "".join(_svg_child_to_xml(c) for c in node.children)
    return f'<svg xmlns="{ns}" viewBox="{vb}" width="{output_width}" height="{output_height}">{children_xml}</svg>'


def _svg_child_to_xml(node):
    from bs4.element import NavigableString
    if isinstance(node, NavigableString):
        return str(node)
    if not isinstance(node, Tag):
        return ""
    attrs = " ".join(f'{k}="{v}"' for k, v in node.attrs.items())
    inner = "".join(_svg_child_to_xml(c) for c in node.children)
    if inner:
        return f"<{node.name} {attrs}>{inner}</{node.name}>" if attrs else f"<{node.name}>{inner}</{node.name}>"
    return f"<{node.name} {attrs}/>" if attrs else f"<{node.name}/>"


def _add_image_run(paragraph, node: Tag, parent_style: Dict[str, str]) -> None:
    src = node.get("src", "") or ""
    if not src:
        return
    width_pt, height_pt = _extract_image_dimensions(node, parent_style)
    image_stream = _load_image_stream(src, node.get("data-sha256"), node.get("data-md5"))
    if image_stream is None:
        alt_text = (node.get("alt", "") or "").strip()
        if alt_text:
            paragraph.add_run(alt_text)
        return
    run = paragraph.add_run()
    if width_pt and height_pt:
        _add_picture_safe(run, image_stream, width_pt, height_pt)
    elif width_pt:
        _add_picture_safe(run, image_stream, width_pt, None)
    elif height_pt:
        _add_picture_safe(run, image_stream, None, height_pt)
    else:
        _add_picture_safe(run, image_stream, None, None)


def _extract_image_dimensions(node: Tag, parent_style: Dict[str, str]) -> tuple[Optional[float], Optional[float]]:
    style_map = _compute_style_map(node, [])
    width_value = style_map.get("width", "") or node.get("width", "")
    height_value = style_map.get("height", "") or node.get("height", "")
    width_pt = _parse_length_to_pt(str(width_value)) if width_value else None
    height_pt = _parse_length_to_pt(str(height_value)) if height_value else None
    if width_pt is None:
        width_pt = _parse_length_to_pt(str(parent_style.get("width", ""))) if parent_style.get("width") else None
    if height_pt is None:
        height_pt = _parse_length_to_pt(str(parent_style.get("height", ""))) if parent_style.get("height") else None
    cell_width_str = parent_style.get("_cell_width_pt", "")
    max_width_pt = float(cell_width_str) if cell_width_str else _DEFAULT_MAX_IMAGE_WIDTH_PT
    if width_pt is None:
        width_pt = max_width_pt
        height_pt = None
    elif width_pt > max_width_pt:
        width_pt = max_width_pt
        height_pt = None
    return width_pt, height_pt


def _load_image_stream(
    src: str, expected_sha256: str | None = None, expected_md5: str | None = None
) -> BytesIO | Path | None:
    expected_sha256, expected_md5 = _image_digests(src, expected_sha256, expected_md5)
    if src.startswith("data:image/"):
        return _load_data_image(src, expected_sha256, expected_md5)
    if src.startswith("http://") or src.startswith("https://"):
        try:
            parsed = urlsplit(src)
            request_url = urlunsplit(parsed._replace(fragment=""))
            request = Request(request_url, headers={"User-Agent": "docs-agent"})
            with urlopen(request, timeout=20) as response:
                data = response.read()
            if (expected_sha256 is not None or expected_md5 is not None) and not verify_image_digest(
                data, expected_sha256, expected_md5
            ):
                return None
            return BytesIO(data)
        except Exception:
            return None
    path = Path(_local_image_path(src))
    if path.exists():
        if expected_sha256 is not None or expected_md5 is not None:
            data = path.read_bytes()
            if not verify_image_digest(data, expected_sha256, expected_md5):
                return None
            if path.suffix.lower() == ".svg":
                return _convert_svg_to_png(data)
            return BytesIO(data)
        if path.suffix.lower() == ".svg":
            return _convert_svg_to_png(path.read_bytes())
        return path
    return None


def _load_data_image(
    src: str, expected_sha256: str | None = None, expected_md5: str | None = None
) -> BytesIO | None:
    try:
        header, encoded = src.split(",", 1)
    except ValueError:
        return None
    is_base64 = "base64" in header
    data = _decode_data_uri(encoded, is_base64)
    if data is None:
        return None
    if (expected_sha256 is not None or expected_md5 is not None) and not verify_image_digest(
        data, expected_sha256, expected_md5
    ):
        return None
    if "image/svg+xml" in header:
        return _convert_svg_to_png(data)
    return BytesIO(data) if data else None


def _decode_data_uri(encoded: str, is_base64: bool) -> Optional[bytes]:
    try:
        if is_base64:
            return base64.b64decode(encoded)
        return encoded.encode("utf-8")
    except (binascii.Error, UnicodeEncodeError):
        return None


def _convert_svg_to_png(svg_bytes: Optional[bytes]) -> BytesIO | None:
    if not svg_bytes:
        return None
    try:
        png_bytes = svg2png(bytestring=svg_bytes)
        return BytesIO(png_bytes)
    except Exception:
        return None


def _add_picture_safe(run, image_stream, width_pt: Optional[float], height_pt: Optional[float]) -> None:
    try:
        if width_pt is not None and height_pt is not None:
            run.add_picture(image_stream, width=Pt(width_pt), height=Pt(height_pt))
        elif width_pt is not None:
            run.add_picture(image_stream, width=Pt(width_pt))
        elif height_pt is not None:
            run.add_picture(image_stream, height=Pt(height_pt))
        else:
            run.add_picture(image_stream)
    except Exception:
        run.add_text("[image]")
