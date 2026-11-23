---
description: Build a standalone presentation SPA in `deck/` for any repository,
  on a 16:9 stage with a slow animated camera between stations, where the
  product's real screens and components run live on an in-browser Demo API and a
  pointer explains and operates them. The look is derived from the repo's own
  design system. Use when asked for an interactive presentation, product
  showcase or demo deck of a codebase, in any stack with a web frontend.
---

# Spatial Repo Showcase Deck (`deck/`)

A self-contained Vite SPA in `<repo>/deck/` that turns a codebase into a presenter-ready spatial presentation: fixed 16:9 stage, calm camera moves between stations, overview map, keyboard control, and the **real UI** running on an in-browser Demo API with data that is faithful to the domain.

This skill is repo-agnostic. Nothing here is a fixed colour, font, product term or route: every visual and every word is derived from the repository you are working on (Phase 0 and 1). The numbers below (stage size, type scale, timings) are engine defaults, not brand choices.

It is not a slide deck: each station develops **one idea**, shows it with something that moves or reacts, and every sub-step changes what is on screen.

## Quality bar (read before building)

The finished deck looks like this, in any repo:
- A full-viewport stage with a flat, brand-tinted background per act, a floating HUD (brand pill with act badge, language, map, fullscreen; Back / progress dots / Next), and nothing else chrome-like.
- Stations are either **narrative** (a title, one lead sentence, one dominant visual: a calculator, a diagram, a chart, real KPI cards) or **live** (a compact title and sub-step pills beside or above the real app inside a window frame, with a pointer that dims the rest and explains one element at a time).
- Text is large, contrast is strong, motion is slow and never flashes. The real app is clickable.

First drafts usually fail in the same ways. Avoid them from the start: inventing a layout instead of building from this blueprint; dark panels on dark surfaces; sub-steps that only zoom; callouts at fixed coordinates; copy that talks about the demo ("real component", file names); decorative stat strips; the embedded app rendered before its locale is loaded. Check the draft against this list before showing anything.

## Core principles

1. **One idea per station.** Split until each station has a single dominant visual.
2. **Every sub-step changes the content** (another tab, calculator, route of the live app). A stop that only nudges zoom is a defect; keep a test that proves otherwise.
3. **The pointer acts on the real UI.** It finds a real element, dims the rest, captions it, then operates it (types, clicks) so the mock visibly changes.
4. **Mix full screens and isolated components.** A framed screen with the app shell for end-to-end flows; a bare stage for a single real component without chrome. Alternate for rhythm.
5. **Readable from the back of a room.** On a 1920×1080 stage: title 48 to 64, lead 22 to 26, body 20 to 24, captions not under 17, HUD 14 to 16. Scale the embedded app up (`zoom`) so its laptop-sized text reads.
6. **The repo's design system wins.** Re-skin nothing: import its stylesheet, tokens and fonts, and let the deck inherit them.

## Phase 0: Design translation (repo's design system → deck)

Do this once, in writing, before any layout:

1. **Find the tokens**: global stylesheet, Tailwind/theme config, CSS variables, font files. Record: brand ink (darkest text colour), brand accent, one or two secondary hues, neutrals, success/warning/danger, display font, text font, numeric font if any, radius scale, shadow style.
2. **Define surface roles** (derive, do not invent):
   - `dark`: the darkest brand colour, used only to frame content;
   - `light`: the lightest neutral, where most reading happens;
   - `accent`: a deep secondary hue for the closing act;
   - `panel`: white (or the app's card colour) on which all text is read;
   - `ink` / `ink-soft`: panel text colours; check each pair for 4.5:1 and adjust the soft ink if needed.
3. **Map the type scale**: display font for titles and big numbers, text font for everything else, tabular numerals for money and percentages. Keep the host's weights and tracking.
4. **Map act colours** to those surfaces, with enough contrast between acts to feel like a journey (dark → light → accent is the default; fewer acts if the product is small).
5. **Decide the audience language(s)** and the dictionary shape. If Italian is among them and the `italiano-decente` skill exists, load it.

If the repo has no usable design system, pick one restrained palette (one ink, one accent, neutrals) and one font pair, and say so in the plan.

## Phase 1: Discovery and ground truth

Inspect in parallel before writing code:

1. **Domain and ground truth**: README, project guidelines, business specs, formulas, glossaries. Never invent numbers that break domain invariants.
2. **Frontend architecture**: package manifest, router and its route tree, state store, i18n (check **when** catalogs load), API client.
3. **API transport and auth guards**: how data is fetched, what triggers redirects (non-JSON content type, 401), what headers are required.
4. **Component inventory**: 3 to 5 full screens for framed live stations; 4 to 6 atomic components for isolated stages.
5. **Units per field**: verify how values are stored and displayed. For example, a completion rate of 25% might arrive as the fraction `0.25` or the whole-percent value `25`; format it according to the actual API contract.
6. **Demo scenario**: pick one coherent scenario with synthetic records and totals that reconcile everywhere in the deck. Do not copy customer names, identifiers, or production records.

## Phase 2: Architecture blueprint

`deck/` is a sibling Vite app that never modifies host backend, frontend or CI:

```text
deck/src/
├── main.tsx                 # install Demo API, hydrate stores, AWAIT locale catalog, then render
├── App.tsx                  # Stage16x9 + CameraWorld + StationSlot; lazy mount of live stations
├── format.ts                # locale-safe currency/number/percent
├── styles/deck.css          # host css import + @source + surface tokens + containment + hide dev-only nav
├── content/copy.ts          # typed per-language dictionary; arrays per sub-step (leads, guides)
├── engine/
│   ├── deckConfig.ts        # STATIONS (grid + serpentine), SUB_STEP_COUNTS, CAMERA_STOPS
│   ├── Stage16x9.tsx  CameraWorld.tsx  WorldConduits.tsx
│   ├── useDeckNavigation.ts # #step-N hash, keyboard guards
│   ├── useVisit.ts          # counter that bumps each time a station becomes active again
│   ├── DeckHud.tsx          # large controls, contrast per surface
│   └── OverviewMap.tsx      # bands computed from stations; aspect from world bounds
├── components/
│   ├── LiveScreenFrame.tsx  # window chrome, theme toggle, providers, overlay slot
│   ├── LiveComponentStage.tsx
│   ├── LiveAppShell.tsx     # host route tree in MemoryRouter
│   ├── LiveStationLayout.tsx# compact title + sub-step pills, live screen taking the rest
│   ├── LiveGuide.tsx  guideFinders.ts   # pointer: ring, dim, caption, action
│   ├── StationHeader.tsx  SubStepTabs.tsx  Reveal.tsx  AnimatedNumber.tsx
├── mocks/ demoData.ts installDemoApi.ts
├── stations/NN-*.tsx
└── __tests__/
```

Keep `subStep` as the **single source of truth**: tabs and buttons inside a station call `goToStation(id, subStep)` so HUD counter, hash and content never diverge. Local state is only for free interaction inside a view (sliders, a selected node).

Component contracts (build them to these):
- **Stage16x9**: a fixed-size (1920×1080) element centred in the viewport and scaled with `min(w/1920, h/1080)`; background colour transitions with the active act.
- **CameraWorld**: all stations laid on a 2-D grid; the camera is a transform of the world to centre a target with a zoom, driven by a critically damped spring.
- **LiveScreenFrame**: a rounded window with a dark title bar (three dots, title, theme toggle), then the app area with its own providers; accepts `overlay` rendered above the app.
- **LiveStationLayout** variants `top` / `left` / `right`: title, lead and vertical or horizontal pills next to the frame. Never repeat the same variant on consecutive live stations.

## Phase 3: Narrative (derive it from the product)

Build the story from the workflows and capabilities found in Phase 1. Choose the number and focus of acts to fit the product, with clear surface contrast between acts. Give each major workflow stage its own live station and each real workflow step its own sub-step; mount live stations lazily on first arrival and keep them mounted afterwards.

For example, a fictional task tracker could use this three-act outline. Adapt it to the capabilities the actual product supports:

- **Act I, `dark` surface: the problem.** Show four sample tasks and make it clear which ones still need attention.
- **Act II, `light` surface: the workflow.** Filter the task list, open a task, and mark it complete.
- **Act III, `accent` surface: the result.** Show the updated completion count and offer a shortcut back to the live workflow.

Snake the stations over rows (left to right, down, right to left, down…) so conduits between them are short.

## Phase 4: Surfaces, motion, accessibility

**Surfaces.** On dark and accent stations the background only frames content; reading happens on `panel`. Never dark panels on dark surfaces, translucent white small text, or accent-on-accent. Keep the tokens in `deck.css` and a `contrast` test that parses them and asserts 4.5:1 for every text/surface pair in use.

**Motion (slow, calm, no flashing).**
- Appear: fade plus 16 to 24 px of travel, 0.5 to 0.8 s, ease-out; stagger 0.15 to 0.25 s. Count-ups 1.5 to 2.3 s, restarted on activation.
- Camera: critically damped spring (no overshoot).
- Forbidden: infinite pings and pulses, scale pops on selection, blur-and-scale exits, visible spring bounce, anything blinking, large high-contrast area changes, more than 3 changes per second. Looping decoration only on 10 s+ cycles and a few pixels of travel.
- Never cross-fade two scenes made of large light panels over a dark background (both show at half opacity and read as a flash). Fade out, swap, fade in in sequence, or do not fade.
- Selection feedback changes one property only. Keep containers (min-height) stable when content swaps.
- Respect `prefers-reduced-motion` everywhere.
- `motion` owns `transform`: never set a `transform` style on an element that also animates `scale`/`x`/`y`; put the static translate on a plain wrapper.
- Guided sequences must not exceed about 10 s per step.

## Phase 5: Host integration and Vite hygiene

1. **CSS.** Import the host stylesheet and add `@source` for the host sources (Tailwind v4). Containment: `.deck-live-screen { position: relative; transform: translateZ(0); contain: layout style; overflow: clip; isolation: isolate; }` and override full-height utilities (`h-screen`) to `height: 100%`. Hide developer-only host entries with CSS in `deck.css`, never by editing host code.
2. **Vite.** Mirror host aliases; `resolve.dedupe` for every stateful singleton; exact aliases for `react`, `react-dom`, `react-hook-form` to concrete files so tests never load a second copy; `server.fs.allow` for `deck/` and host `src/`.
3. **Frame providers and navigation**: query client (retry false), `MemoryRouter`, tooltip provider; stop wheel propagation. Route only allowlisted demo destinations through `MemoryRouter`. Block native link navigation, form submissions, downloads, popups and programmatic redirects from the embedded app, even for same-origin URLs. Handle supported form actions through mocks. Use `form-action 'none'` as a backstop for forms; `connect-src` alone does not control navigation.
4. **Demo API.** Before host code can issue requests, replace its actual transports (fetch, Axios/XHR, WebSocket, or others found in discovery) with in-browser mocks. Allow only explicitly mocked operations, including routes outside `/api/*`; reject unknown requests locally and never fall through to a live backend. Back this up with a browser network policy such as `connect-src 'none'` for in-memory mocks, and keep form actions and app navigation inside the demo. Return JSON where the host expects it. Keep mutations and `resetDemoApi()` in memory; use an in-memory or deck-specific storage adapter and never touch host draft or session keys. If persistence cannot be redirected, use a dedicated origin without access to host credentials or storage. Import host entity types into `demoData.ts` so `tsc` catches drift; no `as any`.
5. **Locale readiness.** Render only after the locale catalog is loaded (`.then(render)`; top-level await breaks the default target) and key the embedded router on the store locale.
6. **Zoom.** Apply `zoom` on the wrapper around the embedded app; keep overlays outside it and convert coordinates.
7. **Keyboard.** Hash sync; arrows, PageUp/Down, Space, Home/End, digits, `O` map, `F` fullscreen, `Esc`. Ignore inside inputs, selects, listboxes, menus; ignore Space on buttons and arrows on tabs and sliders. The pointer must never leave focus on an input.
8. **Ports.** A stale `vite preview` may hold the default port; if the dev server moves port, point scripts at the new one, or you screenshot an old build.

## The pointer (guide that operates the UI)

- A step is `{ find(root) → element, label, side, action? }`. `find` locates the real DOM element (by `data-testid`/`data-slot`, index, input value, text pattern); never hard-code pixel coordinates.
- One step at a time: short delay, the ring glides to the element (geometry tween, no pulsing), the label fades in, then the action: `type` (native value setter plus a bubbling `input` event so React `onChange` fires; progressive for search boxes, `instant` for numeric fields) or `click`. Re-measure after the action (layout shifts), hold, fade, next.
- **Dim** (optional `dim`): everything but the target is shaded by a separate layer (large box-shadow) that follows the ring geometry, fades in slowly (about 1.1 s), out faster (0.5 s), stays on between pointers of one step, and never blocks clicks. Do not bake the shade into the ring's own shadow: it appears at full strength with the ring and flashes.
- Missing element: retry for a few seconds, then skip.
- Measure with `getBoundingClientRect` relative to the frame root and divide by `rootRect.width / root.offsetWidth` to undo stage scale.
- Choose actions with visible impact (filter a table and its KPIs, reveal archived rows, change a value that moves totals, open a detail route). Avoid actions that open portals (popovers, selects): they render outside the scaled stage.
- Caption in empty areas, never over the values that change. Memoise the steps array.
- Restart on every arrival (`key={`${useVisit(active)}-${subStep}`}`).
- **The presenter starts it.** The first "next" on a guided stop is consumed and arms the guide; a hint pill shows meanwhile; the armed state is keyed by stop id.
- **Guided camera.** `LiveGuide` can report the element centre in station coordinates and a zoom (wide 1.2, medium 1.3, small 1.4); the app clamps it inside the station and passes a modified stop to the camera.

## Copy, brand and anti-LLM rules

1. No vanity stat strips, no off-brand uppercase eyebrows above titles, monospace only for literal code.
2. No meta-dev copy: no file paths, component names, "Demo API", "real component", "LIVE DEMO" pills, sparkle icons.
3. No decorative numbering of non-sequential cards; no raw enum identifiers in UI text (keep ids in code, labels in the dictionary).
4. Write for the audience's supported locales; all locale dictionaries share one type.
5. Derive displayed totals from the same demo records across stations, so a change in the live workflow agrees with the summary.

## Phase 6: Verification

1. `cd deck && npm run typecheck && npm test && npm run build`.
2. Tests to keep: hero render, stop progression, hash sync, map jump, language switch, shortcut guards; **every sub-step of every station renders different content**; calculators recompute; contrast on the tokens; guide with fake timers (label shows, input typed, button clicked, missing element skipped); no vanity strings, filenames, em dashes or raw enums in the copy.
3. **Visual QA.** Drive Chrome at 1920×1080, wait for the hash and a reload, capture each stop and timed shots of the guided sequences. Check: no dark-on-dark text, no panel under the HUD, no empty third of the stage, sane numbers, no console errors, no unhandled `/api/*`. If you cannot inspect the images, delegate to `flow-eye` when available (max 6 screenshots per call, never two against the same Chrome); otherwise report that the screenshots were not visually reviewed.
4. Re-check at 1366×768 and 1280×720 and with `prefers-reduced-motion`.
5. In a browser test of the built deck, point the app at a test backend and make an unmapped read and write through each host transport, including an endpoint outside `/api/*`. Assert they fail locally and the backend receives neither. Seed a sentinel host draft and verify that visiting and replaying live stations leaves it untouched.
6. Verify that an allowlisted demo link changes only the memory route. With the built deck served alongside a test backend, exercise an embedded link, form submission, popup, and programmatic redirect to an unmocked same-origin destination outside `/api/*` (for example, `/sample-export`). Assert that the page stays in the deck, no popup opens, and the backend receives no request.

## Anti-patterns

- Zoom-only sub-steps; stops repeating the previous view.
- Dark panels on dark surfaces, small captions, text under 4.5:1.
- Callouts at fixed coordinates or covering what changes.
- Infinite pulses, bouncing springs, scale pops, blur exits, layout jumps.
- Rendering the embedded app before its locale loads.
- Converting every percent field to a fraction without checking.
- Touching host production code: all wiring stays inside `deck/`.
- Starting from a blank layout instead of the blueprint, or from a documentation-site look.
