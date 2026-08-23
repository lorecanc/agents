---
description: Scansiona la cartella programmazione e genera registry porte as-is e ideale
agent: build
---

# Obiettivo

Sei nella cartella `programmazione`, che contiene più progetti/repository di sviluppo.

Devi analizzare tutte le sottocartelle progetto e generare un registry locale dei servizi, delle porte attualmente usate e delle porte ideali secondo una policy ordinata.

La directory corrente è il workspace root, salvo diverso path passato negli argomenti.

Argomenti opzionali:

```txt
$ARGUMENTS
````

Se `$ARGUMENTS` contiene un path, usalo come workspace root. Altrimenti usa la directory corrente.

***

# Output directory

Genera tutti i file esclusivamente dentro:

```txt
.local-services/
```

Se non esiste, creala.

Non modificare nessun file dentro i progetti/repository.

***

# File da generare

Genera questi file:

```txt
.local-services/policy.json
.local-services/services.as-is.json
.local-services/services.ideal.json
.local-services/migration-plan.json
.local-services/conflicts.json
.local-services/services.md
```

Genera anche uno snapshot storico:

```txt
.local-services/history/YYYY-MM-DD-HH-mm-scan.json
```

***

# Policy porte

Crea o aggiorna:

```txt
.local-services/policy.json
```

con questa policy:

```json
{
  "version": "1.0",
  "workspace": {
    "name": "programmazione",
    "root": "."
  },
  "port_ranges": {
    "frontend": "3100-3199",
    "api": "3200-3299",
    "gateway": "3300-3399",
    "data": "3400-3499",
    "tooling": "3500-3599",
    "observability": "3600-3699",
    "auth": "3700-3799",
    "mocking": "3800-3899",
    "reserved": "3900-3999"
  },
  "rules": {
    "prefer_host_ports_in_policy_range": true,
    "keep_container_internal_ports_standard": true,
    "avoid_framework_default_ports_on_host": true,
    "require_healthcheck_for_api": true,
    "require_local_url": true,
    "prefer_strict_ports_for_frontend": true,
    "one_stable_port_per_service": true,
    "do_not_modify_repositories": true
  },
  "avoid_host_ports": [
    3000,
    5000,
    5173,
    5432,
    6379,
    8000,
    8080,
    9000
  ]
}
```

***

# Scope della scansione

Scansiona ricorsivamente tutti i progetti sotto `programmazione`.

Considera una sottocartella come possibile progetto se contiene almeno uno di questi file:

```txt
.git
package.json
docker-compose.yml
docker-compose.yaml
compose.yml
compose.yaml
Dockerfile
pyproject.toml
requirements.txt
pom.xml
build.gradle
go.mod
Cargo.toml
README.md
```

Ignora sempre:

```txt
node_modules
.git/objects
.venv
venv
env
dist
build
target
coverage
.next
.nuxt
.turbo
.cache
.idea
.vscode
__pycache__
.local-services
.opencode
```

***

# File da cercare nei progetti

Per ogni progetto, cerca informazioni in:

```txt
docker-compose.yml
docker-compose.yaml
compose.yml
compose.yaml
Dockerfile
package.json
vite.config.ts
vite.config.js
vite.config.mts
next.config.js
next.config.mjs
nuxt.config.ts
angular.json
.env
.env.local
.env.development
.env.example
pyproject.toml
requirements.txt
Pipfile
poetry.lock
pom.xml
build.gradle
application.yml
application.yaml
application.properties
go.mod
Cargo.toml
README.md
Makefile
justfile
Taskfile.yml
```

***

# Shell commands consentiti

Puoi usare comandi shell solo in lettura.

Prima trova i file rilevanti:

```bash
find . -maxdepth 5 -type f \( \
  -name "docker-compose.yml" -o \
  -name "docker-compose.yaml" -o \
  -name "compose.yml" -o \
  -name "compose.yaml" -o \
  -name "Dockerfile" -o \
  -name "package.json" -o \
  -name "vite.config.ts" -o \
  -name "vite.config.js" -o \
  -name "next.config.js" -o \
  -name "next.config.mjs" -o \
  -name "nuxt.config.ts" -o \
  -name "angular.json" -o \
  -name ".env" -o \
  -name ".env.local" -o \
  -name ".env.development" -o \
  -name ".env.example" -o \
  -name "pyproject.toml" -o \
  -name "requirements.txt" -o \
  -name "pom.xml" -o \
  -name "build.gradle" -o \
  -name "application.yml" -o \
  -name "application.yaml" -o \
  -name "application.properties" -o \
  -name "go.mod" -o \
  -name "Cargo.toml" -o \
  -name "README.md" -o \
  -name "Makefile" -o \
  -name "justfile" -o \
  -name "Taskfile.yml" \
\) \
-not -path "*/node_modules/*" \
-not -path "*/.git/*" \
-not -path "*/.venv/*" \
-not -path "*/venv/*" \
-not -path "*/dist/*" \
-not -path "*/build/*" \
-not -path "*/target/*" \
-not -path "*/coverage/*" \
-not -path "*/.next/*" \
-not -path "*/.nuxt/*" \
-not -path "*/.turbo/*" \
-not -path "*/.cache/*" \
-not -path "*/.local-services/*" \
-not -path "*/.opencode/*"
```

Per porte attualmente in ascolto, prova:

```bash
lsof -iTCP -sTCP:LISTEN -P -n
```

Se `lsof` non è disponibile:

```bash
ss -ltnp
```

Se anche questo non è disponibile, continua usando solo i file di configurazione.

***

# Cosa devi produrre

Devi produrre due viste principali:

1. `services.as-is.json`
2. `services.ideal.json`

***

## `services.as-is.json`

Rappresenta la situazione reale rilevata nella cartella `programmazione`.

Schema:

```json
{
  "version": "1.0",
  "generated_at": "ISO-8601 datetime",
  "workspace": {
    "root": ".",
    "name": "programmazione"
  },
  "services": [
    {
      "id": "repo.service-name",
      "name": "service-name",
      "repo": "repo-name",
      "path": "relative/path/to/repo",
      "category": "frontend | api | gateway | data | tooling | observability | auth | mocking | unknown",
      "type": "vite | nextjs | react | fastapi | flask | django | springboot | node | postgres | redis | keycloak | nginx | unknown",
      "runtime": "localhost | docker | docker-compose | devcontainer | wsl | kubernetes | unknown",
      "status": "detected | active | inactive | unknown",
      "ports": {
        "framework_default": null,
        "internal": null,
        "host": null,
        "published": [],
        "detected_listening": []
      },
      "urls": {
        "host": null,
        "container": null
      },
      "access": [],
      "depends_on": [],
      "proxy": {},
      "healthcheck": null,
      "config_files": [],
      "commands": {},
      "environment_keys": [],
      "source": {
        "detected_by": [],
        "evidence": [],
        "confidence": "low | medium | high"
      },
      "notes": []
    }
  ],
  "conflicts": [],
  "unknowns": []
}
```

***

## `services.ideal.json`

Rappresenta la situazione desiderata dopo migrazione.

Schema:

```json
{
  "version": "1.0",
  "generated_at": "ISO-8601 datetime",
  "workspace": {
    "root": ".",
    "name": "programmazione"
  },
  "policy_ref": ".local-services/policy.json",
  "services": [
    {
      "id": "repo.service-name",
      "name": "service-name",
      "repo": "repo-name",
      "path": "relative/path/to/repo",
      "category": "frontend | api | gateway | data | tooling | observability | auth | mocking | unknown",
      "type": "vite | nextjs | fastapi | postgres | redis | unknown",
      "runtime": "localhost | docker-compose | docker | unknown",
      "ports": {
        "framework_default": null,
        "internal": null,
        "host": null,
        "canonical": null
      },
      "urls": {
        "host": "http://localhost:PORT",
        "container": null
      },
      "access": [],
      "depends_on": [],
      "proxy": {},
      "healthcheck": null,
      "config_files": [],
      "recommended_changes": [],
      "migration": {
        "current_host_port": null,
        "target_host_port": null,
        "breaking_change": false,
        "priority": "low | medium | high",
        "actions": []
      },
      "notes": []
    }
  ],
  "recommendations": []
}
```

***

# Regole di classificazione

Classifica i servizi in base agli indizi nei file.

## Frontend

Categoria:

```txt
frontend
```

Indizi:

```txt
vite
next
react-scripts
nuxt
angular
vue
svelte
astro
```

Range target:

```txt
3100-3199
```

Se è Vite, suggerisci sempre:

```ts
server: {
  port: 310x,
  strictPort: true
}
```

***

## API

Categoria:

```txt
api
```

Indizi:

```txt
fastapi
uvicorn
flask
django
express
nestjs
spring-boot
dotnet webapi
go http
gin
fiber
axum
actix
```

Range target:

```txt
3200-3299
```

***

## Gateway

Categoria:

```txt
gateway
```

Indizi:

```txt
nginx
traefik
kong
gateway
bff
reverse-proxy
api-gateway
```

Range target:

```txt
3300-3399
```

***

## Data

Categoria:

```txt
data
```

Indizi:

```txt
postgres
mysql
mariadb
mongodb
redis
rabbitmq
kafka
zookeeper
elasticsearch
opensearch
qdrant
weaviate
chromadb
```

Range target:

```txt
3400-3499
```

Mantieni porte interne standard nei container:

```txt
postgres: 5432
redis: 6379
mysql: 3306
mongodb: 27017
rabbitmq: 5672
kafka: 9092
elasticsearch: 9200
qdrant: 6333
```

***

## Tooling

Categoria:

```txt
tooling
```

Indizi:

```txt
swagger-ui
storybook
adminer
pgadmin
mailhog
mailpit
minio
docs
playground
docusaurus
mkdocs
jupyter
```

Range target:

```txt
3500-3599
```

***

## Observability

Categoria:

```txt
observability
```

Indizi:

```txt
grafana
prometheus
jaeger
tempo
loki
otel
opentelemetry
zipkin
```

Range target:

```txt
3600-3699
```

***

## Auth

Categoria:

```txt
auth
```

Indizi:

```txt
keycloak
auth
oauth
oidc
identity
dex
hydra
zitadel
```

Range target:

```txt
3700-3799
```

***

## Mocking

Categoria:

```txt
mocking
```

Indizi:

```txt
wiremock
mockoon
msw
stub
fake-api
json-server
prism
httptoolkit
```

Range target:

```txt
3800-3899
```

***

# Regole Docker e Docker Compose

Per servizi Docker o Docker Compose:

* `internal` = porta dentro container;
* `host` = porta esposta su localhost;
* `canonical` = porta host desiderata;
* se trovi `3201:8000`, allora:
  * host = `3201`
  * internal = `8000`;
* se trovi `8000:8000` per API, idealmente proponi `320x:8000`;
* se trovi `5432:5432` per Postgres, idealmente proponi `340x:5432`;
* se trovi `6379:6379` per Redis, idealmente proponi `340x:6379`;
* non cambiare le porte interne standard dei container.

Per ciascun servizio Docker, prova a produrre anche:

```json
"urls": {
  "host": "http://localhost:HOST_PORT",
  "container": "http://SERVICE_NAME:INTERNAL_PORT"
}
```

Per data services non HTTP, usa `localhost:PORT` senza protocollo HTTP.

***

# Regole localhost

Per servizi lanciati direttamente su host:

* `internal`, `host` e `canonical` spesso coincidono;
* se una porta default viene usata direttamente, suggerisci una porta canonica;
* frontend su `310x`;
* API su `320x`;
* gateway su `330x`;
* tooling su `350x`.

***

# Allocazione porte ideali

Assegna porte target in modo stabile e prevedibile.

Regole:

1. Ordina i servizi per categoria e poi per nome repo.
2. Assegna la prima porta libera del range categoria.
3. Non riutilizzare porte già assegnate.
4. Non usare porte in `avoid_host_ports`.
5. Se un servizio è già su una porta corretta e non conflittuale, mantienila.
6. Se un servizio ha una porta fuori range, proponi una porta libera nel range corretto.
7. Se due servizi competono per la stessa porta, mantieni quella al servizio più coerente e sposta l’altro.
8. Se la categoria è `unknown`, non assegnare porta target salvo forte evidenza.

***

# Conflitti da rilevare

Genera:

```txt
.local-services/conflicts.json
```

Cerca almeno:

```txt
port_collision
wrong_range
default_port_used
missing_healthcheck
missing_local_url
missing_dependency
docker_port_not_mapped
env_port_mismatch
stale_service
unknown_runtime
low_confidence_detection
unknown_category
```

Schema:

```json
{
  "version": "1.0",
  "generated_at": "ISO-8601 datetime",
  "conflicts": [
    {
      "type": "port_collision",
      "severity": "error | warning | info",
      "port": 3201,
      "services": [],
      "message": "Descrizione sintetica",
      "suggested_fix": "Fix suggerito"
    }
  ]
}
```

***

# Migration plan

Genera:

```txt
.local-services/migration-plan.json
```

Schema:

```json
{
  "version": "1.0",
  "generated_at": "ISO-8601 datetime",
  "strategy": "incremental",
  "summary": {
    "total_services": 0,
    "services_to_migrate": 0,
    "conflicts": 0,
    "high_priority_actions": 0
  },
  "safe_order": [
    "tooling",
    "mocking",
    "frontend",
    "api",
    "gateway",
    "auth",
    "data",
    "observability"
  ],
  "steps": [
    {
      "step": 1,
      "title": "Congelare situazione attuale",
      "actions": [
        "Salvare services.as-is.json",
        "Salvare snapshot in history"
      ]
    },
    {
      "step": 2,
      "title": "Migrare servizi non critici",
      "actions": []
    },
    {
      "step": 3,
      "title": "Migrare frontend",
      "actions": []
    },
    {
      "step": 4,
      "title": "Migrare API e gateway",
      "actions": []
    },
    {
      "step": 5,
      "title": "Migrare auth e data services",
      "actions": []
    },
    {
      "step": 6,
      "title": "Aggiornare documentazione e client",
      "actions": []
    }
  ],
  "repo_changes": [
    {
      "repo": "repo-name",
      "path": "relative/path",
      "priority": "low | medium | high",
      "changes": [
        {
          "file": "docker-compose.yml",
          "current": "8000:8000",
          "target": "3201:8000",
          "reason": "API should expose host port in api range"
        }
      ],
      "validation": [
        "Verificare che http://localhost:3201/health risponda"
      ]
    }
  ]
}
```

***

# Report Markdown

Genera:

```txt
.local-services/services.md
```

Deve essere sintetico ma utile.

Struttura:

```md
# Local Services Registry

Generated at: ...

Workspace: programmazione

## Summary

- Total services:
- Frontend:
- API:
- Gateway:
- Data:
- Tooling:
- Observability:
- Auth:
- Mocking:
- Unknown:
- Conflicts:

## Port Policy

- Frontend: 3100-3199
- API: 3200-3299
- Gateway: 3300-3399
- Data: 3400-3499
- Tooling: 3500-3599
- Observability: 3600-3699
- Auth: 3700-3799
- Mocking: 3800-3899

## As-is Services

Raggruppa per categoria.

Per ogni servizio mostra:

- nome;
- repo;
- runtime;
- tipo;
- porta host attuale;
- porta interna;
- URL host;
- file sorgente da cui è stato rilevato;
- confidence.

## Ideal Target

Raggruppa per categoria.

Per ogni servizio mostra:

- nome;
- repo;
- porta target;
- URL target;
- modifiche consigliate.

## Conflicts

Elenca conflitti e fix.

## Migration Plan

Elenca i passi consigliati in ordine.

## Unknowns

Elenca cosa va verificato manualmente.
```

***

# Snapshot storico

Copia il contenuto completo di `services.as-is.json` anche in:

```txt
.local-services/history/YYYY-MM-DD-HH-mm-scan.json
```

Usa data e ora locale se possibile.

***

# Requisiti finali

1. Non inventare servizi.
2. Se non sei sicuro, usa `unknown` e confidenza `low`.
3. Non modificare file delle repo.
4. Scrivi solo in `.local-services/`.
5. Mantieni JSON valido.
6. Non usare commenti nei JSON.
7. Non stampare JSON enormi in chat.
8. Alla fine mostra un riepilogo compatto.

***

# Risposta finale attesa

Alla fine rispondi con:

```txt
Generated files:
- .local-services/policy.json
- .local-services/services.as-is.json
- .local-services/services.ideal.json
- .local-services/migration-plan.json
- .local-services/conflicts.json
- .local-services/services.md
- .local-services/history/...

Summary:
- Services detected: N
- Conflicts: N
- Services to migrate: N

Top suggested migrations:
1. ...
2. ...
3. ...

Unknowns:
- ...
```

````

---

## Come lanciarlo

Da terminale:

```bash
cd ~/programmazione
opencode
````

Poi dentro OpenCode:

```txt
/ports-plan
```

Se invece apri OpenCode da un’altra cartella, puoi passargli il path:

```txt
/ports-plan ~/programmazione
```

***

## Nota importante

In questa versione il comando è pensato per fare **solo discovery e planning**.

Non cambia:

* `docker-compose.yml`;
* `.env`;
* `vite.config.ts`;
* `package.json`;
* README delle repo.

Genera solo output in:

```txt
.local-services/
```
