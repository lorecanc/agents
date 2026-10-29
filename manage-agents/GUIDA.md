# Guida pratica a Manage Agents

Manage Agents è lo strumento da terminale del repository per consultare e modificare gli agenti OpenCode, generare distribuzioni di categoria e creare bridge per Claude Code o Codex. Puoi usarlo con comandi CLI oppure con l’interfaccia interattiva TUI.

> **Prima di iniziare:** molte azioni scrivono file o sostituiscono contenuti. Leggi le note di sicurezza e backup prima di eseguire `export`, `import`, `category build` o un’azione di modifica nella TUI. Per la prima prova, usa i comandi di sola lettura indicati qui sotto.

## Indice

- [Avvio rapido](#avvio-rapido)
- [Avvio per sistema operativo](#avvio-per-sistema-operativo)
- [Scegliere CLI o TUI](#scegliere-cli-o-tui)
- [Riferimento CLI per attività](#riferimento-cli-per-attività)
- [Rilascio versioni e sincronizzazione tra repository (sync)](#rilascio-versioni-e-sincronizzazione-tra-repository-sync)
- [TUI: navigazione e comandi](#tui-navigazione-e-comandi)
- [Ricette operative](#ricette-operative)
- [Configurazione, dati e sicurezza](#configurazione-dati-e-sicurezza)
- [Risoluzione dei problemi](#risoluzione-dei-problemi)

## Avvio rapido

Requisiti: **Node.js 26.4.0 o superiore** oppure **Bun 1.3.0 o superiore**; Bun è consigliato. Per creare agenti o selezionare/riparare modelli, serve anche il comando `opencode` disponibile nel `PATH`: `opencode models` deve poter restituire un catalogo di modelli. Questo requisito è distinto dall’avvio del manager/TUI, che può partire anche se il catalogo non è disponibile. Per la validazione e la registrazione automatica dei bridge Claude serve la CLI `claude` nel `PATH`; se manca, il bridge genera comunque l’output e segnala le due operazioni come saltate. Da una shell, entra nella directory del manager, installa le dipendenze e avvia la TUI:

```bash
cd manage-agents
npm ci
npm start
```

In alternativa, dalla radice del repository puoi avviare il manager senza cambiare directory:

```bash
npm ci --prefix manage-agents
npm start --prefix manage-agents
```

`npm ci` installa le dipendenze bloccate dal lockfile. Il primo avvio può compilare automaticamente il bundle: non serve eseguire prima `npm run build`. Con Node il launcher riavvia il processo con l’opzione FFI richiesta da OpenTUI; usa la versione minima supportata. Bun non richiede quel riavvio.

Con Bun puoi installare le dipendenze da `manage-agents/` con `bun install` e avviare con `bun manage-agents.mjs`.

Per lanciare direttamente un comando CLI, dalla radice:

```bash
node manage-agents/manage-agents.mjs lint
```

Se ometti il sottocomando, si apre la TUI. **Non esiste un comando `--help` globale**: usa l’help specifico supportato da `bridge` e dai sottocomandi `category`; un sottocomando sconosciuto ricade nell’avvio della TUI, non mostra l’indice dei comandi.

## Avvio per sistema operativo

I comandi seguenti presuppongono che la directory corrente sia la radice del repository, salvo dove indicato.

### macOS e Linux

Launcher shell (TUI):

```bash
./manage-agents.sh
```

Oppure con Node, Bun o npm:

```bash
node manage-agents/manage-agents.mjs
bun manage-agents/manage-agents.mjs
npm start --prefix manage-agents
```

### Windows PowerShell

```powershell
node .\manage-agents\manage-agents.mjs
bun .\manage-agents\manage-agents.mjs
npm start --prefix manage-agents
```

Per passare argomenti al comando npm, separali con `--`, per esempio `npm start --prefix manage-agents -- lint`. Se un percorso contiene spazi quando avvii direttamente un eseguibile, racchiudilo tra virgolette e usa l’operatore di chiamata PowerShell `&`.

### Windows cmd

```bat
node .\manage-agents\manage-agents.mjs
bun .\manage-agents\manage-agents.mjs
npm start --prefix manage-agents
```

Il launcher `manage-agents.sh` non è per cmd: usa WSL o Git Bash se vuoi lanciarlo. Da WSL/Git Bash puoi seguire le istruzioni macOS/Linux.

### WSL e Git Bash

Apri la radice del repository nella shell Bash e avvia:

```bash
./manage-agents.sh
```

In alternativa, usa `node manage-agents/manage-agents.mjs` o `bun manage-agents/manage-agents.mjs`. Controlla che Git e il runtime scelto siano disponibili nel `PATH` di quella shell.

## Scegliere CLI o TUI

- **CLI**: adatta a verifiche ripetibili, script e comandi espliciti. Per esempio `lint`, `audit` e `category check` non modificano i file.
- **TUI**: adatta a selezionare agenti, controllare differenze e applicare modifiche guidate. Avviala con `npm start`, con il launcher o senza sottocomando.

Il manager individua il workspace se avviato dalla radice del repository, dalla directory `agents/` o da `manage-agents/`. Per evitare ambiguità negli script, esegui i comandi CLI dalla radice e conserva nei tuoi appunti la directory corrente indicata negli esempi.

## Riferimento CLI per attività

Gli esempi in questa sezione partono dalla **radice del repository**. Se sei già in `manage-agents/`, usa `npm start -- <comando>`: npm inoltra ciò che segue `--` al manager. Per esempio:

```bash
cd manage-agents
npm start -- category check --all
```

Le opzioni globali `--auto-commit` e `--no-auto-commit` vanno prima del sottocomando (e prima dell’eventuale separatore `--` di npm). Per esempio: `node manage-agents/manage-agents.mjs --no-auto-commit category build docs`.

### Creare e mantenere il catalogo

| Obiettivo | Comando | Effetto |
|---|---|---|
| Creare un agente | `node manage-agents/manage-agents.mjs create` | Apre un wizard che chiede famiglia opzionale, categoria, ruolo, descrizione e modello. Il file viene creato in `agents/general/agents/`. |
| Controllare i nomi | `node manage-agents/manage-agents.mjs lint` | Report di conformità alla convenzione `[{family}-]{category}-{role_with_underscores}.md`; sola lettura. |
| Vedere le rinomine proposte | `node manage-agents/manage-agents.mjs fix-names --dry-run` | Mostra i nomi suggeriti senza scrivere. |
| Correggere i nomi | `node manage-agents/manage-agents.mjs fix-names` | Chiede conferma; rinomina i file e aggiorna i riferimenti riconosciuti. Fare prima una verifica e un backup del lavoro. |
| Controllare permessi e rischi | `node manage-agents/manage-agents.mjs audit` | Report di ordine delle regole e livelli di rischio; sola lettura. |
| Impostare steps, temperature e thinking/effort | `node manage-agents/manage-agents.mjs tune --steps 50 --temp 0.2 --effort high` | Aggiorna i parametri per tutti gli agenti individuati. Specificare una categoria restringe il gruppo. |

`create [name]` accetta un argomento opzionale `name`, ma il flusso attuale non lo usa per precompilare il nome: categoria e ruolo vengono comunque chiesti nel wizard. Usa `create` senza argomento.

Per il tuning, `--steps <n>`, `--temp <n>` e `--variant <nome>` (alias `--effort <nome>`) sono indipendenti e i campi omessi restano invariati. Usa `--clear-variant` (alias `--clear-effort`) per rimuovere il variant configurato e tornare al default. `--category <nome>` o `-c <nome>` limita gli agenti alla categoria indicata. La temperatura deve essere tra 0 e 1; gli steps devono essere non negativi. Esempi mirati:

```bash
node manage-agents/manage-agents.mjs tune --category wiki --steps 40 --temp 0.2
./manage-agents.sh tune --effort high --category copilot
node manage-agents/manage-agents.mjs tune --clear-variant --category copilot
```

`variant` in frontmatter configura l’effort di thinking/reasoning del modello tramite il mapping del provider OpenCode. I variant standard documentati dipendono da provider e modello: Anthropic include `high` e `max`; OpenAI `none`, `minimal`, `low`, `medium`, `high` e `xhigh`; Google `low` e `high`. Sono possibili anche variant personalizzati definiti nella configurazione del modello. Consulta la documentazione ufficiale OpenCode su [agenti](https://opencode.ai/docs/agents/#additional) e [variant dei modelli](https://opencode.ai/docs/models/#variants).

### Sincronizzare con OpenCode

```bash
node manage-agents/manage-agents.mjs import --dry-run
node manage-agents/manage-agents.mjs export --category wiki
```

- `import [--dry-run]` confronta gli agenti e le risorse di dominio in OpenCode con `agents/general/`. `--dry-run` mostra in anteprima le modifiche ad agenti e risorse senza modificare file né creare backup. L’import effettivo, da CLI o TUI, applica solo agenti nuovi/modificati e risorse companion modificate (`tools/`, `commands/`, `skills/`, `plugins/`); i file identici vengono saltati e non viene creato un backup se non ci sono differenze.
- `export` esporta gli agenti del catalogo nella directory di configurazione OpenCode con sovrascrittura completa, incluso il campo model. La directory è `$XDG_CONFIG_HOME/opencode/` se `XDG_CONFIG_HOME` è impostata, altrimenti `~/.config/opencode/`. Senza filtri esporta tutti gli agenti e chiede conferma.
- `export --all` o `export -a` esplicita l’esportazione completa. `export --category <nome>` o `export -c <nome>` limita l’operazione alla categoria; se specifichi entrambi, **la categoria prevale** e viene esportata solo quella categoria.
- `export --help` o `export -h` mostra l’help del comando; non esegue l’esportazione.

Per ogni agente copiato con successo, l’export individua le risorse companion in `general/tools/`, `general/commands/`, `general/skills/` e `general/plugins/` combinando il manifest `.agent-manager/categories/<dominio>.json` (se presente), le directory con nome `<dominio>` o prefisso `<dominio>-` e i file al livello superiore con nome `<dominio>` o prefisso `<dominio>-`. Il dominio è il primo segmento del nome file dell’agente prima del trattino, per esempio `slides` per `slides-orchestrator.md`. Sono inoltre gestiti mapping supplementari di wrapper/skill: per `slides`, `slide_*.ts`, `pptx` e gli helper runtime; per `docs`, `doc_*.ts`, `docx` e gli helper runtime; per `hybrid`, gli strumenti pipeline `pipeline_*.ts` e `_pipeline_*.js`, `skills/code-review-antipatterns` e `plugins/pipeline-guard.js`. Vengono esportate solo le risorse dei domini degli agenti copiati con successo; risorse e file degli altri domini già presenti nella configurazione OpenCode vengono preservati. Gli script degli strumenti si trovano in `tools/<dominio>/`: gli agenti devono risolvere il percorso dello script in un percorso assoluto prima di invocarlo.

I file di risorsa identici per contenuto e permessi vengono saltati, senza scritture o backup inutili. Prima di sostituire risorse modificate, vengono salvati in un backup separato `resource_export_backup_<timestamp>_<suffix>/` solo i file che saranno sostituiti, nella radice della configurazione OpenCode; vengono conservate automaticamente le 5 directory di backup più recenti. Se l’installazione delle risorse fallisce, vengono ripristinati automaticamente sia le risorse companion sia gli agenti esportati nella stessa operazione.

> **Attenzione:** `import --dry-run` è un’anteprima senza scrittura e senza backup. L’import effettivo CLI/TUI applica solo le differenze: importa agenti nuovi o modificati e risorse companion modificate in `general/`, saltando i file identici; non crea backup se non ci sono differenze. L’export è distruttivo sulla destinazione: leggi [Backup](#backup-e-dati) e verifica i file prima di confermare.

## Rilascio versioni e sincronizzazione tra repository (sync)

Il flusso standard è **dal repository personale/originale alla repository di lavoro Enterprise**:

- Fonte di verità: `/Users/lorenzo.cancellara/dev/Altro/agents`.
- Destinazione di lavoro: `/Users/lorenzo.cancellara/dev/Programmazione/agents`.

La sync trasferisce solo i componenti condivisi dichiarati in `.agent-manager/shared-sync.json`. Non è una copia completa delle repository e non importa le personalizzazioni locali della destinazione. È possibile confrontare direttamente le due repository oppure creare un bundle di rilascio verificabile e trasferirlo separatamente.

### Le tre categorie e le regole d’oro

1. **`agentManager` — condiviso e versionato.** Comprende la CLI/TUI `manage-agents/**`, `manage-agents.sh`, `.agent-manager/bash-profiles.json` e `.agent-manager/translation-config.json`. La lista precisa dei file inclusi/esclusi è nel manifest.
2. **`pipelineCore` — condiviso e versionato.** Comprende gli agenti canonici `src/agents/pipeline-*.md`, i comandi `src/commands/pipeline-*.md`, `src/plugins/pipeline-guard.js` (e il README del plugin), gli strumenti `src/tools/*pipeline*`, gli helper `_guards*`, `_paths.js` e `_safeName*`, e `src/docs/mcp-configuration.md`.
3. **`localOverlay` — locale a ciascuna repository e mai sovrascritto dalla sync.** Comprende lo stack Ontology (`src/agents/ontology-*.md`, `src/tools/ontology/**`, `src/skills/ontology-*/**`, `src/resources/ontology/**`, `src/ontology-pipeline.md`), i profili modello locali (`.agent-manager/pipeline-profiles.json`, per esempio `spark`), `.agent-manager/companion-links.json`, `.agent-manager/categories/**` e `src/opencode.json`. Anche gli output generati `export/categories/**` e `export/bridges/**` restano locali: la sync non li copia dalla fonte. Dopo l’applicazione di `pipelineCore`, i bundle stamped `*-pipeline` vengono aggiornati dal profilo locale; distribuzioni di categoria non stamped e bridge si rigenerano con i rispettivi comandi (`category build` e `bridge`).

**Regole pratiche:** modifica il manager e il core pipeline nella repository fonte; conserva profili, overlay e configurazioni specifiche nella repository di destinazione. Non spostare file da una categoria all’altra senza aggiornare `.agent-manager/shared-sync.json`: è il manifest che definisce cosa è condiviso, cosa è protetto e quali versioni sono compatibili.

### Versioni, compatibilità e modifiche locali

Le versioni SemVer dei due componenti e la compatibilità sono dichiarate in `.agent-manager/shared-sync.json`:

- Aggiorna `components.agentManager.version` quando rilasci modifiche condivise a CLI/TUI, configurazione o profili Bash. Usa patch per correzioni compatibili, minor per funzionalità compatibili e major per cambiamenti incompatibili.
- Aggiorna `components.pipelineCore.version` quando rilasci modifiche condivise agli agenti, ai comandi, agli strumenti o al guard. Applica gli stessi criteri SemVer.
- `components.pipelineCore.requiresAgentManager` è l’intervallo SemVer di versioni del manager con cui il core funziona. Se una modifica del core richiede nuove funzioni o un nuovo contratto del manager, aggiorna l’intervallo e rilascia una versione manager compatibile. Quando applichi entrambi i componenti insieme, la versione manager della fonte deve soddisfare tale intervallo.

`sync status` mostra le versioni e lo stato di compatibilità. L’applicazione di un `pipelineCore` incompatibile viene bloccata. Anche modifiche locali non committate sui file condivisi della destinazione bloccano la sovrascrittura: esaminale e committale/revertile prima di procedere. `--force` consente di superare il blocco dei file condivisi locali solo quando si è deciso consapevolmente di sovrascriverli; non rimuove il controllo di compatibilità. La sync non crea commit Git automatici.

### Flusso operativo rapido

Esegui gli esempi dalla radice della repository fonte (`/Users/lorenzo.cancellara/dev/Altro/agents`):

1. Controlla differenze, versioni, compatibilità e file locali modificati:

   ```bash
   ./manage-agents.sh sync status --target /Users/lorenzo.cancellara/dev/Programmazione/agents
   ```

   Per usarlo in uno script e ottenere exit code `1` quando è incompatibile, sporco o fuori sync, aggiungi `--check`. `status` accetta anche `--from <repository-o-bundle>`, `--component agent-manager|pipeline-core|all` e `--json`.

2. Simula le modifiche, senza scrivere:

   ```bash
   ./manage-agents.sh sync apply --target /Users/lorenzo.cancellara/dev/Programmazione/agents --dry-run
   ```

3. Applica `agentManager` e `pipelineCore` alla destinazione:

   ```bash
   ./manage-agents.sh sync apply --target /Users/lorenzo.cancellara/dev/Programmazione/agents
   ```

   Il comando aggiorna anche i bundle stamped dei profili locali (per esempio `spark-pipeline` e `copilot-pipeline`) e sincronizza i profili Bash quando presenti. Per saltare questi refresh usa `--no-refresh`. Prima dell’applicazione controlla e risolvi eventuali modifiche locali; non viene creato alcun commit automatico. Al termine verifica la destinazione con `git diff` e `git status`.

4. In alternativa, crea un bundle versionato con `release-index.json` e hash SHA-256, quindi applicalo:

   ```bash
   ./manage-agents.sh sync release --out dist/shared-release
   ./manage-agents.sh sync apply --from dist/shared-release --target /Users/lorenzo.cancellara/dev/Programmazione/agents
   ```

   Il bundle include le versioni, l’elenco dei file e `contentDigest`; durante l’import gli hash sono verificati. `release` accetta `--component` e `--json`; `apply` accetta inoltre `--dry-run`, `--force` e `--no-refresh`. Le forme `diff`, `export` e `import` sono alias rispettivamente di `status`, `release` e `apply`; `shared-sync` è alias del comando `sync`.

### Generare bridge Claude Code e Codex

Un bridge traduce una categoria del catalogo in un livello per Claude Code o Codex senza modificare il prompt sorgente. Esempio Claude:

```bash
node manage-agents/manage-agents.mjs bridge --category copilot-pipeline --target claude
```

Esempio Codex:

```bash
node manage-agents/manage-agents.mjs bridge --category copilot-pipeline --target codex
```

Opzioni disponibili:

| Opzione | Significato |
|---|---|
| `--category <nome>`, `-c <nome>` | Categoria da tradurre. Necessaria, salvo che il wizard fornisca un prefisso da cui ricavarla. |
| `--target claude\|codex`, `-t` | Destinazione: `claude` o `codex`. In assenza di opzione si usa il target salvato in configurazione, predefinito `claude`. |
| `--output <percorso>`, `-o` | Directory di output; per default `export/bridges/claude-code/<nome>` o `export/bridges/codex/<nome>`. In un workspace privo di `export/` il bridge usa `bridges/claude-code/<nome>` o `bridges/codex/<nome>`. |
| `--name <nome>`, `-n` | Nome del plugin/layer; il valore iniziale predefinito è `decent-pipeline`. |
| `--prefix <prefisso>`, `-p` | Prefisso da rimuovere dai nomi sorgenti; per default `<categoria>-`. |
| `--source-dir <directory>`, `-s` | Directory sorgente relativa al workspace; per default `general` o il valore della configurazione. |
| `--config <percorso>` | Percorso del file di configurazione del bridge, per default `.agent-manager/translation-config.json`. |
| `--model <sorgente>=<destinazione>` | Associazione ripetibile tra modello sorgente e modello di destinazione. Accetta liste separate da virgola, per esempio `--model "zai-glm-5-3=opus,glm-5-3=haiku"`, e la chiave `"*"` come catch-all. I valori forniti vengono salvati nella configurazione e riusati dalle esecuzioni successive. |
| `--map-all <destinazione>` | Scorciatoia per `--model "*=<destinazione>"`: tutti i modelli mappano su un solo modello. La struttura multi-agente della categoria resta quella originale. |
| `--no-register` | Salta la registrazione automatica del plugin in Claude Code e salva `claude.autoRegister: false`. |
| `--no-validate` | Salta la validazione automatica dopo la generazione e salva `claude.autoValidate: false`. |
| `--marketplace-name <nome>` | Nome del marketplace locale, salvato in `claude.marketplaceName`. Senza opzione si usa `<nome-plugin>-local`. I nomi riservati (`claude`, `claude-code` e i prefissi `claude-`/`anthropic-`) vengono rifiutati. |
| `--wizard`, `-w` | Chiede target, nome, prefisso, directory sorgente e modelli per i tier; salva la configurazione prima della generazione. |
| `--help`, `-h` | Mostra le opzioni di `bridge`. |

Le opzioni esplicite `--no-validate`, `--no-register` e `--marketplace-name` vengono salvate nella configurazione di traduzione, come `--model` e `--map-all`: le esecuzioni successive le riusano anche senza flag. Per riattivare una funzione disattivata non esiste un flag: modifica `claude` in `.agent-manager/translation-config.json`.

Altri esempi:

```bash
node manage-agents/manage-agents.mjs bridge -c copilot-pipeline -t codex -n mio-layer -p copilot-pipeline- -s general
node manage-agents/manage-agents.mjs bridge --category wiki --output artifacts/wiki-claude --target claude
node manage-agents/manage-agents.mjs bridge -c copilot-pipeline -t claude --model "zai-glm-5-3=opus" --model "glm-5-3=haiku"
node manage-agents/manage-agents.mjs bridge -c copilot-pipeline -t claude --marketplace-name acme-tools
node manage-agents/manage-agents.mjs bridge -c copilot-pipeline -t codex --map-all gpt-5.6-luna
node manage-agents/manage-agents.mjs bridge --category copilot-pipeline --wizard
```

Un output personalizzato deve restare dentro il workspace: il bridge verifica il percorso e rifiuta quelli esterni. Scegli un percorso deliberatamente e controlla prima se esiste già. Il wizard salva le impostazioni, ma il bridge scrive anche gli artefatti. Controlla in output la lista dei file, gli avvisi di traduzione e l’esito di validazione e registrazione. Per Claude il manager esegue `claude plugin validate <percorso> --strict` e, se la validazione passa e il marketplace è emesso, registra il plugin in Claude Code; entrambi i passaggi sono attivi per impostazione predefinita. Per Codex indica gli agenti scoped e il manifest del plugin.

#### Marketplace, skill e registrazione automatica

Dopo la generazione di un bridge Claude il manager completa l’output da solo. Il bridge emette `.claude-plugin/marketplace.json`, un marketplace locale che pubblica il plugin dalla directory stessa: `{ "name": "<marketplace>", "owner": { "name": "<autore>" }, "plugins": [{ "name": "<plugin>", "source": "." }] }`. Accanto agli agenti crea `skills/<nome>/SKILL.md` per ogni comando pipeline collegato (`src/commands/pipeline-*.md`): conserva la `description`, imposta `disable-model-invocation: true` e `arguments: request`, sostituisce `$ARGUMENTS` con `$request`, converte le righe `` !`comando` `` in blocchi di codice bash e affida il lavoro all’orchestratore del plugin. Le skill companion, per esempio `code-review-antipatterns`, vengono copiate in `skills/`.

Ogni esecuzione elimina gli artefatti generati che non appartengono al set corrente (agenti e skill non previsti, `marketplace.json` quando l’emissione è disattivata) e segnala ogni file rimosso con un avviso. Un server MCP disabilitato che viene comunque emesso perché gli agenti tradotti ne richiedono i tool produce un altro avviso.

Le impostazioni stanno in `claude` dentro `.agent-manager/translation-config.json`. Le cinque opzioni booleane sono facoltative e valgono `true` per impostazione predefinita; `marketplaceName` è una stringa facoltativa.

| Campo | Effetto |
|---|---|
| `emitMarketplace` | Emette `.claude-plugin/marketplace.json`. |
| `emitCommands` | Traduce i comandi pipeline in `skills/<nome>/SKILL.md`. |
| `emitSkills` | Copia le skill companion in `skills/`. |
| `autoValidate` | Esegue `claude plugin validate <directory> --strict` dopo la generazione. |
| `autoRegister` | Aggiunge il marketplace e installa il plugin in Claude Code. |
| `marketplaceName` | Nome del marketplace; senza valore si usa `<nome-plugin>-local`. Il primo carattere deve essere una lettera o una cifra; i successivi possono essere lettere, cifre, punti, trattini bassi e trattini. Nomi uguali a `claude` o `claude-code` e prefissi `claude-`, `anthropic-` e `anthropics-` sono riservati e vengono rifiutati. |

La validazione e la registrazione avvengono dopo la transazione del repository. Con `autoValidate` attivo il manager esegue `claude plugin validate <directory> --strict`: exit 0 significa validazione superata, 1 fallimento, 2 errore imprevisto della CLI. Un fallimento o un esito non decidibile (exit 2) bloccano la registrazione. Con `autoRegister` attivo esegue poi `claude plugin marketplace add <directory>` e `claude plugin install <plugin>@<marketplace>`, entrambi a scope utente, idempotenti e senza richieste di conferma per le sorgenti locali. Se `claude.emitMarketplace` è disattivato la registrazione viene saltata, perché non c’è alcun manifest del marketplace da aggiungere. Se `claude` non è nel `PATH`, entrambi i passaggi vengono saltati con un avviso e la generazione resta valida.

La registrazione avviene una volta. I marketplace locali si caricano sul posto, quindi dopo una rigenerazione non serve alcun comando di update: il plugin aggiornato è disponibile alla sessione successiva o dopo `/reload-plugins`. Richiama gli agenti con `claude --plugin-dir <directory> --agent <plugin>:<nome>` oppure con `@agent-<plugin>:<nome>`; le skill con `/<plugin>:<skill>`. Il file `.lsp.json` documenta la configurazione LSP del progetto e non viene letto da `claude plugin validate`.

#### Modelli di destinazione

Le chiavi di `claude.modelMap` e `codex.modelMap` si confrontano con il modello sorgente dell’agente in minuscolo: prima l’ID completo (`zai-glm-5-3`), poi l’ID senza provider dopo l’ultima `/` (`glm-5-3`), infine la chiave `"*"`. L’ordine di risoluzione è: override per agente, `modelMap`, tier del ruolo (`roles` e poi `tiers`), inferenza, `defaultTier`. Una mappa vuota non cambia nulla. Resta il comportamento basato sui tier. La chiave `"*"` realizza l’opzione «tutti i modelli su un solo modello» senza toccare la struttura multi-agente della categoria.

Le mappature passate con `--model` o `--map-all` hanno la precedenza sulle chiavi già presenti nel file e vengono salvate; le esecuzioni successive le riusano senza flag, quindi non devi ripetere le stesse opzioni a ogni generazione. Una chiave che non corrisponde ad alcun agente produce un avviso che dipende dal target: `[model-map] entry "<chiave>" matches no source agent model in this bridge` per Claude, `[model-map] entry "<chiave>" matches no source agent model` per Codex.

Per Claude la destinazione deve essere `fable`, `sonnet`, `opus`, `haiku`, `inherit` o un ID completo `claude-*` (per esempio `claude-opus-5-5`). Altre stringhe vengono rifiutate prima della generazione, con `Invalid Claude model "<valore>". Use an alias (fable, sonnet, opus, haiku, inherit) or a full claude-* model ID.` preceduto da `claude.modelMap["<sorgente>"]:`. Per Codex basta una stringa non vuota: l’associazione scrive solo il modello, senza `model_reasoning_effort`.

Non esiste un flag CLI per cancellare un catch-all già salvato. Svuota il campo «Map all models to» nella TUI oppure modifica il JSON. La modifica per singolo modello si fa solo nel JSON.

#### Permessi e companion non tradotti

La traduzione dei permessi è a livello di tool. Le chiavi OpenCode diventano nomi di tool Claude: `bash`/`shell` → `Bash`, `edit` → `Write` e `Edit`, `read`/`grep`/`glob` con i nomi omonimi, `task` → `Agent`, `webfetch` → `WebFetch`, `websearch` → `WebSearch`, `skill` → `Skill`, `lsp` → `LSP`, `question` → `AskUserQuestion`, `todowrite` → `TodoWrite`, le chiavi MCP → `mcp__<server>__*` più la forma con lo scope del plugin. Le regole granulari (liste di pattern per bash, glob per edit, glob di URL per webfetch, stati `ask`) non sono applicabili per agente in un plugin Claude Code: gli agenti del plugin ignorano `permissionMode` e gli hook, e le regole `allow`/`ask`/`deny` per singola azione vivono solo nelle impostazioni, che il plugin non può trasportare. Il bridge emette quindi la decisione a livello di tool, segnala con un avviso specifico le regole granulari perse, le chiavi non rappresentabili e gli stati `ask` promossi e non genera `hooks/hooks.json`.

Il README generato documenta ciò che il bridge non traduce. I link companion della categoria (per `pipeline`: `plugins/pipeline-guard.js` e gli strumenti pipeline) compaiono nella sezione `OpenCode plugins and tools` con l’equivalente Claude più vicino: `tool.execute.before` → `PreToolUse`, `tool.execute.after` → `PostToolUse`, `session.idle` → `Stop`, `permission.asked` → `PermissionRequest`. Per i tool personalizzati il README rimanda a un server MCP. Ogni plugin o tool non trasposto produce anche un avviso.

La sezione `Model connection` dello stesso README chiarisce quali alias riceve Claude: `sonnet`, `opus`, `haiku`, `fable`, `inherit`, a meno che la configurazione fissi un ID completo `claude-*` in `claude.modelMap`, nel modello di un tier o in un override per agente. Gli alias si risolvono in base alla modalità di connessione: l’abbonamento OAuth con `/login` non richiede configurazione aggiuntiva, mentre API key, Bedrock e Vertex seguono la configurazione del provider. `fable` richiede Claude Code CLI 2.1.257 o superiore.

### Generare e verificare distribuzioni di categoria

I manifest in `.agent-manager/categories/` selezionano risorse canoniche. I comandi `check`, `status`, `explain`, `list` e `package --dry-run` sono di ispezione/anteprima; `build` genera output.

| Attività | Comando |
|---|---|
| Elencare gli ID dei manifest | `node manage-agents/manage-agents.mjs category list` |
| Leggere un manifest | `node manage-agents/manage-agents.mjs category explain wiki` |
| Verificare una distribuzione, senza scrivere | `node manage-agents/manage-agents.mjs category check wiki` |
| Verificare tutte le distribuzioni | `node manage-agents/manage-agents.mjs category check --all` |
| Controllarne lo stato | `node manage-agents/manage-agents.mjs category status --all` |
| Generare una categoria | `node manage-agents/manage-agents.mjs --no-auto-commit category build wiki` |
| Generare tutte le categorie | `node manage-agents/manage-agents.mjs --no-auto-commit category build --all` |
| Anteprima pacchetto | `node manage-agents/manage-agents.mjs category package wiki --output artifacts/categories --dry-run` |
| Creare il pacchetto | `node manage-agents/manage-agents.mjs --no-auto-commit category package wiki --output artifacts/categories` |
| Recuperare una build interrotta | `node manage-agents/manage-agents.mjs --no-auto-commit category recover` |

Per `explain`, `status`, `build` e `check` specifica un ID oppure `--all`; `--json` produce JSON, per esempio `category check --all --json`. `category package` richiede `--output <percorso>` e accetta `--dry-run` e `--json`; richiede che le distribuzioni siano già aggiornate (`current`). `--all` seleziona tutti i manifest. Scegli un percorso di output sicuro: la validazione rifiuta percorsi sovrapposti al catalogo canonico, ai contenuti generati, ai file di controllo o a Git.

`category build` **sostituisce** la directory generata corrispondente. Prima controlla con `category check`; se una build generale è stata interrotta e resta un journal, esaminalo e usa `category recover` prima di riprovare.

`topic-export wiki [--check]` è un alias deprecato: per generare o verificare usa rispettivamente `category build wiki` o `category check wiki`. L’opzione `--check` del vecchio alias bypassa le transazioni. Non basare nuovi script sull’alias.

### Help dei comandi

```bash
node manage-agents/manage-agents.mjs bridge --help
node manage-agents/manage-agents.mjs export --help
node manage-agents/manage-agents.mjs category --help
```

L’help implementato è specifico e non tutte le funzioni hanno help. `category --help` descrive in breve la sintassi, mentre l’help dettagliato delle opzioni `bridge` ed `export` si ottiene con i rispettivi comandi.

### Sviluppo e validazione del manager

Questi comandi sono destinati a chi modifica il manager. **Directory corrente: `manage-agents/`**.

| Controllo | Comando | Nota |
|---|---|---|
| Installare dipendenze bloccate | `npm ci` | Riproduce l’installazione definita dal lockfile. |
| Eseguire test e typecheck | `npm test` | Include il controllo TypeScript e i test automatici; non avvia la TUI. |
| Solo typecheck | `npm run typecheck` | Verifica i tipi senza generare il bundle. |
| Compilare | `npm run build` | Genera `dist/index.js`. |
| Validare | `npm run validate` | Esegue typecheck, test, build e `category check --all` in sola verifica. |

Con Bun, gli equivalenti documentati sono `bun install`, `bun test` e `bun run build`. La CI copre Node e Bun su macOS, Linux e Windows; ciò non è una prova della resa interattiva della TUI.

## TUI: navigazione e comandi

Avvia la TUI con `npm start` da `manage-agents/`, con `npm start --prefix manage-agents` dalla radice o con il launcher. La lista e l’inspector sono affiancati; la selezione multipla è indicata nella lista. In generale, le azioni si applicano agli elementi selezionati se ne hai selezionati, altrimenti all’agente attivo o alla categoria attiva come descritto qui sotto.

### Muoversi, cercare e ispezionare

| Tasto | Azione |
|---|---|
| `↑` / `↓` oppure `k` / `j` | Spostano il focus nella lista; nelle schede sicurezza/deleghe spostano il relativo contenuto. |
| `←` / `→` oppure `h` / `l` | Chiudono/aprono una categoria quando il focus è su una cartella nella vista ad albero. |
| `Tab` | Alterna vista piatta e vista ad albero. |
| `/` | Attiva il filtro per nome; digita per filtrare, `Enter` termina la digitazione, `Esc` cancella il filtro e termina. |
| `Space` | Seleziona/deseleziona l’agente attivo. |
| `a` | Seleziona o deseleziona tutti gli agenti visibili nella vista piatta, oppure tutti quelli della categoria attiva nella vista ad albero. |
| `s` | Seleziona/deseleziona agenti con lo stesso modello; in vista ad albero limita alla categoria attiva. |
| `1`–`5` | Cambiano scheda inspector: Info/Overview, Name, Sec, Graph e `Res` (Skills & Tools). La scheda `1` mostra anche il `variant` configurato e l’eventuale `reasoningEffort` passato direttamente al provider. |
| `PageUp` / `PageDown` | Scorrono le schede sicurezza/deleghe/risorse e i risultati lunghi. |
| `Esc` | Chiude o annulla la finestra attiva; in ricerca cancella il filtro. |
| `Ctrl-C` | Esce dalla TUI. |

### Modificare agenti e impostazioni

| Tasto | Azione |
|---|---|
| `m` | Sceglie un modello dal catalogo verificato. Agisce sull’agente attivo o sugli agenti selezionati. Se il catalogo non è disponibile, `m` mostra una finestra con il risultato; premi `y` in quella finestra per riprovare il refresh. Il selettore dei modelli si apre solo quando il catalogo è disponibile. |
| `v` | Avvia la riparazione dei modelli non validi, se ce ne sono. Scegli una sostituzione per ogni gruppo e conferma per applicare. |
| `Shift-T` | Assegna un tier di traduzione ai ruoli degli agenti selezionati o attivi. I ruoli sono condivisi nella configurazione: controlla l’avviso sugli altri agenti che possono essere coinvolti prima di confermare. |
| `t` | Apre Parameter Tuning per l’agente o la selezione: `steps`, `temperature`, `mode` (`subagent`/`primary`), stato `hidden` e Thinking / Effort (`variant`). `Tab`/frecce cambiano campo; `Space` commuta mode/hidden. Nel campo `variant`, `Space` o `←`/`→` scorre i variant standard OpenCode (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) e unset/default. Puoi digitare un nome personalizzato, per esempio `thinking`, e usare `Backspace` per cancellare il valore. Steps non negativi, temperatura da 0 a 1. |
| `c` | Sceglie un colore e lo applica all’agente attivo o alla selezione. |
| `p` | Applica un preset di permessi: `readonly_scout`, `safe_builder` o `unrestricted_dev`. Leggi cosa consente ciascun preset: l’ultimo abilita l’esecuzione bash. |
| `g` | Modifica le deleghe dell’agente attivo; seleziona i subagent consentiti con `Space`, poi conferma con `Enter`. |
| `u` | Apre il manager interattivo di Skills, Tools & MCP per l’agente attivo. |
| `r` | Rinomina l’agente attivo, modificando famiglia (facoltativa), categoria e ruolo. L’operazione aggiorna i riferimenti riconosciuti e crea un backup. |
| `o` | Avvia l’organizzazione degli agenti nelle categorie dopo conferma. Le categorie gestite da manifest non vengono organizzate da questa azione: per quelle usa `category build`. |
| `f` | Apre la creazione di una fork della categoria, o degli agenti selezionati. Inserisci testo da trovare e sostituzioni; la sostituzione può essere una lista separata da virgole. |
| `F` (`Shift-F`) | Nella scheda sicurezza corregge l’ordine delle regole dei permessi quando l’ispettore segnala un errore. `*` deve precedere le regole specifiche. |
| `Shift-L` | Apre la regolazione della proporzione lista/inspector. Frecce o `h`/`l` cambiano la proporzione; `Home`/`End` impostano i limiti, `R` ripristina il default, `Enter` salva e `Esc` annulla. |

La fork può ricevere, ad esempio, `go-, kimi-, hybrid-, free-` oppure la forma compatibile `[go-, kimi-, hybrid-, free-]`. I componenti devono essere non vuoti e univoci. Prima di applicare azioni distruttive, leggi sempre la finestra di conferma e il risultato mostrato a schermo.

### Inspector risorse e manager Skills, Tools & MCP

Premi `5` nella vista principale per selezionare la scheda inspector `Res` (`Skills & Tools`) dell’agente attivo. La scheda mostra:

- le Skills autorizzate da `permission.skill`, incluso `*` per tutte le Skills e il rilevamento dei riferimenti non più esistenti;
- i Custom Tools in `general/tools/*.ts`, incluse le famiglie con prefisso come `slide_*` e `doc_*`;
- server e namespace MCP definiti in `general/opencode.json`, con stato abilitato/disabilitato, confrontati con i permessi dell’agente (`<server>_*`);
- i file companion del dominio in `tools/`, `commands/`, `skills/` e `plugins/`.

La scheda è scorrevole con `↑`/`↓` (`k`/`j`) e `PageUp`/`PageDown`.

Con un agente attivo, premi `u` per aprire la checklist **Skills, Tools & MCP Manager**. `Space` commuta il permesso dell’agente tra `allow` e `deny` per la Skill selezionata (o `* (All Skills)`), una famiglia di tool (`slide_*`, `doc_*`), un singolo tool o un server MCP (`<server>_*`). Su un server MCP configurato, `x` commuta il flag workspace-wide `enabled` in `general/opencode.json`, indipendentemente dai permessi dell’agente. Dopo modifiche a `opencode.json`, riavvia OpenCode perché abbiano effetto durante l’esecuzione.

Le modifiche restano in bozza finché non premi `Enter`: il manager salva tutte le modifiche atomicamente e ripristina i file in caso di errore di scrittura. Se l’auto-commit è abilitato, crea anche un checkpoint del repository. `Esc` scarta la bozza senza modificare alcun file.

### Bridge, esportazione e importazione dalla TUI

| Tasto | Azione |
|---|---|
| `b` | Configura e genera un bridge Claude Code dalla categoria/agenti scelti. |
| `Shift-B` | Configura e genera un bridge Codex. |
| `e` | Esporta in OpenCode; mostra una conferma prima di sovrascrivere i file di destinazione. |
| `i` | Apre il confronto tra catalogo, agenti e risorse companion in OpenCode. Esamina le differenze; `Enter` importa solo agenti nuovi/modificati e risorse modificate (`tools/`, `commands/`, `skills/`, `plugins/`) in `general/`. I file identici sono saltati e, se non ci sono differenze, non viene creato un backup. `Esc` annulla. |

Nei prompt di bridge, usa `Tab` per passare tra nome, prefisso, directory sorgente e `Map all models to`, nello stesso ordine; con il campo prefisso attivo le frecce selezionano i suggerimenti disponibili. Il quarto campo imposta il catch-all per il target scelto: vuoto significa mapping per tier e, se in configurazione esisteva una chiave `"*"`, la elimina. Per Claude il valore deve superare la stessa validazione degli alias descritta sopra; per Codex viene salvato se non è vuoto. La modifica per singolo modello si fa nel JSON. Verifica i valori, il target e i percorsi prima di generare. L’import CLI, come quello TUI, elabora le differenze degli agenti e delle risorse companion; il CLI non permette di scegliere singoli file.

## Ricette operative

### Verificare prima di distribuire una categoria

**Directory corrente: radice del repository.** Questi passaggi non scrivono output:

```bash
node manage-agents/manage-agents.mjs category list
node manage-agents/manage-agents.mjs category explain wiki
node manage-agents/manage-agents.mjs category check wiki
```

Se `check` segnala contenuti mancanti, modificati o extra, controlla il manifest e le sorgenti canoniche. Solo dopo aver verificato l’impatto, rigenera con `node manage-agents/manage-agents.mjs --no-auto-commit category build wiki`, poi ripeti `category check wiki`.

### Esportare un gruppo in OpenCode

**Directory corrente: radice del repository.** Prima controlla la categoria e la destinazione di OpenCode; l’export sostituisce i file e mostra una richiesta di conferma.

```bash
node manage-agents/manage-agents.mjs export --category wiki
```

Rispondi `Y` o premi Invio solo dopo aver letto percorso, numero di agenti e backup mostrati. `n` annulla.

### Preparare e verificare un bridge

**Directory corrente: radice del repository.** Per prima cosa prova un output di destinazione esplicito e non condiviso; il bridge non riscrive gli agenti canonici, ma crea artefatti:

```bash
node manage-agents/manage-agents.mjs bridge --category copilot-pipeline --target claude --output artifacts/copilot-claude
```

Esamina l’elenco di file, preview e warning. Se devi cambiare il modello di alcuni agenti, usa `--model <sorgente>=<destinazione>`; per usarne uno solo per tutti, `--map-all <destinazione>`. Entrambe le opzioni salvano il mapping, quindi le esecuzioni successive lo riusano anche senza flag. Per tier, ruoli e altri override, ripeti con `--wizard` dopo aver verificato che la configurazione salvata sia quella voluta.

Al termine il manager valida l’output con `claude plugin validate <percorso> --strict` e registra il plugin con `claude plugin marketplace add` e `claude plugin install`: la registrazione avviene solo se la validazione passa e se il marketplace è emesso, quindi viene saltata anche quando la validazione non decide (exit 2) o `claude.emitMarketplace` è disattivato. La registrazione si esegue una volta sola: dopo ogni rigenerazione il plugin locale è già aggiornato, senza comandi di update. Avvia l’orchestratore con `claude --plugin-dir <percorso> --agent <nome-plugin>:<orchestratore>`. Se vuoi esaminare l’output prima di toccare Claude Code, usa `--no-validate --no-register`; i comandi manuali restano nel README generato. Queste due opzioni però vengono salvate: per riabilitare i passaggi automatici modifica `claude` nel JSON.

### Riprendere il controllo dopo una build generale interrotta

**Directory corrente: radice del repository.** Non cancellare journal o directory temporanee manualmente senza averne prima capito lo stato. Esamina il journal indicato dall’errore, quindi chiedi al manager di recuperare:

```bash
node manage-agents/manage-agents.mjs --no-auto-commit category recover
node manage-agents/manage-agents.mjs category check --all
```

`recover` è un’operazione di scrittura/recupero, non un controllo in sola lettura. Usala solo in risposta a un journal irrisolto e non mentre è in corso una build.

## Configurazione, dati e sicurezza

### Dove si trovano le sorgenti e gli output

La fonte canonica è `src/`: modifica lì gli agenti e, quando necessario, i manifest sotto `.agent-manager/categories/`. Non modificare direttamente i risultati generati:

- `agents/categories/`: distribuzioni create dai manifest; la build ricrea/sostituisce la directory della categoria.
- `export/bridges/claude-code/` e `export/bridges/codex/`: bridge generati; un `--output` può scegliere un altro percorso. In un workspace senza `export/` la destinazione predefinita è `bridges/claude-code/<nome>` o `bridges/codex/<nome>`.
- `.agent-manager/translation-config.json`: impostazioni persistenti del bridge, comprese destinazione, prefisso, directory sorgente, tier, mapping per ruolo, override e le mappe `claude.modelMap` e `codex.modelMap`. Per `claude` contiene anche `emitMarketplace`, `emitCommands`, `emitSkills`, `autoValidate`, `autoRegister` e `marketplaceName`.
- `agents/.agent-manager/ui-config.json`: proporzione di lista e inspector della TUI.
- `agents/.agent-manager/category-control/`: controllo e journal delle operazioni di generazione/recupero; non rimuovere file mentre un’operazione è in corso.

Il nome `agents/categories/` compare anche come destinazione usata dalla vecchia funzione TUI di organizzazione: per le categorie basate su manifest usa i comandi `category`, che rigenerano l’output secondo l’allowlist. `agents/general/agents/` rimane il catalogo sorgente.

### Layout TUI

Il valore predefinito assegna circa due terzi della larghezza alla lista. Puoi creare `agents/.agent-manager/ui-config.json`:

```json
{
  "version": 1,
  "listShare": 0.6667
}
```

Sono validi valori tra `0.60` e `0.75`. In alternativa, `AGENT_MANAGER_UI_CONFIG` indica un file JSON esterno da leggere: l’override è **sola lettura**, quindi la TUI permette di provare il layout ma `Enter` non può salvarlo. Configurazioni mancanti o non valide fanno usare il layout predefinito. La scrittura della configurazione locale usa un lock per evitare conflitti tra istanze cooperative.

### Backup e dati

- L’export in OpenCode scrive in `$XDG_CONFIG_HOME/opencode/` se `XDG_CONFIG_HOME` è impostata, altrimenti in `~/.config/opencode/`. I file Markdown degli agenti hanno il backup di recupero `agents_backup/` nella stessa directory di configurazione effettiva; il backup è sostituito a ogni export successivo. Le risorse companion identiche (contenuto e permessi) sono saltate senza scrittura o backup. Le risorse modificate hanno un backup separato `resource_export_backup_<timestamp>_<suffix>/`, che contiene solo i file sovrascritti; se non ci sono sostituzioni non viene creato. Nella radice della configurazione OpenCode vengono mantenute automaticamente le 5 directory `resource_export_backup_*` più recenti. Se l’installazione delle risorse fallisce, il manager ripristina automaticamente sia le risorse companion sia gli agenti esportati in quella operazione. L’export/import delle risorse companion copre `tools/`, `commands/`, `skills/` e `plugins/`, inclusi per `hybrid` `pipeline_*.ts`, `_pipeline_*.js`, `skills/code-review-antipatterns` e `plugins/pipeline-guard.js`.
- Import, rinomina, organizzazione e fork creano backup del catalogo locale, dove applicabile, sotto `agents/backups/` (directory ignorata da Git). L’import effettivo applica soltanto le differenze: agenti nuovi/modificati e risorse companion modificate (`tools/`, `commands/`, `skills/`, `plugins/`) vengono importati in `agents/general/`; i file identici vengono saltati e non viene creato un backup quando non ci sono differenze. `import --dry-run` mostra le differenze senza modificare file o creare backup.
- Bridge e pacchetti di categoria scrivono output; leggi sempre il percorso prima di confermare o scegliere `--output`. Il packaging richiede distribuzioni correnti e una directory di artefatti sicura.
- Il build delle categorie sostituisce gli output generati: tieni le modifiche nella sorgente e nei manifest, non nell’output. Le build di tutte le categorie hanno un journal recuperabile se interrotte.
- `--dry-run` non è un’opzione universale: è documentata per `fix-names`, `import` e `category package`; non presumere che funzioni altrove.

### Auto-commit Git

Per impostazione predefinita l’auto-commit è **disattivato**. `--auto-commit` e `AGENT_MANAGER_AUTO_COMMIT=1` abilitano il tentativo solo per le mutazioni che il codice collega esplicitamente a una transazione Git: non rendono committente ogni operazione che scrive file. Tra le operazioni collegate ci sono creazione, import, rinomina e tuning da CLI, build di una singola categoria e le mutazioni transazionali della TUI (per esempio modifica agenti e generazione bridge). Per i bridge Claude, validazione e registrazione avvengono dopo la chiusura della transazione. Per queste il tentativo è best-effort, subordinato ai controlli e alle condizioni Git descritti sotto.

Restano fuori da quella transazione e non ricevono auto-commit, anche se accettano le opzioni globali: export CLI e TUI, `category package`, `category recover`, `category build --all` e il salvataggio del layout TUI. Le modifiche di queste operazioni restano nel worktree o nei percorsi di destinazione senza un’azione Git automatica. Puoi attivare l’auto-commit per le operazioni supportate, ad esempio:

```bash
node manage-agents/manage-agents.mjs --auto-commit tune --category wiki --temp 0.2
```

Oppure impostare `AGENT_MANAGER_AUTO_COMMIT=1` nell’ambiente. Per disattivarlo, usa `--no-auto-commit` o `AGENT_MANAGER_AUTO_COMMIT=0`; le opzioni CLI prevalgono sull’ambiente. Le opzioni globali vanno prima del comando, ad esempio `--no-auto-commit category build wiki`.

Con auto-commit attivo il manager richiede, tra gli altri controlli, un worktree pulito, branch e identità Git disponibili, scope sicuro e assenza di symlink nelle aree coinvolte. Il commit è **locale**, limitato ai percorsi dichiarati e non esegue push; hook, firma e editor sono disabilitati per quel commit. Non abilitarlo se vuoi esaminare e committare manualmente le modifiche. Un guasto Git produce un avviso e non annulla una mutazione valida; il worktree o l’index possono richiedere revisione manuale. La transazione non effettua reset o ripristini automatici. Evita modifiche concorrenti agli stessi file mentre l’operazione è in corso.

## Risoluzione dei problemi

| Sintomo | Cosa controllare |
|---|---|
| Runtime rifiutato | Verifica `node --version` (almeno 26.4.0) o `bun --version` (almeno 1.3.0). Il launcher usa FFI OpenTUI; aggiorna Node oppure usa Bun compatibile. |
| Dipendenze mancanti o primo avvio non riuscito | Dalla radice esegui `npm ci --prefix manage-agents`, poi riprova `npm start --prefix manage-agents`. Il launcher compila automaticamente se il bundle manca o è più vecchio dei sorgenti. |
| Shell non trova il comando o il repository | Avvia dalla radice del repository o da `manage-agents/`; controlla che `node`/`bun`, `npm` e, se necessario, `git` siano nel `PATH`. Il launcher `.sh` richiede macOS/Linux, WSL o Git Bash. |
| TUI Windows mostra caratteri errati | Usa un terminale moderno e un runtime supportato; il launcher prova a impostare la codepage UTF-8 su Windows. |
| Nessun agente appare | Verifica la directory sorgente `general/agents/`, la directory corrente e che ci siano file `.md` leggibili. Il bridge può usare una `sourceDir` diversa dalla TUI. |
| Modelli indisponibili o segnalati non validi | L’elenco viene dal catalogo `opencode models`, quindi verifica che `opencode` sia nel `PATH`. Se il catalogo non è disponibile, nella TUI premi `m` per aprire la finestra del risultato e poi `y` lì per riprovare il refresh; non si apre il selettore. Per modelli non validi usa `v` e verifica tutte le sostituzioni proposte prima di applicarle. |
| Auto-commit non parte | L’auto-commit è opt-in. Per usarlo, configura `git config user.name` e `git config user.email`, assicurati che il worktree sia pulito, che esista un branch e che non sia in corso un’altra operazione Git. |
| Auto-commit mostra un warning | La modifica può essere già stata applicata ma non committata. Segui le istruzioni di recupero nell’avviso, poi controlla manualmente `git status` e l’index. Non presumere che il warning abbia annullato il lavoro. |
| Lock manager già presente | Controlla prima che nessun manager sia ancora in esecuzione; rimuovi un lock stale solo dopo aver verificato che non ci siano processi attivi. Per un journal di build, usa `category recover` solo come indicato sopra. |
| Validazione o registrazione saltata | Controlla che la CLI `claude` sia nel `PATH`: senza di essa il bridge salva comunque l’output e segnala entrambe le operazioni come saltate. Con `autoValidate` attivo, una validazione fallita (exit 1) o un esito non decidibile (exit 2) bloccano la registrazione: correggi gli avvisi del bridge e rigenera. La registrazione viene saltata anche quando `claude.emitMarketplace` è disattivato, perché manca il manifest del marketplace. Per riabilitare i passaggi dopo un `--no-validate` o un `--no-register`, modifica `claude` nel JSON. |
| Rifiuto di un percorso o di un symlink | Usa directory regolari, senza symlink nei percorsi gestiti, e mantieni l’output dei pacchetti in un percorso relativo sicuro non sovrapposto a sorgenti, output gestiti o Git. |
| `category package` rifiuta la distribuzione | Esegui prima `category check <id>`; se risulta stale, controlla le sorgenti e rigenera con `category build <id>`, quindi riprova. |

Le pipeline CI del progetto verificano Node e Bun su macOS, Linux e Windows; questo non sostituisce la prova interattiva della TUI nel terminale specifico che usi.
