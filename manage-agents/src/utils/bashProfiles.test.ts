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
    allow: ["pytest -q", "cd backend", "python3 -m pytest -q tests/test_x.py", "npm test"],
    deny: ["git push", "rm -rf build", "git add .", "env"]
  },
  writer: {
    allow: [`git add ".github/workflows/ci.yml"`, "git add src/a.ts", "cd backend", "npm run build"],
    deny: ["git add .", "git add -A", "git add ./", "npm publish", "rm -rf x"],
    ask: ["rm a.txt"]
  },
  post_session: {
    allow: [`git add ".github/workflows/ci.yml"`, "git add .github/workflows/ci.yml", `git commit -m "x"`],
    deny: ["git add .", "git commit --amend -m x", "git commit -a -m x"],
    ask: ["git push"]
  },
  ops: {
    allow: ["which psql", "pg_isready -h 127.0.0.1 -p 5432", "ls /var/run/docker.sock", "docker compose up -d db", "curl --retry 10 --retry-connrefused -fsS http://127.0.0.1:8000/health", "cat .env.example", "cat .env.sample", "tail -n 50 log.txt", "uname -a",
      "hostnamectl", "journalctl -b -1", "lsblk", "sensors", "dmidecode -t memory", "smartctl -a /dev/nvme0", "docker info",
      "systemctl is-active nginx", "systemctl status nginx", "systemctl list-units --type=service", "journalctl -u nginx -n 50", "set -e"],
    deny: ["cat .env", "cat ./.env", "cat ../.env", "cat ~/.env", `cat "$HOME/.env"`, `cat ".env"`, "tail -n 5 .env.local", "cp .env .env.example", "diff .env .env.example", "grep KEY .env .env.example", "cat .env .env.example", "docker system prune -f", "kubectl delete pod x", "kubectl delete deployment x", "kubectl delete -f deployment.yaml", "gcloud deployment-manager deployments delete x", "git push --delete origin b", "docker rm -f x", "docker compose down -v", "env", "printenv", "sudo rm -rf /tmp/x",
      "npm publish", "pnpm publish", "cargo publish", "twine upload dist/x", "aws ec2 terminate-instances --instance-ids i-1", "kubectl edit configmap c", "terraform import a.b id", "helm uninstall rel",
      "shutdown", "shutdown -h now", "reboot", "reboot -f", "poweroff", "halt", "mkfs.ext4 /dev/sda1", "systemctl reboot", "systemctl poweroff", "sudo shutdown -h now", "set", "export -p", "declare -p", "/usr/bin/env", "/usr/bin/printenv"],
    ask: [`psql -c "SELECT 1"`, "gcloud run deploy x", "sudo smartctl -a /dev/nvme0", "kubectl apply -f x", "docker push x", "git push",
      "helm install rel chart", "helm upgrade rel chart", "helm rollback rel 1", "kubectl patch configmap c -p {}", "kubectl scale sts db --replicas=0", "kubectl rollout restart daemonset x", "vercel --prod",
      "ssh user@host", "scp f.txt host:/tmp/", "rsync -a a.txt host:/tmp/", "nmap -p 22 host"]
  },
  reader: {
    allow: [`git diff -- ".github/workflows/ci.yml"`, "git log --oneline -5", "cd src"],
    deny: ["git add x", "rm x"]
  }
}
const FIXTURE_ROLES: Record<string, string[]> = {
  tester: ["tester"],
  writer: ["executor", "fast_lane", "refactorer"],
  post_session: ["post_session"],
  ops: ["ops"],
  reader: ["explorer", "code_reviewer", "critic", "hitl", "security_auditor"]
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
  "pipeline-executor.md": ["git commit/reset/clean/switch/push"],
  "pipeline-fast_lane.md": ["git commit/reset/clean/switch/push"],
  // "do not run `git add/commit/reset/clean/switch/push`" (prohibition)
  "pipeline-refactorer.md": ["git add/commit/reset/clean/switch/push"],
  // "do not run `git add/commit/...`", "Never use `git stash`, `git checkout`" (prohibitions)
  "pipeline-tester.md": ["git add/commit/reset/clean/checkout/restore/rebase/merge/push", "git stash", "git checkout"],
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

test("prompt scan: backticked commands in pipeline prompts are not denied by the agent's allowlist", () => {
  const failures: string[] = []
  const drift: string[] = []
  for (const file of fs.readdirSync(AGENTS_DIR).filter(name => /^pipeline-.*\.md$/.test(name)).sort()) {
    const frontmatter = frontmatterOf(file.replace(/^pipeline-|\.md$/g, ""))
    const ignored = new Set(PROMPT_SCAN_IGNORE[file] ?? [])
    const knownDrift = new Set(KNOWN_DRIFT[file] ?? [])
    for (const match of bodyOf(file).matchAll(/`([^`\n]+)`/g)) {
      const span = match[1].trim()
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
