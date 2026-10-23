import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { mkTmp } from "./_pipeline_testutil.mjs"

import { repoInfo, scratchDir } from "./_pipeline_core.js"
import { CONTRACT_PATH, findFreePort, isPortFree, loadContract, runSmoke, runVerify } from "./_pipeline_run.js"
import { detectPostgresNative, serviceProblem, wellKnownPostgresDirs, withServices } from "./_pipeline_services.js"

const node = JSON.stringify(process.execPath)

function mkRepo(files = {}, contract = null) {
  const dir = mkTmp("pipe-svc-")
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
    fs.writeFileSync(path.join(dir, CONTRACT_PATH), JSON.stringify(contract))
  }
  sh("add", "-A")
  sh("commit", "-qm", "init")
  return dir
}

// A tiny dependency: answers "pong" over HTTP on $PORT and writes its pid so tests can check it is gone.
const DEP = `
const http = require("http"); const fs = require("fs")
fs.writeFileSync(process.env.PID_FILE || "dep.pid", String(process.pid))
http.createServer((q, r) => r.end("pong")).listen(Number(process.env.PORT), "127.0.0.1")
`
const PING = `${node} -e "fetch(process.env.CACHE_URL).then(r=>r.text()).then(t=>{console.log('got',t);if(t!=='pong')process.exit(3)})"`

const cacheService = (extra = {}) => ({
  start: `${node} dep.js`,
  ready: { port: "${PORT}", timeout_s: 15 },
  env: { CACHE_URL: "http://127.0.0.1:${PORT}/", CACHE_PORT: "${PORT}" },
  ...extra,
})

const pidAliveSync = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Make sure the test never depends on a local PostgreSQL or Docker.
const NOTHING = () => ({ path: mkTmp("pipe-svc-emptybin-"), wellKnownDirs: [] })

test("serviceProblem: validates custom and postgres entries", () => {
  assert.equal(serviceProblem("db", { kind: "postgres" }), null)
  assert.equal(serviceProblem("db", { kind: "postgres", version: "16", env_var: "TEST_DATABASE_URL" }), null)
  assert.equal(serviceProblem("cache", { start: "redis-server" }), null)
  assert.match(serviceProblem("cache", {}), /start must be/)
  assert.match(serviceProblem("x", { kind: "mysql" }), /kind/)
  assert.match(serviceProblem("bad name", { start: "x" }), /name/)
  assert.match(serviceProblem("db", { kind: "postgres", env_var: "1X" }), /env_var/)
  assert.match(serviceProblem("c", { start: "x", env: { A: 1 } }), /env must be/)
  const dir = mkRepo({}, { services: { db: { kind: "postgres" }, broken: { start: "" } }, workspaces: { "backend/": { services: { cache: { start: "x" } } } } })
  fs.mkdirSync(path.join(dir, "backend"))
  const top = loadContract(dir)
  assert.deepEqual(Object.keys(top.contract.services), ["db"])
  assert.ok(top.problems.some((p) => p.includes("services.broken")))
  const ws = loadContract(dir, { workspace: "backend" })
  assert.deepEqual(Object.keys(ws.contract.services).sort(), ["cache", "db"])
  assert.equal(ws.contract.services.cache._cwd, path.join(dir, "backend"))
})

test("custom service: env reaches every check, and the service is always stopped with its port freed", async () => {
  const dir = mkRepo(
    { "dep.js": DEP },
    { services: { cache: cacheService() }, verify: { lint: PING, test_fast: `test "$CACHE_URL" = "http://127.0.0.1:$CACHE_PORT/" && ${PING}` } },
  )
  const res = await runVerify({ info: repoInfo(dir), checks: ["lint", "test_fast"], withServices: ["cache"] })
  assert.equal(res.status, "pass", JSON.stringify(res, null, 2))
  assert.match(res.results[0].output_tail, /got pong/)
  const [svc] = res.services
  assert.equal(svc.name, "cache")
  assert.equal(svc.how, "custom")
  assert.equal(svc.status, "ready")
  assert.equal(svc.started, true)
  assert.equal(svc.ready, true)
  assert.equal(svc.stopped, true)
  assert.deepEqual(svc.cleanup, { process_stopped: true, port_free: true })
  assert.deepEqual(svc.env_keys.sort(), ["CACHE_PORT", "CACHE_URL"])
  assert.equal(await isPortFree(svc.port), true)
  assert.equal(pidAliveSync(Number(fs.readFileSync(path.join(dir, "dep.pid"), "utf8"))), false)
})

test("custom service: stopped after a failing check, and on abort mid-check", async () => {
  const dir = mkRepo({ "dep.js": DEP }, { services: { cache: cacheService() }, verify: { lint: "exit 4", test_fast: "sleep 30" } })
  const fail = await runVerify({ info: repoInfo(dir), checks: ["lint"], withServices: ["cache"] })
  assert.equal(fail.status, "fail")
  assert.equal(fail.services[0].stopped, true)
  assert.equal(await isPortFree(fail.services[0].port), true)

  const ac = new AbortController()
  setTimeout(() => ac.abort(), 1500)
  const t0 = Date.now()
  const aborted = await runVerify({ info: repoInfo(dir), checks: ["test_fast"], withServices: ["cache"], signal: ac.signal })
  assert.ok(Date.now() - t0 < 15000)
  assert.equal(aborted.results[0].status, "aborted")
  assert.equal(aborted.services[0].stopped, true)
  assert.equal(await isPortFree(aborted.services[0].port), true)
  assert.equal(pidAliveSync(Number(fs.readFileSync(path.join(dir, "dep.pid"), "utf8"))), false)
})

test("services start in order, later ones see earlier env, optional stop command runs", async () => {
  const dir = mkRepo(
    { "dep.js": DEP },
    {
      services: {
        first: cacheService({ env: { FIRST_URL: "http://127.0.0.1:${PORT}/" } }),
        second: {
          start: `test -n "$FIRST_URL" && PID_FILE=dep2.pid exec ${node} dep.js`,
          ready: { url: "http://127.0.0.1:${PORT}/", timeout_s: 15 },
          env: { SECOND_PORT: "${PORT}" },
          stop: "echo stopped > stop-ran.txt",
        },
      },
      verify: { lint: `test -n "$FIRST_URL" && test -n "$SECOND_PORT"` },
    },
  )
  const res = await runVerify({ info: repoInfo(dir), checks: ["lint"], withServices: ["first", "second"] })
  assert.equal(res.status, "pass", JSON.stringify(res, null, 2))
  assert.deepEqual(res.services.map((s) => [s.name, s.status, s.stopped]), [["first", "ready", true], ["second", "ready", true]])
  assert.ok(fs.existsSync(path.join(dir, "stop-ran.txt")))
})

test("a service that crashes at startup blocks the run, nothing runs, earlier services are stopped", async () => {
  const dir = mkRepo(
    { "dep.js": DEP },
    {
      services: {
        cache: cacheService(),
        api: { start: `echo "Error: connect ECONNREFUSED 127.0.0.1:6379"; exit 1`, ready: { port: "${PORT}", timeout_s: 10 } },
      },
      verify: { lint: "echo should-not-run > ran.txt" },
    },
  )
  const res = await runVerify({ info: repoInfo(dir), checks: ["lint"], withServices: ["cache", "api"] })
  assert.equal(res.status, "blocked")
  assert.equal(res.phase, "services")
  assert.equal(res.failure_class_hint, "env")
  assert.match(res.reason, /service api/)
  assert.deepEqual(res.results.map((r) => r.status), ["not_run"])
  assert.ok(!fs.existsSync(path.join(dir, "ran.txt")))
  assert.equal(res.services[0].stopped, true)
  assert.equal(await isPortFree(res.services[0].port), true)
  assert.match(res.services[1].log_tail, /ECONNREFUSED/)
})

test("a fixed service port already in use is blocked and the foreign listener survives", async () => {
  const port = await findFreePort(43300, 43399)
  const foreign = net.createServer().listen(port, "127.0.0.1")
  await new Promise((r) => foreign.once("listening", r))
  try {
    const dir = mkRepo({ "dep.js": DEP }, { services: { cache: cacheService({ port }) }, verify: { lint: "true" } })
    const res = await runVerify({ info: repoInfo(dir), checks: ["lint"], withServices: ["cache"] })
    assert.equal(res.status, "blocked")
    assert.equal(res.failure_class_hint, "env")
    assert.equal(res.services[0].started, false)
    assert.equal(await isPortFree(port), false)
  } finally {
    foreign.close()
  }
})

test("unknown service names are a harness error before anything runs", async () => {
  const dir = mkRepo({}, { services: { db: { kind: "postgres" } }, verify: { lint: "echo x > ran.txt" } })
  const res = await runVerify({ info: repoInfo(dir), checks: ["lint"], withServices: ["redis"] })
  assert.equal(res.status, "error")
  assert.match(res.reason, /unknown service\(s\) redis; defined: db/)
  assert.ok(!fs.existsSync(path.join(dir, "ran.txt")))
})

test("postgres builtin: without native binaries or docker it is blocked (env) and says where it looked", async () => {
  const probe = NOTHING()
  const det = detectPostgresNative({ pathEnv: probe.path, wellKnownDirs: [] })
  assert.equal(det.found, false)
  const dir = mkRepo({}, { services: { db: { kind: "postgres", version: "16" } }, verify: { test_fast: "echo ran > ran.txt" } })
  const res = await runVerify({ info: repoInfo(dir), checks: ["test_fast"], withServices: ["db"], serviceOptions: probe })
  assert.equal(res.status, "blocked", JSON.stringify(res, null, 2))
  assert.equal(res.failure_class_hint, "env")
  const [svc] = res.services
  assert.equal(svc.status, "blocked")
  assert.equal(svc.how, "none")
  assert.match(svc.reason, /initdb \+ postgres not found/)
  assert.match(svc.reason, new RegExp(probe.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(svc.reason, /docker CLI not found in PATH/)
  assert.ok(!fs.existsSync(path.join(dir, "ran.txt")))
})

test("postgres builtin: a fake docker CLI whose daemon is down is reported as such", async () => {
  const bin = mkTmp("pipe-svc-fakedocker-")
  fs.writeFileSync(path.join(bin, "docker"), "#!/bin/sh\necho 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' >&2\nexit 1\n", { mode: 0o755 })
  const dir = mkRepo({}, { services: { db: { kind: "postgres" } }, verify: { test_fast: "true" } })
  const res = await runVerify({ info: repoInfo(dir), checks: ["test_fast"], withServices: ["db"], serviceOptions: { path: bin, wellKnownDirs: [] } })
  assert.equal(res.status, "blocked")
  assert.match(res.services[0].reason, /docker daemon not reachable/)
})

test("smoke: services declared in smoke.services are started first and stopped after", async () => {
  const SERVER = `require("http").createServer(async (q, r) => { const t = await (await fetch(process.env.CACHE_URL)).text(); r.end("via-" + t) }).listen(Number(process.env.PORT), "127.0.0.1")`
  const dir = mkRepo(
    { "dep.js": DEP, "server.js": SERVER },
    {
      services: { cache: cacheService() },
      smoke: {
        start: `${node} server.js`,
        services: ["cache"],
        ready: { port: "${PORT}", timeout_s: 15 },
        checks: [{ name: "proxied", url: "http://127.0.0.1:${PORT}/", expect_body: "^via-pong$" }],
      },
    },
  )
  const res = await runSmoke({ info: repoInfo(dir) })
  assert.equal(res.status, "pass", JSON.stringify(res, null, 2))
  assert.equal(res.services[0].stopped, true)
  assert.equal(await isPortFree(res.services[0].port), true)

  const missing = mkRepo({ "server.js": SERVER }, { smoke: { start: `${node} server.js`, services: ["nope"], checks: [] } })
  const bad = await runSmoke({ info: repoInfo(missing) })
  assert.equal(bad.status, "error")
  assert.match(bad.reason, /unknown service/)

  const blocked = mkRepo({ "server.js": SERVER }, { services: { db: { kind: "postgres" } }, smoke: { start: `${node} server.js`, services: ["db"], checks: [] } })
  const b = await runSmoke({ info: repoInfo(blocked), serviceOptions: NOTHING() })
  assert.equal(b.status, "blocked")
  assert.equal(b.phase, "services")
  assert.equal(b.failure_class_hint, "env")
})

test("withServices with no names just runs the function", async () => {
  const info = repoInfo(mkRepo())
  const r = await withServices({ info, defs: {}, names: [] }, async (env) => ({ env }))
  assert.deepEqual(r, { ok: true, value: { env: {} }, services: [] })
})

// ------------------------------------------------- real PostgreSQL (optional)

const nativePg = detectPostgresNative({ wellKnownDirs: wellKnownPostgresDirs() })
const psql = nativePg.found ? path.join(nativePg.binDir, "psql") : null

test("postgres builtin (integration): native ephemeral cluster, DATABASE_URL works, everything removed", { skip: !nativePg.found || !fs.existsSync(psql) ? "no native PostgreSQL" : false, timeout: 120000 }, async () => {
  const dir = mkRepo({}, {
    services: { db: { kind: "postgres", env_var: "TEST_DATABASE_URL" } },
    verify: { test_fast: `${JSON.stringify(psql)} "$TEST_DATABASE_URL" -tAc "create table t(x int); insert into t values (41); select x+1 from t" && test "$PGHOST" = 127.0.0.1 && test "$PGUSER" = postgres` },
  })
  const info = repoInfo(dir)
  const res = await runVerify({ info, checks: ["test_fast"], withServices: ["db"] })
  assert.equal(res.status, "pass", JSON.stringify(res, null, 2))
  assert.match(res.results[0].output_tail, /\b42\b/)
  const [svc] = res.services
  assert.equal(svc.how, "native")
  assert.equal(svc.stopped, true)
  assert.equal(svc.cleanup.port_free, true)
  assert.equal(svc.cleanup.data_removed, true)
  assert.ok(svc.env_keys.includes("TEST_DATABASE_URL"))
  assert.equal(await isPortFree(svc.port), true)
  const leftovers = fs.existsSync(scratchDir(info)) ? fs.readdirSync(scratchDir(info)).filter((n) => n.startsWith("pg-")) : []
  assert.deepEqual(leftovers, [])
})
