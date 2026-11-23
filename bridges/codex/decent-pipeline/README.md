# decent-pipeline

This directory is a generated translation layer from the canonical source agents. Source agents are unchanged.

> **Generated output.** Do not edit this directory directly. Change the pack's agents or `bridges/translation-config.json`, then regenerate with the manager.

## Source and configuration

Agent prompts come from the bridged pack. Translation roles, tiers, model overrides, prefix, and output options come from `bridges/translation-config.json`; MCP declarations are merged from the `opencode.json` of the pack and the packs it requires.

## Run in Codex

From this directory, run `codex` and trust the project to load its local configuration, or open this directory in the Codex app.
Ask Codex to delegate the task to the `orchestrator` subagent.

- `.codex/agents/` contains project-scoped subagent definitions.
- `.codex/config.toml` configures MCP for the project. Run `codex mcp list` here to inspect it.
- `.agents/skills/` contains the pack skills, their supporting files and any translated agent prompts.

## Install the plugin separately

To use the plugin's packaged skills or MCP servers in other projects, run these commands from this directory:

```sh
codex plugin marketplace add .
codex plugin add decent-pipeline@decent-pipeline-local
```

Custom subagents are project-scoped. To use them in another project, copy the relevant TOML files from `.codex/agents/` into that project's `.codex/agents/`.

OpenCode tool names in prompts are translated where Codex has an equivalent (`todowrite` → `update_plan`). Prompts that rely on custom tools shipped by the pack start with a runtime note saying they are unavailable here and that the documented fallbacks apply.

## MCP setup

`npx` servers are fetched on first use. Binary servers must already be available on `PATH`.

- `codebase-memory-mcp` needs this setup. Make `codebase-memory-mcp` available on `PATH`.
- `chrome-devtools` needs this setup. Runs as `npx -y chrome-devtools-mcp@latest` (Node.js, npm, and network required).
- `XcodeBuildMCP` needs this setup. Runs as `npx -y xcodebuildmcp@latest mcp` (Node.js, npm, and network required).
- `shadcn` needs this setup. Runs as `npx -y shadcn@latest mcp` (Node.js, npm, and network required).
- `magic` needs this setup. Runs as `npx -y @21st-dev/magic@latest` (Node.js, npm, and network required), with `API_KEY` exported before launch.
- `cupertino` needs this setup. Make `cupertino` available on `PATH`.
- `axiom` needs this setup. Runs as `npx -y axiom-mcp` (Node.js, npm, and network required).
- `cwe-search` needs this setup. Runs as `npx -y @cyanheads/mitre-cwe-mcp-server@0.3.0` (Node.js, npm, and network required).
- `bigquery` needs this setup. Verify connectivity and authentication for `https://bigquery.googleapis.com/mcp`.
- `cloud-run` needs this setup. Verify connectivity and authentication for `https://run.googleapis.com/mcp`.
- `cloud-logging` needs this setup. Verify connectivity and authentication for `https://logging.googleapis.com/mcp`.
- `cloud-monitoring` needs this setup. Verify connectivity and authentication for `https://monitoring.googleapis.com/mcp`.
- `cloud-sql` needs this setup. Verify connectivity and authentication for `https://sqladmin.googleapis.com/mcp`.
- `cloud-storage` needs this setup. Verify connectivity and authentication for `https://storage.googleapis.com/storage/mcp`.
- `cloud-cli` needs this setup. Verify connectivity and authentication for `https://cloudcli.googleapis.com/mcp`.

Verify the resulting connections from Codex before invoking MCP-dependent agents.

## Per-agent bash allowlists (not enforced)

Codex agent files set only `sandbox_mode`: agents whose OpenCode `bash` or `edit` permission allows anything get `workspace-write`, the others `read-only`. Codex has no per-agent command allowlist; command rules are global. The source rules are listed here for review.

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

## Translation warnings

- [mcp] tool denies for 'codebase-memory-mcp' apply to the entire Codex session
- [mcp] disabled server 'XcodeBuildMCP' was emitted because translated agents require it
- [mcp] 'magic' requires 'API_KEY' to be exported with the value configured in OpenCode before launching Codex
- [mcp] disabled server 'cupertino' was emitted because translated agents require it
- [mcp] disabled server 'bigquery' was emitted because translated agents require it
- [mcp] tool denies for 'bigquery' apply to the entire Codex session
- [mcp] disabled server 'cloud-run' was emitted because translated agents require it
- [mcp] tool denies for 'cloud-run' apply to the entire Codex session
- [mcp] disabled server 'cloud-logging' was emitted because translated agents require it
- [mcp] disabled server 'cloud-monitoring' was emitted because translated agents require it
- [mcp] disabled server 'cloud-sql' was emitted because translated agents require it
- [mcp] tool denies for 'cloud-sql' apply to the entire Codex session
- [mcp] disabled server 'cloud-storage' was emitted because translated agents require it
- [mcp] tool denies for 'cloud-storage' apply to the entire Codex session
- [mcp] disabled server 'cloud-cli' was emitted because translated agents require it
- [skills] exported the chrome-devtools agent prompt as chrome-devtools-agent to preserve the source skill
- [pipeline-chrome_devtools.md] model assignment source: default
- [pipeline-frontend_specialist.md] model assignment source: default
- [pipeline-hitl.md] model assignment source: default
- [pipeline-kotlin_specialist.md] model assignment source: default
- [pipeline-multimodal.md] model assignment source: default
- [pipeline-ops.md] model assignment source: default
- [pipeline-post_session.md] model assignment source: default
- [pipeline-security_auditor.md] model assignment source: default
- [pipeline-swift_specialist.md] model assignment source: default
