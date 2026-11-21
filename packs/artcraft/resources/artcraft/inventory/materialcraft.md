# materialcraft

CLI: `materialcraft-cli mcp` · 20 tool · dumped 2026-11-21

- `bitmap_import` — Embed an image (path relative to the read root) as a bitmap resource. Returns its name, for a `bitmap` node's `resource` parameter.
- `command_batch` — Run several commands in order: steps [{id, params}]. Stops at the first error. Returns {completed, results, failed: {index, id, error} | null}; a failed batch is a tool error.
- `command_list` — List engine commands: id, label, menu path, shortcut, params doc and whether it can run now.
- `command_run` — Run an engine command by id with JSON params (see command_list). Runs with defaults, never opens a dialog. Commands given host paths are disabled: use package_open, package_save, bitmap_import and outputs_export.
- `graph_new` — Add a new graph to the package from a template and open it. Returns {graph, name}.
- `library_list` — The node library: every node's id, label, category, input and output ports and parameters (id, default, range, enum options). Filter by text or category.
- `material_export` — Cook a graph at full size and write it as a portable .mcmat material (cooked maps, exposed inputs, source package) to a path relative to the write root, for TextureCraft. Optional graph, size and exposed input values. Returns {path, bytes}.
- `node_add` — Add a node to the open graph (optionally wired from another node's output). Returns {id}.
- `node_connect` — Wire an output port of one node into an input port of another (replacing what fed that input).
- `node_param` — Set one parameter of a node.
- `outputs_export` — Cook a graph at full size and write every output (base color, normal, roughness, …) into a folder relative to the write root. Returns the written files.
- `package_open` — Open an .sbs or .mcraft package (path relative to the read root). Returns the session; `package.warnings` lists unsupported content (missing nodes are kept as placeholders).
- `package_save` — Save the package (path relative to the write root; omit to save to its own file). Writes .sbs XML with adjacent resources/ or a self-contained .mcraft ZIP. In bridge mode, saving without a path runs File > Save and returns an error while a dialog or prompt blocks it.
- `session_inspect` — The whole session as JSON: package, graphs, the open graph's nodes (definition, parameters, base parameters, ports, cook errors, timings, mean values), connections, frames, comments, pins, exposed inputs, views and history.
- `ui_input` — Bridge mode: synthesize mouse, keyboard and text input in the app window (clicks, drags between node ports, scrolling, shortcuts, typing). Positions are window points (see ui_inspect for node rectangles).
- `ui_inspect` — Bridge mode: the app's UI state (panels, windows, graph view camera, node rectangles on screen, toasts).
- `ui_menu_invoke` — Bridge mode: activate a menu item by id like a click (may open a window); returns an error while a dialog or prompt blocks it. ui.menu.list lists ids and which are enabled.
- `ui_screenshot` — Bridge mode: PNG of the whole app window (downscaled to 2048 px a side at most).
- `view_render` — Headless: render the material on the 3D view's scene, or a node's output (view 2d), as a PNG up to 2048 px a side. In bridge mode use view_screenshot.
- `view_screenshot` — Bridge mode: PNG of the live app's 3D or 2D view.
