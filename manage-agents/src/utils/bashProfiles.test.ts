import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import YAML from "yaml"
import { extractFrontmatter } from "./agents.js"
import {
  bashRulesOf, checkAgentsAgainstBashProfiles, diffBashRules, evaluateAgentBash, evaluateBashCommand, expandBashRole,
  loadBashProfiles, matchBashRule, replaceBashBlock, splitCompoundCommand, syncBashProfiles, validateBashProfiles,
  type BashAction, type BashProfilesConfig, type BashRule
} from "./bashProfiles.js"
import { refreshStampedPipelinesFromSource } from "./pipelineProfiles.js"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const AGENTS_DIR = path.join(REPO, "src", "agents")

function frontmatterOf(role: string): Record<string, any> {
  const { yamlText } = extractFrontmatter(fs.readFileSync(path.join(AGENTS_DIR, `pipeline-${role}.md`), "utf8"))
  return YAML.parse(yamlText!)
}

function bodyOf(file: string): string {
  return extractFrontmatter(fs.readFileSync(path.join(AGENTS_DIR, file), "utf8")).body
}

// --- Matcher ---

test("matcher: globs, last match wins, default deny", () => {
  const rules: BashRule[] = [["*", "deny"], ["git *", "allow"], ["git push*", "ask"], ["git push --force*", "deny"], ["ls ?", "allow"]]
  assert.equal(matchBashRule(rules, "git status"), "allow")
  assert.equal(matchBashRule(rules, "git push origin"), "ask")
  assert.equal(matchBashRule(rules, "git push --force-with-lease"), "deny")
  assert.equal(matchBashRule(rules, "ls a"), "allow")
  assert.equal(matchBashRule(rules, "ls ab"), "deny")
  assert.equal(matchBashRule([["git status*", "allow"]], "npm test"), "deny")
  assert.equal(matchBashRule([["pytest*", "allow"]], "pytest"), "allow", "* matches the empty string")
  assert.equal(matchBashRule([["a.b", "allow"]], "aXb"), "deny", "other characters are literal")
})

test("matcher: compound commands need every part allowed; assignments stay in the part", () => {
  assert.deepEqual(splitCompoundCommand(`cd a && npm test || echo "x && y"; ls | wc -l`), ["cd a", "npm test", `echo "x && y"`, "ls", "wc -l"])
  const rules: BashRule[] = [["*", "deny"], ["cd *", "allow"], ["npm *", "allow"], ["rm *", "ask"]]
  assert.equal(evaluateBashCommand(rules, "cd a && npm test"), "allow")
  assert.equal(evaluateBashCommand(rules, "cd a && rm b"), "ask")
  assert.equal(evaluateBashCommand(rules, "cd a && rm b; curl x"), "deny")
  assert.equal(evaluateBashCommand(rules, "NODE_ENV=test npm test"), "deny", "leading assignments are part of the matched text")
})

// --- Profiles reproduce the canonical agents ---

const config = loadBashProfiles(REPO)!

test("bash-profiles.json is valid and every canonical bash rule block equals its role expansion", () => {
  assert.ok(config, "missing .agent-manager/bash-profiles.json")
  const files = fs.readdirSync(AGENTS_DIR).filter(file => /^pipeline-.*\.md$/.test(file))
  let profiled = 0
  for (const file of files) {
    const role = file.replace(/^pipeline-|\.md$/g, "")
    const rules = bashRulesOf(frontmatterOf(role))
    const expected = expandBashRole(config, role)
    if (Array.isArray(rules)) {
      assert.ok(expected, `${file} has a bash rule block but role '${role}' has no profile`)
      assert.deepEqual(rules, expected, `${file}\n${diffBashRules(rules, expected!).join("\n")}`)
      profiled++
    } else {
      assert.equal(expected, null, `${file} has bash: ${rules} but role '${role}' is profiled`)
    }
  }
  assert.ok(profiled >= 11)
  assert.deepEqual(syncBashProfiles(REPO, { dryRun: true }).changed, [], "pipeline sync-bash must be a no-op")
})

test("shell utility and environment-template profiles respect role boundaries", () => {
  const readOnlyRoles = ["explorer", "code_reviewer", "critic", "hitl", "security_auditor"]
  const writerRoles = ["executor", "fast_lane", "refactorer", "tester"]
  const evaluate = (role: string, command: string) => evaluateBashCommand(expandBashRole(config, role)!, command)

  for (const role of readOnlyRoles) {
    const stack = config.roles[role]
    assert.ok(stack.includes("shell-read"), `${role} should have shell-read`)
    assert.equal(stack[stack.indexOf("shell-read") + 1], "shell-read-guard", `${role} should apply shell-read-guard immediately after shell-read`)
    assert.ok(!stack.includes("shell-build-utils"), `${role} must not have shell-build-utils`)
    assert.ok(!stack.includes("secrets-copy"), `${role} must not have secrets-copy`)
    assert.equal(evaluate(role, "cat README.md"), "allow")
    assert.equal(evaluate(role, "find . -delete"), "deny")
    assert.equal(evaluate(role, "find -delete"), "deny")
    assert.equal(evaluate(role, "find src -delete"), "deny")
    assert.equal(evaluate(role, "find -exec sh -c 'rm a.txt' {}"), "deny")
    assert.equal(evaluate(role, "fd . -x cat"), "deny")
    assert.equal(evaluate(role, "fd -x rm"), "deny")
    assert.equal(evaluate(role, "fd src -x rm"), "deny")
    assert.equal(evaluate(role, "fd --exec rm"), "deny")
    assert.equal(evaluate(role, "sed -i 's/a/b/' file.txt"), "deny")
    assert.equal(evaluate(role, "sort -o output.txt input.txt"), "deny")
    assert.equal(evaluate(role, "awk '{print}' file.txt"), "deny")
    assert.equal(evaluate(role, "curl https://example.test"), "deny")
    assert.equal(evaluate(role, "cp .env.example .env"), "deny")
  }

  for (const role of writerRoles) {
    const stack = config.roles[role]
    assert.ok(stack.includes("shell-read"), `${role} should have shell-read`)
    assert.ok(stack.includes("shell-build-utils"), `${role} should have shell-build-utils`)
    assert.ok(!stack.includes("shell-read-guard"), `${role} should not have the read-only shell guard`)
    assert.equal(stack[stack.indexOf("secrets-guard") + 1], "secrets-copy", `${role} should apply secrets-copy after secrets-guard`)
    for (const command of [
      "awk '{print}' file.txt", "perl -ne 'print' file.txt", "yq . file.yaml", "patch -p1", "xargs echo",
      "tee output.txt", "sleep 1", "timeout 1 command", "gtimeout 1 command", "time command", "tar -tf archive.tar",
      "unzip -l archive.zip", "zip archive.zip file.txt", "gzip file.txt", "gunzip file.txt.gz", "curl https://example.test",
      "cp .env.example .env", "cp .env.sample .env", "cp .env.template .env", "cp .env.test .env",
    ]) {
      assert.equal(evaluate(role, command), "allow", `${role}: ${command}`)
    }
  }

  for (const role of ["ops", "post_session"]) {
    assert.ok(!config.roles[role].includes("shell-build-utils"), `${role} must not have shell-build-utils`)
  }
  assert.ok(!config.roles.post_session.includes("secrets-copy"))
  assert.equal(evaluateBashCommand(expandBashRole(config, "post_session")!, "cp .env.example .env"), "deny")
})

test("validation rejects unknown profiles, bad actions, and duplicated patterns", () => {
  const base = { version: 1, profiles: { a: { rules: [["x *", "allow"]] }, b: { rules: [["x *", "deny"]] } }, roles: { r: ["a"] } }
  validateBashProfiles(base)
  assert.throws(() => validateBashProfiles({ ...base, roles: { r: ["missing"] } }), /unknown profile/)
  assert.throws(() => validateBashProfiles({ ...base, profiles: { a: { rules: [["x", "maybe"]] } } }), /invalid rule/)
  assert.throws(() => validateBashProfiles({ ...base, roles: { r: ["a", "b"] } }), /twice/)
})

// --- Rewriting touches only the bash block ---

const SAMPLE = `---
description: Sample agent with a long description that wraps
  onto a second line.
mode: subagent
permission:
  "*": deny
  # keep this comment
  edit: allow
  bash:
    "*": deny
    "git add .*": deny
    "npm *": allow
  webfetch: deny
temperature: 1
---

# Body

Run \`npm test\`.
`

test("replaceBashBlock rewrites only the bash lines and round-trips through YAML", () => {
  const rules: BashRule[] = [["*", "deny"], ["cd *", "allow"], ["git add *", "allow"], ["git add .", "deny"]]
  const next = replaceBashBlock(SAMPLE, rules)!
  const before = SAMPLE.split("\n"), after = next.split("\n")
  assert.deepEqual(after.slice(0, 9), before.slice(0, 9))
  assert.deepEqual(after.slice(9 + rules.length), before.slice(9 + 3))
  const parsed = YAML.parse(extractFrontmatter(next).yamlText!)
  assert.deepEqual(bashRulesOf(parsed), rules)
  assert.equal(parsed.permission.webfetch, "deny")
  assert.equal(parsed.temperature, 1)
  assert.equal(replaceBashBlock(next, rules), next, "idempotent")
  assert.equal(replaceBashBlock(SAMPLE.replace(/  bash:\n(?:    .*\n)+/, "  bash: deny\n"), rules), null, "scalar bash is left alone")
})

function syncWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bash-profiles-"))
  fs.mkdirSync(path.join(root, "src", "agents"), { recursive: true })
  fs.mkdirSync(path.join(root, ".agent-manager"), { recursive: true })
  const profiles: BashProfilesConfig = {
    version: 1,
    profiles: { base: { rules: [["*", "deny"], ["cd *", "allow"]] }, stage: { rules: [["git add *", "allow"], ["git add .", "deny"]] } },
    roles: { executor: ["base", "stage"] }
  }
  fs.writeFileSync(path.join(root, ".agent-manager", "bash-profiles.json"), JSON.stringify(profiles, null, 2))
  fs.writeFileSync(path.join(root, "src", "agents", "pipeline-executor.md"), SAMPLE)
  fs.writeFileSync(path.join(root, "src", "agents", "pipeline-planner.md"), SAMPLE.replace(/  bash:\n(?:    .*\n)+/, "  bash: deny\n"))
  return root
}

test("syncBashProfiles rewrites drifted agents, skips unprofiled ones, and is then a no-op", () => {
  const root = syncWorkspace()
  const executor = path.join(root, "src", "agents", "pipeline-executor.md")
  const config = loadBashProfiles(root)!
  const drift = checkAgentsAgainstBashProfiles(config, [{ filename: "pipeline-executor.md", currentPath: executor, frontmatter: YAML.parse(extractFrontmatter(SAMPLE).yamlText!) } as any], root)
  assert.equal(drift.length, 1)
  assert.deepEqual([...drift[0].diff].sort(), ['+ "cd *": allow', '+ "git add *": allow', '+ "git add .": deny', '- "git add .*": deny', '- "npm *": allow'])

  const dry = syncBashProfiles(root, { dryRun: true })
  assert.deepEqual(dry.changed, ["src/agents/pipeline-executor.md"])
  assert.equal(fs.readFileSync(executor, "utf8"), SAMPLE, "dry run writes nothing")
  const applied = syncBashProfiles(root)
  assert.deepEqual(applied.changed, ["src/agents/pipeline-executor.md"])
  assert.deepEqual(applied.skipped, ["src/agents/pipeline-planner.md"])
  assert.match(fs.readFileSync(executor, "utf8"), /  # keep this comment\n/)
  assert.deepEqual(syncBashProfiles(root).changed, [])
})

test("refresh replaces a stamped bash block instead of merging stale rules into it", () => {
  const root = syncWorkspace()
  syncBashProfiles(root)
  const stamped = path.join(root, "export", "categories", "go-pipeline", "agents", "go-pipeline-executor.md")
  fs.mkdirSync(path.dirname(stamped), { recursive: true })
  fs.writeFileSync(stamped, SAMPLE.replace("description: Sample", "model: go/model\ndescription: Sample"))
  refreshStampedPipelinesFromSource(root, "go-pipeline")
  const parsed = YAML.parse(extractFrontmatter(fs.readFileSync(stamped, "utf8")).yamlText!)
  assert.deepEqual(bashRulesOf(parsed), expandBashRole(loadBashProfiles(root)!, "executor"))
})

// --- Fixtures: exact expected actions against the current agent files ---

const FIXTURES: Record<string, Partial<Record<BashAction, string[]>>> = {
  tester: {
    allow: ["pytest -q", "npm test", "mkdir -p tmp/out", "mkdir tmp/out", "rmdir tmp/out", "touch tmp/a.txt", "rm tmp/a.txt", "rm -f tmp/a.txt", "rm -rf build", "ls -la", "rg foo src/", "cat README.md | head -n 5", ".venv/bin/pytest", "npx tsc --noEmit", "NODE_ENV=test npm test", "cat .env.example"],
    deny: ["rm -rf .", "rm -rf ./", "rm -rf /*", "rm -rf ~", "rm -rf ..", "rm -rf .git", "cat .env", "cat .env .env.example", "env", "printenv", "git commit -m x", "git push", "npm publish"]
  },
  writer: {
    allow: ["npm run build", "git fetch origin", "git pull --rebase", "git add src/index.ts", "git mv src/a.ts src/b.ts", "git rm src/old.ts", "git rm -r src/old_dir", "mkdir src/new_dir", "rm src/old.ts", "rm -f src/old.ts", "rm -rf dist", "ls -la", "rg pattern src/", "cat .env.example", "cp .env.example .env"],
    deny: ["git add .", "git add -A", "git add -u", "git rm -r .", "git rm -rf .", "rm -rf .", "rm -rf /*", "rm -rf ~", "rm -rf ..", "cat .env", "cat .env .env.example", "env", "git rebase -i HEAD~2", "git fetch --upload-pack=evil", "npm publish", "twine upload dist/*", "git commit -m x"]
  },
  post_session: {
    allow: ["git status", "git add src/a.ts", "git restore --staged src/a.ts", "git rm --cached src/a.ts", `git commit -m "chore: x"`],
    deny: ["git add .", "git add -A", "git add -p", "git commit -a -m x", "git commit --amend", "git commit -m x --no-verify", "git commit -m x", "npm test", "cat .env", "env"],
    ask: ["git push origin main"]
  },
  ops: {
    allow: ["which psql", "pg_isready -h 127.0.0.1 -p 5432", "ls /var/run/docker.sock", "docker compose up -d db", "curl --retry 10 --retry-connrefused -fsS http://127.0.0.1:8000/health", "cat .env.example", "cat .env.sample", "cp .env.example .env", "cp .env.test .env", "tail -n 50 log.txt", "uname -a", "docker ps",
      "hostnamectl", "journalctl -b -1", "lsblk", "sensors", "dmidecode -t memory", "smartctl -a /dev/nvme0", "docker info",
      "systemctl is-active nginx", "systemctl status nginx", "systemctl list-units --type=service", "journalctl -u nginx -n 50", "set -e"],
    deny: ["cat .env", "cat ./.env", "cat ../.env", "cat ~/.env", `cat "$HOME/.env"`, `cat ".env"`, "tail -n 5 .env.local", "cp .env .env.example", "diff .env .env.example", "grep KEY .env .env.example", "cat .env .env.example", "docker system prune -f", "docker rm x", "kubectl delete pod x", "kubectl delete deployment x", "kubectl delete -f deployment.yaml", "gcloud deployment-manager deployments delete x", "git push --delete origin b", "docker rm -f x", "docker compose down -v", "env", "printenv", "sudo rm -rf /tmp/x", "rm -rf build",
      "npm publish", "pnpm publish", "cargo publish", "twine upload dist/x", "aws ec2 terminate-instances --instance-ids i-1", "kubectl edit configmap c", "terraform import a.b id", "helm uninstall rel",
      "shutdown", "shutdown -h now", "reboot", "reboot -f", "poweroff", "halt", "mkfs.ext4 /dev/sda1", "systemctl reboot", "systemctl poweroff", "sudo shutdown -h now", "set", "export -p", "declare -p", "/usr/bin/env", "/usr/bin/printenv"],
    ask: [`psql -c "SELECT 1"`, "psql postgres://localhost/example", "gcloud run deploy x", "sudo ls", "sudo smartctl -a /dev/nvme0", "kubectl apply -f x", "kubectl apply -f x.yaml", "docker push x", "git push", "rm foo.txt",
      "helm install rel chart", "helm upgrade rel chart", "helm rollback rel 1", "kubectl patch configmap c -p {}", "kubectl scale sts db --replicas=0", "kubectl rollout restart daemonset x", "vercel --prod",
      "ssh user@host", "scp f.txt host:/tmp/", "rsync -a a.txt host:/tmp/", "nmap -p 22 host"]
  },
  reader: {
    allow: ["git status", "git diff HEAD~1", "git log -n 5", "git blame src/a.ts", "ls -la", "rg -i todo src/", `find src -name "*.ts"`, "cat .env.example"],
    deny: ["git diff --output=/tmp/x", "git add src/a.ts", "npm test", "rm foo", "cat .env", "env"]
  },
  security_auditor: {
    allow: ["npm audit --json", "semgrep --config auto", "git log -n 5", "rg -i \"(api_key|secret)\" src/", "cat .env.example"],
    deny: ["npm install", "git add .", "rm foo", "cat .env", "env"]
  }
}
const FIXTURE_ROLES: Record<string, string[]> = {
  tester: ["tester"],
  writer: ["executor", "fast_lane", "refactorer"],
  post_session: ["post_session"],
  ops: ["ops"],
  reader: ["explorer", "code_reviewer", "critic", "hitl"],
  security_auditor: ["security_auditor"]
}

for (const [fixture, roles] of Object.entries(FIXTURE_ROLES)) {
  for (const role of roles) {
    test(`fixture ${fixture}: ${role} allowlist gives the expected action`, () => {
      const frontmatter = frontmatterOf(role)
      for (const [action, commands] of Object.entries(FIXTURES[fixture])) {
        for (const command of commands!) assert.equal(evaluateAgentBash(frontmatter, command), action, `${role}: ${command}`)
      }
    })
  }
}

// --- Prompt scan: commands a prompt tells the agent to run must not be denied ---

const KNOWN_BINARIES = /^(?:git|docker|docker-compose|npm|npx|pnpm|yarn|bun|node|deno|python|python3|pip|pip3|pytest|uv|poetry|go|cargo|make|curl|psql|pg_isready|mysql|mongosh|redis-cli|kubectl|helm|gcloud|aws|az|terraform|gh|firebase|fly|flyctl|wrangler|vercel|lsof|ls|cat|head|tail|which|rm|cp|mv|mkdir|cd|find|grep|rg|sed|awk|env|printenv|kill|ps|ss|netstat|nc|uname|sleep|swift|xcodebuild|xcrun|gradle|\.\/gradlew|mvn|dotnet|semgrep|trivy|bandit|gosec|govulncheck|shellcheck|hadolint|osv-scanner|pip-audit|twine)\s+\S/

/**
 * Prompt notation is expanded before matching: `a/b/c` word alternatives
 * become one command per alternative, `<placeholder>` becomes `x`, and a bare
 * `...` part of a compound command is dropped.
 */
function expandNotation(span: string): string[] {
  const command = span.trim().replace(/^\$\s+/, "").replace(/<[^>]+>/g, "x")
  const parts = splitCompoundCommand(command).filter(part => part !== "..." && part !== "…")
  if (parts.length === 0) return []
  let variants = [parts.join(" && ")]
  for (;;) {
    const next = variants.flatMap(variant => {
      const token = variant.split(/\s+/).find(word => word.includes("/") && word.split("/").every(piece => /^-{0,2}[a-z][a-z-]*$/.test(piece)))
      return token ? token.split("/").map(piece => variant.replace(token, piece)) : [variant]
    })
    if (next.length === variants.length) return variants
    variants = next
  }
}

/**
 * Legitimate mentions of commands the agent may not run: prohibitions and
 * advice addressed to the user. Keep minimal; key = file, value = exact span.
 */
const PROMPT_SCAN_IGNORE: Record<string, string[]> = {
  // "running `git commit/reset/clean/switch/push` are denied" (prohibition)
  "pipeline-executor.md": ["git commit/reset/clean/switch/push", "git mv", "git rm"],
  "pipeline-fast_lane.md": ["git commit/reset/clean/switch/push", "git mv", "git rm"],
  // "do not run `git add/commit/reset/clean/switch/push`" (prohibition)
  "pipeline-refactorer.md": ["git add/commit/reset/clean/switch/push", "git commit/reset/clean/switch/push", "git mv", "git rm", "git checkout/restore --ours/--theirs", "git restore --staged/--merge"],
  // "do not run `git add/commit/...`", "Never use `git stash`, `git checkout`" (prohibitions)
  "pipeline-tester.md": ["git add/commit/reset/clean/checkout/restore/rebase/merge/push", "git stash", "git checkout", "git mv", "git rm"],
  // "Destructive operations are denied (... `terraform import`, `kubectl edit` ...)" (prohibition)
  "pipeline-ops.md": ["terraform import", "kubectl edit"],
  // install command recommended to the user in the component report; the agent has bash: deny
  "pipeline-frontend_specialist.md": ["npx shadcn@latest add <component>"]
}

/**
 * Prompt/permission drift found by this scan and reported, not fixed here
 * (agent files are owned elsewhere). The test fails once an entry is no
 * longer denied, so it can be removed.
 */
const KNOWN_DRIFT: Record<string, string[]> = {}

test("prompt scan: inline and fenced commands in pipeline prompts are not denied by the agent's allowlist", () => {
  const failures: string[] = []
  const drift: string[] = []
  for (const file of fs.readdirSync(AGENTS_DIR).filter(name => /^pipeline-.*\.md$/.test(name)).sort()) {
    const frontmatter = frontmatterOf(file.replace(/^pipeline-|\.md$/g, ""))
    const ignored = new Set(PROMPT_SCAN_IGNORE[file] ?? [])
    const knownDrift = new Set(KNOWN_DRIFT[file] ?? [])
    const body = bodyOf(file)
    const spans = [...body.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)].map(match => match[1])
    for (const block of body.matchAll(/```(?:bash|sh)[ \t]*\r?\n([\s\S]*?)```/g)) {
      spans.push(...block[1].split(/\r?\n/).map(line => line.trim()).filter(Boolean))
    }
    for (const rawSpan of spans) {
      const span = rawSpan.trim()
      if (!KNOWN_BINARIES.test(span.replace(/^\$\s+/, "")) || ignored.has(span)) continue
      for (const command of expandNotation(span)) {
        if (evaluateAgentBash(frontmatter, command) !== "deny") continue
        if (knownDrift.has(command)) drift.push(`${file}: ${command}`)
        else failures.push(`${file}: \`${span}\` → ${command}`)
      }
    }
  }
  assert.deepEqual(failures, [])
  const expectedDrift = Object.entries(KNOWN_DRIFT).flatMap(([file, commands]) => commands.map(command => `${file}: ${command}`))
  assert.deepEqual([...new Set(drift)].sort(), expectedDrift.sort(), "a KNOWN_DRIFT entry is fixed or missing: update the list")
})
