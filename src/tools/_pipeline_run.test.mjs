import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { mkTmp } from "./_pipeline_testutil.mjs"

import { repoInfo } from "./_pipeline_core.js"
import {
  autodetect, loadContract, runCommand, runVerify, runSmoke, isPortFree, findFreePort, envHint, killTree, runtimeEnv, CONTRACT_PATH,
} from "./_pipeline_run.js"

const node = JSON.stringify(process.execPath)

function mkRepo(files = {}, contract = null) {
  const dir = mkTmp("pipe-run-")
  const sh = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
  sh("init", "-q", "-b", "main")
  sh("config", "user.email", "t@example.com")
  sh("config", "user.name", "T")
  fs.writeFileSync(path.join(dir, "README.md"), "x\n")
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
  if (contract) {
    fs.mkdirSync(path.join(dir, ".opencode"), { recursive: true })
    fs.writeFileSync(path.join(dir, CONTRACT_PATH), typeof contract === "string" ? contract : JSON.stringify(contract))
  }
  sh("add", "-A")
  sh("commit", "-qm", "init")
  return dir
}

const SERVER = `
const http = require("http")
http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); return res.end("ok") }
  if (req.url === "/teapot") { res.writeHead(418); return res.end("short and stout") }
  res.writeHead(404); res.end("nope")
}).listen(Number(process.env.PORT), "127.0.0.1")
`

// ------------------------------------------------------------ contract

test("autodetect: node scripts, go, cargo, python; never invents a smoke command silently", () => {
  const node1 = mkRepo({ "package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "vitest run", build: "tsc", dev: "vite" } }), "tsconfig.json": "{}" })
  const d = autodetect(node1)
  assert.equal(d.verify.lint, "npm run lint")
  assert.equal(d.verify.test_fast, "npm test --silent")
  assert.equal(d.verify.typecheck, "npx --no-install tsc --noEmit")
  assert.match(d.smokeHint.start, /npm run dev/)
  const noTest = mkRepo({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })
  assert.equal(autodetect(noTest).verify.test_fast, undefined)
  assert.equal(autodetect(mkRepo({ "go.mod": "module x" })).verify.test_fast, "go test ./...")
  assert.equal(autodetect(mkRepo({ "Cargo.toml": "[package]" })).verify.build, "cargo build")
  assert.equal(autodetect(mkRepo({ "pytest.ini": "[pytest]" })).verify.test_fast, "python3 -m pytest -q -x")
})

test("loadContract: file wins over autodetect, problems are reported, lockfile picks the package manager", () => {
  const dir = mkRepo(
    { "package.json": JSON.stringify({ scripts: { lint: "x", test: "y" } }), "pnpm-lock.yaml": "" },
    { verify: { test_fast: "make test", lint: 5 }, timeouts: { test_fast: 12 } },
  )
  const { contract, source, problems } = loadContract(dir)
  assert.equal(source, "file+autodetect")
  assert.equal(contract.verify.test_fast, "make test")
  assert.equal(contract.verify.lint, "pnpm run lint") // invalid file entry falls back to autodetect
  assert.equal(contract.timeouts.test_fast, 12)
  assert.ok(problems.some((p) => p.includes("verify.lint")))
  const bad = mkRepo({}, "{ not json")
  assert.ok(loadContract(bad).problems[0].includes("not valid JSON"))
  assert.equal(loadContract(mkRepo()).source, "none")
})

// ------------------------------------------------------------ processes

test("runCommand: output, exit code, and the whole process group dies on timeout", async () => {
  const dir = mkRepo()
  const env = runtimeEnv(repoInfo(dir))
  const ok = await runCommand("echo hello; exit 0", { cwd: dir, env, timeoutMs: 5000 })
  assert.equal(ok.exitCode, 0)
  assert.match(ok.output, /hello/)
  const fail = await runCommand("echo bad >&2; exit 3", { cwd: dir, env, timeoutMs: 5000 })
  assert.equal(fail.exitCode, 3)
  assert.match(fail.output, /bad/)
  const pidFile = path.join(dir, "child.pid")
  const t0 = Date.now()
  const slow = await runCommand(`sleep 30 & echo $! > ${pidFile}; wait`, { cwd: dir, env, timeoutMs: 400 })
  assert.equal(slow.timedOut, true)
  assert.ok(Date.now() - t0 < 6000)
  const child = Number(fs.readFileSync(pidFile, "utf8"))
  await new Promise((r) => setTimeout(r, 200))
  assert.throws(() => process.kill(child, 0), /ESRCH/, "background child must not survive the timeout")
})

test("runCommand: a finished command leaves no background children behind", async () => {
  const dir = mkRepo()
  const env = runtimeEnv(repoInfo(dir))
  const pidFile = path.join(dir, "bg.pid")
  const r = await runCommand(`sleep 30 & echo $! > ${pidFile}; exit 0`, { cwd: dir, env, timeoutMs: 20000 })
  assert.equal(r.exitCode, 0)
  assert.equal(r.timedOut, false)
  assert.ok(r.durationMs < 4000, `took ${r.durationMs}ms`)
  await new Promise((r2) => setTimeout(r2, 300))
  assert.throws(() => process.kill(Number(fs.readFileSync(pidFile, "utf8")), 0), /ESRCH/)
})

test("runCommand honors an abort signal", async () => {
  const dir = mkRepo()
  const env = runtimeEnv(repoInfo(dir))
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 200)
  const r = await runCommand("sleep 30", { cwd: dir, env, timeoutMs: 60000, signal: ac.signal })
  assert.equal(r.aborted, true)
})

test("ports: free detection, allocation and occupied ports", async () => {
  const port = await findFreePort(43100, 43199)
  assert.equal(await isPortFree(port), true)
  const srv = net.createServer().listen(port, "127.0.0.1")
  await new Promise((r) => srv.once("listening", r))
  assert.equal(await isPortFree(port), false)
  srv.close()
})

test("envHint recognizes environment signatures but not ordinary assertion failures", () => {
  for (const s of ["Error: listen EADDRINUSE: address already in use :::3000", "connect ECONNREFUSED 127.0.0.1:5432", "sh: foo: command not found",
    "Missing required environment variable DATABASE_URL", "FATAL: password authentication failed for user x"]) assert.equal(envHint(s), true, s)
  for (const s of ["AssertionError: expected 1 to equal 2", "TypeError: x is not a function"]) assert.equal(envHint(s), false, s)
})

// --------------------------------------------------------------- verify

test("runVerify: runs in order, stops at the first failure, reports skips and hints", async () => {
  const dir = mkRepo({}, { verify: { lint: "echo lint-ok", typecheck: "echo 'TS2322: bad' >&2; exit 2", test_fast: "echo never" } })
  const info = repoInfo(dir)
  const res = await runVerify({ info, checks: ["lint", "typecheck", "test_fast", "build"] })
  assert.equal(res.status, "fail")
  assert.deepEqual(res.results.map((r) => [r.check, r.status]), [["lint", "pass"], ["typecheck", "fail"], ["test_fast", "not_run"], ["build", "not_run"]])
  assert.equal(res.results[1].exit_code, 2)
  assert.equal(res.results[1].failure_class_hint, "unclassified")
  assert.match(res.results[1].output_tail, /TS2322/)
  const cont = await runVerify({ info, checks: ["lint", "typecheck", "build"], stopOnFail: false })
  assert.deepEqual(cont.results.map((r) => r.status), ["pass", "fail", "skipped"])
})

test("runVerify: env hint, timeout hint, targeted files are quoted and confined to the repo", async () => {
  const dir = mkRepo({}, { verify: { lint: "echo 'connect ECONNREFUSED 127.0.0.1:5432'; exit 1", build: "sleep 30", test_targeted: "echo ARGS:{files}" } })
  const info = repoInfo(dir)
  const envFail = await runVerify({ info, checks: ["lint"] })
  assert.equal(envFail.results[0].failure_class_hint, "env")
  const slow = await runVerify({ info, checks: ["build"], timeoutScale: 0.001 })
  assert.equal(slow.results[0].status, "timeout")
  assert.equal(slow.results[0].failure_class_hint, "timeout")
  const targeted = await runVerify({ info, checks: ["test_targeted"], files: ["src/a b.ts", "../escape.ts", "/etc/passwd"] })
  assert.equal(targeted.status, "pass")
  assert.match(targeted.results[0].output_tail, /ARGS:src\/a b\.ts/)
  assert.deepEqual(targeted.rejected_files, ["../escape.ts", "/etc/passwd"])
  const none = await runVerify({ info, checks: ["test_targeted"] })
  assert.equal(none.results[0].status, "skipped")
})

test("runVerify: a failing `node --test` fails even when this process is itself a node test child", async () => {
  // Regression: NODE_TEST_CONTEXT leaking into the child made a nested `node --test` exit 0 on failures.
  const dir = mkRepo(
    { "package.json": JSON.stringify({ type: "module" }), "test/broken.test.js": 'import { test } from "node:test"\nimport assert from "node:assert/strict"\ntest("broken", () => assert.equal(1, 2))\n' },
    { verify: { test_fast: "node --test" } },
  )
  const res = await runVerify({ info: repoInfo(dir), checks: ["test_fast"] })
  assert.equal(res.results[0].status, "fail", res.results[0].output_tail)
  assert.equal(runtimeEnv(repoInfo(dir)).NODE_TEST_CONTEXT, undefined)
})

test("runVerify: nothing defined is inconclusive, not a silent pass", async () => {
  const res = await runVerify({ info: repoInfo(mkRepo()), checks: ["test_fast"] })
  assert.equal(res.status, "inconclusive")
})

// ---------------------------------------------------------------- smoke

const smokeContract = (extra = {}) => ({
  smoke: {
    start: `${node} server.js`,
    ready: { url: "http://127.0.0.1:${PORT}/health", timeout_s: 15 },
    checks: [{ name: "health", url: "http://127.0.0.1:${PORT}/health", expect_status: 200, expect_body: "^ok$" }],
    ...extra,
  },
})

test("runSmoke: starts, checks, stops, and leaves the port free", async () => {
  const dir = mkRepo({ "server.js": SERVER }, smokeContract())
  const res = await runSmoke({ info: repoInfo(dir) })
  assert.equal(res.status, "pass", JSON.stringify(res))
  assert.equal(res.checks[0].status, "pass")
  assert.equal(res.cleanup.process_stopped, true)
  assert.equal(res.cleanup.port_free, true)
  assert.equal(await isPortFree(res.port), true)
  const scratch = path.join(repoInfo(dir).common, "opencode-scratch")
  assert.deepEqual(fs.readdirSync(scratch).filter((f) => f.startsWith("smoke-")), [])
})

test("runSmoke: autodetects a package start script when no pipeline contract exists", async () => {
  const dir = mkRepo({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" } }),
    "server.js": `
const http = require("http")
http.createServer((req, res) => { res.writeHead(200); res.end("ok") }).listen(Number(process.env.PORT), "127.0.0.1")
`,
  })
  const res = await runSmoke({ info: repoInfo(dir) })
  assert.equal(res.status, "pass", JSON.stringify(res))
  assert.equal(res.contract_source, "autodetect")
  assert.equal(res.cleanup.process_stopped, true)
  assert.equal(res.cleanup.port_free, true)
})

test("runSmoke: a real expectation mismatch is a code failure and the service is still stopped", async () => {
  const dir = mkRepo({ "server.js": SERVER }, smokeContract({ checks: [{ name: "teapot", url: "http://127.0.0.1:${PORT}/teapot", expect_status: 200 }] }))
  const res = await runSmoke({ info: repoInfo(dir) })
  assert.equal(res.status, "fail")
  assert.equal(res.failure_class_hint, "code")
  assert.match(res.checks[0].detail, /expected status 200, got 418/)
  assert.equal(res.cleanup.port_free, true)
})

test("runSmoke: preserves status=aborted and failure_class_hint=harness when aborted during ready or checks", async () => {
  const fastServer = `
const http = require("http")
console.log("smoke-ready")
http.createServer((req, res) => { res.writeHead(200); res.end("ok") }).listen(Number(process.env.PORT), "127.0.0.1")
`
  const checksDir = mkRepo(
    { "server.js": fastServer },
    {
      smoke: {
        start: `echo smoke-ready; ${node} server.js`,
        ready: { log: "smoke-ready", timeout_s: 10 },
        checks: [{ name: "slow-check", cmd: 'node -e "setTimeout(() => {}, 30000)"', timeout_s: 30 }],
      },
    },
  )
  const ac = new AbortController()
  const abortChecks = setTimeout(() => ac.abort(), 350)
  let res
  try {
    res = await runSmoke({ info: repoInfo(checksDir), signal: ac.signal, owner: "test" })
  } finally {
    clearTimeout(abortChecks)
  }
  const delayedServer = `
const http = require("http")
setTimeout(() => http.createServer((req, res) => { res.writeHead(200); res.end("ok") }).listen(Number(process.env.PORT), "127.0.0.1"), 30000)
`
  const readyDir = mkRepo(
    { "server.js": delayedServer },
    {
      smoke: {
        start: `${node} server.js`,
        ready: { url: "http://127.0.0.1:\u0024{PORT}/health", timeout_s: 10 },
        checks: [],
      },
    },
  )
  const ac2 = new AbortController()
  const abortReady = setTimeout(() => ac2.abort(), 200)
  let res2
  try {
    res2 = await runSmoke({ info: repoInfo(readyDir), signal: ac2.signal, owner: "test" })
  } finally {
    clearTimeout(abortReady)
  }
  assert.deepEqual(
    {
      checks: { status: res.status, reason: res.reason, failure_class_hint: res.failure_class_hint, check_status: res.checks[0]?.status },
      ready: { status: res2.status, reason: res2.reason, failure_class_hint: res2.failure_class_hint },
    },
    {
      checks: { status: "aborted", reason: "aborted", failure_class_hint: "harness", check_status: "aborted" },
      ready: { status: "aborted", reason: "aborted", failure_class_hint: "harness" },
    },
  )
})

test("runSmoke: an abort during a successful URL check is reported as aborted", async () => {
  const server = `
const http = require("http")
http.createServer((req, res) => { res.writeHead(200); res.end("ok") }).listen(Number(process.env.PORT), "127.0.0.1")
`
  const dir = mkRepo(
    { "server.js": server },
    { smoke: { start: `echo smoke-ready; ${node} server.js`, ready: { log: "smoke-ready", timeout_s: 10 }, checks: [{ name: "slow-url", url: "http://127.0.0.1:${PORT}/slow" }] } },
  )
  const ac = new AbortController()
  const originalFetch = globalThis.fetch
  let successfulUrlCheck = false
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args)
    if (String(args[0]).includes("/slow")) {
      successfulUrlCheck = response.status === 200 && (await response.clone().text()) === "ok"
      ac.abort()
    }
    return response
  }
  let res
  try {
    res = await runSmoke({ info: repoInfo(dir), signal: ac.signal, owner: "test" })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(successfulUrlCheck, true)
  assert.equal(res.status, "aborted")
  assert.equal(res.failure_class_hint, "harness")
  assert.equal(res.checks[0].status, "aborted")
})

test("runSmoke: an abort immediately after readiness cannot pass with no checks", async () => {
  const dir = mkRepo(
    { "server.js": SERVER },
    { smoke: { start: `${node} server.js`, ready: { url: "http://127.0.0.1:${PORT}/health", timeout_s: 10 }, checks: [] } },
  )
  const ac = new AbortController()
  const originalFetch = globalThis.fetch
  let readySucceeded = false
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args)
    if (String(args[0]).endsWith("/health")) {
      readySucceeded = response.status === 200
      ac.abort()
    }
    return response
  }
  let res
  try {
    res = await runSmoke({ info: repoInfo(dir), signal: ac.signal, owner: "test" })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(readySucceeded, true)
  assert.equal(res.status, "aborted")
  assert.equal(res.failure_class_hint, "harness")
})

test("runSmoke: command checks, env substitution and env_file (values never echoed)", async () => {
  const dir = mkRepo(
    { "server.js": SERVER, ".env.smoke": "SMOKE_SECRET=topsecretvalue\n" },
    smokeContract({ env_file: ".env.smoke", env: { GREETING: "hi-${PORT}" }, checks: [{ name: "env", cmd: `test "$SMOKE_SECRET" = topsecretvalue && test "$GREETING" = "hi-$PORT"` }] }),
  )
  const res = await runSmoke({ info: repoInfo(dir) })
  assert.equal(res.status, "pass", JSON.stringify(res))
  assert.ok(!JSON.stringify(res).includes("topsecretvalue"))
})

test("runSmoke: occupied fixed port is an env block and the foreign process is left alone", async () => {
  const port = await findFreePort(43200, 43299)
  const foreign = net.createServer().listen(port, "127.0.0.1")
  await new Promise((r) => foreign.once("listening", r))
  const dir = mkRepo({ "server.js": SERVER }, smokeContract({ port }))
  const res = await runSmoke({ info: repoInfo(dir) })
  assert.equal(res.status, "blocked")
  assert.equal(res.failure_class_hint, "env")
  assert.equal(await isPortFree(port), false, "the foreign listener must still be running")
  foreign.close()
})

test("runSmoke: startup crash with an env signature is classified env, otherwise unclassified", async () => {
  const envCrash = mkRepo({}, { smoke: { start: `echo "Error: connect ECONNREFUSED 127.0.0.1:5432"; exit 1`, ready: { port: "${PORT}", timeout_s: 10 }, checks: [] } })
  const a = await runSmoke({ info: repoInfo(envCrash) })
  assert.equal(a.status, "fail")
  assert.equal(a.failure_class_hint, "env")
  assert.equal(a.phase, "ready")
  const plainCrash = mkRepo({}, { smoke: { start: `echo "SyntaxError: Unexpected token" >&2; exit 1`, ready: { port: "${PORT}", timeout_s: 10 }, checks: [] } })
  const b = await runSmoke({ info: repoInfo(plainCrash) })
  assert.equal(b.failure_class_hint, "unclassified")
  assert.match(b.note, /read log_tail/)
  assert.match(b.log_tail, /SyntaxError/)
})

test("runSmoke: never-ready service is a harness problem and is killed", async () => {
  const dir = mkRepo({}, { smoke: { start: "sleep 60", ready: { port: "${PORT}", timeout_s: 1 }, checks: [] } })
  const t0 = Date.now()
  const res = await runSmoke({ info: repoInfo(dir) })
  assert.equal(res.status, "fail")
  assert.equal(res.failure_class_hint, "harness")
  assert.equal(res.cleanup.process_stopped, true)
  assert.ok(Date.now() - t0 < 15000)
})

test("runSmoke: log-pattern readiness, local-only URLs, missing contract", async () => {
  const logReady = mkRepo({}, { smoke: { start: "echo 'server ready on port'; sleep 20", ready: { log: "ready on", timeout_s: 10 }, checks: [{ name: "c", cmd: "exit 0" }] } })
  assert.equal((await runSmoke({ info: repoInfo(logReady) })).status, "pass")
  const external = mkRepo({ "server.js": SERVER }, smokeContract({ checks: [{ name: "ext", url: "http://example.com/" }] }))
  const ext = await runSmoke({ info: repoInfo(external) })
  assert.equal(ext.status, "fail")
  assert.match(ext.checks[0].detail, /only target localhost/)
  const none = await runSmoke({ info: repoInfo(mkRepo({ "package.json": JSON.stringify({ scripts: { build: "vite build" } }) })) })
  assert.equal(none.status, "inconclusive")
  assert.equal(none.suggested_smoke, null)
})

test("killTree is safe on pids that are gone or invalid", async () => {
  await killTree(undefined)
  await killTree(0)
  await killTree(2 ** 22 + 99)
})

// ------------------------------------------- targeted / filter / workspace

test("autodetect: targeted and filter commands for vitest, jest, pytest (venv aware), go, cargo", () => {
  const vit = autodetect(mkRepo({ "package.json": JSON.stringify({ devDependencies: { vitest: "1" } }) }))
  assert.equal(vit.verify.test_targeted, "npx --no-install vitest run {files}")
  assert.equal(vit.verify.test_filter, "npx --no-install vitest run {files} -t {filter}")
  const jest = autodetect(mkRepo({ "package.json": JSON.stringify({ devDependencies: { jest: "29" } }), "pnpm-lock.yaml": "" }))
  assert.equal(jest.verify.test_targeted, "pnpm exec jest {files}")
  assert.equal(jest.verify.test_filter, "pnpm exec jest {files} -t {filter}")
  const py = autodetect(mkRepo({ "pyproject.toml": "" }))
  assert.equal(py.verify.test_targeted, "python3 -m pytest -q {files}")
  assert.equal(py.verify.test_filter, "python3 -m pytest -q {files} -k {filter}")
  const venv = autodetect(mkRepo({ "pytest.ini": "", ".venv/bin/python": "" }))
  assert.equal(venv.verify.test_fast, ".venv/bin/python -m pytest -q -x")
  const mixed = autodetect(mkRepo({ "package.json": JSON.stringify({ scripts: { build: "vite build" } }), "pyproject.toml": "" }))
  assert.equal(mixed.verify.test_targeted, "python3 -m pytest -q {files}")
  const go = autodetect(mkRepo({ "go.mod": "module x" }))
  assert.equal(go.verify.test_targeted, "go test {packages}")
  assert.equal(go.verify.test_filter, "go test {packages} -run {filter}")
  const cargo = autodetect(mkRepo({ "Cargo.toml": "[package]" }))
  assert.equal(cargo.verify.test_targeted, undefined)
  assert.equal(cargo.verify.test_filter, "cargo test {filter}")
})

test("runVerify filter: test_filter is the default check, the filter is quoted, {packages} groups dirs", async () => {
  const dir = mkRepo({}, { verify: { test_filter: "printf '%s|' {files} -k {filter}", test_targeted: "printf '%s|' {packages}" } })
  const info = repoInfo(dir)
  const evil = `login and not "x"; touch pwned`
  const res = await runVerify({ info, filter: evil, files: ["tests/test_a.py"] })
  assert.equal(res.status, "pass", JSON.stringify(res))
  assert.equal(res.results[0].check, "test_filter")
  assert.equal(res.filter, evil)
  assert.match(res.results[0].output_tail, /tests\/test_a\.py\|-k\|login and not "x"; touch pwned\|/)
  assert.ok(!fs.existsSync(path.join(dir, "pwned")))
  const pk = await runVerify({ info, files: ["pkg/a/x.go", "pkg/a/y.go", "main.go"] })
  assert.equal(pk.results[0].check, "test_targeted")
  assert.match(pk.results[0].output_tail, /^\.\/pkg\/a\|\.\|$/m)
  const noFilter = await runVerify({ info, checks: ["test_filter"] })
  assert.equal(noFilter.results[0].status, "skipped")
  const multi = await runVerify({ info, filter: "a\nb" })
  assert.equal(multi.status, "error")
  const badContract = loadContract(mkRepo({}, { verify: { test_filter: "pytest -k name" } }))
  assert.ok(badContract.problems.some((p) => p.includes("must contain {filter}")))
  assert.equal(badContract.contract.verify.test_filter, undefined)
})

test("runVerify workspace: cwd is the subdirectory, contract or autodetect per workspace, files become workspace-relative", async () => {
  const dir = mkRepo(
    { "backend/pyproject.toml": "", "backend/tests/test_x.py": "", "frontend/src/a.ts": "", "frontend/package.json": JSON.stringify({ devDependencies: { vitest: "1" } }) },
    { verify: { lint: "echo top-level" }, workspaces: { backend: { verify: { test_targeted: "pwd; echo FILES:{files}", lint: "pwd" } } } },
  )
  const info = repoInfo(dir)
  const res = await runVerify({ info, workspace: "backend", checks: ["test_targeted"], files: ["backend/tests/test_x.py", "frontend/src/a.ts"] })
  assert.equal(res.status, "pass", JSON.stringify(res))
  assert.equal(res.workspace, "backend")
  assert.match(res.results[0].output_tail, new RegExp(`${path.join(dir, "backend")}\\n`))
  assert.match(res.results[0].output_tail, /FILES:tests\/test_x\.py\n/)
  assert.deepEqual(res.rejected_files, ["frontend/src/a.ts"])
  // No workspace entry: autodetect inside the subdirectory, never the top-level verify commands.
  const { contract } = loadContract(dir, { workspace: "frontend" })
  assert.equal(contract.verify.test_targeted, "npx --no-install vitest run {files}")
  assert.equal(contract.verify.lint, undefined)
  const pyWs = loadContract(dir, { workspace: "backend" })
  assert.equal(pyWs.contract.verify.test_filter, "python3 -m pytest -q {files} -k {filter}")
  for (const bad of ["../", "/etc", "missing", ".git"]) {
    const r = await runVerify({ info, workspace: bad, checks: ["lint"] })
    assert.equal(r.status, "error", bad)
    assert.equal(r.failure_class_hint, "harness")
  }
  const outside = mkTmp("pipe-run-outside-")
  fs.symlinkSync(outside, path.join(dir, "link"))
  assert.match((await runVerify({ info, workspace: "link", checks: ["lint"] })).reason, /outside the repository/)
  const root = await runVerify({ info, workspace: ".", checks: ["lint"] })
  assert.match(root.results[0].output_tail, /top-level/)
})
