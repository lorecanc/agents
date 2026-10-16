---
description: Handles visual inputs such as screenshots, UI mockups, diagrams,
  and image-based debugging before planning or implementation.
mode: subagent
model: github-copilot/gpt-6-luna
temperature: 1
permission:
  "*": deny
  external_directory:
    "*": deny
    ~/.local/share/opencode/tool-output/*: allow
    ~/.config/opencode/skills/*: allow
    /tmp/*: allow
    /private/tmp/*: allow
  pipeline_state: allow
  doom_loop: deny
  read: allow
  grep: allow
  glob: allow
  lsp: allow
  skill: allow
  read_mcp_resource: allow
  list_mcp_resources: allow
  list_mcp_resource_templates: allow
  codebase-memory-mcp_*: allow
  codebase-memory-mcp_delete_project: deny
  codebase-memory-mcp_ingest_traces: deny
  codebase-memory-mcp_manage_adr: deny
  codebase-memory-mcp_index_repository: deny
  bash:
    "*": deny
    pwd: allow
    ls*: allow
    find *: allow
    find * -delete*: deny
    find * -exec*: deny
    find * -execdir*: deny
    find * -ok*: deny
    find * -fprint*: deny
    tree *: allow
    git status*: allow
    git diff*: allow
    git diff --output*: deny
    git diff * --output*: deny
    git log*: allow
    git show*: allow
    git ls-files*: allow
    git rev-parse*: allow
    git branch --show-current*: allow
    rg *: allow
    grep *: allow
    sed -n *: allow
    head *: allow
    tail *: allow
    wc *: allow
    find . *: allow
    cat *: allow
    jq *: allow
    yq *: allow
    awk *: allow
    sort *: allow
    uniq *: allow
    cut *: allow
    tr *: allow
    du *: allow
    which *: allow
    type *: allow
    env: allow
    printenv*: allow
    uname*: allow
    ps *: allow
    lsof *: allow
    stat *: allow
    file *: allow
    git ls-tree*: allow
    git ls-remote*: allow
    git cat-file*: allow
    git rev-list*: allow
    git merge-base*: allow
    git range-diff*: allow
    git cherry*: allow
    git branch -a*: allow
    git branch -r*: allow
    git branch -v*: allow
    git branch --list*: allow
    git branch --contains*: allow
    git branch --merged*: allow
    git branch --no-merged*: allow
    git blame*: allow
    git grep*: allow
    git describe*: allow
    git shortlog*: allow
    git for-each-ref*: allow
    git name-rev*: allow
    git show-ref*: allow
    git show-branch*: allow
    git check-ignore*: allow
    git var*: allow
    git verify-commit*: allow
    git verify-tag*: allow
    git tag -l*: allow
    git tag --list*: allow
    git remote -v*: allow
    git remote --verbose*: allow
    git remote show*: allow
    git remote get-url*: allow
    git stash list*: allow
    git stash show*: allow
    git worktree list*: allow
    git reflog*: allow
    git reflog expire*: deny
    git reflog delete*: deny
    git config --get*: allow
    git config --list*: allow
    git config -l*: allow
    git fetch*: allow
    git fetch *--upload-pack*: deny
    git fetch *ext::*: deny
    node -v*: allow
    node --version*: allow
    npm -v*: allow
    npm --version*: allow
    python --version*: allow
    python3 --version*: allow
    go version*: allow
    cargo --version*: allow
    rustc --version*: allow
    java -version*: allow
    swift --version*: allow
color: "#E67E22"
hidden: true
variant: xhigh
steps: 50
---

# cp_nightly-pipeline-multimodal

You are the visual analysis agent.

Follow the repository `AGENTS.md` rules. Interpret screenshots, mockups, diagrams, or visual inputs and convert them into implementation-relevant observations.

## You must
- Describe only what is visible or inferable.
- Identify UI states, layout, content, visual bugs, or diagram relationships.
- Translate visual observations into concise engineering requirements.
- Avoid inventing hidden requirements.
- Do not edit files.

## Output format
```markdown
## Visual observations
- ...

## Engineering implications
- ...

## Ambiguities
- ...
```
