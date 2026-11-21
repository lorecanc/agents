# deckcraft

CLI: `deckcraft-cli mcp` · 25 tool · dumped 2026-11-21

- `list_commands` — Every command (id, label, ribbon/menu place, shortcut, parameter summary, whether it is enabled now). Filter by a substring of id or label.
- `run_command` — Run any command by id with JSON parameters. This is how everything is done: slide.new, shape.insert, text.set, format.bold, shape.fill, design.theme, transition.set, animation.add, table.merge, edit.undo…
- `batch` — Run commands in order; stops at the first error unless keepGoing. Returns each result.
- `new_presentation` — Start a new presentation (one title slide). Optional theme: DeckCraft, Harbor, Ember, Meadow, Nocturne, Paper, Coral Reef, Slate.
- `open_presentation` — Open a .deckcraft or .pptx file by path.
- `save_presentation` — Save the active presentation (.deckcraft or .pptx by extension).
- `export` — Export slides: png/jpeg (one slide, or all with all:true), pptx, deckcraft, outline text, pdf (slides, notes pages or handouts), or an animated gif of the deck (one frame per slide).
- `inspect_document` — Slides (index, id, title, layout, shape count, transition, animations, notes), sections, theme, layouts, media and the selection.
- `inspect_slide` — One slide's shapes with ids, kinds, boxes [x,y,w,h], placeholder types, text, fills, tables, charts; plus background, transition, animations, notes.
- `render_slide` — Render a slide to a PNG image and return it, to check your work visually.
- `add_slide` — Insert a slide after the current one with a layout (title, titleAndContent, sectionHeader, twoContent, comparison, titleOnly, blank, contentWithCaption, pictureWithCaption) and optional title/body text (body: one paragraph per line, leading tabs indent).
- `go_to_slide` — Make a slide current (shape commands act on the current slide).
- `add_shape` — Insert a preset shape (rect, roundRect, ellipse, triangle, diamond, rightArrow, chevron, star5, heart, cloud, wedgeRectCallout, line, straightConnector1… see shape.presets) at x,y with size w×h, with optional text and fill colour (#RRGGBB or accent1..6).
- `add_text_box` — Insert a text box. Height grows to fit the text.
- `set_text` — Replace a shape's text (keeps its first run's formatting). Leading tabs set bullet levels.
- `insert_picture` — Insert a picture from a file path or base64 data, optionally at a box.
- `insert_table` — Insert a table with rows×cols and optional cell text (data: rows of strings).
- `insert_chart` — Insert a chart (column, bar, line, pie, doughnut, area, scatter, stackedColumn…) with categories and series, optionally at a box.
- `select` — Select shapes by id (formatting commands then act on them).
- `pointer` — Drive the active tool with pointer events in slide points: down/drag/up/move/doubleclick/contextclick, exactly like the mouse (draws, moves, resizes, rotates, places the caret; contextclick selects like a right click).
- `select_tool` — Pick the pointer tool: select, textBox, shape (with preset), pen, highlighter, eraser — or a preset name.
- `key` — Press a key as on the keyboard: text editing keys (arrows, Backspace, Enter, Tab), nudges, and shortcuts (cmd+B…).
- `type_text` — Type text into the text being edited (or into the selected shape).
- `screenshot` — Screenshot of the whole DeckCraft window (UI included). Desktop app only (`deckcraft-cli mcp --connect PORT`).
- `call_app` — Call any control-channel method (ui.click, ui.set, ui.dialog.*, ui.inspect…). Desktop app only (`deckcraft-cli mcp --connect PORT`).
