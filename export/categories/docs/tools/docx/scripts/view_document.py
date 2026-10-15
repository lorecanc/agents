import sys, json
from pathlib import Path
from doc_file_utils import get_project_dir


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: python3 view_document.py <project_name> <document_name> [start_line] [end_line]"}))
        sys.exit(1)
    project_name = sys.argv[1]
    doc_name_raw = sys.argv[2]
    view_range = None
    if len(sys.argv) >= 5:
        try:
            view_range = (int(sys.argv[3]), int(sys.argv[4]))
        except ValueError:
            pass
    doc_name = doc_name_raw.replace(".html", "").replace(".docx", "").replace(".md", "")
    project_dir = get_project_dir(project_name)
    if not project_dir.exists():
        print(json.dumps({"error": f"Project '{project_name}' not found."}))
        sys.exit(1)
    source_path = project_dir / f"{doc_name}.source.html"
    md_path = project_dir / f"{doc_name}.md"
    if not source_path.exists() and not md_path.exists():
        print(json.dumps({"error": f"Document '{doc_name}' not found in project '{project_name}'."}))
        sys.exit(1)
    path = source_path if source_path.exists() else md_path
    content = path.read_text(encoding="utf-8")
    lines = content.split("\n")
    total_lines = len(lines)
    if view_range:
        start_line, end_line = view_range
        if start_line < 1 or end_line < start_line or start_line > total_lines:
            print(json.dumps({"error": f"Invalid range [{start_line}, {end_line}]. Total lines: {total_lines}"}))
            sys.exit(1)
        start_idx = start_line - 1
        end_idx = min(end_line, total_lines)
        content = "\n".join(lines[start_idx:end_idx])
    else:
        start_line, end_line = 1, total_lines
    print(json.dumps({
        "success": True,
        "project": project_name,
        "document": doc_name,
        "filename": path.name,
        "total_lines": total_lines,
        "view_start": start_line if view_range else 1,
        "view_end": end_line if view_range else total_lines,
        "content": content,
    }))


if __name__ == "__main__":
    main()
