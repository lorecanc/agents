import sys, json, tempfile
from pathlib import Path
from html_docx_constants import _UA_RESET_STYLE
from html_validation import build_unsupported_error, find_unsupported_html
from doc_file_utils import get_project_dir
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright
from html_docx_playwright import _launch_chromium_with_install
from html_docx_images import embed_local_images
from PIL import Image


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: python3 create_document.py <project_name> <document_name> <content_type> <content_file> [overwrite]"}))
        sys.exit(1)
    project_name = sys.argv[1]
    doc_name_raw = sys.argv[2]
    content_type = sys.argv[3]
    content_file = Path(sys.argv[4])
    overwrite = len(sys.argv) > 5 and sys.argv[5].lower() == "true"
    doc_name = doc_name_raw.replace(".html", "").replace(".docx", "").replace(".md", "")
    project_dir = get_project_dir(project_name)
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "assets").mkdir(exist_ok=True)
    content_value = content_file.read_text(encoding="utf-8")
    if content_type == "markdown":
        md_path = project_dir / f"{doc_name}.md"
        if md_path.exists() and not overwrite:
            print(json.dumps({"error": f"Document '{doc_name}' already exists. Use overwrite=true."}))
            sys.exit(1)
        md_path.write_text(content_value, encoding="utf-8")
        print(json.dumps({"success": True, "project": project_name, "document": doc_name, "files": [str(md_path)]}))
        return
    source_path = project_dir / f"{doc_name}.source.html"
    if source_path.exists() and not overwrite:
        print(json.dumps({"error": f"Document '{doc_name}' already exists. Use overwrite=true."}))
        sys.exit(1)
    normalized_html = _ensure_ua_reset(content_value)
    issues = find_unsupported_html(normalized_html)
    if issues:
        print(json.dumps({"error": build_unsupported_error(issues), "issues": issues}))
        sys.exit(1)
    source_path.write_text(normalized_html, encoding="utf-8")
    result = {"success": True, "project": project_name, "document": doc_name, "files": [str(source_path)]}
    try:
        preview_path = _build_html_preview_image(normalized_html, project_dir, doc_name)
        if preview_path:
            result["preview_path"] = str(preview_path)
    except Exception:
        pass
    print(json.dumps(result))


def _ensure_ua_reset(html_content: str) -> str:
    if "UA reset to neutralize browser defaults" in html_content:
        return html_content
    lower = html_content.lower()
    head_index = lower.find("<head")
    if head_index != -1:
        head_close = lower.find(">", head_index)
        if head_close != -1:
            return html_content[:head_close + 1] + _UA_RESET_STYLE + html_content[head_close + 1:]
    if "<html" in lower:
        return html_content.replace("<html>", f"<html><head>{_UA_RESET_STYLE}</head>", 1)
    return f"<!DOCTYPE html><html><head>{_UA_RESET_STYLE}</head><body>{html_content}</body></html>"


def _build_html_preview_image(html_content: str, base_dir: Path, doc_name: str):
    preview_html = embed_local_images(html_content, base_dir)
    assets_dir = base_dir / "assets"
    assets_dir.mkdir(exist_ok=True)
    preview_path = assets_dir / f"{doc_name}_preview.jpg"
    with tempfile.NamedTemporaryFile(mode="w", suffix=".html", delete=False, encoding="utf-8", dir=base_dir) as tmp_html:
        tmp_html.write(preview_html)
        tmp_html_path = Path(tmp_html.name)
    try:
        with sync_playwright() as p:
            browser = _launch_chromium_with_install(p)
            page = browser.new_page(viewport={"width": 794, "height": 1123})
            page.goto(tmp_html_path.as_uri())
            page.wait_for_load_state("networkidle")
            page.screenshot(path=str(preview_path), full_page=True, type="jpeg", quality=80)
            browser.close()
        img = Image.open(preview_path)
        new_size = (int(img.width * 0.75), int(img.height * 0.75))
        img = img.resize(new_size, Image.Resampling.LANCZOS)
        img.save(preview_path, "JPEG", quality=75, optimize=True)
        return preview_path
    finally:
        tmp_html_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
