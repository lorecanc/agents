---
name: flow-visual-loop
description: Render-and-iterate loop for UI changes. Start the project's dev server with pipeline_serve, capture screenshots at mobile/tablet/desktop with chrome-devtools (or delegate to flow-eye when your model cannot see images), compare with the design brief and rubric, fix, repeat (max 3 rounds), then check console and accessibility. Load after the first UI implementation pass.
---

# Visual loop

Writing UI without rendering it is guessing. This loop closes the gap between the code and what users see.

## 0. Get a URL

1. Run `pipeline_serve` with `action: "start"`. It reads the `serve` or `smoke` section of `.opencode/pipeline.json`, or the `dev`/`start` script. It returns a localhost URL and always stops by itself.
2. If it cannot start (`env` or `harness` class), try once to fix the obvious cause (a missing install, the wrong workspace). Otherwise, for static HTML, open the file with a `file://` URL.
3. If nothing can render, stop the loop and report `UNVERIFIED: <reason>`. Do not pretend.
4. Do not start dev servers with raw `npm run dev &`; they outlive the session.

## 1. Look

**If your model accepts images**, use chrome-devtools directly:
- `new_page` or `navigate_page` to the route.
- For each viewport `375x812`, `768x1024` and `1280x800`: run `resize_page`, then `take_screenshot` (full page when it is long).
- Run `take_snapshot` when you need the DOM or accessibility tree, and `list_console_messages` for errors.

**If it does not** (or you are unsure), delegate to `flow-eye` with:
- the URL and routes;
- the viewports;
- the design brief (5–10 lines);
- what changed;
- any states to trigger (hover, an open menu, an error).

`flow-eye` returns rubric scores and concrete fixes. Several routes can be checked by parallel `flow-eye` calls in one message.

## 2. Judge

Use the rubric in `flow-frontend-design` section 7. Be honest: "looks fine" is not a verdict.
Compare against the reference or mockup when one exists. Look at the biggest problem first, usually
hierarchy or spacing rather than colors.

## 3. Fix and repeat

- Fix the highest-impact items first, and prefer token-level fixes over one-off overrides.
- Re-render only the affected viewports.
- Stop after **3 rounds** or when the rubric passes. Report the remaining items honestly.

## 4. Final checks

- The console has no errors or warnings caused by the change.
- Run `lighthouse_audit` (accessibility category) when the page is user-facing and the server is up. Fix contrast and label issues.
- For keyboard checks, press Tab through the main flow and make sure focus is visible and the order is logical.
- Run `pipeline_serve` with `action: "stop"` when done.

In the final summary, include the viewports checked, the rounds used, what was fixed and what is left.
