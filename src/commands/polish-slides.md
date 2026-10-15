---
description: Polish and enhance the visual design of slides
agent: slides
---

Polish and enhance the visual design of $ARGUMENTS.

Workflow:
1. Take screenshots of all slides to see current state
2. For each slide, read its HTML and determine the slide type:
   - **Corporate template slide**: has `[data-placeholder]` attributes → use `slides-template-writer` subagent
   - **Standard slide**: uses `═══ FISSO`/`≈≈≈ ADATTA` zones (template-based), or is free-form (legacy, no composition) — in both cases use `slides-html-writer` subagent
3. Analyze content structure, layout hierarchy, and visual effectiveness
4. Apply design enhancements:
   - Convert text/tables to diagrams (flowcharts, timelines)
   - Use color blocks to group related content
   - Add subtle background textures and depth layers
   - Apply high-contrast accent colors for key insights
5. Fix each slide using the appropriate writer subagent (max 2 edits per slide)
6. Rebuild PPTX

Avoid over-engineering. End with "Would you like any further adjustments?"
