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

Questa repository ospita solo pack. `manage-agents` (nella repository indipendente
[`lorecanc/manage-agents`](https://github.com/lorecanc/manage-agents)) li valida, li installa, li modifica e ne genera
il routing dei modelli seguendo il contratto versionato pubblicato in
[`contract/CONTRACT.md`](https://github.com/lorecanc/manage-agents/blob/main/contract/CONTRACT.md), unica interfaccia
ammessa tra catalogo e motore.

## 1. Struttura

- `packs/<nome>/`: un pack per directory, con `opencode-pack.json` e il layout nativo di OpenCode (`agents/`,
  `commands/`, `skills/<id>/SKILL.md`, `plugins/<nome>/index.ts`, `tools/<pack>/`, `resources/<pack>/`,
  `opencode.json`, `AGENTS.md`). Sono l'unica fonte: niente viene generato dentro `packs/`.
  - Workflow: `flow`, `pipeline`, `docs`, `slides`, `wiki`, `general`.
  - Pack condivisi, elencati nei `requires` di chi li usa: `common` (MCP `codebase-memory-mcp`,
    `experimental.todo`, skill comuni), `code-review`, `dev-tools` (`dev_env`, `dev_verify`, `dev_smoke`,
    `dev_serve` e gli helper `_repo.js`, `_sessions.js`, `_run.js`, ...), `office-tools` (tool `doc_*` e `slide_*`
    con gli script Python), `toolkit` e `integrations` (server MCP opzionali e LSP).
- `scripts/`: strumenti del catalogo. `merge-packs.mjs` costruisce `.tree/`; `sync-bash.mjs` e `bash-profiles.json`
  generano le regole `shell` degli agenti della pipeline.
- `.tree/`: vista unita di tutti i pack, con il layout che OpenCode riceve dopo l'installazione. È generata (da
  `npm test` o `npm run merge`), ignorata da git e non va modificata.
- `bench/`, `bin/`, `docs/`: benchmark degli agenti, `opencode-wt` e documentazione; girano da `.tree/`.
- `bridges/`: plugin Claude Code e layer Codex generati dalla pipeline, più `translation-config.json`. Si rigenerano
  con il motore, mai a mano.

## 2. Regole del contratto da ricordare

- Ogni file che non è nativo di OpenCode sta nel namespace del pack: `tools/<pack>/…`, `resources/<pack>/…`. Il
  codice usato da più pack va in un pack dedicato, che gli altri richiedono in `requires`. Un pack può riferirsi solo
  ai file dei pack che richiede direttamente.
- Un pack può impostare in `opencode.json` solo `plugins`, `mcp`, `skills`, `instructions`, `agents`, `commands`,
  `formatter`, `lsp` ed `experimental`. Il resto (`model`, `default_agent`, `providers`, `permissions`) appartiene
  all'utente. Due pack non possono impostare la stessa voce con valori diversi.
- I test (`*.test.*`) stanno accanto al codice che verificano, non vengono installati e girano su `.tree/`: per
  questo i loro import seguono il layout installato (`../dev-tools/_repo.js`), non quello del singolo pack.
- Prima di consegnare, ogni pack modificato deve passare `manage-agents pack validate --git packs/<nome>`.

## 3. Archetipi: `flow` e `pipeline`

- Sono pack con `archetype` nel manifest: i chiamanti (`flow-build` e `flow-plan`, `pipeline-orchestrator`)
  delegano ai subagent del pack. Quando un chiamante gira su un provider o su un modello esatto, `routingDefaults`
  assegna i modelli dei subagent; i ruoli assenti, o con `inherit`, usano il modello del chiamante.
- `routingDefaults` si modifica con la TUI (`m` sulla cartella del pack, senza agenti selezionati), che scrive `opencode-pack.json` e rivalida
  il pack. Ciascun utente sovrascrive i default per il proprio target con `manage-agents models`, senza toccare il
  catalogo.
- Il plugin di routing (`plugins/manage-agents-router`) e il suo `routing.json` appartengono al motore, che li
  installa e li rigenera a ogni reconcile. Non vanno aggiunti a un pack.
- Un subagent con `model` nel frontmatter è fisso e il routing lo salta: si fissa solo quando serve davvero (per
  esempio un modello con input immagini per `flow-eye`). Tra i chiamanti, solo `pipeline-orchestrator` fissa `model`,
  come modello di partenza. I subagent di un archetipo non vanno nascosti con `hidden: true`, altrimenti spariscono
  dall'elenco del tool `subagent`.
- `flow` è la v2 della pipeline in stile Claude Code: l'agente di lavoro `flow-build`, la plan mode `flow-plan`
  nella stessa conversazione (Shift+Tab, `/flow-plan`, oppure `flow_plan_enter`, con approvazione tramite
  `flow_plan_exit`) e i subagent read-only `flow-explore`, `flow-review`, `flow-research`, `flow-eye`, `flow-ops`.

## 4. Plugin OpenCode V2 e bridge

- Un plugin è una directory `plugins/<nome>/index.ts` (o `index.js`) che esporta `Plugin.define` da
  `@opencode/plugin`. I plugin che registrano tool (`dev-tools`, `pipeline-tools`, `doc-tools`, `slide-tools`, `flow-mode`
  con `flow_plan_enter` e `flow_plan_exit`) usano `ctx.tool.transform` con import statici; `pipeline-guard`,
  `flow-guard` e `flow-context` usano solo gli hook. I file singoli `plugins/*.js` di OpenCode V1 non sono supportati.
- Un componente condiviso da più workflow non porta il prefisso di un workflow (`dev-tools`, non `pipeline-dev`). I
  contratti su disco restano invariati: `.opencode/pipeline.json`, la directory di stato `opencode-pipeline`,
  `$PIPELINE_SCRATCH`, `PIPELINE_SERVE_CMD` e `pipeline-supervisor`.
- I bridge (`manage-agents bridge --pack pipeline --target claude|codex`, oppure `B`/`Shift+B` nella TUI) traducono
  il pack con i pack che richiede: agenti, comandi, skill, server MCP e LSP. Usano
  `bridges/translation-config.json` e non le configurazioni dei modelli. I plugin TypeScript e i tool custom non
  vengono tradotti: il README generato li elenca.

## 5. Checklist operativa

1. Modificare i file in `packs/`. Se cambiano i profili in `scripts/bash-profiles.json`, eseguire
   `npm run sync-bash`; `npm run check` segnala gli agenti non allineati.
2. Eseguire `npm test`, che ricostruisce `.tree/` e lancia i test dei pack, del bench e degli script.
3. Validare i pack toccati con `manage-agents pack validate --git packs/<nome>` (con `manage-agents` installato da
   `lorecanc/manage-agents` nel `PATH`, oppure invocato con `node <percorso-manage-agents>/manage-agents.mjs`).
4. Se cambiano agenti, skill o server MCP della pipeline o dei pack che richiede, rigenerare i bridge e verificarli:
   - `manage-agents --no-auto-commit bridge --pack pipeline --target claude --no-register`
   - `manage-agents --no-auto-commit bridge --pack pipeline --target codex`
   - `manage-agents bridge check`
   I flag `--no-register` e `--no-validate` vengono salvati in `bridges/translation-config.json`: se non devono
   restare, ripristinare il file dopo la generazione.
5. Per provare i pack nella propria configurazione OpenCode: registrare una volta il catalogo come sorgente
   (`manage-agents source add catalog <percorso-del-repo>`), poi `manage-agents install flow pipeline`. Dopo una
   modifica, `manage-agents update` porta il target alla nuova versione; `manage-agents status` dice se qualcosa si
   è disallineato.

## 6. Regole di orchestrazione e finestra di contesto

- Non riusare mai `sessionID` per concatenare task esplorativi o di verifica indipendenti nello stesso subagent:
  accumula token e degrada la finestra di contesto. Aprire sessioni fresche e lanciare in parallelo, nello stesso
  turno, tutti i subagent indipendenti.
- Non concatenare `git add` e `git commit` con `&&` se la policy della shell li blocca.
