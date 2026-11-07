---
description: "Flow: design or redesign UI with a brief and a render-and-iterate loop"
agent: mistral-flow-build
---

Design request: $ARGUMENTS

This is visual work. Quality of the rendered result is the goal.

1. Load `flow-frontend-design`. Find the existing design system (tokens, theme, components) and write the design brief (section 1). If a screenshot or mockup is attached, it is the reference: describe what you take from it.
2. Implement with the design system, fixing tokens at the source when they are weak. "Smallest diff" does not apply to visual quality; behavior and APIs stay intact.
3. Load `flow-visual-loop`. Render with `pipeline_serve` and check 375, 768 and 1280. If you cannot see images, delegate to `mistral-flow-eye` (in parallel for several routes). Iterate on the rubric, up to 3 rounds.
4. Check console errors, accessibility basics and the empty, loading and error states.
5. Unless the change is CSS-only, finish with a `mistral-flow-review` (quality focus).
6. Report the viewports checked, the rounds used, what changed visually and what is left.
