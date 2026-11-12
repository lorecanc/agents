# Guida alla configurazione MCP e LSP (`opencode.json`)

> **Nota:** i documenti vendorizzati sotto `docs/docs-opencode/` sono ritagli di riferimento V1, non il contratto corrente.

Ecco la mappa dei file. I sorgenti vivono in `packs/common/opencode.json` per `codebase-memory-mcp` e in `packs/integrations/opencode.json` per tutti gli altri server MCP e per i server LSP, scritti con comandi portabili su macOS, Linux, Windows e WSL così da fondersi senza ritocchi dentro `~/.config/opencode/opencode.json`.

---

## Panoramica e struttura nei pack

L'unione avviene durante l'installazione. Siccome `flow`, `pipeline` e `general` dichiarano `integrations` tra le proprie dipendenze (mentre `flow`, `pipeline`, `docs`, `slides` e `wiki` dichiarano `common`), lanciare `manage-agents install` registra automaticamente le voci MCP e LSP lasciando intatte le tue chiavi personali in `opencode.json`.

### Principi di configurazione
1. **Comandi portabili**: Utilizzo dei binari registrati nel `PATH` di sistema o esecuzione tramite `npx -y` anziché percorsi assoluti specifici per un utente o un OS (`/Users/...`, `/opt/homebrew/...`).
2. **Gestione Variabili d'Ambiente**: Sintassi standard OpenCode (`{env:NOME_VAR}`) per iniettare chiavi API senza esporle nel file di configurazione.
3. **Attivazione Selettiva**: I server specifici per un determinato OS o toolchain (es. Xcode su macOS) sono disabilitati di default (`"disabled": true` nella voce sotto `mcp.servers`) per evitare errori all'avvio su altri ambienti (es. Linux o Windows).

---

## 🛠️ MCP Server Inclusi

| Server MCP | Descrizione | Requisiti / Note | Abilitato di Default |
| :--- | :--- | :--- | :---: |
| `chrome-devtools` | Tool per audit a11y, performance LCP e debugging web via Chrome DevTools | Node.js (`npx`) | `true` |
| `codebase-memory-mcp` | Knowledge graph della codebase (indicizzazione e navigazione simboli) | Binary `codebase-memory-mcp` nel `PATH` | `true` |
| `shadcn` | Integrazione componenti UI shadcn | Node.js (`npx`) | `true` |
| `magic` | Generazione e ricerca componenti 21st.dev | Node.js, richiede `TWENTYFIRST_API_KEY` | `true` |
| `axiom` | Integrazione log e osservabilità Axiom | Node.js (`npx`) | `true` |
| `cwe-search` | Ricerca e analisi vulnerabilità Common Weakness Enumeration (CWE) | Node.js (`npx`) | `true` |
| `XcodeBuildMCP` | Integrazione Xcode per build e testing di app iOS/macOS | macOS con Xcode CLI Tools | `false` (Attivare su macOS) |
| `cupertino` | Toolchain Cupertino per progetti Apple/Flutter | CLI `cupertino` installata nel `PATH` | `false` (Attivare se presente) |
| `bigquery` | Query, esplorazione e gestione dei dati BigQuery | Remote (Google Cloud); endpoint `https://bigquery.googleapis.com/mcp` | `false` |
| `cloud-run` | Ispezione e gestione dei servizi Cloud Run | Remote (Google Cloud); endpoint `https://run.googleapis.com/mcp` | `false` |
| `cloud-logging` | Ricerca e analisi dei log, inclusi quelli di Cloud Run e Cloud Build | Remote (Google Cloud); endpoint `https://logging.googleapis.com/mcp` | `false` |
| `cloud-monitoring` | Ispezione di metriche e risorse monitorate, inclusi Cloud Run e Cloud Build | Remote (Google Cloud); endpoint `https://monitoring.googleapis.com/mcp` | `false` |
| `cloud-sql` | Ispezione delle istanze Cloud SQL ed esecuzione SQL su PostgreSQL | Remote (Google Cloud); endpoint `https://sqladmin.googleapis.com/mcp` | `false` |
| `cloud-storage` | Esplorazione dei bucket e degli oggetti Cloud Storage | Remote (Google Cloud); endpoint `https://storage.googleapis.com/storage/mcp` | `false` |
| `cloud-cli` | Operazioni CLI Google Cloud; permette di ispezionare Cloud Build insieme a `cloud-logging` | Remote (Google Cloud); endpoint `https://cloudcli.googleapis.com/mcp` | `false` |

---

## Server MCP Remoti Google Cloud (GCP)

I sette server remoti sono già descritti in `packs/integrations/opencode.json`; non richiedono l'installazione di un pacchetto locale. Prima di usarli, abilita le API necessarie, assegna i ruoli IAM e configura l'autenticazione. Nel pack partono disabilitati con `"disabled": true`.

### Gestione Multi-Progetto GCP

Non è necessario duplicare i server MCP in `opencode.json` per ogni progetto né fissare `GOOGLE_CLOUD_PROJECT`: ogni tool MCP riceve il progetto di destinazione come parametro della chiamata. Usa `projectId` per BigQuery e per Cloud Storage `list_buckets` (i tool Cloud Storage sugli oggetti ricevono direttamente `bucketName`), `project` per Cloud Run e Cloud SQL, e il nome risorsa `projects/TARGET_PROJECT_ID` per Cloud Logging e Cloud Monitoring (ad esempio `resourceNames: ["projects/TARGET_PROJECT_ID"]` o `name: "projects/TARGET_PROJECT_ID"`, in base al tool). Cloud CLI segue una convenzione diversa: con `run_gcloud_command`, l'argomento MCP `project: "projects/EXECUTION_PROJECT_ID"` è usato per l'abilitazione e la quota della Cloud CLI Execution API, mentre il flag `--project=TARGET_PROJECT_ID` nel comando `gcloud` seleziona il progetto target su cui operare.

Con l'autenticazione tramite OAuth Client ID/Secret basta un unico OAuth Client Desktop, creato in un progetto hub o principale; non serve l'header `x-goog-user-project`. In ogni progetto target su cui vuoi operare, abilita le API relative ai servizi e assegna al tuo utente Google `roles/mcp.toolUser` e i ruoli IAM specifici del servizio indicati sotto. Puoi assegnare i ruoli a livello di Folder o Organization GCP perché si applichino automaticamente ai progetti contenuti.

### Abilitazione delle API su GCP

Abilita `cloudcli.googleapis.com` nel progetto di esecuzione (hub) indicato dall'argomento MCP `project` di `run_gcloud_command`:

```bash
gcloud services enable cloudcli.googleapis.com --project="EXECUTION_PROJECT_ID"
```

Abilita le API dei servizi e Cloud Build in ciascun progetto di destinazione:

```bash
gcloud services enable \
  bigquery.googleapis.com \
  run.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com \
  sqladmin.googleapis.com \
  storage.googleapis.com \
  cloudbuild.googleapis.com \
  --project="TARGET_PROJECT_ID"
```

Da `gcloud` 581.0.0, `gcloud services enable` abilita automaticamente anche il remote MCP endpoint del servizio. Il vecchio comando `gcloud beta services mcp enable` è stato rimosso.

### Ruoli IAM richiesti

Concedi i ruoli all'identità Google usata da OpenCode. Per tutti gli endpoint MCP remoti Google è obbligatorio il ruolo base `roles/mcp.toolUser`, che include `mcp.tools.call`. Aggiungi anche i ruoli specifici dei servizi necessari:

- **BigQuery**: `roles/bigquery.jobUser` e `roles/bigquery.dataViewer`; per scrivere dati, usa `roles/bigquery.dataEditor`.
- **Cloud Run**: la configurazione `cloud-run` fornita in `packs/integrations/opencode.json` è in sola lettura (`scope: "https://www.googleapis.com/auth/run.readonly"`) e gli agenti pipeline negano `cloud-run_deploy_*`; richiede `roles/run.viewer`. Se in futuro servono operazioni di scrittura o deploy, concedi `roles/run.developer` (oltre a `roles/iam.serviceAccountUser` e `roles/artifactregistry.reader`), cambia lo scope OAuth in `https://www.googleapis.com/auth/run` e consenti esplicitamente i tool di deploy nei permessi dell'agente.
- **Cloud Logging e Monitoring** (anche per osservare Cloud Run e Cloud Build): `roles/logging.viewer` oppure `roles/logging.admin`, e `roles/monitoring.viewer` oppure `roles/monitoring.admin`.
- **Cloud SQL (PostgreSQL)**: `roles/cloudsql.viewer` e `roles/cloudsql.studioUser` (oppure `roles/cloudsql.admin`). Per consentire l'esecuzione SQL è inoltre obbligatorio abilitare Data API sull'istanza PostgreSQL:

  ```bash
  gcloud sql instances patch INSTANCE_NAME \
    --data-api-access=ALLOW_DATA_API \
    --project=PROJECT_ID
  ```

- **Cloud Storage**: `roles/storage.objectViewer`; per elencare i bucket occorre `roles/storage.admin` oppure un ruolo custom che includa `storage.buckets.list`.
- **Cloud CLI** (per ispezionare Cloud Build): `roles/cloudbuild.builds.viewer`.

### Autenticazione su OpenCode

Gli endpoint remoti Google non supportano OAuth Dynamic Client Registration (DCR). Configura quindi un client OAuth pre-registrato, oppure passa un token Bearer ADC statico.

#### OAuth Client ID/Secret pre-registrato (consigliato per uso continuativo)

Nella Google Cloud Console, vai a **APIs & Services → Credentials → Create credentials → OAuth client ID** e crea un unico client di tipo **Desktop app** in un progetto hub o principale. Se richiesto, configura prima la schermata di consenso in Google Auth Platform. Esporta le credenziali del client nell'ambiente in cui avvii OpenCode:

```bash
export GCLOUD_MCP_CLIENT_ID="il-tuo-client-id.apps.googleusercontent.com"
export GCLOUD_MCP_CLIENT_SECRET="il-tuo-client-secret"
```

Il blueprint usa queste variabili per gli oggetti `oauth` dei server remoti. Il progetto target viene indicato nei parametri dei singoli tool MCP, non tramite una variabile d'ambiente.

#### Alternativa rapida con ADC Bearer Token (scadenza 1 ora)

Esegui il login ADC e crea un token di accesso:

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="il-tuo-project-id"
export GCLOUD_MCP_ACCESS_TOKEN="$(gcloud auth application-default print-access-token)"
```

Nell'oggetto del server MCP remoto in `~/.config/opencode/opencode.json`, imposta gli header seguenti e rimuovi la configurazione `oauth` del client, oppure impostala a `false`:

```json
"headers": {
  "Authorization": "Bearer {env:GCLOUD_MCP_ACCESS_TOKEN}",
  "x-goog-user-project": "{env:GOOGLE_CLOUD_PROJECT}"
},
"oauth": false
```

Il token Bearer scade dopo un'ora: per continuare a usare i server, genera ed esporta un nuovo token. L'header `x-goog-user-project` è necessario solo con questa alternativa manuale ADC, non con OAuth Client ID/Secret.

### Attivazione in OpenCode

Basta rimuovere `"disabled": true`. Dopo aver installato i pack con `manage-agents install`, puoi ridefinire il server desiderato nell'`opencode.json` della root del progetto su cui lavori senza `"disabled": true` (in V2 un server è attivo quando `disabled` è assente), oppure modificare la voce in `~/.config/opencode/opencode.json`: `manage-agents` non sovrascrive mai in silenzio una voce gestita modificata dall'utente senza `--adopt`.

---

## ⚙️ LSP Server Inclusi

| Language Server | Linguaggio / Estensioni | Comando |
| :--- | :--- | :--- |
| `basedpyright` | Python (`.py`) | `basedpyright-langserver --stdio` |
| `ruff` | Python (`.py`) | `ruff server` |
| `html` | HTML / Vue (`.html`, `.htm`, `.vue`) | `vscode-html-language-server --stdio` |
| `css` | CSS / SCSS / LESS (`.css`, `.scss`, `.less`) | `vscode-css-language-server --stdio` |
| `sql` | SQL (`.sql`) | `sqls` |
| `markdown` | Markdown (`.md`, `.mdx`) | `marksman server` |

---

## 📦 Guida all'Installazione dei Requisiti

### 1. Requisiti Base (Tutte le piattaforme)
- **Node.js & npm** (per eseguire i server `npx`)
- **Python 3.10+** (se si usano i tool Python / LSP Python)

### 2. Installazione `codebase-memory-mcp`
Assicurarsi che il binario `codebase-memory-mcp` sia disponibile nel `PATH` di sistema:
```bash
# Esempio via pip / pipx / npm
pip install codebase-memory-mcp
# oppure verificare che il binario sia presente in ~/.local/bin o /usr/local/bin
```

### 3. Configurazione delle Variabili d'Ambiente

Per il server `magic` (21st.dev), impostare la chiave API nel proprio ambiente:

**Linux / macOS (Bash / Zsh):**
```bash
export TWENTYFIRST_API_KEY="tua-api-key-qui"
```

**Windows (PowerShell):**
```powershell
$env:TWENTYFIRST_API_KEY="tua-api-key-qui"
```

**Windows (CMD):**
```cmd
set TWENTYFIRST_API_KEY=tua-api-key-qui
```

---

## Come installare le configurazioni MCP e LSP

### Installazione con `manage-agents` (consigliata)

Usa il gestore dei pack. Registrando il catalogo come sorgente ed eseguendo `manage-agents install flow pipeline` (oppure `manage-agents install integrations common` se vuoi solo server MCP e LSP, passando `--target <dir>` a `install` e `status` quando usi una cartella diversa da `~/.config/opencode`), il motore unisce `mcp` e `lsp` preservando `model`, `providers`, `permissions` e ogni altra chiave personale:

```bash
manage-agents source add catalog https://github.com/lorecanc/agents.git
manage-agents source pull
manage-agents install flow pipeline
manage-agents status
```

---

## 🔧 Personalizzazione e Abilitazione Server

### Attivare un Server disabilitato (es. XcodeBuildMCP su macOS)
Apri il file `opencode.json` e, nella voce del server sotto `mcp.servers`, rimuovi `"disabled": true`:

```json
"mcp": {
  "servers": {
    "XcodeBuildMCP": {
        "type": "local",
        "command": ["npx", "-y", "xcodebuildmcp@latest", "mcp"],
        "codemode": false
    }
  }
}
```

### Disabilitare temporaneamente un server MCP
Se non desideri caricare un determinato server per ridurre il numero di token o evitare conflitti:

```json
"mcp": {
  "servers": {
    "chrome-devtools": {
        "type": "local",
        "command": ["npx", "-y", "chrome-devtools-mcp@latest"],
        "codemode": false,
        "disabled": true
    }
  }
}
```

`codemode` è valido solo sui server locali; i server remoti non lo accettano. Sui server locali `codemode: false` è obbligatorio, perché gli agenti pipeline negano `execute` (Code Mode) e un server che abilitasse Code Mode non sarebbe utilizzabile.
