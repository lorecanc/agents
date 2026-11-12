import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { expandRole, rewriteShellRules, syncBash, validateProfiles } from "./sync-bash.mjs"

const PROFILES = { version: 1, profiles: { base: { rules: [["*", "deny"], ["git *", "allow"]] }, rm: { rules: [["rm *", "ask"]] } }, roles: { executor: ["base", "rm"] } }

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
