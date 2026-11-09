<!-- codebase-memory-mcp:start -->
# Codebase Knowledge Graph (codebase-memory-mcp)

This project uses codebase-memory-mcp to maintain a knowledge graph of the codebase.
ALWAYS prefer MCP graph tools over grep/glob/file-search for code discovery.

## Priority Order
1. `search_graph` — find functions, classes, routes, variables by pattern
2. `trace_path` — trace who calls a function or what it calls
3. `get_code_snippet` — read specific function/class source code
4. `query_graph` — run Cypher queries for complex patterns
5. `get_architecture` — high-level project summary

## When to fall back to grep/glob
- Searching for string literals, error messages, config values
- Searching non-code files (Dockerfiles, shell scripts, configs)
- When MCP tools return insufficient results

## Examples
- Find a handler: `search_graph(name_pattern=".*OrderHandler.*")`
- Who calls it: `trace_path(function_name="OrderHandler", direction="inbound")`
- Read source: `get_code_snippet(qualified_name="pkg/orders.OrderHandler")`
<!-- codebase-memory-mcp:end -->

# Handoff per agenti e manutenzione della repository

## 1. Architettura delle sorgenti (`src/` vs `.agent-manager/` vs `export/`)

- `src/` è l'unica fonte canonica: include `src/agents/`, `src/plugins/`, `src/tools/`, `src/commands/`, `src/skills/` e `src/opencode.json`. Non modificare mai a mano i file generati sotto `export/categories/**` o `export/bridges/**`.
- `src/AGENTS.md` viene distribuito in `export/categories/{docs,slides,wiki,flow,pipeline}/AGENTS.md`. Questo `AGENTS.md` nella root è invece l'handoff per gli agenti che lavorano su questa repository.
- La categoria `flow` (`src/agents/flow-*.md`, skill `src/skills/flow-*`, comandi `src/commands/flow-*.md`, plugin `src/plugins/flow-guard`, `src/plugins/flow-mode`, `src/plugins/flow-context`) è la v2 della pipeline in stile Claude Code: l'agente di lavoro `flow-build`, la plan mode `flow-plan` nella stessa conversazione (Shift+Tab, `/flow-plan`, oppure build la propone con `flow_plan_enter`; l'utente approva il piano con `flow_plan_exit` e si torna a build) e subagent read-only (`flow-explore`, `flow-review`, `flow-research`, `flow-eye`, `flow-ops`). È una categoria con manifest V2 (`.agent-manager/categories/flow.json`) e non tocca la pipeline v1. È un **archetipo**: si distribuisce una sola volta con gli agenti canonici (niente bundle timbrati per provider) e i modelli dei subagent arrivano dalle configurazioni modelli. Gli agenti canonici `flow-*` non fissano `model`, tranne quando l'utente vuole un agente fisso (per esempio `flow-eye`, che richiede un modello con input immagini).
- **Archetipi e configurazioni modelli: leggere [`ARCHETIPI.md`](ARCHETIPI.md) prima di toccare modelli, agenti o risorse di `flow` o `pipeline`.** In breve: il TUI (`M` sulla cartella `flow` o `pipeline`) o `manage-agents routing` scrivono `.agent-manager/agent-routing.json` ("se `flow-build` o `pipeline-orchestrator` gira su questo provider o modello, i subagent usano questi modelli"). Il plugin `src/plugins/agent-router` lo applica a runtime leggendo `src/plugins/agent-router/routing.json`, che è generato e non va mai modificato a mano. Non reintrodurre bundle `*-flow` o `*-pipeline`, né profili per famiglia: sono stati rimossi apposta. I subagent di un archetipo non vanno nascosti con `hidden: true`, altrimenti spariscono dall'elenco del tool `subagent`.
- La categoria `pipeline` (`src/agents/pipeline-*.md`, comandi `src/commands/pipeline-*.md`, plugin `pipeline-guard`, `pipeline-tools`, `dev-tools`, `doc-tools`, `slide-tools` e `agent-router`) è il secondo archetipo, con `pipeline-orchestrator` come agente di riferimento. Ha il manifest V2 `.agent-manager/categories/pipeline.json` e si costruisce in `export/categories/pipeline`. Solo l'orchestratore fissa `model`, come modello di partenza; i modelli dei subagent arrivano dalle configurazioni.

## 2. Distribuzione delle categorie (Manifest V2)

- **Categorie con manifest (`docs`, `slides`, `wiki`, `flow`, `pipeline`)**: sono governate da `.agent-manager/categories/<id>.json` (`schemaVersion: 2`), che definisce l'allowlist esatta delle risorse con `policy: "text" | "binary" | "mixed" | "runtime"` e i metadati di provenienza SHA-256 (`CATEGORY.json`, `PROVENANCE.json`, `opencode.json`).
- **Sincronizzazione Resource Manager (`U` nella TUI) ↔ manifest**: `.agent-manager/companion-links.json` governa i companion link per l'export diretto a OpenCode. Quando si aggiornano i plugin di una categoria con manifest V2 (`updateCategoryCompanionLinks`), le risorse plugin già presenti in `.agent-manager/categories/<id>.json` mantengono la policy esistente (per esempio `"text"`), mentre le nuove voci plugin aggiunte ricevono `policy: "runtime"`; l'operazione valida l'ID categoria e rifiuta path traversal e symlink, poi ricostruisce il bundle in `export/categories/<id>`.

## 3. Regole sui plugin OpenCode V2 vs bridge Claude Code / Codex

- **Plugin OpenCode V2**: devono essere directory (`src/plugins/<name>/index.ts` o `index.js`) che esportano `Plugin.define` da `@opencode/plugin`. I plugin che registrano tool (`dev-tools`, `pipeline-tools`, `doc-tools` e `slide-tools`) usano `ctx.tool.transform` con import statici; `pipeline-guard` è hook-only e non registra tool. Un componente usato da più workflow (`flow` e `pipeline`) non porta il prefisso di un workflow: `dev-tools` registra `dev_env`, `dev_verify`, `dev_smoke` e `dev_serve` e viene distribuito con entrambi, come gli helper `_repo.js`, `_sessions.js`, `_bash_guard.js`, `_run.js`, `_env.js`, `_serve.js` e `_services.js`; `pipeline-tools` (`pipeline_state`, `pipeline_commit`) e `_pipeline_core.js` restano solo della pipeline. I contratti su disco non cambiano nome: `.opencode/pipeline.json`, la directory di stato `opencode-pipeline`, `$PIPELINE_SCRATCH`, `PIPELINE_SERVE_CMD` e `pipeline-supervisor`. Resource Manager (`discoverAvailableCategoryCompanionItems`), `exportAgents` e `validateCategoryManifest` accettano `index.ts` e `index.js` in directory `plugins/<name>` e rifiutano file singoli o directory senza entrypoint.
- **Plugin V1 legacy a file singolo (`plugins/*.js`)**: non sono supportati da OpenCode V2, non compaiono nel Resource Manager e non vengono convertiti automaticamente nella configurazione utente (`~/.config/opencode/plugins/`). Gli eventuali plugin personali a file singolo vanno migrati a directory o rimossi manualmente.
- **Bridge Claude Code / Codex (`B` / `Shift+B` e `manage-agents bridge`)**: generano pacchetti in `export/bridges/{claude-code,codex}/` traducendo agenti, skill, comandi e server MCP, inclusi gli endpoint MCP remoti con `url`; il `README.md` li documenta senza istruzioni di installazione locale vuote. Partono dagli agenti canonici della categoria, si bloccano se la lista agenti è vuota e non usano le configurazioni modelli (traducono i modelli con `.agent-manager/translation-config.json`). Non effettuano la transpilazione dei plugin runtime TypeScript di OpenCode (`src/plugins/*`).

## 4. Checklist operativa per aggiornare la pipeline e verificare la repository

1. Modificare solo i file canonici in `src/`. Se cambiano i profili Bash in `.agent-manager/bash-profiles.json`, eseguire `node manage-agents/manage-agents.mjs --no-auto-commit pipeline sync-bash`.
2. Rigenerare le categorie e `src/plugins/agent-router/routing.json` con `node manage-agents/manage-agents.mjs --no-auto-commit category build --all`. Il comando è idempotente sui contenuti e sulle `mtime` dei file invariati.
3. Se cambiano agenti, skill o configurazione MCP della pipeline, rigenerare i bridge:
   - `node manage-agents/manage-agents.mjs --no-auto-commit bridge --category pipeline --target claude`
   - `node manage-agents/manage-agents.mjs --no-auto-commit bridge --category pipeline --target codex`
4. Prima di concludere, validare tutto con `npm --prefix manage-agents run validate` (esegue `typecheck`, `test`, `build`, `category build --all`, `category check --all` e `bridge check`).
5. Per installare o aggiornare nella configurazione locale OpenCode (`~/.config/opencode`), eseguire `node manage-agents/manage-agents.mjs export --all --yes`. È idempotente: aggiorna solo ciò che cambia, migra il blocco MCP di `opencode.json` a V2 preservando le chiavi utente, registra le directory plugin ed elimina le vecchie risorse gestite non più consegnate tramite `.resource-export-manifest.json`. Quando installa la pipeline elimina anche gli agenti timbrati ritirati (`{free,go,hybrid,mistral}-pipeline-<ruolo>.md`), solo per nome esatto.

## 5. Regole di orchestrazione e gestione della finestra di contesto

- Non riusare mai `sessionID` per concatenare task esplorativi o di verifica indipendenti nello stesso subagent: accumula token e degrada la finestra di contesto. Aprire sempre sessioni fresche e lanciare in parallelo, nello stesso turno, tutti i subagent indipendenti.
- Non concatenare `git add` e `git commit` con `&&` se la policy della shell li blocca; verificare sempre con `npm --prefix manage-agents run validate`.
