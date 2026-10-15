import re, sys, json
from pathlib import Path
from doc_file_utils import get_project_dir


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: python3 restore_document.py <project_name> <docx_filename>"}))
        sys.exit(1)
    project_name = sys.argv[1]
    docx_name = sys.argv[2]
    if not docx_name.endswith(".docx"):
        docx_name = f"{docx_name}.docx"
    project_dir = get_project_dir(project_name)
    snapshot_path = project_dir / f"{docx_name}.snapshot.html"
    if not snapshot_path.exists():
        available = sorted(p.name for p in project_dir.glob("*.docx.snapshot.html"))
        print(json.dumps({"error": f"No snapshot found for '{docx_name}'.", "available_snapshots": available}))
        sys.exit(1)
    doc_name = Path(docx_name).stem
    doc_name = re.sub(r"_v\d+$", "", doc_name)
    source_path = project_dir / f"{doc_name}.source.html"
    source_path.write_text(snapshot_path.read_text(encoding="utf-8"), encoding="utf-8")
    print(json.dumps({"success": True, "document": doc_name, "restored_from": docx_name, "source_path": str(source_path)}))


if __name__ == "__main__":
    main()
