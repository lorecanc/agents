import sys, json, re
from pathlib import Path
from html_docx_core import html_to_docx
from html_docx_images import embed_local_images
from html_docx_playwright import auto_page_breaks
from html_docx_fonts import embed_fonts
from doc_file_utils import get_project_dir, next_docx_version
from bs4 import BeautifulSoup
import html2text


_UNICODE_TO_ASCII = str.maketrans({
    "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
    "\u2013": "-", "\u2014": "--", "\u2026": "...", "\u00a0": " ",
    "\x19": "'", "\x11": "-", "\x18": "'", "\x1c": '"', "\x1d": '"', "\x14": "--",
})


def _normalize_unicode(html: str) -> str:
    return html.translate(_UNICODE_TO_ASCII)


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: python3 convert_document.py <project_name> <document_name> <format> [overwrite]"}))
        sys.exit(1)
    project_name = sys.argv[1]
    doc_name_raw = sys.argv[2]
    output_format = sys.argv[3]
    overwrite = len(sys.argv) > 4 and sys.argv[4].lower() == "true"
    doc_name = doc_name_raw.replace(".html", "").replace(".docx", "").replace(".md", "")
    project_dir = get_project_dir(project_name)
    if not project_dir.exists():
        print(json.dumps({"error": f"Project '{project_name}' not found."}))
        sys.exit(1)
    source_path = project_dir / f"{doc_name}.source.html"
    if not source_path.exists():
        print(json.dumps({"error": f"Document '{doc_name}' not found in project '{project_name}'."}))
        sys.exit(1)
    ext_map = {"pdf": ".pdf", "docx": ".docx", "markdown": ".md", "txt": ".txt"}
    output_path = project_dir / f"{doc_name}{ext_map[output_format]}"
    if output_format == "docx":
        output_path = next_docx_version(output_path)
    elif output_path.exists() and not overwrite:
        print(json.dumps({"error": f"Output '{output_path.name}' exists. Set overwrite=True."}))
        sys.exit(1)
    html_content = source_path.read_text(encoding="utf-8")
    html_content = embed_local_images(html_content, project_dir)
    if output_format in ("pdf", "docx"):
        html_content = auto_page_breaks(html_content)
    font_count = 0
    try:
        if output_format == "pdf":
            from weasyprint import HTML
            HTML(string=_normalize_unicode(html_content)).write_pdf(output_path)
        elif output_format == "docx":
            html_to_docx(html_content, output_path)
            fonts_dir = project_dir / "assets" / "fonts"
            if fonts_dir.exists():
                font_count = embed_fonts(output_path, fonts_dir)
            else:
                font_count = 0
            snapshot_path = output_path.parent / f"{output_path.name}.snapshot.html"
            snapshot_path.write_text(source_path.read_text(encoding="utf-8"), encoding="utf-8")
        elif output_format == "markdown":
            converter = html2text.HTML2Text()
            converter.body_width = 0
            markdown = converter.handle(html_content)
            output_path.write_text(markdown, encoding="utf-8")
        elif output_format == "txt":
            soup = BeautifulSoup(html_content, "html.parser")
            text = soup.get_text(separator="\n", strip=True)
            output_path.write_text(text, encoding="utf-8")
        result = {"success": True, "project": project_name, "document": doc_name, "format": output_format, "output_path": str(output_path.resolve())}
        if output_format == "docx":
            result["fonts_embedded"] = font_count
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
