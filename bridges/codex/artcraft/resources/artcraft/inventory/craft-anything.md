# craft-anything

CLI: `craft-anything-cli mcp` · 30 tool · dumped 2026-11-21

- `core_target_close` — Close the active target (or the one named). Evidence stays in the project.
- `core_session_show` — What's open, which target is active, Clean room or Deep mode, evidence and unknown counts, version.
- `core_targets_list` — Every open target with its id, kind and sha256.
- `core_target_select` — Make another open target the active one.
- `core_evidence_show` — All evidence recorded in this session (detail=summary for a compact list; filter by operation or evidence_id).
- `core_evidence_export` — Write every evidence record and unknown to a JSON bundle file.
- `core_evidence_import` — Load a bundle written by core_evidence_export. Tampered records are rejected.
- `core_unknowns_show` — Recorded unknowns, filtered by status, severity or domain.
- `core_unknown_add` — Record something not yet known, with what would settle it.
- `core_unknown_edit` — Change an unknown's status, evidence or resolution. Pass based_on_revision; a stale revision gives stale_revision.
- `core_unknown_verify` — Check that a resolved unknown has a resolution and cites evidence that exists and is intact.
- `core_person_ask` — Ask the person a question in the app and wait for the answer: a short question, up to six suggested answers shown as buttons, and optionally a typed reply. Use it when a choice changes the result (scope, style, which feature first) and you can't decide from the evidence. Returns the answer text, or a note to continue with your best judgement if nobody answers within 30 minutes.
- `core_action_approve` — Permission check for a coding agent's action (tool name and input). Edits inside the workspace's app folder and common build commands are allowed; dev servers are refused with a hint; anything else asks the person. Returns {behavior: allow, updatedInput} or {behavior: deny, message}.
- `assets_image_generate` — Make a picture with fal.ai (Nano Banana Pro) and save it as a PNG inside app/: a texture, a sky or background, an icon, a title screen or concept art. shape: square (1024x1024, default), wide (1024x576) or tall (576x1024). Costs about $0.15, counted against the project's asset budget. Describe original designs in the original's style; never ask for recognisable characters, logos or brand artwork. Returns where it was saved, the cost and the budget left.
- `assets_model_generate` — Make a game-ready, low-poly 3D model (GLB) with fal.ai (Tripo P1) and save it inside app/. Give a prompt (a picture is made first, then turned into the model) or an image (a web address, or a picture inside the project such as reference/picture-1.png). faces caps the face count (48 to 20000, default 3000): about 500-1500 for small props and pickups, 2000-5000 for weapons, furniture and vehicles, 6000-15000 for main characters; fewer faces run faster, so use the fewest that still look right. textured (default true) gives colours and surfaces. A textured model costs $0.50 plus $0.15 for the picture, counted against the project's asset budget; it takes a minute or two. Describe one original object per model; never ask for recognisable characters, logos or brand artwork. Returns where it was saved, the cost and the budget left.
- `core_investigation_show` — The working memory of this investigation: brief, plan with step status, hypotheses, findings (with evidence ids) and the latest handoff. Read it first when starting or resuming.
- `core_brief_write` — Set the investigation brief: the question, purpose, targets, constraints and what 'done' means. Write it before the first analysis call on a new question.
- `core_plan_update` — Replace the plan with a numbered list of steps, each todo/doing/done/blocked with a short why. Pass based_on_revision to avoid overwriting someone else's update.
- `core_hypothesis_record` — Record a claim being tested, ideally with the prediction that would confirm or refute it, plus any supporting/contradicting evidence ids.
- `core_hypothesis_update` — Change a hypothesis's status (testing/supported/refuted/abandoned) and attach supporting or contradicting evidence ids and notes.
- `core_finding_record` — Record a settled answer. Requires at least one evidence id; every id is checked against the ledger. Findings are the source for reports.
- `core_finding_edit` — Correct a recorded finding without changing its id. Requires a statement and existing evidence ids; pass based_on_revision to refuse a stale investigation update.
- `core_handoff_write` — Rewrite the handoff note: where we are, what's next, traps to avoid. Write it at the end of every turn so the next turn (or agent) resumes without re-deriving.
- `core_journal_read` — Page through the project's append-only journal (tool calls, model turns, consents, errors), filtered by day, kind or tool. Needs an open project.
- `core_report_save` — Save a report a client composed (Markdown, HTML or plain text) to an absolute path the person chose. Only .md, .html, .htm or .txt files.
- `core_report_write` — Turn the investigation (brief, plan, findings, hypotheses, handoff) and the evidence ledger into a readable report: what we looked at, what we found (each finding with its plain-English summary, confidence and cited evidence), open questions, and how it was done. format=markdown (default) or html. With an absolute path it writes the file (WRITES_FILESYSTEM); otherwise it returns the text.
- `core_evidence_browse` — View part of a stored (or inline) evidence record: the summary, one part, one row of a list, a page of a list's rows (optionally only the rows matching given field values, cut to chosen fields, with the field names listed), or a part of a function dossier (pseudocode, assembly, basic_blocks, callers, callees, flow_*…), with coverage and next_offset. Nothing is analysed again.
- `rebuild_check` — For the builder: test the project's current build against the original now, with the same checks Craft Anything runs after each turn (a website's likeness at each width with the padding, colour, font and layout differences; an app's or game's picture against the original's; whether it builds; the mechanics sheet; credits). The project's running build answers it, so the builder can fix what it lists and check again before replying. Not counted as a round. project defaults to the project this tool server works for.
- `list_toolsets` — List the groups of tools (native code, Android, web, Electron, runtime…) with how many tools each has and whether it is enabled in this connection.
- `enable_toolset` — Add a group of tools to this connection's tool list (the list then changes). Use list_toolsets to see what each group covers.
