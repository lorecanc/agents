# Guida pratica a Manage Agents

Manage Agents è lo strumento da terminale del repository per consultare e modificare gli agenti OpenCode, generare distribuzioni di categoria e creare bridge per Claude Code o Codex. Puoi usarlo con comandi CLI oppure con l’interfaccia interattiva TUI.

> **Prima di iniziare:** molte azioni scrivono file o sostituiscono contenuti. Leggi le note di sicurezza e backup prima di eseguire `export`, `import`, `category build` o un’azione di modifica nella TUI. Per la prima prova, usa i comandi di sola lettura indicati qui sotto.

## Indice

- [Avvio rapido](#avvio-rapido)
- [Avvio per sistema operativo](#avvio-per-sistema-operativo)
- [Scegliere CLI o TUI](#scegliere-cli-o-tui)
- [Riferimento CLI per attività](#riferimento-cli-per-attività)
- [TUI: navigazione e comandi](#tui-navigazione-e-comandi)
- [Ricette operative](#ricette-operative)
- [Configurazione, dati e sicurezza](#configurazione-dati-e-sicurezza)
- [Risoluzione dei problemi](#risoluzione-dei-problemi)

## Avvio rapido

Requisiti: **Node.js 26.4.0 o superiore** oppure **Bun 1.3.0 o superiore**; Bun è consigliato. Per creare agenti o selezionare/riparare modelli, serve anche il comando `opencode` disponibile nel `PATH`: `opencode models` deve poter restituire un catalogo di modelli. Questo requisito è distinto dall’avvio del manager/TUI, che può partire anche se il catalogo non è disponibile. Da una shell, entra nella directory del manager, installa le dipendenze e avvia la TUI:

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
| `--output <percorso>`, `-o` | Directory di output; per default `agents/bridges/claude-code/<nome>` o `agents/bridges/codex/<nome>`. |
| `--name <nome>`, `-n` | Nome del plugin/layer; il valore iniziale predefinito è `decent-pipeline`. |
| `--prefix <prefisso>`, `-p` | Prefisso da rimuovere dai nomi sorgenti; per default `<categoria>-`. |
| `--source-dir <directory>`, `-s` | Directory sorgente relativa al workspace; per default `general` o il valore della configurazione. |
| `--config <percorso>` | Percorso del file di configurazione del bridge, normalmente `agents/.agent-manager/translation-config.json`. |
| `--wizard`, `-w` | Chiede target, nome, prefisso, directory sorgente e modelli per i tier; salva la configurazione prima della generazione. |
| `--help`, `-h` | Mostra le opzioni di `bridge`. |

Altri esempi:

```bash
node manage-agents/manage-agents.mjs bridge -c copilot-pipeline -t codex -n mio-layer -p copilot-pipeline- -s general
node manage-agents/manage-agents.mjs bridge --category wiki --output artifacts/wiki-claude --target claude
node manage-agents/manage-agents.mjs bridge --category copilot-pipeline --wizard
```

Un output personalizzato può trovarsi fuori dal repository; scegli un percorso deliberatamente e controlla prima se esiste già. Il wizard salva le impostazioni, ma il bridge scrive anche gli artefatti. Controlla in output la lista dei file e gli eventuali avvisi di traduzione. Per Claude il manager suggerisce `claude plugin validate <percorso> --strict`; per Codex indica gli agenti scoped e il manifest del plugin.

### Generare e verificare distribuzioni di categoria

I manifest in `agents/.agent-manager/categories/` selezionano risorse canoniche. I comandi `check`, `status`, `explain`, `list` e `package --dry-run` sono di ispezione/anteprima; `build` genera output.

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

Nei prompt di bridge, usa `Tab` per passare tra nome, prefisso e directory sorgente; con il campo prefisso attivo le frecce selezionano i suggerimenti disponibili. Verifica i valori, il target e i percorsi prima di generare. L’import CLI, come quello TUI, elabora le differenze degli agenti e delle risorse companion; il CLI non permette di scegliere singoli file.

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

Esamina l’elenco di file, preview e warning. Se il mapping di modelli o ruoli va modificato, ripeti con `--wizard` dopo aver verificato che la configurazione salvata è quella voluta.

### Riprendere il controllo dopo una build generale interrotta

**Directory corrente: radice del repository.** Non cancellare journal o directory temporanee manualmente senza averne prima capito lo stato. Esamina il journal indicato dall’errore, quindi chiedi al manager di recuperare:

```bash
node manage-agents/manage-agents.mjs --no-auto-commit category recover
node manage-agents/manage-agents.mjs category check --all
```

`recover` è un’operazione di scrittura/recupero, non un controllo in sola lettura. Usala solo in risposta a un journal irrisolto e non mentre è in corso una build.

## Configurazione, dati e sicurezza

### Dove si trovano le sorgenti e gli output

La fonte canonica è `agents/general/`: modifica lì gli agenti e, quando necessario, i manifest sotto `agents/.agent-manager/categories/`. Non modificare direttamente i risultati generati:

- `agents/categories/`: distribuzioni create dai manifest; la build ricrea/sostituisce la directory della categoria.
- `agents/bridges/claude-code/` e `agents/bridges/codex/`: bridge generati; un `--output` può scegliere un altro percorso.
- `agents/.agent-manager/translation-config.json`: impostazioni persistenti del bridge, comprese destinazione, prefisso, directory sorgente, tier, mapping per ruolo e override.
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

Per impostazione predefinita l’auto-commit è **disattivato**. `--auto-commit` e `AGENT_MANAGER_AUTO_COMMIT=1` abilitano il tentativo solo per le mutazioni che il codice collega esplicitamente a una transazione Git: non rendono committente ogni operazione che scrive file. Tra le operazioni collegate ci sono creazione, import, rinomina e tuning da CLI, build di una singola categoria e le mutazioni transazionali della TUI (per esempio modifica agenti e generazione bridge). Per queste il tentativo è best-effort, subordinato ai controlli e alle condizioni Git descritti sotto.

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
| Rifiuto di un percorso o di un symlink | Usa directory regolari, senza symlink nei percorsi gestiti, e mantieni l’output dei pacchetti in un percorso relativo sicuro non sovrapposto a sorgenti, output gestiti o Git. |
| `category package` rifiuta la distribuzione | Esegui prima `category check <id>`; se risulta stale, controlla le sorgenti e rigenera con `category build <id>`, quindi riprova. |

Le pipeline CI del progetto verificano Node e Bun su macOS, Linux e Windows; questo non sostituisce la prova interattiva della TUI nel terminale specifico che usi.
