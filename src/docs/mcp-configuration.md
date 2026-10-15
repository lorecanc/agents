# Guida alla Configurazione MCP e LSP (`opencode.json`)

Questo documento illustra la struttura del blueprint di configurazione `general/opencode.json` per **OpenCode**, progettato per essere **portabile e multipiattaforma** (macOS, Linux, Windows / WSL).

---

## 🚀 Panoramica e Blueprint

Il file `general/opencode.json` serve da configurazione di riferimento per attivare server **MCP** (Model Context Protocol) e **LSP** (Language Server Protocol) all'interno di OpenCode.

### Principi del Blueprint
1. **Comandi portabili**: Utilizzo dei binari registrati nel `PATH` di sistema o esecuzione tramite `npx -y` anziché percorsi assoluti specifici per un utente o un OS (`/Users/...`, `/opt/homebrew/...`).
2. **Gestione Variabili d'Ambiente**: Sintassi standard OpenCode (`{env:NOME_VAR}`) per iniettare chiavi API senza esporle nel file di configurazione.
3. **Attivazione Selettiva**: I server specifici per un determinato OS o toolchain (es. Xcode su macOS) sono disabilitati di default (`"enabled": false`) per evitare errori all'avvio su altri ambienti (es. Linux o Windows).

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

## 📂 Come Utilizzare `opencode.json`

### Opzione A: Copia Globale in `~/.config/opencode/`
Per applicare la configurazione a tutti i progetti OpenCode:

**Linux / macOS:**
```bash
mkdir -p ~/.config/opencode
cp general/opencode.json ~/.config/opencode/opencode.json
```

**Windows (PowerShell):**
```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.config\opencode"
Copy-Item general\opencode.json "$env:USERPROFILE\.config\opencode\opencode.json"
```

### Opzione B: Riferimento nel file di configurazione principale
Se hai già un file `~/.config/opencode/opencode.json`, puoi collegare questo progetto aggiungendo la sezione `projects`:

```json
{
  "projects": {
    "agents": {
      "path": "~/.config/opencode/projects/agents",
      "agents": "general/agents"
    }
  }
}
```

### Opzione C: Symlink (macOS / Linux)
```bash
ln -sf $(pwd)/general/opencode.json ~/.config/opencode/opencode.json
```

---

## 🔧 Personalizzazione e Abilitazione Server

### Attivare un Server disabilitato (es. XcodeBuildMCP su macOS)
Apri il file `opencode.json` e modifica la proprietà `"enabled"` da `false` a `true`:

```json
"XcodeBuildMCP": {
    "type": "local",
    "command": ["npx", "-y", "xcodebuildmcp@latest", "mcp"],
    "enabled": true
}
```

### Disabilitare temporaneamente un server MCP
Se non desideri caricare un determinato server per ridurre il numero di token o evitare conflitti:

```json
"chrome-devtools": {
    "type": "local",
    "command": ["npx", "-y", "chrome-devtools-mcp@latest"],
    "enabled": false
}
```
