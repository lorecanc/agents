import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

import { mkTmp } from "./_testutil.test.mjs"
import { repoInfo } from "./_repo.js"
import { findFreePort, isPortFree } from "./_run.js"
import { readService, serviceStatus, startService, stopService, stopServicesOwnedBy } from "./_serve.js"

const node = JSON.stringify(process.execPath)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function mkRepo(files = {}, contract = null) {
  const dir = mkTmp("pipe-serve-services-")
  const sh = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
  sh("init", "-q", "-b", "main")
  sh("config", "user.email", "t@example.com")
  sh("config", "user.name", "T")
  sh("config", "core.autocrlf", "false")
  fs.writeFileSync(path.join(dir, "README.md"), "x\n")
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
  if (contract) {
    fs.mkdirSync(path.join(dir, ".opencode"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".opencode", "pipeline.json"), JSON.stringify(contract))
  }
  sh("add", "-A")
  sh("commit", "-qm", "init")
  return repoInfo(dir)
}

const backend = `
const http = require("http"); const fs = require("fs")
fs.writeFileSync("backend.pid", String(process.pid))
fs.writeFileSync("backend.port", String(process.env.PORT))
http.createServer((q, r) => r.end("pong")).listen(Number(process.env.PORT), "127.0.0.1")
`

const app = `
const http = require("http")
http.createServer(async (q, r) => {
  if (!process.env.BACKEND_URL) return r.end("no-backend")
  try { r.end(process.env.BACKEND_URL + "|" + await (await fetch(process.env.BACKEND_URL)).text()) }
  catch (e) { r.statusCode = 500; r.end(e.message) }
}).listen(Number(process.env.PORT), "127.0.0.1")
`

const trackedApp = `
const fs = require("fs"); const http = require("http")
fs.writeFileSync("server.pid", String(process.pid))
fs.writeFileSync("server.port", String(process.env.PORT))
http.createServer((q, r) => r.end("pong")).listen(Number(process.env.PORT), "127.0.0.1")
`

const backingService = (extra = {}) => ({
  start: `${node} backend.cjs`,
  ready: { port: "${PORT}", timeout_s: 15 },
  env: { BACKEND_URL: "http://127.0.0.1:${PORT}/" },
  ...extra,
})

const serve = (extra = {}) => ({
  start: `${node} app.cjs`,
  ready: { url: "http://127.0.0.1:${PORT}/", timeout_s: 15 },
  services: ["backend"],
  ...extra,
})

const get = async (url) => (await fetch(url, { signal: AbortSignal.timeout(2000) })).text()
const portFreeSoon = async (port, ms = 6000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await isPortFree(port)) return true
    await sleep(200)
  }
  return false
}
const pidGone = (pid) => {
  try {
    process.kill(pid, 0)
    return false
  } catch (e) {
    return e.code === "ESRCH"
  }
}
const pidGoneSoon = async (pid, ms = 8000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pidGone(pid)) return true
    await sleep(200)
  }
  return false
}

test("with_services passes backing env to the server and stop frees both processes and ports", { skip: process.platform === "win32" }, async () => {
  const info = mkRepo({ "backend.cjs": backend, "app.cjs": app }, { services: { backend: backingService() }, serve: serve() })
  const started = await startService({ info, ownerRoot: "ses_A", withServices: true })
  assert.equal(started.status, "running", JSON.stringify(started))
  assert.equal(started.services[0].name, "backend")
  assert.equal(started.services[0].status, "ready")
  assert.equal((await serviceStatus(info)).services[0].status, "ready")
  const body = await get(started.url)
  assert.match(body, /^http:\/\/127\.0\.0\.1:\d+\/\|pong$/)

  const rec = readService(info)
  const [dep] = rec.dependentServices
  assert.deepEqual(JSON.parse(JSON.stringify(rec.dependentServices)), rec.dependentServices)
  const backendPid = Number(fs.readFileSync(path.join(info.top, "backend.pid"), "utf8"))
  const stopped = await stopService({ info, callerRoot: "ses_A" })
  assert.equal(stopped.status, "stopped")
  assert.equal(stopped.port_free, true)
  assert.equal(readService(info), null)
  assert.equal(await portFreeSoon(dep.port), true)
  assert.equal(await pidGoneSoon(backendPid), true)
  assert.equal(await pidGoneSoon(rec.supervisorPid), true)
})

test("persisted serve state excludes env_file secrets and restores them for a service stop command", { skip: process.platform === "win32" }, async () => {
  const secret = "top_secret_val_999"
  const info = mkRepo(
    { "backend.cjs": backend, "app.cjs": app, ".env": `SUPER_SECRET_TOKEN=${secret}\n` },
    {
      services: {
        backend: backingService({ env_file: ".env", stop: `printf '%s' "$SUPER_SECRET_TOKEN" > stop-env.txt` }),
      },
      serve: serve(),
    },
  )
  const started = await startService({ info, ownerRoot: "ses_secret", withServices: true })
  assert.equal(started.status, "running", JSON.stringify(started))

  try {
    const stateFile = path.join(info.stateDir, "serve", "default.json")
    const rawStateJson = fs.readFileSync(stateFile, "utf8")
    assert.equal(rawStateJson.includes(secret), false)

    const stopped = await stopService({ info, callerRoot: "ses_secret" })
    assert.equal(stopped.status, "stopped")
    assert.equal(fs.readFileSync(path.join(info.top, "stop-env.txt"), "utf8"), secret)
  } finally {
    if (readService(info)) await stopService({ info, callerRoot: "ses_secret", force: true })
  }
})

test("session idle cleanup stops both the server and its managed backing services", { skip: process.platform === "win32" }, async () => {
  const info = mkRepo({ "backend.cjs": backend, "app.cjs": app }, { services: { backend: backingService() }, serve: serve() })
  const started = await startService({ info, ownerRoot: "ses_idle", withServices: true })
  const rec = readService(info)
  const depPort = rec.dependentServices[0].port
  const depPid = Number(fs.readFileSync(path.join(info.top, "backend.pid"), "utf8"))
  const stopped = await stopServicesOwnedBy(info, "ses_idle")
  assert.equal(stopped.status, "stopped")
  assert.equal(await portFreeSoon(started.port), true)
  assert.equal(await portFreeSoon(depPort), true)
  assert.equal(await pidGoneSoon(depPid), true)
  assert.equal(readService(info), null)
})

test("backing startup failure rolls back earlier services and writes no serve state", { skip: process.platform === "win32" }, async () => {
  const info = mkRepo(
    { "backend.cjs": backend, "app.cjs": app },
    {
      services: {
        backend: backingService(),
        broken: { start: "echo backend failed >&2; exit 1", ready: { port: "${PORT}", timeout_s: 10 } },
      },
      serve: serve({ services: ["backend", "broken"] }),
    },
  )
  const result = await startService({ info, ownerRoot: "ses_A", withServices: true })
  assert.equal(result.status, "fail")
  assert.equal(result.phase, "services")
  assert.equal(readService(info), null)
  assert.equal(result.services[0].stopped, true)
  const backendPid = Number(fs.readFileSync(path.join(info.top, "backend.pid"), "utf8"))
  assert.equal(await portFreeSoon(result.services[0].port), true)
  assert.equal(await pidGoneSoon(backendPid), true)
})

test("main server readiness failure stops already-started backing services", { skip: process.platform === "win32" }, async () => {
  const info = mkRepo(
    { "backend.cjs": backend },
    {
      services: { backend: backingService() },
      serve: {
        start: "sleep 120",
        ready: { port: "${PORT}", timeout_s: 1 },
        services: ["backend"],
      },
    },
  )
  const result = await startService({ info, ownerRoot: "ses_A", withServices: true })
  assert.equal(result.status, "fail")
  assert.equal(result.phase, "ready")
  assert.equal(readService(info), null)
  const servicePort = Number(fs.readFileSync(path.join(info.top, "backend.port"), "utf8"))
  const backendPid = Number(fs.readFileSync(path.join(info.top, "backend.pid"), "utf8"))
  assert.equal(await portFreeSoon(servicePort), true)
  assert.equal(await pidGoneSoon(backendPid), true)
})

test("the server TTL also expires managed backing services without a stop call", { skip: process.platform === "win32" }, async () => {
  const info = mkRepo({ "backend.cjs": backend, "app.cjs": trackedApp }, { services: { backend: backingService() }, serve: serve() })
  const started = await startService({ info, ownerRoot: "ses_ttl", withServices: true, ttlS: 2 })
  assert.equal(started.status, "running", JSON.stringify(started))
  const rec = readService(info)
  const depPort = rec.dependentServices[0].port
  const depPid = Number(fs.readFileSync(path.join(info.top, "backend.pid"), "utf8"))
  const serverPid = Number(fs.readFileSync(path.join(info.top, "server.pid"), "utf8"))

  assert.equal(rec.ttlS, 2)
  assert.equal(await pidGoneSoon(rec.supervisorPid), true)
  assert.equal(await pidGoneSoon(serverPid), true)
  assert.equal(await pidGoneSoon(depPid), true)
  assert.equal(await portFreeSoon(started.port), true)
  assert.equal(await portFreeSoon(depPort), true)
})

test("post-service startup exceptions stop every started process and leave no serve record", { skip: process.platform === "win32" }, async () => {
  const mainPort = await findFreePort()
  const info = mkRepo(
    { "backend.cjs": backend, "app.cjs": trackedApp },
    {
      services: { backend: backingService() },
      serve: serve({ start: `${node} app.cjs`, port: mainPort }),
    },
  )
  const signal = {
    get aborted() {
      if (fs.existsSync(path.join(info.top, "server.pid"))) throw new Error("simulated readiness exception")
      return false
    },
  }
  const result = await startService({ info, ownerRoot: "ses_error", withServices: true, signal })
  assert.equal(result.status, "error")
  assert.match(result.reason, /simulated readiness exception/)
  assert.equal(readService(info), null)
  assert.equal(fs.existsSync(path.join(info.stateDir, "serve", "default.json")), false)

  const depPort = Number(fs.readFileSync(path.join(info.top, "backend.port"), "utf8"))
  const depPid = Number(fs.readFileSync(path.join(info.top, "backend.pid"), "utf8"))
  const serverPid = Number(fs.readFileSync(path.join(info.top, "server.pid"), "utf8"))
  assert.equal(await pidGoneSoon(serverPid), true)
  assert.equal(await pidGoneSoon(depPid), true)
  assert.equal(await portFreeSoon(depPort), true)
  assert.equal(await isPortFree(mainPort), true)
})

test("unknown declared service is a harness error before startup", async () => {
  const info = mkRepo({ "app.cjs": app }, { services: { backend: backingService() }, serve: serve({ services: ["missing"] }) })
  const result = await startService({ info, ownerRoot: "ses_A", withServices: true })
  assert.equal(result.status, "error")
  assert.equal(result.failure_class_hint, "harness")
  assert.match(result.reason, /unknown service\(s\) missing/)
  assert.equal(readService(info), null)
})

test("a running server can be upgraded from unmanaged to managed backing services", { skip: process.platform === "win32" }, async () => {
  const info = mkRepo({ "backend.cjs": backend, "app.cjs": app }, { services: { backend: backingService() }, serve: serve() })
  const first = await startService({ info, ownerRoot: "ses_A" })
  assert.equal(first.status, "running")
  assert.equal(first.services, undefined)

  const upgraded = await startService({ info, ownerRoot: "ses_A", withServices: true })
  assert.equal(upgraded.status, "running", JSON.stringify(upgraded))
  assert.equal(upgraded.reused, undefined)
  assert.equal(upgraded.services[0].status, "ready")
  assert.match(await get(upgraded.url), /^http:\/\/127\.0\.0\.1:\d+\/\|pong$/)
  assert.equal(readService(info).dependentServices.length, 1)
  await stopService({ info, callerRoot: "ses_A" })
})
