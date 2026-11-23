---
name: interactive-repo-guide
description: Build a standalone Vite + React step-by-step interactive guide in `guide/` for any web app, where each step shows the real, clickable app screen on an in-browser Demo API, dims everything but the element being explained, captions it and can operate it, grouped in colour-coded levels from fundamentals to advanced and administration, and opened from the app's help button with a deep link. The look is derived from the repo's own design system. Works with or without a spatial deck. Use when asked to replace a text help dialog or manual with a guided interactive tour of a product, or to publish a hosted user guide.
---

# Interactive Repo Guide (`guide/`)

A linear, calm, searchable guide that sits next to the product. The reader moves step by step from the fundamentals to the advanced and administrative features; in every step the **real app** is on screen, on sample data, and can be clicked freely.

This skill is repo-agnostic and **does not require a deck**. Nothing here is a fixed colour, font, product term or route: the look comes from the repo's design system (Phase 0) and the content from its real screens (Phase 1). Sizes and timings below are engine defaults.

## Quality bar (read before building)

The finished guide looks like this, in any repo:
- The same family of look as a polished product showcase: a fixed 16:9 stage scaled to the viewport, a flat level-tinted background, a floating HUD, large type, soft white cards. **Not** a documentation site: no article column, no sidebar tree, no header search bar.
- Each screen of the guide is one section: compact title at the top left, a white info card with the explanation centred vertically in the free space below it, the step pills at the bottom, and the live app in a window frame filling the rest.
- The explained element is ringed and captioned while the rest of the app fades under a shade. The app stays clickable.

First drafts usually fail in the same ways: building a docs layout from habit; copying help text without checking it against the screen; one caption reused for every pointer; the shade appearing with a flash; finders that only work in one language; state left over from a previous step. Check the draft against this list before showing it.

## Core principles

1. **The real app in every step.** The actual route tree on the Demo API, not screenshots.
2. **Explain by dimming.** Everything but the target is darkened; the target gets a ring and a short caption of its own.
3. **Fundamentals first.** Levels: 1 essentials, 2 core workflow, 3 advanced, 4 administration (adapt names to the product, keep the order). One hue per level, used for the stage tint, the HUD badge, the progress dots, the index and the info icon.
4. **Ground truth over old help text.** Write each step from the real screen and the domain specs. Old help is usually wrong somewhere (role names, KPIs, flows that were never built). Log each discrepancy in the project's audit document.
5. **The repo's design system wins.** Import its stylesheet and tokens; never re-skin.

## Phase 0: Design translation

Write this down before any layout:
1. **Tokens**: from the global stylesheet or theme config, record brand ink, brand accent, secondary hues, neutrals, display and text fonts, radius and shadow style.
2. **Surface roles**: `panel` (white or the app's card colour, where all text sits), `ink` and `ink-soft` (check 4.5:1 on the panel), and one **light tint per level**, derived from that level's hue (about 8 to 12% hue on white), so dark text and the real screens stay readable.
3. **Level hues**: take them from the brand palette first (accent, deep secondary, neutral ink), add a distinct fourth if needed. For each hue record also an `ink` shade dark enough for text on white (4.5:1) for badges and labels.
4. **Type**: display font for titles, text font for the rest; keep host weights.
5. **Language(s)** of the audience and dictionary shape; load `italiano-decente` for Italian if available.

## Phase 1: Discovery

1. Read the existing help (dialog, wiki, manual): the screen ids it distinguishes and how it resolves them from route and UI state. Those ids become the guide's entry points (`helpIds`).
2. Read the route tree and list every screen. Walk the app's main flow first, then group the remaining screens into levels. For example, in a fictional task tracker, open the task list, inspect a task, and mark it complete.
3. For each screen record the real labels in every language, the stable elements to point at, and the interactions with visible impact.
4. List what the Demo API lacks for the routes you need and add it in the guide's own mock layer (or the deck's, if it exists), never in the host. Use synthetic records, such as `Sample task A`; do not copy customer names, identifiers, or production records.
5. Check units, formats and permissions: the labels a reader sees depend on language, number format and role.

## Phase 2: Kernel (build it, or import it from a deck)

The guide needs five pieces. If the repo already has a `deck/` built with `spatial-repo-deck`, **import them through an alias** (`@deck` → `../deck/src`) and do not copy. Otherwise build them inside `guide/src/kernel/` to these contracts:

- **Stage16x9**: a 1920×1080 element centred in the viewport, scaled by `min(w/1920, h/1080)`, with the background colour transitioning with the level.
- **Demo API** (`installDemoApi`, `demoData`, `resetDemoApi`): before any host code can issue requests, replace the embedded app's actual transports with in-browser mocks. Inventory fetch, Axios/XHR, WebSocket, and other channels the host uses, including endpoints outside `/api/*`. Allow only explicitly mocked operations; reject unknown requests locally, log method and path without credentials or payloads, and never fall through to a real backend, even on the same origin. Back this up with a browser network policy such as `connect-src 'none'` when all mocks run in memory; keep form actions and app navigation inside the demo. Return JSON where the host client expects it, keep mutations in memory, and import host entity types so `tsc` catches drift.
- **App shell** (`LiveAppShell`): the host's route tree inside a `MemoryRouter`, with the host's layout.
- **Frame** (`LiveScreenFrame`): rounded window with a dark title bar (three dots, title, light/dark toggle), isolated providers (query client with retry off, router, tooltips), wheel propagation stopped, `overlay` slot above the app, remount keyed on the store locale. Route only allowlisted demo destinations through `MemoryRouter`. Block native link navigation, form submissions, downloads, popups and programmatic redirects from the embedded app, including to same-origin URLs. Handle supported form actions through mocks. Use `form-action 'none'` as a backstop for forms; `connect-src` alone does not control navigation. Keep the HUD's deliberate “open the app” link outside the embedded frame.
- **Pointer** (`LiveGuide`): see Phase 4.

Plus `SubStepTabs` (vertical pill buttons), `StationHeader` (compact title) and the HUD pieces if you build them yourself.

## Phase 3: Architecture and layout

```text
guide/
├── package.json  tsconfig.json  vite.config.ts  index.html  .gitignore
└── src/
    ├── main.tsx            # install Demo API, hydrate stores, AWAIT locale from the hash, then render
    ├── App.tsx             # Stage16x9 + HUD + index + keyboard; stage tint per level
    ├── guide.css           # host css + @source (host AND kernel/deck) + containment + hide dev-only nav
    ├── hashRoute.ts        # #/<section>/<step>?lang=  and  #/help/<screenId>?lang=
    ├── ui.ts               # typed per-language chrome strings
    ├── content/guide.ts    # LEVELS, ROUTES, SECTIONS → steps → pointers, copy by locale
    ├── components/         # GuideStation, GuideHud, GuideIndex
    └── __tests__/
```

- **Vite**: `base: "/<hosting-path>/"`, host aliases and `dedupe` as the host needs, `fs.allow` for every source root, its own port. Copy the host or deck dependency versions exactly. In Tailwind v4 add `@source` for the host **and** the kernel/deck sources, or classes used only there are not generated and the stage collapses.
- **Hash routing**: no server rule needed on a static bucket. `#/help/<id>` resolves to the first step of the section that claims the id; unknown ids go to step 0; out-of-range steps clamp. `?lang=` is applied to the store before the first render and kept in the hash.

**Layout of a section (`GuideStation`)** on the stage: left column 400 px, live frame filling the rest.

```text
Title (compact)
        ┌ info card ───────────────┐   ← vertically centred in the free space
        │ (i)  Step title          │
        │ explanation…             │
        └──────────────────────────┘
(pill) Step 1   (active)   Step 2   Step 3
```

- The info card is white with a soft border and shadow, a **thin outline info icon** (stroke about 1.75) in the level's ink colour, the step title beside it, the explanation below. No side bar, no filled circle behind the icon: it must stay sober.
- Clicking the active pill replays the step; another pill goes to it.
- **HUD**: brand pill with the level badge (level ink colour, white text); language switch, index button (`O`), fullscreen, "open the app" link; bottom: Back, progress dots coloured per level (current wider, others dimmed), counter, Next.
- **Index**: overlay with a search box and the four levels as tinted cards (top border in the level hue) holding section pills; the active section filled with the level ink; search lists steps with their section.

## Phase 4: Pointers, dimming, state hygiene

**Content model.** `step(route, copyByLocale, ...pointers)`, `pointer = { find, side?, action?, label? }`. One `ROUTES` table holds every initial route, including query parameters for multi-step screens.

**Finders.** Prefer `data-testid`, `data-slot`, then structure (`thead`, `tbody tr`, first `input` of `main`), then text. Rules:
- Match by **regex covering every language and number format**, never by a literal value or one language.
- Match the deepest element for text, not a container that contains it.
- Do not click controls that open a portal (pickers, selects): they render outside the scaled stage. Click a neutral part of the row.
- **Verify every step in every supported locale**: a selector that works in one locale may fail in another.

**Pointer behaviour.** One pointer at a time: short delay, the ring glides to the element, the caption fades in, then the action (`type` through the native value setter plus a bubbling `input` event; `click`), re-measure, hold, next. Missing element: retry briefly, then skip. Measure with `getBoundingClientRect` relative to the frame root, divided by `rootRect.width / root.offsetWidth`. Captions sit in empty areas. Every pointer in a multi-pointer step has **its own short caption**; single-pointer steps may reuse the title.

**Dim.** A separate layer with a very large box-shadow follows the ring geometry. It fades in over about 1.1 s, out in 0.5 s, stays on between two pointers of the same step (the hole glides, it does not switch off and on), is `pointer-events: none` so the app stays clickable, and respects reduced motion. Never put the shade in the ring's own shadow: it shows at full strength with the ring and reads as a flash.

**Clean start per step.** Use an in-memory storage adapter for the embedded app, or guide-specific keys when persistence is needed. Reset only demo state and `resetDemoApi()` before mounting a new frame keyed by section, step, replay and language. Never read, write or clear the host app's draft or session keys. If the host's persistence cannot be redirected, keep the guide on a dedicated origin without access to the host's credentials or storage; do not ship it on the host origin.

**Keyboard.** `←/→`, `PageUp/Down`, `Home/End`, `O` index, `F` fullscreen, `Esc` closes the index; ignore events from inputs, dialogs and the embedded app. Focus the index search on the **next animation frame**, or the `o` that opened it is typed into the box.

## Phase 5: Content rules

1. Use one copy structure for the audience's supported locales. For Italian, follow `italiano-decente` if available.
2. Use the app's own words for labels and buttons (quote them), real role, KPI and field names. Never invent thresholds, percentages or flows; take them from specs or old help and flag anything the screen does not show.
3. A step is one thing: a short noun-phrase title and 2 to 4 sentences. Fundamentals say where and what; advanced steps say the consequence.
4. No step for something the app cannot show (an unmounted panel, a flow that does not exist): record it in the audit.
5. `helpIds` per section; sections without a help button use an empty list; no id claimed twice.

## Phase 6: App and pipeline integration

1. **Help button.** Replace the dialog with `<a href="{GUIDE_URL ?? '/guide/'}#/help/<id>?lang=<code>" target="_blank" rel="noopener noreferrer">`. Keep the id resolver and the accessible name and tooltip (title only). Drop the old help copy only after the guide covers every id, replace its tests with: URL per id and language, `target`/`rel`, and following the UI state that selects the id. Type the env variable in the env declarations.
2. **Hosting.** For same-origin hosting, build the guide and copy its `dist` into the frontend `dist/<path>/` before the existing upload. If the guide needs a dedicated origin for storage isolation, use independent access control and point `GUIDE_URL` there. Require the network and storage isolation checks to pass in the chosen hosting setup before publishing. CI installs dependencies of every project it imports from. Everything the build needs (`guide/`, and `deck/` if imported) **must be tracked in git** or CI fails. Document the path and the env variable in the deployment doc.
3. **Ports.** `vite preview` serves `dist/` under the `base`: open `http://host:port/<base>/`. Pass npm arguments with `--` (`npm run preview -- --port 4174`). Kill stale servers before screenshotting.

## Phase 7: Verification

1. `guide`: typecheck, tests, build; plus the suites of anything the guide edited (host, deck).
2. Tests: every help id has an entry section; none claimed twice; unique ids; each step has a route, at least one pointer, and a non-empty title and body in every supported locale; hash round trip, help entry, clamping. If Italian is supported, check that its copy contains no em dashes or English quotation marks.
3. **Resolve every pointer for real.** In Chrome loop over every step in **every language**, wait about 3.5 s, assert the ring exists with non-zero size. A miss means a broken finder, state leak or late render: fix the finder, not the timeout.
4. Visual QA in the browser (use `flow-visual-loop` if available): title and card centred, icon sober, shade fades gently, caption never covers what changes, level tint and badge right, index and search work, no console errors, no unhandled `/api/*`. State plainly that phones are poorly served by a scaled stage.
5. In a browser test of the built guide, point the app at a test backend and make an unmapped read and write through each host transport. Assert they fail locally and the backend receives neither. Include an endpoint outside `/api/*`. Seed a sentinel host draft, then open the guide, change steps and replay one: the demo restarts from sample data and the host draft stays untouched.
6. Verify that an allowlisted demo link changes only the memory route. With the built guide served alongside a test backend, exercise an embedded link, form submission, popup, and programmatic redirect to an unmocked same-origin destination outside `/api/*` (for example, `/sample-export`). Assert that the page stays in the guide, no popup opens, and the backend receives no request.

## Anti-patterns

- A documentation-style layout when the brief is a polished showcase look.
- Screenshots instead of the real routes; copying the kernel when a deck already provides it.
- One caption for every pointer; captions over the changing values.
- The shade in the ring's shadow, blocking clicks, or switching off between pointers.
- Finders on literal values or one language; clicks that open portals.
- Carrying help copy over unchecked.
- Loud decoration on the info card (filled badges, side bars).
- Forgetting `base`, the `@source` for imported sources, or git tracking for CI.
