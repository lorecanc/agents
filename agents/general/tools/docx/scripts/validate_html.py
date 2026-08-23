import sys, json
from pathlib import Path
from html_validation import find_unsupported_html


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python3 validate_html.py <html_content_or_path>"}))
        sys.exit(1)
    input_val = sys.argv[1]
    html_content = Path(input_val).read_text(encoding="utf-8") if Path(input_val).exists() else input_val
    issues = find_unsupported_html(html_content)
    print(json.dumps({"valid": len(issues) == 0, "issues": issues}))


if __name__ == "__main__":
    main()
