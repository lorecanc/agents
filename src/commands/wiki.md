---
description: Generate or update the project wiki automatically
agent: wiki-orchestrator
---

You have been invoked via the /wiki command. Your job is to generate or update the project wiki.

## Arguments

Depth level requested by user: $ARGUMENTS
(If empty, auto-detect based on project size)

## Current State

### Wiki directory status
!`ls -la wiki/ 2>/dev/null && echo "WIKI_EXISTS" || echo "NO_WIKI"`

### Watermark (last processed commit)
!`cat wiki/.last-updated-commit 2>/dev/null || echo "NO_WATERMARK"`

### Current HEAD commit
!`git rev-parse HEAD 2>/dev/null || echo "NO_GIT"`

### Changes since last wiki update
!`if [ -f wiki/.last-updated-commit ]; then git diff --name-status $(cat wiki/.last-updated-commit) HEAD 2>/dev/null || echo "NO_DIFF"; else echo "FULL_SCAN_NEEDED"; fi`

### Project file tree (source files only)
!`find . -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.rb" -o -name "*.swift" -o -name "*.kt" -o -name "*.c" -o -name "*.cpp" -o -name "*.h" -o -name "*.cs" -o -name "*.vue" -o -name "*.svelte" \) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/build/*" -not -path "*/wiki/*" -not -path "*/.opencode/*" | sort | head -100`

### Project file count
!`find . -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.rb" -o -name "*.swift" -o -name "*.kt" -o -name "*.c" -o -name "*.cpp" -o -name "*.h" -o -name "*.cs" -o -name "*.vue" -o -name "*.svelte" \) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/build/*" -not -path "*/wiki/*" | wc -l`

### Project config files
!`ls -1 package.json Cargo.toml go.mod pyproject.toml setup.py build.gradle pom.xml Gemfile *.sln *.csproj 2>/dev/null || echo "NO_CONFIG_FILES"`

### Codebase memory refresh
!`if [ -x .opencode/scripts/refresh-codebase-memory.sh ]; then .opencode/scripts/refresh-codebase-memory.sh 2>&1; elif command -v codebase-memory-mcp >/dev/null 2>&1; then echo "CODEBASE_MEMORY_STATUS=binary_found_no_refresh_script"; else echo "CODEBASE_MEMORY_STATUS=unavailable"; fi`

Now analyze the state above and proceed:
- If NO_WIKI → run the CREATION flow
- If WIKI_EXISTS → run the UPDATE flow
- Report the Codebase memory refresh status from the section above
