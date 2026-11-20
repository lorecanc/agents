---
name: flow-visual-loop
description: Render-and-iterate loop for UI changes. Start the project's dev server with dev_serve, capture screenshots at relevant breakpoints with chrome-devtools (or delegate to flow-eye when your model cannot see images), compare with the design brief and rubric, verify fixes, then check console and accessibility. Load after the first UI implementation pass.
---

# Visual loop

Writing UI without rendering it is guessing. This loop closes the gap between the code and what users see.

## 0. Get a URL

1. Run `dev_serve` with `action: "start"`. If `.opencode/pipeline.json` declares backing `services`
   (such as Postgres or Redis) for `serve` or `smoke`, pass `with_services: true` as in
   `dev_serve({ action: "start", with_services: true })`. This lets full-stack pages use live
   dependencies during browser checks; `dev_serve` cleans them up on stop or idle. The file is
   optional: without a usable `serve`/`smoke` section, a simple root `package.json` app can use its
   `dev`/`start` script; otherwise discover the workspace and command in the repository and pass
   `workspace`, `command` (using `${PORT}`), and any applicable `ready_path`, `ready_url` or
   `ready_timeout_s` directly to `dev_serve({ action: "start", ... })`.
2. If it cannot start (`env` or `harness` class), try once to fix the obvious cause (a missing install, the wrong workspace). Otherwise, for static HTML, open the file with a `file://` URL. Never skip browser verification because `.opencode/pipeline.json` is absent.
3. If nothing can render, stop the loop and report `UNVERIFIED: <reason>`. Do not pretend.
4. Do not start dev servers with raw `npm run dev &`; they outlive the session.

## 1. Look

**If your model accepts images**, use chrome-devtools directly:
- `new_page` or `navigate_page` to the route.
- Pick sizes from the request, supported devices, container constraints and actual breakpoints.
  Check both sides of a layout transition the change could break. At each selected size run
  `resize_page`, exercise the state under review, then `take_screenshot`.
- Run `take_snapshot` when you need the DOM or accessibility tree, and `list_console_messages` for errors.

**If it does not** (or you are unsure), delegate to `flow-eye` with:
- the URL and routes;
- the viewports;
- the design brief (5–10 lines);
- what changed;
- any states to trigger (hover, an open menu, an error).

Give the reviewer a separate browser page for each independent route or run the routes in sequence
if page selection or viewport state is shared. If the reviewer reports `NO_VISION` or an unavailable
browser, carry that visual coverage gap into the final report.

## 2. Judge

Use the rubric in `flow-frontend-design` section 7. Be honest: "looks fine" is not a verdict.
Compare against the reference or mockup when one exists. Look at the biggest problem first, usually
hierarchy or spacing rather than colors.

## 3. Fix and repeat

- Fix the highest-impact items first, and prefer token-level fixes over one-off overrides.
- Re-render only the affected viewports.
- Recheck a fix in the state that exposed it. Stop when the requested states meet the brief, or when a concrete blocker prevents further verification. Report the observed result and any remaining gap.

## 4. Final checks

- The console has no errors or warnings caused by the change.
- Run `lighthouse_audit` (accessibility category) when the page is user-facing and the server is up. Fix contrast and label issues.
- For keyboard checks, press Tab through the main flow and make sure focus is visible and the order is logical.
- Use the feature, not just the screenshot: click through the golden path, trigger the edge cases (empty input, long text, an error response) and glance at the neighbouring features the change could have broken.
- Run `dev_serve` with `action: "stop"` when done.

In the final summary, include the routes, viewports and states checked, what was fixed and what is left.
