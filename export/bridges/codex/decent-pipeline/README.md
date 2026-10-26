# decent-pipeline

This directory is a generated translation layer from the canonical source agents. Source agents are unchanged.

> **Generated output.** Do not edit this directory directly. Change canonical agents or `.agent-manager/translation-config.json`, then regenerate with the manager.

## Source and configuration

Agent prompts are discovered under `src/`. Translation roles, tiers, model overrides, prefix, and output options come from `.agent-manager/translation-config.json`; MCP declarations come from `src/opencode.json` (legacy fallback `general/opencode.json`).

## Contents

- `.codex-plugin/plugin.json` — Codex plugin manifest.
- `.mcp.json` — enabled MCP servers plus servers explicitly required by translated agents.
- `.codex/agents/` — project-scoped Codex subagent definitions.
- `skills/` — plugin skills containing translated instructions.
- `README.md` — this generated inventory and setup guide.

Note: custom prompts in `~/.codex/prompts` are deprecated; prefer skills such as the ones generated here.

OpenCode tool names in prompts are translated where Codex has an equivalent (`todowrite` → `update_plan`). Prompts that rely on OpenCode-only tools (`pipeline_*`) start with a runtime note saying they are unavailable here and that the documented fallbacks apply.

## MCP setup

`npx` servers are fetched on first use. Binary servers must already be available on `PATH`.

- `chrome-devtools`: runs as `npx -y chrome-devtools-mcp@latest` (Node.js, npm, and network required).
- `codebase-memory-mcp`: install `codebase-memory-mcp` and verify with `command -v codebase-memory-mcp`; see https://github.com/DeusData/codebase-memory-mcp#quick-start.
- `XcodeBuildMCP`: runs as `npx -y xcodebuildmcp@latest mcp` (Node.js, npm, and network required).
- `shadcn`: runs as `npx -y shadcn@latest mcp` (Node.js, npm, and network required).
- `magic`: runs as `npx -y @21st-dev/magic@latest` (Node.js, npm, and network required); set `TWENTYFIRST_API_KEY`.
- `cupertino`: install `cupertino` and verify with `command -v cupertino`; see https://aleahim.com/blog/cupertino-09-release/.
- `axiom`: runs as `npx -y axiom-mcp` (Node.js, npm, and network required).
- `cwe-search`: runs as `npx -y cwe-search-mcp@latest` (Node.js, npm, and network required).

Verify the resulting connections from Codex before invoking MCP-dependent agents.

## Per-agent bash allowlists (not enforced)

Codex agent files set only `sandbox_mode`: agents whose OpenCode `bash` or `edit` permission allows anything get `workspace-write`, the others `read-only`. Codex has no per-agent command allowlist; command rules are global. The source rules are listed here for review.

<details><summary>code-reviewer (10 rules)</summary>

- allow: `cd *`, `git status*`, `git diff*`, `git log*`, `git show*`, `git blame*`, `git rev-parse*`, `git merge-base*`, `git branch --show-current*`
- deny: `git diff *--output*`

</details>

<details><summary>critic (10 rules)</summary>

- allow: `cd *`, `git status*`, `git diff*`, `git log*`, `git show*`, `git blame*`, `git rev-parse*`, `git merge-base*`, `git branch --show-current*`
- deny: `git diff *--output*`

</details>

<details><summary>executor (93 rules)</summary>

- allow: `cd *`, `node *`, `npm *`, `npx *`, `pnpm *`, `yarn *`, `bun *`, `deno *`, `python *`, `python3 *`, `pytest*`, `uv *`, `poetry *`, `pip *`, `pip3 *`, `go *`, `cargo *`, `rustc *`, `make*`, `cmake *`, `gradle *`, `./gradlew*`, `mvn *`, `./mvnw*`, `dotnet *`, `bundle *`, `rake*`, `rspec*`, `composer *`, `php *`, `swift *`, `xcodebuild *`, `xcrun *`, `mkdir -p *`, `cp *`, `mv *`, `git status*`, `git diff*`, `git log*`, `git show*`, `git rev-parse*`, `git merge-base*`, `git branch --show-current*`, `git fetch*`, `git pull*`, `git merge*`, `git rebase*`, `git cherry-pick*`, `git checkout --ours *`, `git checkout --theirs *`, `git restore --staged *`, `git restore --ours *`, `git restore --theirs *`, `git restore --merge *`, `git add *`
- ask: `rm *`
- deny: `git diff *--output*`, `git fetch *--upload-pack*`, `git fetch *ext::*`, `git pull *--upload-pack*`, `git pull *ext::*`, `git rebase *-i*`, `git rebase *--interactive*`, `git rebase *-x*`, `git rebase *--exec*`, `git add .`, `git add ./`, `git add -A*`, `git add --all*`, `git add -u*`, `git add --update*`, `npm publish*`, `pnpm publish*`, `yarn publish*`, `bun publish*`, `cargo publish*`, `twine upload*`, `rm -r*`, `rm -f*`, `rm -rf /*`, `rm -fr /*`, `rm -rf ~*`, `rm -fr ~*`, `rm -rf ..*`, `rm -fr ..*`, `rm -rf .`, `rm -fr .`, `rm -rf *`, `rm -fr *`, `rm * -r*`, `rm * -f*`, `rm --recursive*`, `rm * --recursive*`

</details>

<details><summary>explorer (10 rules)</summary>

- allow: `cd *`, `git status*`, `git diff*`, `git log*`, `git show*`, `git blame*`, `git rev-parse*`, `git merge-base*`, `git branch --show-current*`
- deny: `git diff *--output*`

</details>

<details><summary>fast-lane (93 rules)</summary>

- allow: `cd *`, `node *`, `npm *`, `npx *`, `pnpm *`, `yarn *`, `bun *`, `deno *`, `python *`, `python3 *`, `pytest*`, `uv *`, `poetry *`, `pip *`, `pip3 *`, `go *`, `cargo *`, `rustc *`, `make*`, `cmake *`, `gradle *`, `./gradlew*`, `mvn *`, `./mvnw*`, `dotnet *`, `bundle *`, `rake*`, `rspec*`, `composer *`, `php *`, `swift *`, `xcodebuild *`, `xcrun *`, `mkdir -p *`, `cp *`, `mv *`, `git status*`, `git diff*`, `git log*`, `git show*`, `git rev-parse*`, `git merge-base*`, `git branch --show-current*`, `git fetch*`, `git pull*`, `git merge*`, `git rebase*`, `git cherry-pick*`, `git checkout --ours *`, `git checkout --theirs *`, `git restore --staged *`, `git restore --ours *`, `git restore --theirs *`, `git restore --merge *`, `git add *`
- ask: `rm *`
- deny: `git diff *--output*`, `git fetch *--upload-pack*`, `git fetch *ext::*`, `git pull *--upload-pack*`, `git pull *ext::*`, `git rebase *-i*`, `git rebase *--interactive*`, `git rebase *-x*`, `git rebase *--exec*`, `git add .`, `git add ./`, `git add -A*`, `git add --all*`, `git add -u*`, `git add --update*`, `npm publish*`, `pnpm publish*`, `yarn publish*`, `bun publish*`, `cargo publish*`, `twine upload*`, `rm -r*`, `rm -f*`, `rm -rf /*`, `rm -fr /*`, `rm -rf ~*`, `rm -fr ~*`, `rm -rf ..*`, `rm -fr ..*`, `rm -rf .`, `rm -fr .`, `rm -rf *`, `rm -fr *`, `rm * -r*`, `rm * -f*`, `rm --recursive*`, `rm * --recursive*`

</details>

<details><summary>hitl (10 rules)</summary>

- allow: `cd *`, `git status*`, `git diff*`, `git log*`, `git show*`, `git blame*`, `git rev-parse*`, `git merge-base*`, `git branch --show-current*`
- deny: `git diff *--output*`

</details>

<details><summary>ops (85 rules)</summary>

- allow: `cat .env.example`, `cat .env.sample`
- ask: `sudo *`, `psql *`, `mysql *`, `mongosh *`, `redis-cli *`, `rm *`, `* install*`, `* deploy*`, `* apply*`, `* submit*`, `* push*`, `* release create*`, `* workflow run*`, `* upgrade*`, `* rollback*`, `* patch*`, `* scale*`, `* rollout*`, `vercel *`, `ssh *`, `scp *`, `sftp *`, `rsync *`, `telnet *`, `mosh *`, `socat *`, `nmap *`
- deny: `env`, `env *`, `printenv*`, `*.env*`, `* rm *`, `* delete*`, `*--delete*`, `* destroy*`, `* prune*`, `* uninstall*`, `* down -v*`, `* terminate*`, `terraform import*`, `terraform * import*`, `kubectl edit*`, `kubectl * edit*`, `set`, `export -p*`, `declare -p*`, `/usr/bin/env*`, `/usr/bin/printenv*`, `shutdown*`, `sudo shutdown*`, `reboot*`, `poweroff*`, `halt*`, `init 0*`, `init 6*`, `mkfs*`, `systemctl reboot*`, `systemctl poweroff*`, `systemctl halt*`, `systemctl suspend*`, `systemctl hibernate*`, `npm publish*`, `pnpm publish*`, `yarn publish*`, `bun publish*`, `cargo publish*`, `twine upload*`, `rm -r*`, `rm -f*`, `rm -rf /*`, `rm -fr /*`, `rm -rf ~*`, `rm -fr ~*`, `rm -rf ..*`, `rm -fr ..*`, `rm -rf .`, `rm -fr .`, `rm -rf *`, `rm -fr *`, `rm * -r*`, `rm * -f*`, `rm --recursive*`, `rm * --recursive*`

</details>

<details><summary>post-session (30 rules)</summary>

- allow: `cd *`, `git status*`, `git diff*`, `git log*`, `git show*`, `git rev-parse*`, `git branch --show-current*`, `git restore --staged *`, `git add *`, `git commit -m *`
- ask: `git push*`
- deny: `git diff *--output*`, `git add -A*`, `git add --all*`, `git add -u*`, `git add --update*`, `git add -p*`, `git add --patch*`, `git add -i*`, `git add --interactive*`, `git add .`, `git add ./`, `git add -- .`, `git add */`, `git add *.`, `git commit -a*`, `git commit --all*`, `git commit * --amend*`, `git commit * --no-verify*`, `git commit * --all*`

</details>

<details><summary>refactorer (93 rules)</summary>

- allow: `cd *`, `node *`, `npm *`, `npx *`, `pnpm *`, `yarn *`, `bun *`, `deno *`, `python *`, `python3 *`, `pytest*`, `uv *`, `poetry *`, `pip *`, `pip3 *`, `go *`, `cargo *`, `rustc *`, `make*`, `cmake *`, `gradle *`, `./gradlew*`, `mvn *`, `./mvnw*`, `dotnet *`, `bundle *`, `rake*`, `rspec*`, `composer *`, `php *`, `swift *`, `xcodebuild *`, `xcrun *`, `mkdir -p *`, `cp *`, `mv *`, `git status*`, `git diff*`, `git log*`, `git show*`, `git rev-parse*`, `git merge-base*`, `git branch --show-current*`, `git fetch*`, `git pull*`, `git merge*`, `git rebase*`, `git cherry-pick*`, `git checkout --ours *`, `git checkout --theirs *`, `git restore --staged *`, `git restore --ours *`, `git restore --theirs *`, `git restore --merge *`, `git add *`
- ask: `rm *`
- deny: `git diff *--output*`, `git fetch *--upload-pack*`, `git fetch *ext::*`, `git pull *--upload-pack*`, `git pull *ext::*`, `git rebase *-i*`, `git rebase *--interactive*`, `git rebase *-x*`, `git rebase *--exec*`, `git add .`, `git add ./`, `git add -A*`, `git add --all*`, `git add -u*`, `git add --update*`, `npm publish*`, `pnpm publish*`, `yarn publish*`, `bun publish*`, `cargo publish*`, `twine upload*`, `rm -r*`, `rm -f*`, `rm -rf /*`, `rm -fr /*`, `rm -rf ~*`, `rm -fr ~*`, `rm -rf ..*`, `rm -fr ..*`, `rm -rf .`, `rm -fr .`, `rm -rf *`, `rm -fr *`, `rm * -r*`, `rm * -f*`, `rm --recursive*`, `rm * --recursive*`

</details>

<details><summary>security-auditor (24 rules)</summary>

- allow: `cd *`, `git status*`, `git diff*`, `git log*`, `git show*`, `git blame*`, `git rev-parse*`, `git merge-base*`, `git branch --show-current*`, `npm audit*`, `pnpm audit*`, `yarn audit*`, `bun audit*`, `pip-audit*`, `cargo audit*`, `govulncheck*`, `gosec*`, `semgrep*`, `trivy*`, `bandit*`, `osv-scanner*`, `hadolint*`, `shellcheck*`
- deny: `git diff *--output*`

</details>

<details><summary>tester (61 rules)</summary>

- allow: `cd *`, `node *`, `npm *`, `npx *`, `pnpm *`, `yarn *`, `bun *`, `deno *`, `python *`, `python3 *`, `pytest*`, `uv *`, `poetry *`, `pip *`, `pip3 *`, `go *`, `cargo *`, `rustc *`, `make*`, `cmake *`, `gradle *`, `./gradlew*`, `mvn *`, `./mvnw*`, `dotnet *`, `bundle *`, `rake*`, `rspec*`, `composer *`, `php *`, `swift *`, `xcodebuild *`, `xcrun *`, `mkdir -p *`, `cp *`, `mv *`, `git status*`, `git diff*`, `git log*`, `git show*`, `git rev-parse*`, `git merge-base*`, `git branch --show-current*`
- ask: `rm *`
- deny: `git diff *--output*`, `rm -r*`, `rm -f*`, `rm -rf /*`, `rm -fr /*`, `rm -rf ~*`, `rm -fr ~*`, `rm -rf ..*`, `rm -fr ..*`, `rm -rf .`, `rm -fr .`, `rm -rf *`, `rm -fr *`, `rm * -r*`, `rm * -f*`, `rm --recursive*`, `rm * --recursive*`

</details>

Primary agent: @orchestrator
