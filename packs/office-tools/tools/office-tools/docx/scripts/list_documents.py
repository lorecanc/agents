import sys, json
from pathlib import Path
from doc_file_utils import get_project_dir, get_mnt_dir


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python3 list_documents.py <project_name>"}))
        sys.exit(1)
    project_name = sys.argv[1]
    project_dir = get_project_dir(project_name)
    if not project_dir.exists():
        mnt_dir = get_mnt_dir()
        projects = []
        if mnt_dir.exists():
            projects = [d.name for d in mnt_dir.iterdir() if d.is_dir() and (d / "documents").exists()]
        print(json.dumps({"error": f"Project '{project_name}' not found.", "available_projects": projects}))
        sys.exit(1)
    source_files = list(project_dir.glob("*.source.html"))
    documents = []
    for source_file in sorted(source_files):
        doc_name = source_file.name.replace(".source.html", "")
        entry = {
            "name": doc_name,
            "source": {"filename": source_file.name, "size": source_file.stat().st_size},
            "docx_exports": [],
            "other_formats": {},
        }
        docx_exports = sorted(f for f in project_dir.glob(f"{doc_name}*.docx") if not f.name.startswith("~$"))
        for docx in docx_exports:
            snapshot = project_dir / f"{docx.name}.snapshot.html"
            entry["docx_exports"].append({
                "filename": docx.name,
                "size": docx.stat().st_size,
                "has_snapshot": snapshot.exists(),
            })
        for ext, label in [(".pdf", "pdf"), (".md", "markdown"), (".txt", "txt")]:
            f = project_dir / f"{doc_name}{ext}"
            if f.exists():
                entry["other_formats"][label] = {"filename": f.name, "size": f.stat().st_size}
        documents.append(entry)
    print(json.dumps({"success": True, "project": project_name, "path": str(project_dir), "documents": documents}))


if __name__ == "__main__":
    main()
