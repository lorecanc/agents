---
description: cp_nightly pipeline: research only, no code changes (internal explorer in parallel with external researcher)
agent: cp_nightly-cp_nightly-pipeline-orchestrator
---

Question (research only): $ARGUMENTS

## Preset
- Type is `research`. Use the Research Lane: launch `@cp_nightly-pipeline-explorer` (what is in our repository) and `@cp_nightly-pipeline-researcher` (what the outside world says) in the **same turn** when the question has both parts; drop the side that has nothing to answer. If the external question depends on an internal fact, run the explorer first.
- Write a self-contained question for the researcher; it does not see the explorer's output.
- Do not modify files, run HITL, or create commits. Compare the two reports and point out where they disagree.

## Repository state at session start

Use this as the session baseline (`base_commit`, `baseline_dirty`). Files listed under "uncommitted" existed before this session and must not be mixed into its commits.

- Branch: !`git branch --show-current 2>/dev/null || echo "NO_GIT"`
- HEAD: !`git rev-parse HEAD 2>/dev/null || echo "NO_GIT"`
- Uncommitted or untracked files (first 60):

!`git status --porcelain=v1 -uall 2>/dev/null | head -60 || true`
