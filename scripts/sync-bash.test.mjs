import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { expandRole, rewriteShellRules, syncBash, validateProfiles } from "./sync-bash.mjs"

const PROFILES = { version: 1, profiles: { base: { rules: [["*", "deny"], ["git *", "allow"]] }, rm: { rules: [["rm *", "ask"]] } }, roles: { executor: ["base", "rm"] } }
const REAL_PROFILES = JSON.parse(fs.readFileSync(new URL("./bash-profiles.json", import.meta.url), "utf8"))
const globRegex = (pattern) => new RegExp(`^${pattern.split("*").map(part => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")).join(".*")}$`)
const effectFor = (role, command) => {
  let effect = null
  for (const [pattern, candidate] of expandRole(validateProfiles(REAL_PROFILES), role)) {
    if (globRegex(pattern).test(command)) effect = candidate
  }
  return effect
}

test("operational roles stay workspace-agnostic and read-only roles default to deny", () => {
  const config = validateProfiles(REAL_PROFILES)
  const operationalRoles = ["executor", "fast_lane", "refactorer", "tester", "ops"]
  const readonlyRoles = ["explorer", "code_reviewer", "critic", "security_auditor", "hitl", "post_session"]

  for (const role of operationalRoles) assert.deepEqual(config.profiles[config.roles[role][0]].rules, [["*", "allow"]], role)
  for (const role of readonlyRoles) assert.deepEqual(config.profiles[config.roles[role][0]].rules, [["*", "deny"]], role)
  for (const role of readonlyRoles) {
    for (const command of ["python3 script.py", "node script.js", 'sh -c "ls"', "rm .env .env.example", "git add .env .env.example"]) {
      assert.equal(effectFor(role, command), "deny", `${role}: ${command}`)
    }
  }
  for (const role of readonlyRoles.slice(0, -1)) {
    for (const command of ["ls", "pwd", "git status --short", "cat README.md"]) {
      assert.equal(effectFor(role, command), "allow", `${role}: ${command}`)
    }
    for (const command of ["find . -exec node script.js", "fd . -x rm file", "sort input -o output", "yq -i '.x=1' file.yaml", "cat file > out"]) {
      assert.equal(effectFor(role, command), "deny", `${role}: ${command}`)
    }
  }
  assert.equal(effectFor("security_auditor", "gitleaks detect"), "allow")
  assert.equal(effectFor("security_auditor", "npm audit --fix"), "deny")
})

test("environment dumps and real env files are denied without false positives", () => {
  for (const role of Object.keys(REAL_PROFILES.roles)) {
    assert.equal(effectFor(role, "rm .env .env.example"), "deny", `${role}: rm real env with template`)
    assert.equal(effectFor(role, "git add .env .env.example"), "deny", `${role}: stage real env with template`)
    assert.equal(effectFor(role, "cat .env.example"), "allow", `${role}: read safe template`)
    assert.equal(effectFor(role, "cat /tmp/.env"), "deny", `${role}: read real env by path`)
    assert.equal(effectFor(role, "cat /tmp/.env.local"), "deny", `${role}: read real env variant by path`)
  }
  assert.equal(effectFor("post_session", "git add .env.example"), "allow")

  assert.equal(effectFor("executor", "env FOO=bar"), "deny")
  assert.equal(effectFor("executor", "/usr/bin/env FOO=bar"), "deny")
  assert.equal(effectFor("executor", "env python3 --version"), "allow")
  assert.equal(effectFor("executor", "/usr/bin/env python3 --version"), "allow")
  assert.equal(effectFor("executor", "FOO=bar python3 --version"), "allow")
  assert.equal(effectFor("executor", "cp .env.example .env"), "deny")
  assert.equal(effectFor("executor", "cp .env.example /tmp/.env"), "deny")
  assert.equal(effectFor("executor", "cp .env.example .env.test-local"), "allow")
  assert.equal(effectFor("executor", "node -e \"console.log(process.env.PORT)\""), "allow")
  assert.equal(effectFor("ops", "node -e \"console.log(process.env.PORT)\""), "allow")
  assert.equal(effectFor("executor", "npm publish"), "deny")
})

test("read-only roles deny inline code and nested shell interpreters", () => {
  const readonlyRoles = ["explorer", "code_reviewer", "critic", "security_auditor", "hitl"]
  const deniedCommands = [
    "node -e \"fs.writeFileSync('a','b')\"",
    "python3 -c \"open('a','w')\"",
    "sh -c \"echo x\""
  ]

  for (const role of readonlyRoles) {
    for (const command of deniedCommands) assert.equal(effectFor(role, command), "deny", `${role}: ${command}`)
  }
})

test("census fixes: staged apply/restore, single-quoted commit, git inspection, sed denied, trivy image", () => {
  assert.equal(effectFor("post_session", "git restore --staged a.txt"), "allow")
  assert.equal(effectFor("post_session", "git restore -S a.txt"), "allow")
  assert.equal(effectFor("post_session", "git apply --cached p.diff"), "allow")
  assert.equal(effectFor("post_session", "git apply --cached --check p.diff"), "allow")
  assert.equal(effectFor("post_session", "git apply --check --cached p.diff"), "allow")
  assert.equal(effectFor("post_session", "git apply p.diff"), "deny")
  assert.equal(effectFor("post_session", "git apply --index p.diff"), "deny")
  assert.equal(effectFor("post_session", "git commit -m 'chore(checkpoint): x'"), "allow")
  assert.equal(effectFor("post_session", 'git commit -m "x"'), "allow")
  assert.equal(effectFor("post_session", 'git commit -m "x" --amend'), "deny")
  assert.equal(effectFor("post_session", "git commit -m 'x' --allow-empty"), "deny", "single-quote pattern requires the closing quote")

  assert.equal(effectFor("explorer", "git rev-parse HEAD"), "allow")
  assert.equal(effectFor("explorer", "git ls-tree HEAD"), "allow")
  assert.equal(effectFor("explorer", "git -C /repo ls-tree HEAD"), "allow")
  // sed stays denied for read-only roles: without a sed allow in shell-read, every form
  // fails by default. The sed-specific write/exec/secret denies live in the bash guard tests.
  for (const command of [
    "sed -n 1,20p a.txt",
    "sed -n 's/a/b/g' f",
    "sed -n 's/a/b/pg' f",
    "sed -n 's/a/b/2' f",
    "sed -n 's#x#y#g' f",
    "sed -n 'w /etc/x' f",
    "sed -n '1w out.txt' f",
    "sed -n 's/a/b/w out.txt' f",
    "sed -ne 'e id' f",
    "sed -n 's/a/b/e' f",
    "sed -n 's/.*/touch x/ge' f",
    "sed -n 's/a/b/g e' f",
    "sed -n 'r .env' f",
    "sed -n -f script.sed f",
  ]) {
    assert.equal(effectFor("explorer", command), "deny", command)
  }
  assert.equal(effectFor("explorer", "git add x"), "deny")

  assert.equal(effectFor("executor", "git apply p.diff"), "deny")
  assert.equal(effectFor("tester", "git apply p.diff"), "deny")

  assert.equal(effectFor("security_auditor", "trivy image x:1"), "allow")
  assert.equal(effectFor("security_auditor", "trivy image --output /Users/lore/x img"), "deny")
  assert.equal(effectFor("security_auditor", "trivy image --server https://evil img"), "deny")
  assert.equal(effectFor("security_auditor", "trivy fs --cache-dir /Users/lore/x ."), "deny")
  assert.equal(effectFor("security_auditor", "trivy image --config /tmp/c.yml img"), "deny", "trivy config templates are denied (custom rules from untrusted files)")
  assert.equal(effectFor("security_auditor", "trivy image --config=/tmp/c.yml img"), "deny", "trivy --config= form is denied too")
  assert.equal(effectFor("security_auditor", "trivy fs ."), "allow", "legitimate trivy use stays allowed")
})

test("deployment and infrastructure destruction require confirmation", () => {
  assert.equal(effectFor("executor", "railway deploy"), "ask")
  assert.equal(effectFor("executor", "pulumi destroy"), "ask")
})

test("roles expand to their profiles in order; duplicates and unknown profiles are rejected", () => {
  assert.deepEqual(expandRole(validateProfiles(PROFILES), "executor"), [["*", "deny"], ["git *", "allow"], ["rm *", "ask"]])
  assert.equal(expandRole(PROFILES, "other"), null)
  assert.throws(() => validateProfiles({ ...PROFILES, roles: { x: ["base", "base"] } }), /twice/)
  assert.throws(() => validateProfiles({ ...PROFILES, roles: { x: ["ghost"] } }), /unknown profile/)
})

test("rewrite replaces only the shell rules, in place, and keeps the body", () => {
  const before = "---\nmode: subagent\npermissions:\n  - action: read\n    resource: \"*\"\n    effect: allow\n  - action: shell\n    resource: old\n    effect: allow\n  - action: edit\n    resource: \"*\"\n    effect: deny\n---\n\nBody  \n"
  const after = rewriteShellRules(before, [["a *", "allow"], ["b", "deny"]])
  assert.match(after, /action: read[\s\S]*action: shell\n {4}resource: a \*[\s\S]*resource: b\n {4}effect: deny[\s\S]*action: edit/)
  assert.ok(after.endsWith("---\n\nBody  \n"))
})

test("sync rewrites drifted pipeline agents and --check reports them without writing", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-bash-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, "scripts"))
  fs.mkdirSync(path.join(root, "packs", "pipeline", "agents"), { recursive: true })
  fs.writeFileSync(path.join(root, "scripts", "bash-profiles.json"), JSON.stringify(PROFILES))
  const agent = path.join(root, "packs", "pipeline", "agents", "pipeline-executor.md")
  fs.writeFileSync(agent, "---\npermissions:\n  - action: shell\n    resource: \"*\"\n    effect: allow\n---\nbody\n")
  fs.writeFileSync(path.join(root, "packs", "pipeline", "agents", "pipeline-planner.md"), "---\nmode: subagent\n---\n")

  assert.deepEqual(syncBash({ root, check: true }), { changed: ["pipeline-executor.md"], unchanged: [], skipped: ["pipeline-planner.md"] })
  assert.match(fs.readFileSync(agent, "utf8"), /effect: allow\n---/)
  syncBash({ root })
  assert.deepEqual(syncBash({ root, check: true }).changed, [])
})
