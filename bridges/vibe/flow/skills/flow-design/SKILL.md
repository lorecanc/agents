---
name: flow-design
description: "Flow: design or redesign UI with a brief and a render-and-iterate loop"
user-invocable: true
disable-model-invocation: true
---

This command runs under the flow-build Vibe agent (the translated primary agent). If this session already runs it, execute the brief below directly. Otherwise tell the user to start Vibe with `vibe --agent flow-build` (or switch a live session with `/agent flow-build`) and re-run the command, or, if the user prefers to continue here, spawn the translated specialists yourself with the native `agents.spawn` tool and evaluate their reports. The $request placeholder below is the text the user typed after the /skill invocation.

Design request: $request

This is visual work. Quality of the rendered result is the goal.

1. For web work load `flow-frontend-design`. For native work load the relevant platform skill. Find the existing design system (tokens, theme, components) and write the design brief. Inspect screenshots attached by the user yourself and describe what you take from them. Give `flow-eye` the path or URL of any other reference image that needs inspection.
2. Implement with the design system, fixing tokens at the source when they are weak. "Smallest diff" does not apply to visual quality; behavior and APIs stay intact.
3. Load `flow-visual-loop` for web work. Choose viewports from the request, supported devices and layout breakpoints. For native work use the platform simulator or device. Delegate review of the rendered result to `flow-eye` without loading additional images in `flow-build`.
4. Exercise the affected states and check console errors and accessibility as applicable.
5. Apply the Review gate in `flow-build` to the risks introduced by the change.
6. Report the environments and states checked, what changed visually and anything still unverified.
