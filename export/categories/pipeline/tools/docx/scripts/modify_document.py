import sys, json, traceback
from pathlib import Path
from doc_file_utils import get_project_dir
from html_validation import build_unsupported_error, find_unsupported_html


def main():
    if len(sys.argv) < 5:
        print(json.dumps({"error": "Usage: python3 modify_document.py <project_name> <document_name> <operation> <args_json>"}))
        sys.exit(1)
    project_name = sys.argv[1]
    doc_name_raw = sys.argv[2]
    operation = sys.argv[3]
    args = json.loads(sys.argv[4])
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
    editing_markdown = not source_path.exists()
    current_content = md_path.read_text(encoding="utf-8") if editing_markdown else source_path.read_text(encoding="utf-8")
    if operation == "search_and_replace":
        replacements = args.get("replacements", [])
        if not replacements:
            print(json.dumps({"error": "'replacements' is required for search_and_replace."}))
            sys.exit(1)
        updated = current_content
        for i, item in enumerate(replacements, start=1):
            old = item.get("old_content", "")
            new = item.get("new_content", "")
            if old not in updated:
                snippet = old[:80].replace("\n", "↵")
                print(json.dumps({"error": f"replacement #{i} not found. Snippet: '{snippet}'"}))
                sys.exit(1)
            updated = updated.replace(old, new, 1)
        _save(updated, source_path, md_path, editing_markdown)
        print(json.dumps({"success": True, "operation": "search_and_replace", "count": len(replacements)}))
    elif operation in ("replace", "insert", "delete"):
        lines = current_content.split("\n")
        total_lines = len(lines)
        start_line = args.get("start_line")
        end_line = args.get("end_line")
        new_content = args.get("new_content")
        after = args.get("after", False)
        if operation == "replace":
            if not new_content or not end_line or not start_line:
                print(json.dumps({"error": "new_content, start_line, and end_line required for replace."}))
                sys.exit(1)
            if start_line < 1 or start_line > total_lines:
                print(json.dumps({"error": f"Invalid start_line {start_line}."}))
                sys.exit(1)
            if end_line < start_line or end_line > total_lines:
                print(json.dumps({"error": f"Invalid end_line {end_line}."}))
                sys.exit(1)
            start_idx, end_idx = start_line - 1, end_line
            del lines[start_idx:end_idx]
            lines.insert(start_idx, new_content)
        elif operation == "insert":
            if not new_content or not start_line:
                print(json.dumps({"error": "new_content and start_line required for insert."}))
                sys.exit(1)
            if start_line < 1 or start_line > total_lines + 1:
                print(json.dumps({"error": f"Invalid start_line {start_line}."}))
                sys.exit(1)
            insert_idx = start_line if after else start_line - 1
            lines.insert(insert_idx, new_content)
        elif operation == "delete":
            if not start_line or not end_line:
                print(json.dumps({"error": "start_line and end_line required for delete."}))
                sys.exit(1)
            if start_line < 1 or start_line > total_lines:
                print(json.dumps({"error": f"Invalid start_line {start_line}."}))
                sys.exit(1)
            if end_line < start_line or end_line > total_lines:
                print(json.dumps({"error": f"Invalid end_line {end_line}."}))
                sys.exit(1)
            start_idx, end_idx = start_line - 1, end_line
            del lines[start_idx:end_idx]
        _save("\n".join(lines), source_path, md_path, editing_markdown)
        print(json.dumps({"success": True, "operation": operation}))
    else:
        print(json.dumps({"error": f"Unknown operation '{operation}'."}))
        sys.exit(1)


def _save(content, source_path, md_path, editing_markdown):
    if editing_markdown:
        md_path.write_text(content, encoding="utf-8")
        return
    issues = find_unsupported_html(content)
    if issues:
        print(json.dumps({"error": build_unsupported_error(issues), "issues": issues}))
        sys.exit(1)
    source_path.write_text(content, encoding="utf-8")


if __name__ == "__main__":
    main()
