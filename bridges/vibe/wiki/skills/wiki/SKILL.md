---
name: wiki
description: Generate or update the project wiki automatically
user-invocable: true
disable-model-invocation: true
---

This command runs under the wiki-orchestrator Vibe agent (the translated primary agent). If this session already runs it, execute the brief below directly. Otherwise tell the user to start Vibe with `vibe --agent wiki-orchestrator` (or switch a live session with `/agent wiki-orchestrator`) and re-run the command, or, if the user prefers to continue here, spawn the translated specialists yourself with the native `agents.spawn` tool and evaluate their reports. The $request placeholder below is the text the user typed after the /skill invocation.

You have been invoked via the /wiki command. Your job is to generate or update the project wiki.

## Arguments

Depth level requested by user: $request
(If empty, auto-detect based on project size)

## Current State

### Wiki directory status


```bash
ls -la wiki/ 2>/dev/null && echo "WIKI_EXISTS" || echo "NO_WIKI"
```



### Watermark (last processed commit)


```bash
cat wiki/.last-updated-commit 2>/dev/null || echo "NO_WATERMARK"
```



### Current HEAD commit


```bash
git rev-parse HEAD 2>/dev/null || echo "NO_GIT"
```



### Changes since last wiki update


```bash
if [ -f wiki/.last-updated-commit ]; then git diff --name-status $(cat wiki/.last-updated-commit) HEAD 2>/dev/null || echo "NO_DIFF"; else echo "FULL_SCAN_NEEDED"; fi
```



### Uncommitted working-tree status


```bash
git status --short 2>/dev/null | head -50 || echo "NO_GIT"
```



The watermark tracks committed `HEAD` state only. If source changes are uncommitted, report in the final summary which affected areas remain pending the next commit.

### Project file tree (source files only)


```bash
find . -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.rb" -o -name "*.swift" -o -name "*.kt" -o -name "*.c" -o -name "*.cpp" -o -name "*.h" -o -name "*.cs" -o -name "*.vue" -o -name "*.svelte" \) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/build/*" -not -path "*/wiki/*" -not -path "*/.opencode/*" | sort | head -100
```



### Project file count


```bash
find . -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.rb" -o -name "*.swift" -o -name "*.kt" -o -name "*.c" -o -name "*.cpp" -o -name "*.h" -o -name "*.cs" -o -name "*.vue" -o -name "*.svelte" \) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/build/*" -not -path "*/wiki/*" | wc -l
```



### Project config files


```bash
ls -1 package.json Cargo.toml go.mod pyproject.toml setup.py build.gradle pom.xml Gemfile *.sln *.csproj 2>/dev/null || echo "NO_CONFIG_FILES"
```



### Codebase memory refresh


```bash
if [ -x .opencode/scripts/refresh-codebase-memory.sh ]; then .opencode/scripts/refresh-codebase-memory.sh 2>&1; elif command -v codebase-memory-mcp >/dev/null 2>&1; then echo "CODEBASE_MEMORY_STATUS=binary_found_no_refresh_script"; else echo "CODEBASE_MEMORY_STATUS=unavailable"; fi
```



Now analyze the state above and proceed:
- If NO_WIKI → run the CREATION flow
- If WIKI_EXISTS → run the UPDATE flow
- Report the Codebase memory refresh status from the section above
