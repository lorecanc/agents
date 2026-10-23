import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { mkTmp } from "./_pipeline_testutil.mjs"

import { collectEnv, detectWorkspaces, envTemplateNames, whichBin } from "./_pipeline_env.js"
import { repoInfo, snapshot, writeSession } from "./_pipeline_core.js"

function mkRepo(files = {}) {
  const dir = mkTmp("pipe-env-")
  const sh = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
  sh("init", "-q", "-b", "main")
  sh("config", "user.email", "t@example.com")
  sh("config", "user.name", "T")
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n")
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), body)
  }
  sh("add", "-A")
  sh("commit", "-qm", "init")
  return dir
}

/** A PATH directory with fake executables (name -> shell body). */
function fakeBin(scripts) {
  const dir = mkTmp("pipe-env-bin-")
  for (const [name, body] of Object.entries(scripts)) {
    const p = path.join(dir, name)
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`)
    fs.chmodSync(p, 0o755)
  }
  return dir
}

test("pipeline_env works without a contract and never throws outside a git repo", async () => {
  const dir = mkRepo()
  const r = await collectEnv({ directory: dir, env: { PATH: fakeBin({}) }, sessionId: "ses_none" })
  assert.equal(r.repository.git, true)
  assert.equal(r.contract.exists, false)
  assert.deepEqual(r.contract.problems, [])
  assert.deepEqual(r.contract.services, [])
  assert.equal(r.docker.cli, null)
  assert.equal(r.docker.daemon.reachable, false)
  assert.equal(r.pipeline.guard_registered, false)
  assert.ok(r.pipeline.tools_present.includes("pipeline_env"))
  assert.ok(r.pipeline.tools_present.includes("pipeline_state"))
  assert.equal(r.verification_outlook.unit_tests.feasible, false)
  assert.equal(r.verification_outlook.runtime_smoke.feasible, false)
  assert.ok(r.elapsed_ms < 5000)

  const plain = mkTmp("pipe-env-nogit-")
  const r2 = await collectEnv({ directory: plain, env: { PATH: "" } })
  assert.equal(r2.repository.git, false)
  assert.equal(r2.pipeline.guard_registered, "unknown")
  assert.ok(r2.verification_outlook)
})

test("pipeline_env reports env var presence only, never values, and never reads .env", async () => {
  const dir = mkRepo({
    ".env.example": "# comment\nDATABASE_URL=postgres://user:pw@localhost/db\nexport API_TOKEN=\nUNSET_ONE=x\n",
    ".env": "LEAKED_FROM_DOTENV=dotenv-secret-value\n",
  })
  const env = { PATH: fakeBin({}), DATABASE_URL: "postgres://admin:very-secret-pw@db/prod", API_TOKEN: "tok-super-secret-123", LEAKED_FROM_DOTENV: "x" }
  const r = await collectEnv({ directory: dir, env })
  const text = JSON.stringify(r)
  for (const value of ["very-secret-pw", "tok-super-secret-123", "dotenv-secret-value", "user:pw"]) assert.ok(!text.includes(value), `leaked ${value}`)
  assert.ok(!text.includes("LEAKED_FROM_DOTENV"), ".env must not be read")
  assert.deepEqual(r.env_vars.files, [".env.example"])
  assert.deepEqual(r.env_vars.vars, [{ name: "DATABASE_URL", set: true }, { name: "API_TOKEN", set: true }, { name: "UNSET_ONE", set: false }])
  assert.deepEqual(r.env_vars.unset, ["UNSET_ONE"])
  // DATABASE_URL implies postgres; without binaries or docker the db outlook says why not
  assert.equal(r.verification_outlook.db_backed_tests.feasible, false)
  assert.match(r.verification_outlook.db_backed_tests.reason, /postgres/)
})

test("pipeline_env detects workspaces up to depth 2 and skips vendored dirs", async () => {
  const dir = mkRepo({
    "package.json": JSON.stringify({ scripts: { test: "node --test", dev: "vite" } }),
    "packages/api/package.json": "{}",
    "services/py/pyproject.toml": "[project]\nname='x'\n",
    "backend/go.mod": "module x\n",
    "apps/android/build.gradle.kts": "",
    "node_modules/dep/package.json": "{}",
    "dist/package.json": "{}",
    "a/b/c/Cargo.toml": "",
  })
  const ws = detectWorkspaces(dir)
  assert.deepEqual(ws.dirs.map((d) => d.dir).sort(), [".", "apps/android", "backend", "packages/api", "services/py"])
  const r = await collectEnv({ directory: dir, env: { PATH: path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin" } })
  assert.deepEqual(r.contract.verify_autodetected, ["test_fast"])
  assert.equal(r.contract.smoke_autodetected, true)
  if (whichBin("npm", path.dirname(process.execPath))) assert.equal(r.verification_outlook.unit_tests.feasible, true)
  // workspace argument: autodetect runs in the sub-project; escapes are refused
  const sub = await collectEnv({ directory: dir, workspace: "backend", env: { PATH: "" } })
  assert.equal(sub.workspace.dir, "backend")
  for (const k of ["typecheck", "test_fast", "build"]) assert.ok(sub.contract.verify_autodetected.includes(k), k)
  assert.equal(sub.verification_outlook.unit_tests.feasible, false)
  assert.match(sub.verification_outlook.unit_tests.reason, /go, which is not on PATH/)
  const esc = await collectEnv({ directory: dir, workspace: "../..", env: { PATH: "" } })
  assert.match(esc.workspace.error, /outside the repository/)
})

test("pipeline_env summarizes the contract generically (services, workspaces, unknown keys, problems)", async () => {
  const dir = mkRepo({
    ".opencode/pipeline.json": JSON.stringify({
      version: 1,
      verify: { test_fast: "npm test", lint: "" },
      services: { db: { kind: "postgres", port: 5432 }, cache: { image: "redis:7" }, worker: { start: "node w.js" } },
      workspaces: { "packages/api": { verify: { test_fast: "npm test" }, services: ["db"] } },
      serve: { start: "npm run dev" },
      future_thing: true,
    }),
  })
  const bin = fakeBin({ pg_ctl: "exit 0", initdb: "exit 0", npm: "exit 0" })
  const r = await collectEnv({ directory: dir, env: { PATH: bin } })
  assert.equal(r.contract.exists, true)
  assert.deepEqual(r.contract.verify_defined, ["test_fast"])
  assert.deepEqual(r.contract.problems, ["verify.lint must be a non-empty string"])
  assert.deepEqual(r.contract.services, [{ name: "db", kind: "postgres" }, { name: "cache", kind: "docker", image: "redis:7" }, { name: "worker", kind: "process" }])
  assert.deepEqual(r.contract.workspaces, [{ dir: "packages/api", verify: ["test_fast"], services: ["db"] }])
  assert.deepEqual(r.contract.other_keys, ["future_thing"])
  assert.equal(r.contract.serve, true)
  assert.equal(r.verification_outlook.unit_tests.feasible, true)
  // postgres is local; redis (cache) needs docker, which is unavailable
  assert.equal(r.verification_outlook.db_backed_tests.feasible, false)
  assert.match(r.verification_outlook.db_backed_tests.reason, /redis/)

  fs.writeFileSync(path.join(dir, ".opencode/pipeline.json"), "{ not json")
  const bad = await collectEnv({ directory: dir, env: { PATH: "" } })
  assert.deepEqual(bad.contract.problems, [".opencode/pipeline.json is not valid JSON"])
})

test("pipeline_env probes docker with a bounded call and sees the guard registration", async () => {
  const dir = mkRepo()
  const ok = await collectEnv({ directory: dir, env: { PATH: fakeBin({ docker: 'echo "27.1.1"' }) } })
  assert.deepEqual(ok.docker.daemon, { reachable: true, server_version: "27.1.1" })
  const down = await collectEnv({ directory: dir, env: { PATH: fakeBin({ docker: 'echo "Cannot connect to the Docker daemon" >&2; exit 1' }) } })
  assert.equal(down.docker.daemon.reachable, false)
  assert.match(down.docker.daemon.reason, /Cannot connect/)
  const t0 = Date.now()
  const hung = await collectEnv({ directory: dir, env: { PATH: fakeBin({ docker: "exec /bin/sleep 20" }) }, dockerTimeoutMs: 300 })
  assert.equal(hung.docker.daemon.reachable, "unknown")
  assert.ok(Date.now() - t0 < 4000)

  const info = repoInfo(dir)
  writeSession(info, { sessionId: "ses_root", rootId: "ses_root", agent: "x-pipeline-orchestrator", pid: process.pid, busy: true, updatedAt: Date.now(), baseline: snapshot(info), files: {} })
  writeSession(info, { sessionId: "ses_child", rootId: "ses_root", agent: "x-pipeline-planner", pid: process.pid, updatedAt: Date.now() })
  const reg = await collectEnv({ directory: dir, sessionId: "ses_child", env: { PATH: "" } })
  assert.equal(reg.pipeline.guard_registered, true)
  assert.equal(reg.pipeline.baseline, true)
  assert.equal(reg.pipeline.root_session, "ses_root")
})

test("env template parsing keeps names only", () => {
  const dir = mkTmp("pipe-env-tpl-")
  fs.writeFileSync(path.join(dir, ".env.sample"), "A=1\n  export B = 2\n#C=3\nnot a var\nA=dup\n")
  assert.deepEqual(envTemplateNames(path.join(dir, ".env.sample")), ["A", "B"])
  assert.equal(envTemplateNames(path.join(dir, "missing")), null)
})
