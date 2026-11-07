---
name: flow-frontend-design
description: Visual design method for web UI work (pages, components, landing pages, dashboards, redesigns, "make it look better"). Design brief before code, typography/spacing/color systems, layout and hierarchy rules, the generic "AI-made" look to avoid, how to respect or extend an existing design system, and the review rubric used on screenshots. Load before writing or changing any user-facing UI.
---

# Frontend design

Good UI comes from deciding **what the page is for** and building a small, consistent system around it,
then **looking at the result and iterating**. Code that compiles is not the finish line; a screenshot
that would survive a designer's review is.

For visual work, "smallest diff" does not apply. Change as much markup and styling as the design
needs, while keeping behavior, data flow and public APIs intact.

## 1. Write a design brief first (5–10 lines, in your todo or reply)

- **Purpose:** what the user must understand or do on this screen, in one sentence.
- **Primary action:** the one thing that should draw the eye first. Everything else is secondary.
- **Audience and tone:** for example "developers, dense and precise", "consumers, calm and friendly" or "internal tool, quiet".
- **Content inventory:** the real elements, ranked by importance. Use real-looking copy, not lorem ipsum.
- **Constraints:** the existing design system and tokens, the component library, dark mode, the breakpoints that matter.
- **Reference:** a mockup or screenshot from the user, or a named style ("Linear-like", "Stripe docs-like"). If there is none, pick one deliberately and say so.

When the request is vague ("make it nicer"), state the direction you chose in one line and go. Do not ask
five questions.

## 2. Respect the house style, then raise its quality

1. Find the existing system before inventing one: CSS variables and theme files, `tailwind.config.*` or the `@theme` block, the shadcn `components.json`, the shared `Button`/`Card`/`Input` components, and the font setup.
2. Reuse those tokens and components. A new one-off color or radius is a smell.
3. If the existing system is weak (random spacing, five greys, no type scale), fix the **tokens** in one place. Do not patch every component.
4. shadcn/ui and similar libraries are a starting point, not a design. Adjust radius, density, colors and typography to the brief. Default shadcn plus a gradient is the generic look.

## 3. Systems to apply

**Typography**
- Use one family, or two at most (display plus text). Use the system stack or the project font. Never mix three.
- Use a modular scale, for example 12 / 14 / 16 / 20 / 24 / 32 / 48. Pick 4 to 6 steps and use only those.
- Body text is 15–18px with line-height 1.5–1.7. Headings use line-height 1.1–1.3 and tighter tracking on large sizes.
- Keep line length at 60–75 characters for prose (`max-width: 65ch`).
- Build hierarchy from **weight and size together**, using at most 3 weights (400/500/600 or 400/600/700). Muted text is a color token, not 0.5 opacity everywhere.

**Spacing and layout**
- Use a 4px base and an 8px rhythm: 4, 8, 12, 16, 24, 32, 48, 64, 96. Use nothing off-scale.
- Proximity is the main grouping tool. Related items sit close together, and sections get clearly more space than items inside them (often 2–3×).
- Align everything to a small number of edges. Most "something feels off" problems are misaligned left edges or uneven gutters.
- Keep content width deliberate: about 1100–1280px for apps, narrower for reading. Avoid full-bleed text.
- Use generous whitespace around the primary action and less in dense data areas. Density should match the audience.

**Color**
- Use a neutral ramp (about 9–11 steps) plus **one** accent and semantic colors (success, warning, danger, info).
- Neutrals carry about 90% of the UI. The accent marks interactive or primary elements only.
- Define roles, not raw colors: `bg`, `surface`, `surface-raised`, `border`, `text`, `text-muted`, `accent`, `accent-fg`, `ring`.
- Contrast must be at least 4.5:1 for text and 3:1 for large text and UI boundaries. Check muted text on tinted surfaces, which fails most often.
- Dark mode is a second set of the same roles, not inverted colors. Surfaces get lighter as they rise; shadows matter less and borders matter more.

**Depth, shape and detail**
- Use one radius scale (for example 6 / 10 / 16) and apply it consistently. Nested radii are the outer radius minus the padding.
- Prefer subtle borders (1px, a low-contrast neutral) and soft, layered shadows used sparingly. Not every block needs a shadow.
- Icons come from one set (the project's, or Lucide) with consistent stroke and size, aligned to the text baseline.
- Every interactive element needs hover, focus-visible (a visible ring), active and disabled states. Inputs need error and help text.
- Design empty, loading (skeletons matching the final layout) and error states. They are part of the design, not extras.
- Motion lasts 150–250ms with ease-out, on transform and opacity only. Respect `prefers-reduced-motion`.

**Responsive**
- Design at 375, 768 and 1280 widths. Mobile is a real layout, not a squeezed desktop: stack, reorder by priority, and make tap targets at least 44px.
- Avoid horizontal scroll at 375px except for intentional carousels and tables (wrap tables in a scroll container).

## 4. The generic "AI-made" look: avoid by default

- A purple-to-blue gradient hero, gradient text and glowing blobs as decoration.
- Everything centered, every section a grid of three identical cards with an icon on top.
- Emoji used as icons, or random icons that add no meaning.
- Heavy drop shadows plus borders plus rounded-2xl on everything.
- Vague marketing copy ("Unlock the power of…", "Seamless", "Revolutionize").
- Too many accent colors and too many font sizes.
- Glassmorphism without reason, and low-contrast grey-on-grey text.
- Placeholder avatars, fake logos and invented metrics when real content exists.

Use these only if the brief explicitly asks for them.

## 5. Implementation habits

- Tokens go in CSS variables or the Tailwind theme. Components consume roles (`bg-surface`, `text-muted`), not hex values.
- Use semantic HTML (`header`, `nav`, `main`, `section`, `button` for actions, `a` for navigation), labels on inputs, alt text and a logical heading order.
- Build layout with flex or grid and `gap`, not margins on children. Use `min-width: 0` on flex children that hold text.
- Avoid magic numbers. If a value is not on the scale, explain why in a short comment or move it to the scale.
- Keep components small. Extract a repeated block once it appears for the third time.

## 6. Look at it: the visual loop

Load `flow-visual-loop` and iterate **until the rubric passes or 3 rounds are used**. Never declare UI work done
without at least one rendered check, unless the app cannot run. In that case, say so explicitly (`UNVERIFIED: …`).

## 7. Review rubric (also used by `flow-eye`)

Score each item **pass / fix**. For every fix, give a concrete change (selector or component, then property, then value).

1. **Hierarchy:** the primary action and the main message are obvious within 3 seconds, and there is one focal point per view.
2. **Alignment and spacing:** edges line up, spacing is on-scale, and sections are clearly separated with groups tight.
3. **Typography:** at most 6 sizes are used, body text is readable, line length is fine and weights carry the hierarchy.
4. **Color and contrast:** neutrals dominate with one accent used purposefully, and contrast meets AA (including muted text).
5. **Consistency:** radius, borders, shadows, icons and buttons are uniform, and the design system is respected.
6. **States:** hover, focus-visible, disabled, empty, loading and error states exist where relevant.
7. **Responsive:** there is no overflow at 375, the layout is sensible at 768 and 1280, and tap targets are at least 44px.
8. **Polish:** there is nothing from section 4, the copy is specific and real, and no orphaned or cut-off text remains.
9. **Accessibility basics:** labels, alt text, focus order, no keyboard traps, and the console has no errors.
