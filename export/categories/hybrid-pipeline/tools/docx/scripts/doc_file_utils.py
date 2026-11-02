import os, re, sys, json
from pathlib import Path


def get_mnt_dir() -> Path:
    return Path("/app/mnt") if Path("/.dockerenv").is_file() else Path(os.getcwd()) / "projects"


def get_project_dir(project_name: str) -> Path:
    return get_mnt_dir() / project_name / "documents"


def next_docx_version(desired: Path) -> Path:
    if not desired.exists():
        return desired
    base = re.sub(r"_v\d+$", "", desired.stem)
    n = 2
    while True:
        candidate = desired.parent / f"{base}_v{n}{desired.suffix}"
        if not candidate.exists():
            return candidate
        n += 1
