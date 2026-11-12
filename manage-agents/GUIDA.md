# Guida pratica a manage-agents

`manage-agents` installa, modifica e instrada gli agenti OpenCode distribuiti come **pack**. Un pack è una directory
con il layout di una configurazione OpenCode (`agents/`, `commands/`, `skills/`, `plugins/`, `tools/<pack>/`,
`opencode.json`) più il manifest `opencode-pack.json`. I pack arrivano da sorgenti locali o git, quante ne vuoi.

Il motore risolve i pack richiesti e quelli da cui dipendono, li copia nella directory di configurazione di OpenCode,
unisce le loro voci di `opencode.json` alle tue e tiene traccia di ciò che possiede, così da poterlo aggiornare o
rimuovere in seguito. Modifica anche gli agenti (modelli, permessi, skill, deleghe, parametri), genera il routing dei
modelli dei pack archetipo e traduce i pack in plugin Claude Code e layer Codex.

Motore e catalogo sono indipendenti. Il motore non conosce nessun catalogo in particolare, e a un catalogo basta
rispettare il contratto.

- Contratto dei pack: [`contract/CONTRACT.md`](contract/CONTRACT.md), con lo schema
  [`contract/opencode-pack.schema.json`](contract/opencode-pack.schema.json) e l'esempio
  [`contract/examples/minimal-pack`](contract/examples/minimal-pack).
- Skill per gli agenti che scrivono pack:
  [`contract/skills/opencode-pack-authoring`](contract/skills/opencode-pack-authoring/SKILL.md).
- Riferimento completo in inglese: [README.md](README.md).

## Requisiti e installazione

Serve Node.js `>=26.4.0` oppure Bun `>=1.3.0`. OpenTUI usa FFI, quindi con Node il launcher si riavvia da solo con
`--experimental-ffi`.

```bash
git clone <engine-repo> manage-agents && cd manage-agents
npm ci            # oppure: bun install
npm link          # facoltativo: mette `manage-agents` nel PATH
```

Si avvia con `manage-agents`, `node manage-agents.mjs` o `bun manage-agents.mjs`. Il launcher ricompila `dist/`
quando i sorgenti sono più recenti, quindi non serve lanciare la build a mano.

Altri programmi, a seconda di cosa fai:

- `git` nel `PATH` per le sorgenti git;
- `opencode` nel `PATH` per il catalogo dei modelli (`opencode models`), usato dal selettore modelli e da `create`;
- `claude` nel `PATH` per validare e registrare i bridge Claude Code.

Senza comando si apre la TUI sul workspace. Ogni comando ha il suo `--help`, per esempio
`manage-agents install --help` o `manage-agents bridge --help`.

## Concetti

**Sorgente.** Una directory o un repository git che contiene pack (`packs/<nome>/opencode-pack.json`, oppure pack a
qualsiasi profondità). Le sorgenti sono registrate in `~/.config/manage-agents/sources.json`. I checkout git stanno
in `~/.cache/manage-agents/sources/<nome>` e il motore non li modifica mai.

**Target.** La directory di configurazione di OpenCode in cui installi, per default `~/.config/opencode` (più
precisamente `$XDG_CONFIG_HOME/opencode`). Ogni comando di installazione accetta `--target <dir>`. Lo stato vive in
`<target>/.manage-agents/`:

| File | Contenuto |
|---|---|
| `desired.json` | i pack che hai chiesto |
| `lock.json` | la risoluzione esatta: sorgente, versione, revisione, hash |
| `installed.json` | i file e le voci di configurazione che il motore possiede |

**Workspace.** Il catalogo (una directory con `packs/<nome>/opencode-pack.json`) o il singolo pack su cui lavorano la
TUI e i comandi `create`, `lint`, `fix-names`, `audit`, `tune` e `bridge`. Il motore lo cerca in quest'ordine:
`--workspace <dir>`, la variabile `$MANAGE_AGENTS_WORKSPACE`, poi il catalogo o il pack più vicino risalendo dalla
directory corrente.

**Pack archetipo.** Un pack i cui agenti primari (`archetype.callers` nel manifest) delegano ai suoi subagent. Con
`routingDefaults` il pack dichiara quale modello usa ogni subagent in base al modello del chiamante. Quando installi un
archetipo, il motore aggiunge il proprio plugin di routing, `plugins/manage-agents-router`, e ne rigenera
`routing.json` a ogni reconcile.

**Impostazioni utente.** Stanno in `~/.config/manage-agents/`:

| File | Contenuto |
|---|---|
| `sources.json` | sorgenti registrate, fiducia e preferenze |
| `routing.json` | routing dei modelli scelto da te |
| `overrides.json` | modifiche al frontmatter degli agenti installati |
| `ui.json` | layout della TUI |

Routing e override si applicano al reconcile e non finiscono mai dentro i pack. Per questo funzionano anche con
sorgenti git in sola lettura.

## Installare e mantenere i pack

### Aggiungere una sorgente

Una directory locale:

```bash
manage-agents source add catalog ~/dev/agents
```

Un repository git (`https:`, `ssh:` o `git@host:path`; gli URL con credenziali vengono rifiutati):

```bash
manage-agents source add catalog https://github.com/<utente>/agents.git --ref main
manage-agents source pull catalog
```

`source pull` clona o aggiorna le sorgenti git e fa il checkout in detached HEAD sul ref indicato. Senza `--ref` usa
la HEAD del remoto. Senza nomi aggiorna tutte le sorgenti git.

Gli altri sottocomandi di `source`:

- `source list [--json]` elenca le sorgenti, con il tipo e lo stato di fiducia;
- `source remove <nome>` la toglie dal registro;
- `source trust <nome>` e `source untrust <nome>` cambiano la fiducia (si può dare anche con `--trust` in `add`);
- `source prefer <pack> <sorgente>` sceglie la sorgente quando più sorgenti offrono lo stesso pack, e
  `source prefer <pack> --clear` toglie la preferenza.

Una sorgente nuova parte non fidata. Installare da lì un pack con contenuto eseguibile (plugin, moduli in `tools/`,
script delle skill, server MCP, comandi esterni) richiede una conferma. Anche un aggiornamento che cambia il codice
eseguibile la chiede, qualunque sia la sorgente. Al terminale rispondi alla domanda; negli script, o senza terminale,
serve `--yes`.

`manage-agents pack list` mostra i pack offerti dalle sorgenti registrate.

### Vedere cosa succederebbe

```bash
manage-agents resolve flow pipeline
```

`resolve` non scrive nulla. Stampa l'ordine di installazione, la superficie eseguibile, le differenze rispetto al lock
del target e ciò che richiederebbe conferma. Per ogni nome di pack deve esistere un solo candidato: il motore non
sceglie mai da solo la versione più recente. Se due sorgenti offrono lo stesso pack, scegli con `catalog/flow` oppure
con `source prefer`. Cicli e pack mancanti sono errori.

### Installare

```bash
manage-agents install flow pipeline
manage-agents install catalog/docs@^2.0.0 --dry-run
```

Un pack si indica come `[sorgente/]pack[@intervallo]`. I pack già installati mantengono la versione bloccata nel lock.
`--dry-run` mostra il piano senza scrivere, `--json` produce un report leggibile da script.

La parte gestita di `opencode.json` viene rigenerata dai pack. Le tue chiavi restano. Le sezioni che il motore svuota
(per esempio `mcp.servers` o `experimental`) vengono rimosse, mentre una sezione vuota scritta da te resta dov'è. Un
`opencode.jsonc` con commenti viene riscritto come JSON semplice, e l'originale finisce nel backup.

### Controllare lo stato

```bash
manage-agents status
```

Il comando è in sola lettura. Stampa «In sync.» quando il target corrisponde al lock e termina con exit 1 quando
qualcosa differisce: file modificati o cancellati, impostazioni utente ancora da applicare. Se mancano file installati,
`manage-agents reconcile` ricostruisce il target da `desired.json` e `lock.json`.

### Aggiornare

```bash
manage-agents update            # tutti i pack
manage-agents update pipeline   # solo le sorgenti dei pack indicati
```

`update` scarica le sorgenti git dei pack indicati (tutte, se non ne indichi) e risolve di nuovo dentro gli intervalli
di `requires`. Una sorgente git si muove in blocco: tutti i suoi pack seguono la nuova revisione. Accetta `--adopt`,
`--yes`, `--dry-run` e `--json`.

### Disinstallare

```bash
manage-agents uninstall docs
```

Toglie i pack dalle richieste. Le dipendenze ancora richieste da altri pack restano alla versione bloccata. Un file
che avevi già, con lo stesso contenuto del pack, resta tuo anche dopo la disinstallazione.

### Conflitti, `--adopt` e `restore`

Prima di scrivere, il motore controlla tutti i conflitti:

- lo stesso ID (agente, comando, skill, plugin, server MCP) o lo stesso percorso in due pack;
- un file o una voce di configurazione che appartiene a te;
- un file gestito che hai modificato a mano.

Ogni conflitto viene segnalato e non si scrive niente. Se vuoi che il pack prenda il posto della tua versione,
ripeti con `--adopt`: il motore salva la tua copia in `<target>/.manage-agents/backups/<id>/` e la sostituisce. Per
tornare indietro:

```bash
manage-agents restore <backup-id>
```

Il contenuto ripristinato diventa di nuovo tuo, cioè non gestito.

### Migrare da una configurazione creata col vecchio `export`

Le versioni precedenti di manage-agents copiavano gli agenti con il comando `export`, che non esiste più. Per passare
ai pack basta un `install` normale. I file elencati nel vecchio `.resource-export-manifest.json` vengono sostituiti
senza bisogno di `--adopt`, con il backup consueto:

```bash
manage-agents source add catalog ~/dev/agents
manage-agents install flow pipeline
manage-agents status
```

Gli altri file che avevi creato a mano restano conflitti come sempre: decidi caso per caso se usare `--adopt`.

## Modelli

Ci sono tre livelli, ciascuno con il suo strumento.

### Routing degli archetipi

Quando un chiamante di un pack archetipo gira su un certo provider o modello (il *trigger*), il router assegna un
modello a ciascun subagent. I livelli si sommano agente per agente: prima i `routingDefaults` del pack, poi le tue
impostazioni globali, infine quelle del target. Per un trigger `provider/model` la corrispondenza esatta vince su
quella per provider. `inherit` lascia al subagent il modello del chiamante.

```bash
manage-agents models show
manage-agents models set flow mistral flow-explore=mistral/deepseek-v4-1-flash-1017#high flow-review=inherit
manage-agents models unset flow mistral flow-explore
```

Un subagent con un modello fisso (nel frontmatter o in un override) è *pinned* e il routing lo salta:

```bash
manage-agents models pin flow/flow-eye openai/gpt-5.6-sol
manage-agents models unpin flow/flow-eye
```

`pin` scrive l'override `model`. `unpin` lo imposta a `null`, così il subagent segue il routing anche se è il pack a
fissarne il modello. `models set` non tocca mai il frontmatter.

**Ambito.** Senza opzioni la modifica vale solo per il target (quello di default o quello di `--target`), che vince
sulle impostazioni globali. Con `--global` vale per tutti i target: gli altri la applicano al loro prossimo
`reconcile` e intanto `status` la segnala come in sospeso. Ogni modifica riconcilia subito il target, salvo
`--no-reconcile`; `--yes` accetta le conferme che il reconcile dovesse chiedere.

### Override del frontmatter

`override` modifica i campi degli agenti e dei comandi installati senza toccare il pack:

```bash
manage-agents override set flow/flow-build steps=30 hidden=true
manage-agents override set flow/flow-plan description=null
manage-agents override set pipeline/pipeline-bug agent=pipeline-orchestrator --command
manage-agents override unset flow/flow-build steps
manage-agents override show
```

I valori sono YAML e `null` rimuove il campo. Per gli agenti sono ammessi `description`, `mode`, `model`,
`permissions`, `hidden`, `color`, `steps`, `disabled`, `request`, `temperature` e `top_p`. Per i comandi (con
`--command`) `description`, `agent`, `model` e `subagent`. Ambito e reconcile funzionano come per `models`.

### Default del pack

I `routingDefaults` sono ciò che il pack distribuisce, e si cambiano nel catalogo. Nella TUI porta il cursore sulla
cartella di un pack archetipo e, senza agenti selezionati, premi `m`: compare una riga per trigger. Ogni modifica
scrive `routingDefaults` in `opencode-pack.json` e valida il pack. Se il file non rispetta più il contratto, la TUI lo
ripristina. Serve il catalogo dei modelli di OpenCode.

## Lavorare su un catalogo

### La TUI

```bash
cd ~/dev/agents && manage-agents
manage-agents --workspace ~/dev/agents
```

La lista degli agenti è un albero con una cartella per pack, tutte chiuse all'avvio. `→`/`l` apre la cartella sotto
il cursore e `←`/`h` la chiude. La ricerca (`/`) filtra per nome file, nasconde le cartelle senza corrispondenze e
mostra aperte le altre. Quando la svuoti, ogni cartella torna com'era.

| Tasto | Azione |
|---|---|
| frecce, `j`/`k` | spostano il cursore; nelle schede 3–5 dell'inspector scorrono la scheda |
| `/` | cerca per nome file (`Enter` mantiene il filtro, `Esc` lo cancella) |
| `Space`, `a`, `s` | selezionano l'agente, tutto il pack, gli agenti del pack con lo stesso modello |
| `m` | modello; sulla cartella di un archetipo, senza selezione, i suoi default di routing |
| `v` | ripara i modelli non validi |
| `t`, `Shift-T` | parametri (selezione, cartella o agente), tier di traduzione |
| `c`, `p`, `g` | colore, preset di permessi, deleghe |
| `u` | skill, tool e server MCP dell'agente sotto il cursore |
| `r` | rinomina l'agente |
| `e` | installa in OpenCode il pack sotto il cursore |
| `b`, `Shift-B` | bridge Claude Code, bridge Codex |
| `1`–`5` | schede dell'inspector: Info, Name, Sec, Graph, Res |
| `F` | corregge l'ordine dei permessi (scheda 3) |
| `Shift-L` | layout |
| `Esc`, `Ctrl-C` | chiude le finestre, esce |

Alcuni dettagli utili:

- **Selettore modelli.** Solo le frecce navigano. I tasti stampabili scrivono nella ricerca (ogni parola deve
  comparire in `provider/model`), `Esc` la svuota e poi chiude, `Enter` apre un provider o assegna il modello,
  `Ctrl-R` ricarica il catalogo.
- **Installazione (`e`).** Mostra prima un dry run con pack, file e conferme richieste, poi installa se premi `Y`. La
  prima volta il workspace viene registrato come sorgente locale, con il nome della sua directory.
- **Skill, tool e MCP (`u`).** `Space` alterna `allow` e `deny` per una skill (o `* (All Skills)`), una famiglia di
  tool (`slide_*`), un singolo tool o un server MCP (`<server>_*`). L'elenco contiene ciò che offrono il pack
  dell'agente e i pack che richiede. `Enter` salva il file dell'agente e nient'altro.
- **Parametri (`t`).** Imposta `steps`, `temperature`, `mode`, `hidden` e Thinking/Effort (`variant`). Nel campo
  `variant`, `Space` o `←`/`→` scorrono `none`, `minimal`, `low`, `medium`, `high`, `xhigh` e `max`; puoi anche
  scrivere un nome personalizzato. I variant sono definiti sul modello, come spiega la documentazione OpenCode su
  [agenti](https://opencode.ai/docs/agents/#additional) e
  [variant dei modelli](https://opencode.ai/docs/models/#variants).
- **Layout (`Shift-L`).** Frecce o `h`/`l` cambiano la proporzione, `Home`/`End` vanno ai limiti, `R` ripristina,
  `Enter` salva in `~/.config/manage-agents/ui.json` (valori tra 0.60 e 0.75). Con
  `AGENT_MANAGER_UI_CONFIG=<file>` la TUI legge un altro file e il layout diventa di sola lettura.

La scheda 5 (Res) mostra le skill dell'agente, segnalando i riferimenti morti, i tool personalizzati dei suoi pack
raggruppati per famiglia e i server MCP che può usare, con il loro stato nell'`opencode.json` del target.

### Comandi sul workspace

| Comando | Effetto |
|---|---|
| `create` | crea un agente in un pack del workspace (`[famiglia-]<pack>-<ruolo>.md`, frontmatter V2) |
| `lint` | controlla la convenzione dei nomi, in sola lettura |
| `fix-names [--dry-run]` | rinomina i file e aggiorna i riferimenti |
| `audit` | controlla ordine dei permessi e livelli di rischio, in sola lettura |
| `tune` | aggiorna i parametri del modello |

Opzioni di `tune`: `--steps <n>`, `--temp <n>`, `--variant <nome>` (alias `--effort`), `--clear-variant` (alias
`--clear-effort`) e `--category <pack>` oppure `--all` per scegliere gli agenti:

```bash
manage-agents tune --category pipeline --steps 40 --variant high
manage-agents tune --category pipeline --clear-variant
```

La `temperature` a livello di agente non ha effetto in OpenCode 2.2.5. Per cambiare il comportamento usa i variant
del modello.

## Bridge per Claude Code e Codex

Un bridge traduce un pack del workspace, insieme ai pack che richiede, in un plugin Claude Code o in un layer Codex:
agenti, comandi (che diventano skill), skill, server MCP e LSP presi dagli `opencode.json` dei pack.

```bash
manage-agents bridge --pack pipeline --target claude
manage-agents bridge --pack pipeline --target codex
manage-agents bridge check
```

L'output predefinito è `bridges/claude-code/<nome>` o `bridges/codex/<nome>` nel workspace. Un `--output` diverso
deve restare dentro il workspace. Se ometti `--pack`, il motore usa il `prefix` della configurazione senza il trattino
finale. `bridge check` rigenera i bridge già presenti e li confronta byte per byte con quelli salvati; accetta
`--pack` e `--target claude|codex`.

Le opzioni stanno in `bridges/translation-config.json` del workspace: `pluginName`, `prefix`, tier e mappe dei
modelli, impostazioni Claude. Le opzioni principali:

| Opzione | Significato |
|---|---|
| `--target`, `-t` | `claude` (default) o `codex` |
| `--output`, `-o` | directory di output |
| `--name`, `-n` | nome del plugin (default `decent-pipeline`) |
| `--prefix`, `-p` | prefisso da togliere dai nomi degli agenti (default `<pack>-`) |
| `--config` | file di configurazione alternativo |
| `--model <sorgente>=<destinazione>` | mappa un modello; ripetibile, accetta liste separate da virgole |
| `--map-all <destinazione>` | equivale a `--model "*=<destinazione>"` |
| `--no-validate`, `--no-register` | saltano validazione e registrazione Claude |
| `--marketplace-name <nome>` | marketplace usato per la registrazione (default `<plugin>-local`) |
| `--wizard`, `-w` | chiede le mappature dei modelli e le salva prima di generare |

**Modelli.** Una chiave corrisponde al modello dell'agente come ID completo in minuscolo oppure come ID dopo l'ultima
`/`. L'ordine di risoluzione è: override per agente, poi `modelMap` (ID completo, ID senza provider, `"*"`), poi il tier
del ruolo, poi l'inferenza, infine `defaultTier`. Per Claude la destinazione dev'essere `fable`, `sonnet`, `opus`,
`haiku`, `inherit` o un ID completo `claude-*`. Per Codex basta un ID non vuoto.

**Opzioni che restano.** Le mappature e i flag Claude passati da riga di comando (`--no-validate`, `--no-register`,
`--marketplace-name`) vengono salvati nella configurazione e riusati dalle esecuzioni successive. Non esiste un flag
per riattivare validazione o registrazione: rimetti a `true` `claude.autoValidate` o `claude.autoRegister` in
`bridges/translation-config.json`.

**Plugin Claude.** Il bridge emette `.claude-plugin/plugin.json`, un `marketplace.json` locale, gli agenti, le skill
(i comandi diventano `skills/<nome>/SKILL.md`, con `$ARGUMENTS` sostituito da `$request`), `.mcp.json` e `.lsp.json`.
Poi, salvo disattivazione, esegue `claude plugin validate --strict` e registra il plugin in Claude Code, a livello
utente e una sola volta. Se `claude` non è nel `PATH`, i due passaggi vengono saltati con un avviso. A ogni esecuzione
il bridge cancella i file generati che non produce più.

**Permessi.** La traduzione lavora per tool: `shell` diventa `Bash`, `edit` diventa `Write`/`Edit`, `task` diventa
`Agent`, le chiavi MCP diventano `mcp__<server>__*`. Le regole granulari (allowlist della shell, glob di `edit`, stati
`ask`) non si possono trasportare negli agenti di un plugin: ognuna produce un avviso e compare nel README generato.

**Cosa non viene tradotto.** I plugin OpenCode e i tool personalizzati dei pack. Il README generato li elenca con
l'equivalente Claude più vicino.

Nella TUI, `b` e `Shift-B` aprono lo stesso bridge per il pack sotto il cursore. `Tab` passa tra nome del plugin,
prefisso e `Map all models to`. L'ultimo campo imposta il catch-all `"*"` del target; vuoto, si torna alla mappatura
per tier.

## Scrivere un pack

Il contratto completo è in [`contract/CONTRACT.md`](contract/CONTRACT.md). Le regole che contano di più:

- **Layout.** Le directory native sono `agents/`, `commands/`, `skills/<id>/SKILL.md`, `plugins/<nome>/index.ts` (o
  `index`/`server` `.js`/`.mjs`, o `package.json`) e `themes/`. I plugin a file singolo (`plugins/x.ts`) e le vecchie
  forme al singolare (`agent/`, `tool/`, `mode/`, ...) vengono rifiutati. Il frontmatter degli agenti usa le chiavi V2.
- **Namespace.** Ogni percorso non nativo sta sotto il nome del pack: `tools/<pack>/…`, `resources/<pack>/…`. Per i
  tool è accettata anche la forma piatta `tools/_<pack>_*`.
- **Condivisione.** Due pack non condividono file. Il codice comune va in un pack dedicato, che gli altri elencano in
  `requires`. Un pack può riferirsi solo ai file dei pack che richiede.
- **Manifest.** `opencode-pack.json` ha `contract`, `name`, `version` (semver completo), `description`, e
  facoltativamente `requires` (mappa nome → intervallo semver), `archetype` e `routingDefaults`. Le chiavi sconosciute
  sono errori. `"*"` in `requires` è ammesso solo nelle sorgenti locali.
- **`opencode.json`.** Un pack può impostare solo `$schema`, `plugins`, `mcp`, `skills`, `instructions`, `agents`,
  `commands`, `formatter`, `lsp` ed `experimental`. Il resto (`model`, `default_agent`, `providers`, `permissions`)
  appartiene all'utente. Due pack che impostano lo stesso flag `experimental` con valori diversi vanno in conflitto.
- **`AGENTS.md`** del pack viene installato come `instructions/<pack>.md` e registrato in `instructions`.
- **Test.** I file `*.test.*` stanno accanto al codice che verificano e non vengono installati. I loro import non
  vengono controllati, perché girano sul layout unito di tutti i pack.
- **Percorsi riservati.** `instructions/`, `.manage-agents/` e `plugins/manage-agents-router/` appartengono al
  motore.

Prima di distribuire un pack, validalo:

```bash
manage-agents pack validate packs/flow
manage-agents pack validate packs/flow --json
manage-agents pack validate packs/flow --git
```

Il report elenca gli ID del pack, la sua superficie eseguibile e ciò che un pack richiesto deve fornire. Termina con
exit 1 se ci sono errori. `--git` applica le regole più severe delle sorgenti git.

## Sicurezza e auto-commit

Installazione, disinstallazione e aggiornamento sono transazioni sul target. Il motore pianifica, controlla i
conflitti, registra le operazioni nel journal e poi applica. Se qualcosa fallisce, o il processo si interrompe, il
comando successivo annulla il lavoro a metà. Sullo stesso target lavora un comando alla volta. Il contenuto tuo che
viene sostituito finisce in `<target>/.manage-agents/backups/<id>/`.

Il contenuto dei pack è considerato non fidato. L'output sul terminale neutralizza i caratteri di controllo, gli URL
git con credenziali vengono rifiutati e i symlink non vengono mai seguiti nelle aree gestite. Un `opencode.json` che
è un symlink non viene sostituito: il motore lo segnala, e puoi modificare il file a cui punta o usarlo come
`--target`.

Le modifiche al workspace (TUI, `create`, `fix-names`, `tune`, `bridge`) sono atomiche per file e rifiutano i file
cambiati su disco dopo la lettura. L'auto-commit è spento per default. Lo accendi con `--auto-commit` prima del
comando, oppure con `AGENT_MANAGER_AUTO_COMMIT=1`; `--no-auto-commit` o `AGENT_MANAGER_AUTO_COMMIT=0` lo spengono.
Quando è attivo, ogni modifica diventa un commit locale, non firmato e senza hook, che contiene esattamente i
percorsi toccati. Prima il motore verifica worktree pulito, identità git, branch, lock, symlink e ambito. Se un
controllo fallisce, la modifica resta su disco per il recupero manuale e il tuo lavoro non viene mai resettato.

```bash
manage-agents --no-auto-commit bridge --pack pipeline --target claude
```

## Risoluzione dei problemi

| Sintomo | Cosa fare |
|---|---|
| `install` si ferma su un conflitto | leggi l'elenco; se il pack deve sostituire la tua versione, ripeti con `--adopt` e annulla eventualmente con `restore <backup-id>` |
| «needs confirmation» senza terminale | controlla le righe stampate e ripeti con `--yes`, oppure rendi fidata la sorgente con `source trust` |
| più candidati per lo stesso pack | indica la sorgente (`catalog/flow`) o usa `source prefer <pack> <sorgente>` |
| `status` termina con exit 1 | un file gestito è stato cambiato o cancellato, o c'è un'impostazione in sospeso: `reconcile` (con `--adopt` per sovrascrivere le modifiche) |
| comando bloccato dal lock | un `<target>/.manage-agents/install.lock` rimasto viene recuperato da solo quando il processo che lo teneva non esiste più |
| la sorgente git non cambia | `source pull <nome>` oppure `update`; controlla il `--ref` della sorgente |
| selettore modelli non disponibile | verifica che `opencode models` funzioni; nella finestra d'errore `Y` riprova |
| auto-commit saltato | imposta `git config user.name` e `user.email` e parti da un worktree pulito |
| validazione o registrazione Claude saltate | metti `claude` nel `PATH`, oppure controlla `claude.autoValidate`/`autoRegister` |
| Windows | usa Node o Bun direttamente (`node manage-agents.mjs`) |

Per chi sviluppa il motore, dalla directory `manage-agents/`:

```bash
npm ci
npm test          # typecheck e node:test
npm run build
npm run validate  # test, build e validazione del pack di esempio
```
