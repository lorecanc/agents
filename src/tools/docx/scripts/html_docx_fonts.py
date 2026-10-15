"""Font embedding for DOCX files.

Embeds .woff2, .ttf, and .otf font files from a project's assets/fonts/
directory into an existing .docx file using direct ZIP manipulation.
"""

import zipfile
import io
from pathlib import Path
from xml.etree import ElementTree as ET


FONT_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"

CONTENT_TYPES = {
    ".woff2": "application/font-woff2",
    ".ttf": "application/x-font-ttf",
    ".otf": "application/x-font-opentype",
}

# OOXML font table namespace
WML_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def embed_fonts(docx_path: Path, fonts_dir: Path) -> int:
    """Embed font files from fonts_dir into the DOCX at docx_path.

    Returns the number of fonts embedded.
    """
    if not fonts_dir.exists():
        return 0

    font_files = []
    for ext in [".woff2", ".ttf", ".otf"]:
        font_files.extend(fonts_dir.glob(f"*{ext}"))
        font_files.extend(fonts_dir.glob(f"*{ext.upper()}"))

    if not font_files:
        return 0

    # ── Read existing DOCX ─────────────────────────────────────
    with zipfile.ZipFile(docx_path, "r") as zin:
        zip_data = {name: zin.read(name) for name in zin.namelist()}

    # ── Update [Content_Types].xml ─────────────────────────────
    ct_xml = zip_data.get("[Content_Types].xml")
    if ct_xml is None:
        return 0
    ct_root = ET.fromstring(ct_xml)
    existing_exts = set()
    for child in ct_root:
        ext = child.get("Extension")
        if ext:
            existing_exts.add(ext.lower())

    for font_file in font_files:
        ext = font_file.suffix.lower()
        if ext not in existing_exts and ext in CONTENT_TYPES:
            ET.SubElement(
                ct_root,
                f"{{{CONTENT_TYPES_NS}}}Default",
                {"Extension": ext.lstrip("."), "ContentType": CONTENT_TYPES[ext]},
            )
            existing_exts.add(ext)
    zip_data["[Content_Types].xml"] = _xml_tostring(ct_root)

    # ── Update word/_rels/document.xml.rels ────────────────────
    rels_path = "word/_rels/document.xml.rels"
    rels_xml = zip_data.get(rels_path)
    if rels_xml is None:
        return 0
    rels_root = ET.fromstring(rels_xml)

    # Find max existing rId
    max_id = 0
    for child in rels_root:
        rid = child.get("Id", "")
        if rid.startswith("rId"):
            try:
                max_id = max(max_id, int(rid[3:]))
            except ValueError:
                pass

    font_rel_ids: dict[str, str] = {}  # font_filename -> rId
    for i, font_file in enumerate(font_files):
        target = f"fonts/{font_file.name}"
        rid = f"rIdFont{i + 1}"  # use stable IDs
        font_rel_ids[font_file.name] = rid
        # Check if already exists
        exists = False
        for child in rels_root:
            if child.get("Target") == target:
                exists = True
                break
        if not exists:
            ET.SubElement(
                rels_root,
                f"{{{REL_NS}}}Relationship",
                {
                    "Id": rid,
                    "Type": FONT_REL_TYPE,
                    "Target": target,
                },
            )
    zip_data[rels_path] = _xml_tostring(rels_root)

    # ── Add font files to word/fonts/ ──────────────────────────
    for font_file in font_files:
        arcname = f"word/fonts/{font_file.name}"
        zip_data[arcname] = font_file.read_bytes()

    # ── Update or create word/fontTable.xml ────────────────────
    font_table_path = "word/fontTable.xml"
    font_table_xml = zip_data.get(font_table_path)
    if font_table_xml is not None:
        fonts_root = ET.fromstring(font_table_xml)
    else:
        fonts_root = ET.Element(f"{{{WML_NS}}}fonts")

    for font_file in font_files:
        family_name = _guess_font_family(font_file.name)
        # Check if font entry already exists
        entry_exists = False
        for child in fonts_root:
            if child.tag == f"{{{WML_NS}}}font":
                name_elem = child.find(f"{{{WML_NS}}}name")
                if name_elem is not None and name_elem.get(f"{{{WML_NS}}}val") == family_name:
                    entry_exists = True
                    # Ensure embed tag
                    embed = child.find(f"{{{WML_NS}}}embedRegular")
                    if embed is None:
                        ET.SubElement(child, f"{{{WML_NS}}}embedRegular")
                    break

        if not entry_exists:
            font_elem = ET.SubElement(fonts_root, f"{{{WML_NS}}}font")
            font_elem.attrib[f"{{{WML_NS}}}name"] = family_name
            # Try to determine panose-1 or charset — not critical for embedding
            ET.SubElement(font_elem, f"{{{WML_NS}}}embedRegular")

    zip_data[font_table_path] = _xml_tostring(fonts_root)

    # ── Also add font table relationship if not present ────────
    font_table_rel_path = "word/_rels/fontTable.xml.rels"
    font_table_rel_target = "fontTable.xml"
    font_table_rel_type = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable"

    # Check if main document rels already has fontTable relationship
    ft_rel_exists = False
    for child in rels_root:
        if child.get("Type") == font_table_rel_type:
            ft_rel_exists = True
            break

    if not ft_rel_exists:
        max_id_val = max_id
        for child in rels_root:
            rid = child.get("Id", "")
            if rid.startswith("rIdFont"):
                continue
            if rid.startswith("rId"):
                try:
                    max_id_val = max(max_id_val, int(rid[3:]))
                except ValueError:
                    pass
        ft_rid = f"rId{max_id_val + 1}"
        ET.SubElement(
            rels_root,
            f"{{{REL_NS}}}Relationship",
            {
                "Id": ft_rid,
                "Type": font_table_rel_type,
                "Target": font_table_rel_target,
            },
        )
        zip_data[rels_path] = _xml_tostring(rels_root)

    # ── Also add font table content-type if not present ────────
    if font_table_path not in zip_data:
        # Need to ensure content type for fontTable.xml part
        # The partURI /word/fontTable.xml needs an Override in [Content_Types].xml
        override_exists = False
        for child in ct_root:
            if child.get("PartName") == "/word/fontTable.xml":
                override_exists = True
                break
        if not override_exists:
            ET.SubElement(
                ct_root,
                f"{{{CONTENT_TYPES_NS}}}Override",
                {
                    "PartName": "/word/fontTable.xml",
                    "ContentType": "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml",
                },
            )
            zip_data["[Content_Types].xml"] = _xml_tostring(ct_root)

    # ── Write back ─────────────────────────────────────────────
    with zipfile.ZipFile(docx_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for name, data in zip_data.items():
            zout.writestr(name, data)

    return len(font_files)


def _xml_tostring(root: ET.Element) -> bytes:
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _guess_font_family(filename: str) -> str:
    """Extract a font family name from the filename."""
    name = Path(filename).stem
    # Handle common patterns: BaikalExp-Medium, Inter-Bold, etc.
    parts = name.split("-")
    # First part is usually the family name
    family = parts[0]
    # Map known Baikal names
    known = {
        "BaikalExp": "Baikal Exp",
        "BaikalExtraCond": "Baikal ExtraCond",
        "BaikalNormal": "Baikal Normal",
    }
    for k, v in known.items():
        if family.startswith(k):
            return v
    return family


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print("Usage: python3 html_docx_fonts.py <docx_path> <fonts_dir>")
        sys.exit(1)

    docx_path = Path(sys.argv[1])
    fonts_dir = Path(sys.argv[2])
    count = embed_fonts(docx_path, fonts_dir)
    print(f"Embedded {count} font(s)")
