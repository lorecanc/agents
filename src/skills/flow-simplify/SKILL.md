---
name: flow-simplify
description: Cleanup pass over the current change set - reuse existing helpers instead of new ones, remove duplication, collapse needless abstraction, tighten naming, delete dead code - without changing behavior. Load after a feature works and before the final review, or when the user asks to simplify or clean up.
---

# Simplify the change set

The goal is less code that does the same thing and reads like the rest of the codebase. **Behavior
does not change.** Tests that passed before must still pass, and their assertions must stay the same.

## Scope

Only the diff of this task (`git diff` against the starting point, plus new files). Do not clean up the
whole codebase unless the user asked for it.

## Checklist, in priority order

1. **Reuse.** For each new function, type or constant, search the codebase for an existing equivalent (same name family, same signature, same regex or constant). Use it and delete the new one.
2. **Duplication.** If the same 3 or more lines appear twice in the diff, or once in the diff and once elsewhere, extract them, or call the existing copy. Two similar lines are fine. Do not extract for a single use.
3. **Needless abstraction.** Look for an interface with one implementation, a factory for one class, an options object for one flag, a wrapper that only forwards, config for values that never change, or a layer the rest of the codebase does not have. Inline it.
4. **Defensive noise.** Remove null checks on values that cannot be null, try/catch blocks that rethrow or swallow, and re-validation of data already validated at the boundary.
5. **Dead code.** Remove unused imports, variables, parameters and branches, commented-out code, and leftover debug output.
6. **Naming and shape.** Names say what a thing is, using the codebase's vocabulary. Prefer early returns over nested conditionals, and keep functions small enough to read in one screen.
7. **Comments.** Keep the ones that explain *why*. Delete the ones that restate *what* the code does. Match the file's comment density.
8. **Efficiency, only when it is obvious.** Fix N+1 queries, repeated work inside loops, and sync I/O in hot paths. Do not micro-optimize.

## Rules

- Make one logical cleanup at a time and re-run the targeted tests after a meaningful batch.
- Do not change public APIs, file layout or formatting style unless the cleanup requires it.
- If a cleanup would need a behavior change, list it as a suggestion instead.
- In the summary, say what you removed or reused and how many lines changed in each direction.
