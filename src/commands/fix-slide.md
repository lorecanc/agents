---
description: Fix layout issues on an existing slide
agent: slides
---

Fix layout issues on the slide $ARGUMENTS.

Workflow:
1. Take a screenshot to see the current rendering
2. Read the slide's HTML to find root causes and determine slide type:
   - **Corporate template slide**: has `[data-placeholder]` attributes → use `slides-template-writer` subagent
   - **Standard slide**: uses `═══ FISSO`/`≈≈≈ ADATTA` zones (template-based), or is free-form (legacy, no composition) — in both cases use `slides-html-writer` subagent
3. Diagnose specific issues (overlaps, alignment, overflow, spacing)
4. Fix using the appropriate writer subagent for the detected slide type
5. Verify with a new screenshot

Max 2 attempts — if still not right, report to me instead of looping. End with "Would you like any further adjustments?"
