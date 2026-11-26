---
name: flow-visual-loop
description: Render-and-iterate loop for UI changes. Use dev_serve and delegate
  screenshot capture and visual review to flow-eye. Verify fixes, console and
  accessibility. Load after the first UI implementation pass.
---

# Visual loop

Writing UI without rendering it is guessing. This loop closes the gap between the code and what users see.

## 0. Get a URL

1. Use an existing URL if it will stay available during review. Otherwise, have `flow-eye` start the
   app with `dev_serve` (`action: "start"`), so it stays up even if the primary session goes idle.
   If the primary already started the app for its own checks, stop that instance before handing off
   startup. If the selected `serve`/`smoke` section of `.opencode/pipeline.json` lists required
   services, include `with_services: true` in the recipe. Without a usable section, a simple root
   `package.json` app can use its auto-detected `dev`/`start` script. For other apps, discover the
   workspace, `command` (using `${PORT}`), and any readiness options. If the app needs declared
   services with auto-detected startup, pass the discovered command explicitly with
   `with_services: true`; the auto-detected command alone won't start them.
2. If it cannot start (`env` or `harness` class), try once to fix the obvious cause (a missing install, the wrong workspace). For static HTML, give the reviewer a `file://` URL. If nothing can render, report `UNVERIFIED: <reason>`.
3. Do not start dev servers with raw `npm run dev &`; they outlive the session.

## 1. Look

Inspect screenshots attached directly by the user yourself and summarize relevant details in the
brief. Delegate screenshot capture and all other visual review to `flow-eye`, even if your model
can see images. Use Chrome DevTools directly only for non-image checks such as DOM and console
inspection. Give `flow-eye` the URL and routes, the brief, what changed, paths for any reference
images not already attached, and a small batch of viewport/state pairs.
Pick viewports from the supported devices and actual breakpoints, including both sides of a layout
transition the change could break. Start each batch in a new session without `sessionID`. Use
separate pages for independent reviews, and run batches in sequence if they share a managed dev
server or browser state.

## 2. Judge

Use `flow-eye`'s text-only verdict against the brief and the rubric in `flow-frontend-design`
section 7. If the child fails or returns no usable verdict, retry once in a new `flow-eye` session
without `sessionID`, narrowing to the missing checks. If the retry fails, or the reviewer reports
an unresolved blocker such as `NO_VISION`, mark those checks unverified. Do not open the review captures yourself.

## 3. Fix and repeat

- Fix the highest-impact items first, and prefer token-level fixes over one-off overrides.
- Re-render only the affected viewports in a new `flow-eye` session, without `sessionID`.
- Recheck a fix in the state that exposed it. Stop when the requested states meet the brief, or when a concrete blocker prevents further verification. Report the observed result and any remaining gap.

## 4. Final checks

Use `dev_serve` again for direct textual checks if the reviewer stopped its server. Close only the
server you started.

- The console has no errors or warnings caused by the change.
- Run `lighthouse_audit` (accessibility category) when the page is user-facing and the server is up. Fix contrast and label issues.
- For keyboard checks, press Tab through the main flow and make sure focus is visible and the order is logical.
- Use the feature, not just the screenshot: click through the golden path, trigger the edge cases (empty input, long text, an error response) and glance at the neighbouring features the change could have broken.
- Run `dev_serve` with `action: "stop"` when done if you started the server.

In the final summary, include the routes, viewports and states checked, what was fixed and what is left.
