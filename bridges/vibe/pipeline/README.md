# pipeline

This directory is a generated **Vibe plugin** (Agent Plugins 1.0 with the `ai.mistral.vibe` extension) translated from the canonical OpenCode source agents. Source agents are unchanged.

> **Generated output.** Do not edit this directory directly. Change the pack's agents or `bridges/translation-config.json`, then regenerate with the manager.

## Install

Copy this directory (or let the manager install it) into one of the plugin roots:

- `~/.vibe/plugins/pipeline/` — user global: available in every session.
- `<project>/.vibe/plugins/pipeline/` — project scope: available when that trusted folder is open.

New sessions pick the plugin up automatically; a live session needs `/reload-plugins` (or `/reload`). `/plugins` lists it with its components.

## Source and configuration

Agent prompts come from the bridged pack. Translation roles, tiers, model overrides, prefix, and output options come from `bridges/translation-config.json`; MCP declarations are merged from the `opencode.json` of the pack and the packs it requires.

- `plugin.json` — Agent Plugins 1.0 manifest with the `ai.mistral.vibe` extension.
- `skills/` — pack skills plus the translated commands; each is a standard `SKILL.md` named `pipeline:<skill>` at runtime. User-invocable command skills appear in the slash menu.
- `ai.mistral.vibe/agents/` — one TOML per translated subagent, named `<plugin>:<agent>` at runtime.
- `agent-profiles/` — one TOML per translated primary agent, to install into `~/.vibe/agents/` (the manager does this by default).
- `mcp.json` — MCP servers declared by the plugin.

All agents are also spawnable subagents, named `<plugin>:<agent>` at runtime: ask the model to delegate, or spawn them directly by name. Spawned subagents run with a reduced toolset — file access, session utilities and background processes; no MCP or connector tools, no skill loading, no user questions and no nested delegation — so the main agent gathers MCP- or skill-derived facts itself and passes them in the delegation message.

## Main agent profiles

The plugin format ships spawnable subagents only, and a spawned subagent cannot delegate further. The translated primary agents therefore also ship as main agent profiles: install `agent-profiles/` into `~/.vibe/agents/` (the manager does this by default) and start Vibe with `vibe --agent <profile>` (or switch a live session with `/agent <profile>`).

- **pipeline-orchestrator** (`vibe --agent pipeline-orchestrator`, session model): Primary coordinator for the pipeline multi-agent workflow. Assesses work size, routes to the smallest effective lane, delegates to specialized agents, and evaluates results. Never writes code or solves problems directly.

If your `config.toml` sets `enabled_agents`, add the profile names there or they stay hidden. Subagent profiles are rejected as `--agent`, so these main profiles are also the only way to run a specialist at the session level (for example from external tooling).

### Model connection

Every agent follows the Vibe session's model by default: a tier model, a `modelMap` entry or an override pins `active_model` only when the translation config says so, and `inherit` restores the default. Vibe only accepts aliases defined in the `[[models]]` entries of its own configuration and refuses an agent file whose alias is unknown, so align any pinned tier model with the aliases of your Vibe installation. A `plugin.agent.invalid` diagnostic in the startup warnings names any refused agent file.

OpenCode tool names in prompts are rewritten where Vibe has an equivalent (`todowrite` → `todo`, `question` → `ask_user_question`, Task tool → `agents.spawn`, `read` → `read_file`, `write` → `write_file`). Prompts that rely on custom tools shipped by the pack start with a runtime note saying they are unavailable here and that the documented fallbacks apply. Commands were translated into user-invocable skills: their `$ARGUMENTS` placeholder became `$request`, and `!`substitutions`` became inline bash blocks.

## MCP setup

`mcp.json` declares the translated servers. `npx` commands are fetched on first use; binaries must already be available on `PATH`.

- `codebase-memory-mcp` — runs `codebase-memory-mcp` (Node.js, npm and network access required for npx).
- `chrome-devtools` — runs `npx -y chrome-devtools-mcp@latest --executable-path={browser} --headless --no-usage-statistics` (Node.js, npm and network access required for npx).
- `XcodeBuildMCP` — runs `npx -y xcodebuildmcp@latest mcp` (Node.js, npm and network access required for npx).
- `shadcn` — runs `npx -y shadcn@latest mcp` (Node.js, npm and network access required for npx).
- `cupertino` — runs `cupertino serve` (Node.js, npm and network access required for npx).
- `axiom` — runs `npx -y axiom-mcp` (Node.js, npm and network access required for npx).
- `cwe-search` — runs `npx -y @cyanheads/mitre-cwe-mcp-server@0.3.0` (Node.js, npm and network access required for npx).
- `bigquery` — remote endpoint `https://bigquery.googleapis.com/mcp`; check network and authentication access.
- `cloud-run` — remote endpoint `https://run.googleapis.com/mcp`; check network and authentication access.
- `cloud-logging` — remote endpoint `https://logging.googleapis.com/mcp`; check network and authentication access.
- `cloud-monitoring` — remote endpoint `https://monitoring.googleapis.com/mcp`; check network and authentication access.
- `cloud-sql` — remote endpoint `https://sqladmin.googleapis.com/mcp`; check network and authentication access.
- `cloud-storage` — remote endpoint `https://storage.googleapis.com/storage/mcp`; check network and authentication access.
- `cloud-cli` — remote endpoint `https://cloudcli.googleapis.com/mcp`; check network and authentication access.

The plugin carries these servers as-is. Authenticated remote servers (and `{env:VAR}` headers) cannot be expressed in a plugin's static mcp.json: install them at the Vibe config level instead, for example `vibe mcp add <name> --url <url> --api-key-env <VAR>`, or via OAuth.

Commands may carry the `{browser}` placeholder: the manager's installer resolves it to this machine's browser (Chromium preferred over Chrome) and drops the argument when none is installed.

Platform-gated servers (`XcodeBuildMCP`: darwin, `cupertino`: darwin) are recorded in `mcp-platforms.json`: the manager's installer keeps them only on matching machines, because a plugin's mcp.json cannot express conditions.

In a session, run `/mcp` (or `/mcp status`) to verify every server is connected.

## OpenCode plugins and tools

These OpenCode companions ship with the bridged packs but have no Vibe equivalent (Vibe loads skills, agents, hooks and MCP servers only). Replace custom tools with a skill when the agents need that behavior:

- Plugin: `plugins/dev-tools`
- Plugin: `plugins/doc-tools`
- Plugin: `plugins/pipeline-guard`
- Plugin: `plugins/pipeline-tools`
- Plugin: `plugins/slide-tools`
- Tool: `tools/dev-tools/dev_env.ts`
- Tool: `tools/dev-tools/dev_serve.ts`
- Tool: `tools/dev-tools/dev_smoke.ts`
- Tool: `tools/dev-tools/dev_verify.ts`
- Tool: `tools/office-tools/doc_compile_theme.ts`
- Tool: `tools/office-tools/doc_convert.ts`
- Tool: `tools/office-tools/doc_create.ts`
- Tool: `tools/office-tools/doc_list.ts`
- Tool: `tools/office-tools/doc_modify.ts`
- Tool: `tools/office-tools/doc_restore.ts`
- Tool: `tools/office-tools/doc_view.ts`
- Tool: `tools/office-tools/pptx/html2pptx.js`
- Tool: `tools/office-tools/pptx/html2pptx_runner.js`
- Tool: `tools/office-tools/slide_analyze_template.ts`
- Tool: `tools/office-tools/slide_assemble_pptx.ts`
- Tool: `tools/office-tools/slide_build_pptx.ts`
- Tool: `tools/office-tools/slide_compile_composition.ts`
- Tool: `tools/office-tools/slide_compile_theme.ts`
- Tool: `tools/office-tools/slide_create_thumbnails.ts`
- Tool: `tools/office-tools/slide_download_image.ts`
- Tool: `tools/office-tools/slide_generate_image.ts`
- Tool: `tools/office-tools/slide_screenshot.ts`
- Tool: `tools/pipeline/pipeline_commit.ts`
- Tool: `tools/pipeline/pipeline_state.ts`

## Per-agent bash allowlists (not enforced)

Vibe agent files narrow tool use with `[tools.<name>] permission = "ask" | "never"` only; there is no per-command allowlist. The bridge emits `permission = "never"` for the tools an OpenCode agent denies and lets everything else follow the session's approval policy. The source rules are listed here so they can be reviewed or copied into the Vibe config `[tools.bash]` allowlist/denylist entries.

<details><summary>code-reviewer (135 rules)</summary>

- allow: `cd *`, `git status*`, `git diff*`, `git log*`, `git show*`, `git ls-files*`, `git grep*`, `git shortlog*`, `git describe*`, `git reflog show*`, `git stash list*`, `git stash show*`, `git worktree list*`, `git tag -l*`, `git tag --list*`, `git remote -v*`, `git config --get*`, `git config --list*`, `git check-ignore*`, `git check-attr*`, `git --no-pager status*`, `git --no-pager diff*`, `git --no-pager log*`, `git --no-pager show*`, `git --no-pager blame*`, `git --no-pager branch*`, `git --no-pager grep*`, `git --no-pager ls-files*`, `git -P status*`, `git -P diff*`, `git -P log*`, `git -P show*`, `git -C * status*`, `git -C * diff*`, `git -C * log*`, `git -C * show*`, `git -C * rev-parse*`, `git rev-parse*`, `git ls-tree*`, `git cat-file*`, `git merge-base*`, `git for-each-ref*`, `git -C * ls-tree*`, `git -C * cat-file*`, `git -C * merge-base*`, `git -C * for-each-ref*`, `ls*`, `pwd`, `wc*`, `head *`, `tail *`, `cat *`, `stat *`, `file *`, `which *`, `type *`, `uname*`, `whoami`, `id`, `date*`, `rg *`, `grep *`, `egrep *`, `fgrep *`, `find *`, `fd *`, `jq *`, `yq *`, `tree*`, `du *`, `df*`, `diff *`, `sort *`, `uniq*`, `cut *`, `tr *`, `awk *`, `cat .env.example`, `cat .env.sample`, `cat .env.template`, `cat .env.test`, `head .env.example`, `head .env.sample`, `head .env.template`, `head .env.test`
- deny: `git diff *--output*`, `git log *--output*`, `git show *--output*`, `git --no-pager diff *--output*`, `git --no-pager log *--output*`, `git --no-pager show *--output*`, `git -P diff *--output*`, `git -P log *--output*`, `git -P show *--output*`, `git -C * diff *--output*`, `git -C * log *--output*`, `git -C * show *--output*`, `* > *`, `* >> *`, `*>*`, `*>>*`, `find *-exec*`, `find *-execdir*`, `find *-delete*`, `find *-ok*`, `fd *-x*`, `fd *-X*`, `fd *--exec*`, `sort *-o *`, `sort *--output*`, `sort -o*`, `sort --output=*`, `yq *-i*`, `yq *--inplace*`, `rg *--pre*`, `awk *-f*`, `awk *system*`, `awk *getline*`, `env`, `/usr/bin/env`, `env -*`, `/usr/bin/env -*`, `env *=*`, `/usr/bin/env *=*`, `printenv*`, `/usr/bin/printenv*`, `set`, `export -p*`, `declare -p*`, `* .env`, `* .env *`, `*/.env`, `*/.env *`, `* .env.*`, `*/.env.*`

</details>

<details><summary>critic (135 rules)</summary>

- allow: `cd *`, `git status*`, `git diff*`, `git log*`, `git show*`, `git ls-files*`, `git grep*`, `git shortlog*`, `git describe*`, `git reflog show*`, `git stash list*`, `git stash show*`, `git worktree list*`, `git tag -l*`, `git tag --list*`, `git remote -v*`, `git config --get*`, `git config --list*`, `git check-ignore*`, `git check-attr*`, `git --no-pager status*`, `git --no-pager diff*`, `git --no-pager log*`, `git --no-pager show*`, `git --no-pager blame*`, `git --no-pager branch*`, `git --no-pager grep*`, `git --no-pager ls-files*`, `git -P status*`, `git -P diff*`, `git -P log*`, `git -P show*`, `git -C * status*`, `git -C * diff*`, `git -C * log*`, `git -C * show*`, `git -C * rev-parse*`, `git rev-parse*`, `git ls-tree*`, `git cat-file*`, `git merge-base*`, `git for-each-ref*`, `git -C * ls-tree*`, `git -C * cat-file*`, `git -C * merge-base*`, `git -C * for-each-ref*`, `ls*`, `pwd`, `wc*`, `head *`, `tail *`, `cat *`, `stat *`, `file *`, `which *`, `type *`, `uname*`, `whoami`, `id`, `date*`, `rg *`, `grep *`, `egrep *`, `fgrep *`, `find *`, `fd *`, `jq *`, `yq *`, `tree*`, `du *`, `df*`, `diff *`, `sort *`, `uniq*`, `cut *`, `tr *`, `awk *`, `cat .env.example`, `cat .env.sample`, `cat .env.template`, `cat .env.test`, `head .env.example`, `head .env.sample`, `head .env.template`, `head .env.test`
- deny: `git diff *--output*`, `git log *--output*`, `git show *--output*`, `git --no-pager diff *--output*`, `git --no-pager log *--output*`, `git --no-pager show *--output*`, `git -P diff *--output*`, `git -P log *--output*`, `git -P show *--output*`, `git -C * diff *--output*`, `git -C * log *--output*`, `git -C * show *--output*`, `* > *`, `* >> *`, `*>*`, `*>>*`, `find *-exec*`, `find *-execdir*`, `find *-delete*`, `find *-ok*`, `fd *-x*`, `fd *-X*`, `fd *--exec*`, `sort *-o *`, `sort *--output*`, `sort -o*`, `sort --output=*`, `yq *-i*`, `yq *--inplace*`, `rg *--pre*`, `awk *-f*`, `awk *system*`, `awk *getline*`, `env`, `/usr/bin/env`, `env -*`, `/usr/bin/env -*`, `env *=*`, `/usr/bin/env *=*`, `printenv*`, `/usr/bin/printenv*`, `set`, `export -p*`, `declare -p*`, `* .env`, `* .env *`, `*/.env`, `*/.env *`, `* .env.*`, `*/.env.*`

</details>

<details><summary>executor (157 rules)</summary>

- allow: `cat .env.example`, `cat .env.sample`, `cat .env.template`, `cat .env.test`, `head .env.example`, `head .env.sample`, `head .env.template`, `head .env.test`, `cp .env.example *`, `cp .env.sample *`, `cp .env.template *`, `cp .env.test *`
- ask: `docker push*`, `kubectl *`, `helm *`, `terraform *`, `gcloud *`, `aws *`, `az *`, `flyctl *`, `vercel *`, `wrangler deploy*`, `ssh *`, `scp *`, `sftp *`, `rsync *`, `* deploy*`, `* apply*`, `* destroy*`, `* publish*`
- deny: `sudo`, `sudo *`, `doas`, `doas *`, `su`, `su *`, `pkexec`, `pkexec *`, `shutdown*`, `reboot*`, `poweroff*`, `halt*`, `init 0*`, `init 6*`, `mkfs*`, `systemctl reboot*`, `systemctl poweroff*`, `systemctl halt*`, `systemctl suspend*`, `systemctl hibernate*`, `env`, `/usr/bin/env`, `env -*`, `/usr/bin/env -*`, `env *=*`, `/usr/bin/env *=*`, `printenv*`, `/usr/bin/printenv*`, `set`, `export -p*`, `declare -p*`, `* .env`, `* .env *`, `*/.env`, `*/.env *`, `* .env.*`, `*/.env.*`, `cp * .env`, `cp * */.env`, `npm publish*`, `pnpm publish*`, `yarn publish*`, `bun publish*`, `cargo publish*`, `twine upload*`, `gem push*`, `dotnet nuget push*`, `rm -rf`, `rm -fr`, `rm -r`, `rm -f`, `rm -rf /*`, `rm -fr /*`, `rm -r /*`, `rm /*`, `rm /`, `rm -rf ~*`, `rm -fr ~*`, `rm -r ~*`, `rm ~*`, `rm -rf ..*`, `rm -fr ..*`, `rm -r ..*`, `rm ..*`, `rm -rf .`, `rm -fr .`, `rm -r .`, `rm .`, `rm -rf ./`, `rm -fr ./`, `rm -r ./`, `rm ./`, `rm -rf .*`, `rm -fr .*`, `rm -r .*`, `rm .*`, `rm .git*`, `rm * .git*`, `git push*`, `git commit*`, `git reset*`, `git clean*`, `git switch*`, `git checkout -b*`, `git checkout -B*`, `git checkout --orphan*`, `git stash`, `git stash push*`, `git stash save*`, `git stash pop*`, `git stash apply*`, `git stash drop*`, `git stash clear*`, `git stash branch*`, `git worktree add*`, `git worktree remove*`, `git worktree move*`, `git worktree prune*`, `git apply*`, `git branch -d*`, `git branch -D*`, `git branch -m*`, `git branch -M*`, `git branch --delete*`, `git branch --move*`, `git tag -a*`, `git tag -d*`, `git tag -f*`, `git tag -s*`, `git rebase -i*`, `git rebase --interactive*`, `git rebase -x*`, `git rebase --exec*`, `git fetch *--upload-pack*`, `git pull *--upload-pack*`, `*ext::*`, `git add .`, `git add ./`, `git add -- .`, `git add -A*`, `git add --all*`, `git add -u*`, `git add --update*`, `git add -p*`, `git add --patch*`, `git add -i*`, `git add --interactive*`

</details>

<details><summary>explorer (135 rules)</summary>

- allow: `cd *`, `git status*`, `git diff*`, `git log*`, `git show*`, `git ls-files*`, `git grep*`, `git shortlog*`, `git describe*`, `git reflog show*`, `git stash list*`, `git stash show*`, `git worktree list*`, `git tag -l*`, `git tag --list*`, `git remote -v*`, `git config --get*`, `git config --list*`, `git check-ignore*`, `git check-attr*`, `git --no-pager status*`, `git --no-pager diff*`, `git --no-pager log*`, `git --no-pager show*`, `git --no-pager blame*`, `git --no-pager branch*`, `git --no-pager grep*`, `git --no-pager ls-files*`, `git -P status*`, `git -P diff*`, `git -P log*`, `git -P show*`, `git -C * status*`, `git -C * diff*`, `git -C * log*`, `git -C * show*`, `git -C * rev-parse*`, `git rev-parse*`, `git ls-tree*`, `git cat-file*`, `git merge-base*`, `git for-each-ref*`, `git -C * ls-tree*`, `git -C * cat-file*`, `git -C * merge-base*`, `git -C * for-each-ref*`, `ls*`, `pwd`, `wc*`, `head *`, `tail *`, `cat *`, `stat *`, `file *`, `which *`, `type *`, `uname*`, `whoami`, `id`, `date*`, `rg *`, `grep *`, `egrep *`, `fgrep *`, `find *`, `fd *`, `jq *`, `yq *`, `tree*`, `du *`, `df*`, `diff *`, `sort *`, `uniq*`, `cut *`, `tr *`, `awk *`, `cat .env.example`, `cat .env.sample`, `cat .env.template`, `cat .env.test`, `head .env.example`, `head .env.sample`, `head .env.template`, `head .env.test`
- deny: `git diff *--output*`, `git log *--output*`, `git show *--output*`, `git --no-pager diff *--output*`, `git --no-pager log *--output*`, `git --no-pager show *--output*`, `git -P diff *--output*`, `git -P log *--output*`, `git -P show *--output*`, `git -C * diff *--output*`, `git -C * log *--output*`, `git -C * show *--output*`, `* > *`, `* >> *`, `*>*`, `*>>*`, `find *-exec*`, `find *-execdir*`, `find *-delete*`, `find *-ok*`, `fd *-x*`, `fd *-X*`, `fd *--exec*`, `sort *-o *`, `sort *--output*`, `sort -o*`, `sort --output=*`, `yq *-i*`, `yq *--inplace*`, `rg *--pre*`, `awk *-f*`, `awk *system*`, `awk *getline*`, `env`, `/usr/bin/env`, `env -*`, `/usr/bin/env -*`, `env *=*`, `/usr/bin/env *=*`, `printenv*`, `/usr/bin/printenv*`, `set`, `export -p*`, `declare -p*`, `* .env`, `* .env *`, `*/.env`, `*/.env *`, `* .env.*`, `*/.env.*`

</details>

<details><summary>fast-lane (157 rules)</summary>

- allow: `cat .env.example`, `cat .env.sample`, `cat .env.template`, `cat .env.test`, `head .env.example`, `head .env.sample`, `head .env.template`, `head .env.test`, `cp .env.example *`, `cp .env.sample *`, `cp .env.template *`, `cp .env.test *`
- ask: `docker push*`, `kubectl *`, `helm *`, `terraform *`, `gcloud *`, `aws *`, `az *`, `flyctl *`, `vercel *`, `wrangler deploy*`, `ssh *`, `scp *`, `sftp *`, `rsync *`, `* deploy*`, `* apply*`, `* destroy*`, `* publish*`
- deny: `sudo`, `sudo *`, `doas`, `doas *`, `su`, `su *`, `pkexec`, `pkexec *`, `shutdown*`, `reboot*`, `poweroff*`, `halt*`, `init 0*`, `init 6*`, `mkfs*`, `systemctl reboot*`, `systemctl poweroff*`, `systemctl halt*`, `systemctl suspend*`, `systemctl hibernate*`, `env`, `/usr/bin/env`, `env -*`, `/usr/bin/env -*`, `env *=*`, `/usr/bin/env *=*`, `printenv*`, `/usr/bin/printenv*`, `set`, `export -p*`, `declare -p*`, `* .env`, `* .env *`, `*/.env`, `*/.env *`, `* .env.*`, `*/.env.*`, `cp * .env`, `cp * */.env`, `npm publish*`, `pnpm publish*`, `yarn publish*`, `bun publish*`, `cargo publish*`, `twine upload*`, `gem push*`, `dotnet nuget push*`, `rm -rf`, `rm -fr`, `rm -r`, `rm -f`, `rm -rf /*`, `rm -fr /*`, `rm -r /*`, `rm /*`, `rm /`, `rm -rf ~*`, `rm -fr ~*`, `rm -r ~*`, `rm ~*`, `rm -rf ..*`, `rm -fr ..*`, `rm -r ..*`, `rm ..*`, `rm -rf .`, `rm -fr .`, `rm -r .`, `rm .`, `rm -rf ./`, `rm -fr ./`, `rm -r ./`, `rm ./`, `rm -rf .*`, `rm -fr .*`, `rm -r .*`, `rm .*`, `rm .git*`, `rm * .git*`, `git push*`, `git commit*`, `git reset*`, `git clean*`, `git switch*`, `git checkout -b*`, `git checkout -B*`, `git checkout --orphan*`, `git stash`, `git stash push*`, `git stash save*`, `git stash pop*`, `git stash apply*`, `git stash drop*`, `git stash clear*`, `git stash branch*`, `git worktree add*`, `git worktree remove*`, `git worktree move*`, `git worktree prune*`, `git apply*`, `git branch -d*`, `git branch -D*`, `git branch -m*`, `git branch -M*`, `git branch --delete*`, `git branch --move*`, `git tag -a*`, `git tag -d*`, `git tag -f*`, `git tag -s*`, `git rebase -i*`, `git rebase --interactive*`, `git rebase -x*`, `git rebase --exec*`, `git fetch *--upload-pack*`, `git pull *--upload-pack*`, `*ext::*`, `git add .`, `git add ./`, `git add -- .`, `git add -A*`, `git add --all*`, `git add -u*`, `git add --update*`, `git add -p*`, `git add --patch*`, `git add -i*`, `git add --interactive*`

</details>

<details><summary>hitl (135 rules)</summary>

- allow: `cd *`, `git status*`, `git diff*`, `git log*`, `git show*`, `git ls-files*`, `git grep*`, `git shortlog*`, `git describe*`, `git reflog show*`, `git stash list*`, `git stash show*`, `git worktree list*`, `git tag -l*`, `git tag --list*`, `git remote -v*`, `git config --get*`, `git config --list*`, `git check-ignore*`, `git check-attr*`, `git --no-pager status*`, `git --no-pager diff*`, `git --no-pager log*`, `git --no-pager show*`, `git --no-pager blame*`, `git --no-pager branch*`, `git --no-pager grep*`, `git --no-pager ls-files*`, `git -P status*`, `git -P diff*`, `git -P log*`, `git -P show*`, `git -C * status*`, `git -C * diff*`, `git -C * log*`, `git -C * show*`, `git -C * rev-parse*`, `git rev-parse*`, `git ls-tree*`, `git cat-file*`, `git merge-base*`, `git for-each-ref*`, `git -C * ls-tree*`, `git -C * cat-file*`, `git -C * merge-base*`, `git -C * for-each-ref*`, `ls*`, `pwd`, `wc*`, `head *`, `tail *`, `cat *`, `stat *`, `file *`, `which *`, `type *`, `uname*`, `whoami`, `id`, `date*`, `rg *`, `grep *`, `egrep *`, `fgrep *`, `find *`, `fd *`, `jq *`, `yq *`, `tree*`, `du *`, `df*`, `diff *`, `sort *`, `uniq*`, `cut *`, `tr *`, `awk *`, `cat .env.example`, `cat .env.sample`, `cat .env.template`, `cat .env.test`, `head .env.example`, `head .env.sample`, `head .env.template`, `head .env.test`
- deny: `git diff *--output*`, `git log *--output*`, `git show *--output*`, `git --no-pager diff *--output*`, `git --no-pager log *--output*`, `git --no-pager show *--output*`, `git -P diff *--output*`, `git -P log *--output*`, `git -P show *--output*`, `git -C * diff *--output*`, `git -C * log *--output*`, `git -C * show *--output*`, `* > *`, `* >> *`, `*>*`, `*>>*`, `find *-exec*`, `find *-execdir*`, `find *-delete*`, `find *-ok*`, `fd *-x*`, `fd *-X*`, `fd *--exec*`, `sort *-o *`, `sort *--output*`, `sort -o*`, `sort --output=*`, `yq *-i*`, `yq *--inplace*`, `rg *--pre*`, `awk *-f*`, `awk *system*`, `awk *getline*`, `env`, `/usr/bin/env`, `env -*`, `/usr/bin/env -*`, `env *=*`, `/usr/bin/env *=*`, `printenv*`, `/usr/bin/printenv*`, `set`, `export -p*`, `declare -p*`, `* .env`, `* .env *`, `*/.env`, `*/.env *`, `* .env.*`, `*/.env.*`

</details>

<details><summary>ops (142 rules)</summary>

- allow: `cat .env.example`, `cat .env.sample`, `cat .env.template`, `cat .env.test`, `head .env.example`, `head .env.sample`, `head .env.template`, `head .env.test`, `cp .env.example *`, `cp .env.sample *`, `cp .env.template *`, `cp .env.test *`
- ask: `psql *`, `mysql *`, `mongosh *`, `redis-cli *`, `rm *`, `* install*`, `* submit*`, `* push*`, `* release create*`, `* workflow run*`, `* upgrade*`, `* rollback*`, `* patch*`, `* scale*`, `* rollout*`, `telnet *`, `mosh *`, `socat *`, `nmap *`, `docker push*`, `kubectl *`, `helm *`, `terraform *`, `gcloud *`, `aws *`, `az *`, `flyctl *`, `vercel *`, `wrangler deploy*`, `ssh *`, `scp *`, `sftp *`, `rsync *`, `* deploy*`, `* apply*`, `* destroy*`, `* publish*`
- deny: `sudo`, `sudo *`, `doas`, `doas *`, `su`, `su *`, `pkexec`, `pkexec *`, `shutdown*`, `reboot*`, `poweroff*`, `halt*`, `init 0*`, `init 6*`, `mkfs*`, `systemctl reboot*`, `systemctl poweroff*`, `systemctl halt*`, `systemctl suspend*`, `systemctl hibernate*`, `env`, `/usr/bin/env`, `env -*`, `/usr/bin/env -*`, `env *=*`, `/usr/bin/env *=*`, `printenv*`, `/usr/bin/printenv*`, `set`, `export -p*`, `declare -p*`, `* .env`, `* .env *`, `*/.env`, `*/.env *`, `* .env.*`, `*/.env.*`, `cp * .env`, `cp * */.env`, `* rm *`, `* delete*`, `*--delete*`, `* prune*`, `* uninstall*`, `* down -v*`, `* terminate*`, `terraform import*`, `terraform * import*`, `kubectl edit*`, `kubectl * edit*`, `npm publish*`, `pnpm publish*`, `yarn publish*`, `bun publish*`, `cargo publish*`, `twine upload*`, `gem push*`, `dotnet nuget push*`, `rm -rf`, `rm -fr`, `rm -r`, `rm -f`, `rm -rf /*`, `rm -fr /*`, `rm -r /*`, `rm /*`, `rm /`, `rm -rf ~*`, `rm -fr ~*`, `rm -r ~*`, `rm ~*`, `rm -rf ..*`, `rm -fr ..*`, `rm -r ..*`, `rm ..*`, `rm -rf .`, `rm -fr .`, `rm -r .`, `rm .`, `rm -rf ./`, `rm -fr ./`, `rm -r ./`, `rm ./`, `rm -rf .*`, `rm -fr .*`, `rm -r .*`, `rm .*`, `rm .git*`, `rm * .git*`, `rm -rf *`, `rm -fr *`, `rm -r*`, `rm -f*`

</details>

<details><summary>post-session (128 rules)</summary>

- allow: `cd *`, `git status*`, `git diff*`, `git log*`, `git show*`, `git ls-files*`, `git grep*`, `git shortlog*`, `git describe*`, `git reflog show*`, `git stash list*`, `git stash show*`, `git worktree list*`, `git tag -l*`, `git tag --list*`, `git remote -v*`, `git config --get*`, `git config --list*`, `git check-ignore*`, `git check-attr*`, `git --no-pager status*`, `git --no-pager diff*`, `git --no-pager log*`, `git --no-pager show*`, `git --no-pager blame*`, `git --no-pager branch*`, `git --no-pager grep*`, `git --no-pager ls-files*`, `git -P status*`, `git -P diff*`, `git -P log*`, `git -P show*`, `git -C * status*`, `git -C * diff*`, `git -C * log*`, `git -C * show*`, `git -C * rev-parse*`, `git rev-parse*`, `git ls-tree*`, `git cat-file*`, `git merge-base*`, `git for-each-ref*`, `git -C * ls-tree*`, `git -C * cat-file*`, `git -C * merge-base*`, `git -C * for-each-ref*`, `git blame*`, `git branch --show-current*`, `git branch -l*`, `git branch --list*`, `git branch -a*`, `git branch --all*`, `git branch -r*`, `git branch --remotes*`, `git branch -v*`, `git branch -vv*`, `git branch --contains*`, `git branch --merged*`, `git branch --no-merged*`, `git add *`, `git rm --cached *`, `git restore --staged *`, `git restore -S *`, `git apply --cached *`, `git apply --check --cached *`, `git apply --cached --check *`, `git commit -m "*"`, `git commit -m '*'`, `cat .env.example`, `cat .env.sample`, `cat .env.template`, `cat .env.test`, `head .env.example`, `head .env.sample`, `head .env.template`, `head .env.test`, `git add .env.example`, `git add .env.sample`, `git add .env.template`, `git add .env.test`
- deny: `git diff *--output*`, `git log *--output*`, `git show *--output*`, `git --no-pager diff *--output*`, `git --no-pager log *--output*`, `git --no-pager show *--output*`, `git -P diff *--output*`, `git -P log *--output*`, `git -P show *--output*`, `git -C * diff *--output*`, `git -C * log *--output*`, `git -C * show *--output*`, `git add -A*`, `git add --all*`, `git add -u*`, `git add --update*`, `git add -p*`, `git add --patch*`, `git add -i*`, `git add --interactive*`, `git add .`, `git add ./`, `git add -- .`, `git add */`, `git add *.`, `git commit*`, `git commit -a*`, `git commit --all*`, `git commit * --amend*`, `git commit * --no-verify*`, `git commit * --all*`, `env`, `/usr/bin/env`, `env -*`, `/usr/bin/env -*`, `env *=*`, `/usr/bin/env *=*`, `printenv*`, `/usr/bin/printenv*`, `set`, `export -p*`, `declare -p*`, `* .env`, `* .env *`, `*/.env`, `*/.env *`, `* .env.*`, `*/.env.*`

</details>

<details><summary>refactorer (157 rules)</summary>

- allow: `cat .env.example`, `cat .env.sample`, `cat .env.template`, `cat .env.test`, `head .env.example`, `head .env.sample`, `head .env.template`, `head .env.test`, `cp .env.example *`, `cp .env.sample *`, `cp .env.template *`, `cp .env.test *`
- ask: `docker push*`, `kubectl *`, `helm *`, `terraform *`, `gcloud *`, `aws *`, `az *`, `flyctl *`, `vercel *`, `wrangler deploy*`, `ssh *`, `scp *`, `sftp *`, `rsync *`, `* deploy*`, `* apply*`, `* destroy*`, `* publish*`
- deny: `sudo`, `sudo *`, `doas`, `doas *`, `su`, `su *`, `pkexec`, `pkexec *`, `shutdown*`, `reboot*`, `poweroff*`, `halt*`, `init 0*`, `init 6*`, `mkfs*`, `systemctl reboot*`, `systemctl poweroff*`, `systemctl halt*`, `systemctl suspend*`, `systemctl hibernate*`, `env`, `/usr/bin/env`, `env -*`, `/usr/bin/env -*`, `env *=*`, `/usr/bin/env *=*`, `printenv*`, `/usr/bin/printenv*`, `set`, `export -p*`, `declare -p*`, `* .env`, `* .env *`, `*/.env`, `*/.env *`, `* .env.*`, `*/.env.*`, `cp * .env`, `cp * */.env`, `npm publish*`, `pnpm publish*`, `yarn publish*`, `bun publish*`, `cargo publish*`, `twine upload*`, `gem push*`, `dotnet nuget push*`, `rm -rf`, `rm -fr`, `rm -r`, `rm -f`, `rm -rf /*`, `rm -fr /*`, `rm -r /*`, `rm /*`, `rm /`, `rm -rf ~*`, `rm -fr ~*`, `rm -r ~*`, `rm ~*`, `rm -rf ..*`, `rm -fr ..*`, `rm -r ..*`, `rm ..*`, `rm -rf .`, `rm -fr .`, `rm -r .`, `rm .`, `rm -rf ./`, `rm -fr ./`, `rm -r ./`, `rm ./`, `rm -rf .*`, `rm -fr .*`, `rm -r .*`, `rm .*`, `rm .git*`, `rm * .git*`, `git push*`, `git commit*`, `git reset*`, `git clean*`, `git switch*`, `git checkout -b*`, `git checkout -B*`, `git checkout --orphan*`, `git stash`, `git stash push*`, `git stash save*`, `git stash pop*`, `git stash apply*`, `git stash drop*`, `git stash clear*`, `git stash branch*`, `git worktree add*`, `git worktree remove*`, `git worktree move*`, `git worktree prune*`, `git apply*`, `git branch -d*`, `git branch -D*`, `git branch -m*`, `git branch -M*`, `git branch --delete*`, `git branch --move*`, `git tag -a*`, `git tag -d*`, `git tag -f*`, `git tag -s*`, `git rebase -i*`, `git rebase --interactive*`, `git rebase -x*`, `git rebase --exec*`, `git fetch *--upload-pack*`, `git pull *--upload-pack*`, `*ext::*`, `git add .`, `git add ./`, `git add -- .`, `git add -A*`, `git add --all*`, `git add -u*`, `git add --update*`, `git add -p*`, `git add --patch*`, `git add -i*`, `git add --interactive*`

</details>

<details><summary>security-auditor (158 rules)</summary>

- allow: `cd *`, `git status*`, `git diff*`, `git log*`, `git show*`, `git ls-files*`, `git grep*`, `git shortlog*`, `git describe*`, `git reflog show*`, `git stash list*`, `git stash show*`, `git worktree list*`, `git tag -l*`, `git tag --list*`, `git remote -v*`, `git config --get*`, `git config --list*`, `git check-ignore*`, `git check-attr*`, `git --no-pager status*`, `git --no-pager diff*`, `git --no-pager log*`, `git --no-pager show*`, `git --no-pager blame*`, `git --no-pager branch*`, `git --no-pager grep*`, `git --no-pager ls-files*`, `git -P status*`, `git -P diff*`, `git -P log*`, `git -P show*`, `git -C * status*`, `git -C * diff*`, `git -C * log*`, `git -C * show*`, `git -C * rev-parse*`, `git rev-parse*`, `git ls-tree*`, `git cat-file*`, `git merge-base*`, `git for-each-ref*`, `git -C * ls-tree*`, `git -C * cat-file*`, `git -C * merge-base*`, `git -C * for-each-ref*`, `ls*`, `pwd`, `wc*`, `head *`, `tail *`, `cat *`, `stat *`, `file *`, `which *`, `type *`, `uname*`, `whoami`, `id`, `date*`, `rg *`, `grep *`, `egrep *`, `fgrep *`, `find *`, `fd *`, `jq *`, `yq *`, `tree*`, `du *`, `df*`, `diff *`, `sort *`, `uniq*`, `cut *`, `tr *`, `awk *`, `bandit*`, `cargo audit*`, `gitleaks*`, `govulncheck*`, `npm audit*`, `osv-scanner scan*`, `pip-audit*`, `pnpm audit*`, `semgrep scan*`, `snyk test*`, `trivy config*`, `trivy fs*`, `trivy image*`, `yarn npm audit*`, `bun audit*`, `cat .env.example`, `cat .env.sample`, `cat .env.template`, `cat .env.test`, `head .env.example`, `head .env.sample`, `head .env.template`, `head .env.test`
- deny: `git diff *--output*`, `git log *--output*`, `git show *--output*`, `git --no-pager diff *--output*`, `git --no-pager log *--output*`, `git --no-pager show *--output*`, `git -P diff *--output*`, `git -P log *--output*`, `git -P show *--output*`, `git -C * diff *--output*`, `git -C * log *--output*`, `git -C * show *--output*`, `* > *`, `* >> *`, `*>*`, `*>>*`, `find *-exec*`, `find *-execdir*`, `find *-delete*`, `find *-ok*`, `fd *-x*`, `fd *-X*`, `fd *--exec*`, `sort *-o *`, `sort *--output*`, `sort -o*`, `sort --output=*`, `yq *-i*`, `yq *--inplace*`, `rg *--pre*`, `awk *-f*`, `awk *system*`, `awk *getline*`, `trivy * --output*`, `trivy * --server*`, `trivy * --cache-dir*`, `trivy * --config*`, `npm audit --fix*`, `pnpm audit --fix*`, `yarn npm audit --fix*`, `bun audit --fix*`, `env`, `/usr/bin/env`, `env -*`, `/usr/bin/env -*`, `env *=*`, `/usr/bin/env *=*`, `printenv*`, `/usr/bin/printenv*`, `set`, `export -p*`, `declare -p*`, `* .env`, `* .env *`, `*/.env`, `*/.env *`, `* .env.*`, `*/.env.*`

</details>

<details><summary>tester (166 rules)</summary>

- allow: `cat .env.example`, `cat .env.sample`, `cat .env.template`, `cat .env.test`, `head .env.example`, `head .env.sample`, `head .env.template`, `head .env.test`, `cp .env.example *`, `cp .env.sample *`, `cp .env.template *`, `cp .env.test *`
- ask: `docker push*`, `kubectl *`, `helm *`, `terraform *`, `gcloud *`, `aws *`, `az *`, `flyctl *`, `vercel *`, `wrangler deploy*`, `ssh *`, `scp *`, `sftp *`, `rsync *`, `* deploy*`, `* apply*`, `* destroy*`, `* publish*`
- deny: `sudo`, `sudo *`, `doas`, `doas *`, `su`, `su *`, `pkexec`, `pkexec *`, `shutdown*`, `reboot*`, `poweroff*`, `halt*`, `init 0*`, `init 6*`, `mkfs*`, `systemctl reboot*`, `systemctl poweroff*`, `systemctl halt*`, `systemctl suspend*`, `systemctl hibernate*`, `env`, `/usr/bin/env`, `env -*`, `/usr/bin/env -*`, `env *=*`, `/usr/bin/env *=*`, `printenv*`, `/usr/bin/printenv*`, `set`, `export -p*`, `declare -p*`, `* .env`, `* .env *`, `*/.env`, `*/.env *`, `* .env.*`, `*/.env.*`, `cp * .env`, `cp * */.env`, `npm publish*`, `pnpm publish*`, `yarn publish*`, `bun publish*`, `cargo publish*`, `twine upload*`, `gem push*`, `dotnet nuget push*`, `rm -rf`, `rm -fr`, `rm -r`, `rm -f`, `rm -rf /*`, `rm -fr /*`, `rm -r /*`, `rm /*`, `rm /`, `rm -rf ~*`, `rm -fr ~*`, `rm -r ~*`, `rm ~*`, `rm -rf ..*`, `rm -fr ..*`, `rm -r ..*`, `rm ..*`, `rm -rf .`, `rm -fr .`, `rm -r .`, `rm .`, `rm -rf ./`, `rm -fr ./`, `rm -r ./`, `rm ./`, `rm -rf .*`, `rm -fr .*`, `rm -r .*`, `rm .*`, `rm .git*`, `rm * .git*`, `git push*`, `git commit*`, `git reset*`, `git clean*`, `git switch*`, `git checkout -b*`, `git checkout -B*`, `git checkout --orphan*`, `git stash`, `git stash push*`, `git stash save*`, `git stash pop*`, `git stash apply*`, `git stash drop*`, `git stash clear*`, `git stash branch*`, `git worktree add*`, `git worktree remove*`, `git worktree move*`, `git worktree prune*`, `git apply*`, `git branch -d*`, `git branch -D*`, `git branch -m*`, `git branch -M*`, `git branch --delete*`, `git branch --move*`, `git tag -a*`, `git tag -d*`, `git tag -f*`, `git tag -s*`, `git rebase -i*`, `git rebase --interactive*`, `git rebase -x*`, `git rebase --exec*`, `git fetch *--upload-pack*`, `git pull *--upload-pack*`, `*ext::*`, `git add .`, `git add ./`, `git add -- .`, `git add -A*`, `git add --all*`, `git add -u*`, `git add --update*`, `git add -p*`, `git add --patch*`, `git add -i*`, `git add --interactive*`, `git add*`, `git rm*`, `git mv*`, `git pull*`, `git merge*`, `git rebase*`, `git cherry-pick*`, `git checkout*`, `git restore*`

</details>

## Agents

- **chrome-devtools** (spawn as `pipeline:chrome-devtools`, safety `safe`, model: deepseek-v4-1-flash-1017): Frontend debugging and visual validation agent. Uses Chrome DevTools for performance audits, a11y testing, layout verification, and console error detection. Called in the frontend lane before and after code changes. Can start the project's service itself with dev_serve.
- **code-reviewer** (spawn as `pipeline:code-reviewer`, safety `neutral`, model: deepseek-v4-1-flash-1017): Reviews code changes for correctness, simplicity, maintainability, regressions, and security. Does not implement by default.
- **critic** (spawn as `pipeline:critic`, safety `neutral`, model: deepseek-v4-1-flash-1017): Final validation agent for complex work. Checks whether the result satisfies the original request without overengineering.
- **docs-grounding** (spawn as `pipeline:docs-grounding`, safety `safe`, model: deepseek-v4-1-flash-1017): Fetches and summarizes external library documentation to ground the planner and executor in real APIs. Does not edit files.
- **executor** (spawn as `pipeline:executor`, safety `neutral`, model: deepseek-v4-1-flash-1017): Focused implementation agent. Applies small, plan-driven code changes without expanding scope.
- **explorer** (spawn as `pipeline:explorer`, safety `neutral`, model: deepseek-v4-1-flash-1017): Fast read-only codebase explorer. Locates relevant files, patterns, tests, configs, and implementation context before planning or coding.
- **fast-lane** (spawn as `pipeline:fast-lane`, safety `neutral`, model: deepseek-v4-1-flash-1017): Fast low-cost agent for trivial or small, clear, low-risk coding tasks and obvious local bug fixes.
- **frontend-specialist** (spawn as `pipeline:frontend-specialist`, safety `safe`, model: deepseek-v4-1-flash-1017): Read-only frontend advisor used BEFORE implementation. Detects the repository's UI conventions, finds reusable components (existing, shadcn/ui, 21st.dev) and tells the executor what to build and which visual checks apply. Does not edit files or validate the result in a browser.
- **hitl** (spawn as `pipeline:hitl`, safety `neutral`, model: deepseek-v4-1-flash-1017): Human-in-the-loop checkpoint agent. Explains repository changes in plain Italian with the why, a visual Mermaid map, simple concrete examples, and essential diffs, without technical jargon. Informational and non-blocking.
- **kotlin-specialist** (spawn as `pipeline:kotlin-specialist`, safety `safe`, model: deepseek-v4-1-flash-1017): Kotlin/Android specialist. Uses Google Developer Knowledge MCP (developer.android.com docs, Jetpack guides, API reference) to validate plans and code against Android conventions and API correctness. Does not edit files.
- **multimodal** (spawn as `pipeline:multimodal`, safety `safe`, model: deepseek-v4-1-flash-1017): Handles visual inputs such as screenshots, UI mockups, diagrams, and image-based debugging before planning or implementation.
- **ops** (spawn as `pipeline:ops`, safety `neutral`, model: deepseek-v4-1-flash-1017): Operational diagnostics, runtime verification, and controlled deployment agent. Runs bash commands (gcloud, docker, kubectl, curl, etc.) for log inspection, infrastructure checks, runtime verification, and user-authorized deployments. Cannot modify repository files.
- **orchestrator** (spawn as `pipeline:orchestrator`, safety `safe`, session model): Primary coordinator for the pipeline multi-agent workflow. Assesses work size, routes to the smallest effective lane, delegates to specialized agents, and evaluates results. Never writes code or solves problems directly.
- **planner** (spawn as `pipeline:planner`, safety `safe`, session model): Creates minimal implementation plans after repository context is available. Does not edit files.
- **post-session** (spawn as `pipeline:post-session`, safety `neutral`, model: deepseek-v4-1-flash-1017): Creates final or checkpoint commits for completed pipeline work. Does not update wiki or codebase memory.
- **reasoner** (spawn as `pipeline:reasoner`, safety `safe`, session model): Deep reasoning agent for complex bugs, algorithms, architecture, performance, security, concurrency, and root-cause analysis.
- **refactorer** (spawn as `pipeline:refactorer`, safety `neutral`, model: deepseek-v4-1-flash-1017): Performs behavior-preserving simplification and cleanup. No new features, no speculative architecture.
- **researcher** (spawn as `pipeline:researcher`, safety `safe`, model: deepseek-v4-1-flash-1017): External research agent. Looks outside the repository (web, registries, changelogs, advisories) for best practices, alternatives, known issues and migration guides, and returns sourced findings. Does not explore the repo; that is the explorer's job.
- **security-auditor** (spawn as `pipeline:security-auditor`, safety `neutral`, model: deepseek-v4-1-flash-1017): Security vulnerability scanner. Reviews diffs for OWASP Top 10 and CWE patterns. Uses CWE-search MCP for classification. Does not edit files.
- **swift-specialist** (spawn as `pipeline:swift-specialist`, safety `safe`, model: deepseek-v4-1-flash-1017): Apple/Swift specialist. Uses Cupertino MCP (363K Apple docs, HIG, Swift Evolution, symbol search) and Axiom MCP (264 iOS skills, 41 agents, diagnostics tools) to validate plans and code against Apple conventions. Does not edit files.
- **tester** (spawn as `pipeline:tester`, safety `neutral`, model: deepseek-v4-1-flash-1017): Designs, writes, and evaluates tests for changed behavior. Focuses on minimal meaningful coverage and regression prevention.

## Translation warnings

- [model-map] entry "opencode-go/deepseek-v4.1-flash" matches no source agent model
- [mcp] disabled server 'XcodeBuildMCP' was emitted because translated agents require it
- [mcp] disabled server 'cupertino' was emitted because translated agents require it
- [mcp] disabled server 'bigquery' was emitted because translated agents require it
- [mcp] disabled server 'cloud-run' was emitted because translated agents require it
- [mcp] disabled server 'cloud-logging' was emitted because translated agents require it
- [mcp] disabled server 'cloud-monitoring' was emitted because translated agents require it
- [mcp] disabled server 'cloud-sql' was emitted because translated agents require it
- [mcp] disabled server 'cloud-storage' was emitted because translated agents require it
- [mcp] disabled server 'cloud-cli' was emitted because translated agents require it
- pipeline-chrome_devtools.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-chrome_devtools.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- pipeline-chrome_devtools.md: permission 'webfetch' has no per-agent Vibe equivalent; dropped
- pipeline-chrome_devtools.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-chrome_devtools.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-code_reviewer.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-code_reviewer.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- pipeline-code_reviewer.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-code_reviewer.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-critic.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-critic.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- pipeline-critic.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-critic.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-docs_grounding.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-docs_grounding.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-docs_grounding.md: permission 'webfetch' has no per-agent Vibe equivalent; dropped
- pipeline-docs_grounding.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-executor.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-executor.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-executor.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- pipeline-executor.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-explorer.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-explorer.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- pipeline-explorer.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-explorer.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-fast_lane.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-fast_lane.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-fast_lane.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- pipeline-fast_lane.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-frontend_specialist.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-frontend_specialist.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- pipeline-frontend_specialist.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-frontend_specialist.md: permission 'webfetch' has no per-agent Vibe equivalent; dropped
- pipeline-frontend_specialist.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-hitl.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-hitl.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- pipeline-hitl.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-hitl.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-kotlin_specialist.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-kotlin_specialist.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- pipeline-kotlin_specialist.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-kotlin_specialist.md: permission 'webfetch' has no per-agent Vibe equivalent; dropped
- pipeline-kotlin_specialist.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-multimodal.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-multimodal.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- pipeline-multimodal.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-multimodal.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-ops.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-ops.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-ops.md: permission 'webfetch' has no per-agent Vibe equivalent; dropped
- pipeline-ops.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- pipeline-ops.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-orchestrator.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-orchestrator.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-orchestrator.md: permission 'question' has no per-agent Vibe equivalent; dropped
- pipeline-orchestrator.md: references MCP server(s) codebase-memory-mcp; spawned Vibe subagents have no MCP or connector tools, so the main agent must gather those facts and pass them in the delegation message
- pipeline-orchestrator.md: OpenCode mode 'primary' emitted as spawnable subagent 'pipeline:orchestrator' and as main agent profile 'pipeline-orchestrator' (run it with 'vibe --agent pipeline-orchestrator'; a spawned subagent cannot delegate further)
- pipeline-orchestrator.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-planner.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-planner.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- pipeline-planner.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-planner.md: permission 'webfetch' has no per-agent Vibe equivalent; dropped
- pipeline-planner.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-post_session.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-post_session.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- pipeline-post_session.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-post_session.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-reasoner.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-reasoner.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- pipeline-reasoner.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-reasoner.md: permission 'webfetch' has no per-agent Vibe equivalent; dropped
- pipeline-reasoner.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-refactorer.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-refactorer.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-refactorer.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- pipeline-refactorer.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-researcher.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-researcher.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-researcher.md: permission 'webfetch' has no per-agent Vibe equivalent; dropped
- pipeline-researcher.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-security_auditor.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-security_auditor.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- pipeline-security_auditor.md: permission 'webfetch' has no per-agent Vibe equivalent; dropped
- pipeline-security_auditor.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-security_auditor.md: references MCP server(s) cwe-search; spawned Vibe subagents have no MCP or connector tools, so the main agent must gather those facts and pass them in the delegation message
- pipeline-security_auditor.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-swift_specialist.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-swift_specialist.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- pipeline-swift_specialist.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-swift_specialist.md: permission 'webfetch' has no per-agent Vibe equivalent; dropped
- pipeline-swift_specialist.md: references MCP server(s) cupertino; spawned Vibe subagents have no MCP or connector tools, so the main agent must gather those facts and pass them in the delegation message
- pipeline-swift_specialist.md: 'steps' has no per-agent Vibe equivalent; ignored
- pipeline-tester.md: permission 'external_directory' has no per-agent Vibe equivalent; dropped
- pipeline-tester.md: permission 'skill' has no per-agent Vibe equivalent; dropped
- pipeline-tester.md: permission 'lsp' has no per-agent Vibe equivalent; dropped
- pipeline-tester.md: 'steps' has no per-agent Vibe equivalent; ignored
- OpenCode plugin 'plugins/dev-tools' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode plugin 'plugins/doc-tools' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode plugin 'plugins/pipeline-guard' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode plugin 'plugins/pipeline-tools' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode plugin 'plugins/slide-tools' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/dev-tools/dev_env.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/dev-tools/dev_serve.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/dev-tools/dev_smoke.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/dev-tools/dev_verify.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/office-tools/doc_compile_theme.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/office-tools/doc_convert.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/office-tools/doc_create.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/office-tools/doc_list.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/office-tools/doc_modify.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/office-tools/doc_restore.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/office-tools/doc_view.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/office-tools/pptx/html2pptx.js' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/office-tools/pptx/html2pptx_runner.js' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/office-tools/slide_analyze_template.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/office-tools/slide_assemble_pptx.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/office-tools/slide_build_pptx.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/office-tools/slide_compile_composition.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/office-tools/slide_compile_theme.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/office-tools/slide_create_thumbnails.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/office-tools/slide_download_image.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/office-tools/slide_generate_image.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/office-tools/slide_screenshot.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/pipeline/pipeline_commit.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- OpenCode tool 'tools/pipeline/pipeline_state.ts' is not transpiled; see the README section 'OpenCode plugins and tools'
- [commands] 'pipeline-bug': converted 0 !-substitution(s) to inline instructions
- [commands] 'pipeline-feature': converted 0 !-substitution(s) to inline instructions
- [commands] 'pipeline-init': converted 0 !-substitution(s) to inline instructions
- [commands] 'pipeline-ops': converted 0 !-substitution(s) to inline instructions
- [commands] 'pipeline-refactor': converted 0 !-substitution(s) to inline instructions
- [commands] 'pipeline-research': converted 0 !-substitution(s) to inline instructions
