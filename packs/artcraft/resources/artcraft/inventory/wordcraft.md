# wordcraft

CLI: `wordcraft-cli mcp` · 18 tool · dumped 2026-11-21

- `list_commands` — Every WordCraft command: id, label, ribbon location, shortcut and params. Filter with `query`.
- `execute` — Run one command by id with params, e.g. {command:"format.bold"} or {command:"insert.table", params:{rows:3, cols:4}}. To insert a table that is already filled, use `insert_table`. Commands work on the active document, or on the open document `doc` names. file.new and file.open open another document beside the open ones and make it active; view.switchWindows {id} makes another one active and file.closeDocument {id, force?} closes one.
- `insert_table` — Insert a table at the caret, filled from `values` in one call (an array of rows, each an array of cells; all rows the same length, up to 1000 rows and 63 columns). Set `header` to make the first row a repeating header row.
- `batch` — Run commands in order; stops at the first error unless keepGoing. `doc` sends every command to that open document.
- `new_document` — Start a document: blank, sample, letter, resume or report. It opens beside the documents already open and becomes the active one; the reply's `id` addresses it (`doc`).
- `open_document` — Open a .docx, .doc, .odt, .rtf, .md, .tex, .html, .txt or .json file, or any other text file (.m3u, .log, .ini…) as plain text. Give `password` for a protected file; without it the call fails asking for one. The file opens beside the documents already open (it replaces a blank one nobody has used) and becomes the active one; a file that is already open becomes active again (`alreadyOpen`). The reply's `id` addresses it (`doc`).
- `save_document` — Save (format from the extension: docx, pdf, odt, rtf, html, md, tex, txt, png).
- `type_text` — Type at the caret (replacing the selection). Use \n... for line breaks inside text; use execute text.newParagraph for new paragraphs, or `paragraphs: true` to split lines into paragraphs (one undo step, at most 10000 lines).
- `select_text` — Select the n-th occurrence of some text.
- `get_text` — Body text with tracked deletions omitted.
- `inspect_document` — Structure: blocks with text, styles, formatting runs, lists, tables, sections, parts, selection, pages.
- `render_page` — Render a page to PNG to look at the result.
- `list_documents` — The open documents in the order they were opened: id, title, path, dirty (unsaved changes) and active (the one commands work on by default). new_document and open_document open another document beside these. Give a document's id as `doc` to execute, batch, type_text, select_text, get_text, inspect_document, render_page or save_document to work on it while it stays in the background; execute view.switchWindows {id} makes it the active one, file.closeDocument {id, force?} closes it.
- `parity` — WordCraft's command coverage of the word-processor feature catalog.
- `screenshot` — Screenshot of the whole WordCraft window (desktop app only).
- `click` — Click at window coordinates (desktop app only).
- `key` — Press a key with modifiers (desktop app only), e.g. {key:"B", cmd:true}.
- `ui_inspect` — UI state: tab, panes, dialog, page rectangles on screen, caret (desktop app only).
