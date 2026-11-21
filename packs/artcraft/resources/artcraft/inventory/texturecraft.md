# texturecraft

CLI: `texturecraft-cli mcp` · 22 tool · dumped 2026-11-21

- `bake` — Bake mesh maps (ambient occlusion, curvature, thickness, …) for generators and smart materials. Rays run on the GPU when there is one (`cpu: true` forces the CPU); per-map ray settings are `bake.settings` parameters (command_run).
- `bake_mesh_add` — Add a high-definition mesh for baking (path relative to the read root), or with `cage: true` set the bake cage. Files next to a .gltf or USD layer (buffers, base color textures) come along. Returns {name, meshes}; bake with `bake`.
- `command_batch` — Run several commands in order: steps [{id, params}]. Stops at the first error. Returns {completed, results, failed: {index, id, error} | null}; a failed batch is a tool error.
- `command_list` — List engine commands: id, label, menu path, shortcut, params doc and whether it can run now.
- `command_run` — Run an engine command by id with JSON params (see command_list). Runs with defaults, never opens a dialog. Commands given host paths (file.open, file.save, resource.import, material.save, …) are disabled: use the workspace tools (project_open, project_save, mesh_import, mesh_reimport, mesh_export, bake_mesh_add, resource_import, material_save, material_load, textures_export).
- `material_load` — Add a smart material from a .tcmat file (relative to the read root) above the selection. Returns its layer.
- `material_save` — Save a layer or folder (default: the selected one) as a smart material file (.tcmat) below the write root.
- `mesh_export` — Export the mesh with its textures (obj, glb, usda, usdc or usdz; path relative to the write root). Returns {path, textures?}.
- `mesh_import` — New project from a mesh file (path relative to the read root): one texture set per material. Returns the session; import warnings are in the session log.
- `mesh_reimport` — Reimport the project's mesh from a file (path relative to the read root) or, without a path, from the project's own copy. Texture sets map by material index; `preserveStrokes` re-projects painted pixels where the UVs changed. Returns {preserved?}.
- `paint_stroke` — Paint a stroke with the paint tool on the selected layer (or its mask target): sets the brush material (color, roughness, metallic, height) and size/hardness, then strokes through `points` in viewport pixels. See viewport_render for where the mesh is.
- `project_new` — Start a new project on a built-in mesh (one texture set per material, each with an empty paint layer). Returns the session.
- `project_open` — Open a .tcraft project or a mesh file (path relative to the read root). Returns the session.
- `project_save` — Save the project as .tcraft (path relative to the write root; omit to save to its own file).
- `resource_import` — Import an image (png, jpg, tga, tif, bmp, webp, exr, hdr; path relative to the read root) as a project resource. Returns its name, for command_run layer.add.image {name} or tool.stencil {image}.
- `session_inspect` — The whole session as JSON: project, mesh, texture sets (resolution, channels, baked maps), the layer stack top to bottom (fill sources, masks, effects, painted tile counts), tool, camera, display and history.
- `textures_export` — Export textures with a preset into a folder relative to the write root. Returns the written files and warnings.
- `ui_inspect` — Bridge mode: the app's UI state (panels, windows, mode, layout, viewport rect, toasts).
- `ui_menu_invoke` — Bridge mode: activate a menu item by id like a click (may open a window). ui.menu.list lists ids.
- `ui_screenshot` — Bridge mode: PNG of the whole app window (downscaled to 2048 px a side at most).
- `viewport_render` — Headless: render the 3D view (or the 2D UV view) as a PNG image, up to 2048 px a side. Camera yaw/pitch apply to this render only. In bridge mode use viewport_screenshot.
- `viewport_screenshot` — Bridge mode: PNG of the live app's 3D or 2D viewport.
