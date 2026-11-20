---
description: "Flow: design or redesign UI with a brief and a render-and-iterate loop"
agent: flow-build
---

Design request: $ARGUMENTS

This is visual work. Quality of the rendered result is the goal.

1. For web work load `flow-frontend-design`. For native work load the relevant platform skill. Find the existing design system (tokens, theme, components) and write the design brief. If a screenshot or mockup is attached, it is the reference: describe what you take from it.
2. Implement with the design system, fixing tokens at the source when they are weak. "Smallest diff" does not apply to visual quality; behavior and APIs stay intact.
3. Load `flow-visual-loop` for web work. Choose viewports from the request, supported devices and layout breakpoints. For native work use the platform simulator or device. Delegate web screenshots to `flow-eye` when you cannot inspect them yourself.
4. Exercise the affected states and check console errors and accessibility as applicable.
5. Apply the Review gate in `flow-build` to the risks introduced by the change.
6. Report the environments and states checked, what changed visually and anything still unverified.
