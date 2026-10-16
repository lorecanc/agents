import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"

import { mkTmp } from "./_pipeline_testutil.mjs"
import { repoInfo } from "./_pipeline_core.js"
import { isPortFree, findFreePort } from "./_pipeline_run.js"
import { readService, serviceStatus, startService, stopService, stopServicesOwnedBy } from "./_pipeline_serve.js"

const node = JSON.stringify(process.execPath)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const SERVER = (label = "app") => `
const http = require("http")
http.createServer((req, res) => { res.writeHead(200); res.end(${JSON.stringify(label)}) }).listen(Number(process.env.PORT), "127.0.0.1")
`

function mkRepo(files = {}, contract = null) {
  const dir = mkTmp("pipe-serve-")
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
    fs.writeFileSync(path.join(dir, ".opencode", "pipeline.json"), JSON.stringify(contract))
  }
  sh("add", "-A")
  sh("commit", "-qm", "init")
  return repoInfo(dir)
}

const smoke = (extra = {}) => ({
  smoke: { start: `${node} server.js`, ready: { url: "http://127.0.0.1:${PORT}/", timeout_s: 15 }, checks: [], ...extra },
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
const scratchLogs = (info) => {
  try {
    return fs.readdirSync(path.join(info.common, "opencode-scratch")).filter((f) => f.startsWith("serve-"))
  } catch {
    return []
  }
}

test("start, status, stop: serves the page, then leaves no process, port, record or log behind", async () => {
  const info = mkRepo({ "server.js": SERVER("hello") }, smoke())
  const started = await startService({ info, ownerRoot: "ses_A" })
  assert.equal(started.status, "running", JSON.stringify(started))
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
  assert.equal(await get(started.url), "hello")
  assert.ok(started.expires_in_s > 800 && started.expires_in_s <= 900)
  const st = await serviceStatus(info)
  assert.equal(st.status, "running")
  assert.equal(st.listening, true)
  const stopped = await stopService({ info, callerRoot: "ses_A" })
  assert.equal(stopped.status, "stopped")
  assert.equal(stopped.process_stopped, true)
  assert.equal(stopped.port_free, true)
  assert.equal(readService(info), null)
  assert.deepEqual(scratchLogs(info), [])
  assert.equal((await serviceStatus(info)).status, "stopped")
  assert.equal((await stopService({ info, callerRoot: "ses_A" })).note, "nothing was running")
})

test("startService: autodetects a package start script when no pipeline contract exists", async () => {
  const info = mkRepo({
    "package.json": JSON.stringify({ scripts: { start: "node server.js" } }),
    "server.js": SERVER("autodetected"),
  })
  const started = await startService({ info, ownerRoot: "ses_auto" })
  assert.equal(started.status, "running", JSON.stringify(started))
  assert.equal(readService(info).spec, "autodetect")
  assert.equal(await get(started.url), "autodetected")
  const stopped = await stopService({ info, callerRoot: "ses_auto" })
  assert.equal(stopped.status, "stopped")
  assert.equal(stopped.process_stopped, true)
  assert.equal(stopped.port_free, true)
})

test("start is idempotent and only the owner can stop a live service of another live session", async () => {
  const info = mkRepo({ "server.js": SERVER() }, smoke())
  const a = await startService({ info, ownerRoot: "ses_A" })
  const again = await startService({ info, ownerRoot: "ses_A" })
  assert.equal(again.reused, true)
  assert.equal(again.shared, false)
  assert.equal(again.port, a.port)
  const other = await startService({ info, ownerRoot: "ses_B" })
  assert.equal(other.reused, true)
  assert.equal(other.shared, true)
  const refused = await stopService({ info, callerRoot: "ses_B" })
  assert.equal(refused.status, "refused")
  assert.match(refused.reason, /belongs to another active session/)
  assert.equal(await get(a.url), "app", "the service must still be running")
  assert.equal((await stopService({ info, callerRoot: "ses_B", force: true })).status, "stopped")
  assert.equal(await portFreeSoon(a.port), true)
})

test("a service whose owner process is dead can be stopped by anyone", async () => {
  const info = mkRepo({ "server.js": SERVER() }, smoke())
  const a = await startService({ info, ownerRoot: "ses_A" })
  const rec = readService(info)
  fs.writeFileSync(path.join(info.stateDir, "serve", "default.json"), JSON.stringify({ ...rec, ownerPid: 2 ** 22 + 77 }))
  const res = await stopService({ info, callerRoot: "ses_B" })
  assert.equal(res.status, "stopped")
  assert.equal(await portFreeSoon(a.port), true)
})

test("TTL: the supervisor stops the service by itself", async () => {
  const info = mkRepo({ "server.js": SERVER() }, smoke())
  const a = await startService({ info, ownerRoot: "ses_A", ttlS: 2 })
  assert.equal(a.status, "running")
  assert.equal(await portFreeSoon(a.port, 9000), true, "service must be gone after the TTL")
  const st = await serviceStatus(info) // inside the supervisor's shutdown window: must already say stopped
  assert.equal(st.status, "stopped")
  assert.match(st.note, /already ended/)
  assert.equal(readService(info), null)
  assert.deepEqual(scratchLogs(info), [])
})

test("status never reports a service as running after its TTL or owner are gone, even during the shutdown window", async () => {
  const info = mkRepo({ "server.js": SERVER() }, smoke())
  const a = await startService({ info, ownerRoot: "ses_A", ttlS: 600 })
  const rec = readService(info)
  fs.writeFileSync(path.join(info.stateDir, "serve", "default.json"), JSON.stringify({ ...rec, expiresAt: Date.now() - 1 }))
  const st = await serviceStatus(info)
  assert.equal(st.status, "stopped")
  assert.equal(await portFreeSoon(a.port), true, "reaping must also kill the service")
  assert.equal(await pidGoneSoon(rec.supervisorPid), true)
  // and a new start after an ended-but-lingering one replaces it instead of reusing it
  const b = await startService({ info, ownerRoot: "ses_A" })
  assert.equal(b.status, "running")
  assert.equal(b.reused, undefined)
  await stopService({ info, callerRoot: "ses_A" })
})

test("owner death (even kill -9) stops the service without anyone calling stop", async () => {
  const info = mkRepo({ "server.js": SERVER() }, smoke())
  const owner = spawn("sleep", ["60"], { stdio: "ignore", detached: true })
  owner.unref()
  try {
    const a = await startService({ info, ownerRoot: "ses_A", ownerPid: owner.pid })
    assert.equal(a.status, "running")
    assert.equal(await get(a.url), "app")
    process.kill(owner.pid, "SIGKILL")
    assert.equal(await portFreeSoon(a.port, 9000), true, "service must die with its owner")
  } finally {
    try {
      process.kill(owner.pid, "SIGKILL")
    } catch {
      /* already gone */
    }
    await stopService({ info, callerRoot: "ses_A", force: true })
  }
})

test("everything the service spawned dies with it (grandchildren)", async () => {
  const info = mkRepo(
    { "server.js": SERVER(), "start.sh": "sleep 300 &\necho $! > grandchild.pid\nexec " + node + " server.js\n" },
    { smoke: { start: "sh start.sh", ready: { url: "http://127.0.0.1:${PORT}/", timeout_s: 15 }, checks: [] } },
  )
  const a = await startService({ info, ownerRoot: "ses_A" })
  assert.equal(a.status, "running", JSON.stringify(a))
  const gc = Number(fs.readFileSync(path.join(info.top, "grandchild.pid"), "utf8"))
  assert.equal(pidGone(gc), false, "the grandchild is running while the service runs")
  await stopService({ info, callerRoot: "ses_A" })
  await sleep(300)
  assert.equal(pidGone(gc), true, "the grandchild must be killed too")
})

test("stop still cleans up if the supervisor itself was killed with SIGKILL", async () => {
  const info = mkRepo({ "server.js": SERVER() }, smoke())
  const a = await startService({ info, ownerRoot: "ses_A" })
  process.kill(readService(info).supervisorPid, "SIGKILL")
  await sleep(300)
  assert.equal(await get(a.url), "app", "the orphaned service keeps running without its supervisor")
  const res = await stopService({ info, callerRoot: "ses_A" })
  assert.equal(res.port_free, true)
})

test("startup crash with an environment signature is classified env and nothing is left", async () => {
  const info = mkRepo({}, { smoke: { start: `echo "Error: connect ECONNREFUSED 127.0.0.1:5432"; exit 1`, ready: { port: "${PORT}", timeout_s: 10 }, checks: [] } })
  const res = await startService({ info, ownerRoot: "ses_A" })
  assert.equal(res.status, "fail")
  assert.equal(res.failure_class_hint, "env")
  assert.match(res.log_tail, /ECONNREFUSED/)
  assert.equal(readService(info), null)
  assert.deepEqual(scratchLogs(info), [])
})

test("a plain crash is unclassified and asks for a decision; a never-ready service is a harness problem and is killed", async () => {
  const crash = mkRepo({}, { smoke: { start: `echo "SyntaxError: Unexpected token" >&2; exit 1`, ready: { port: "${PORT}", timeout_s: 10 }, checks: [] } })
  const a = await startService({ info: crash, ownerRoot: "ses_A" })
  assert.equal(a.failure_class_hint, "unclassified")
  assert.match(a.note, /read log_tail/)
  const hang = mkRepo({}, { smoke: { start: "sleep 120", ready: { port: "${PORT}", timeout_s: 1 }, checks: [] } })
  const t0 = Date.now()
  const b = await startService({ info: hang, ownerRoot: "ses_A" })
  assert.equal(b.status, "fail")
  assert.equal(b.failure_class_hint, "harness")
  assert.ok(Date.now() - t0 < 15000)
  assert.equal(readService(hang), null)
})

test("an occupied fixed port is an env block and the foreign process is not touched", async () => {
  const port = await findFreePort(43400, 43499)
  const foreign = net.createServer().listen(port, "127.0.0.1")
  await new Promise((r) => foreign.once("listening", r))
  const info = mkRepo({ "server.js": SERVER() }, smoke({ port }))
  const res = await startService({ info, ownerRoot: "ses_A" })
  assert.equal(res.status, "blocked")
  assert.equal(res.failure_class_hint, "env")
  assert.equal(await isPortFree(port), false)
  foreign.close()
})

test("contract: serve section wins over smoke; none at all is inconclusive; urls must be local", async () => {
  const both = mkRepo(
    { "server.js": SERVER("smoke-server"), "dev.js": SERVER("dev-server") },
    { smoke: { start: `${node} server.js`, ready: { port: "${PORT}", timeout_s: 15 }, checks: [] }, serve: { start: `${node} dev.js`, ready: { port: "${PORT}", timeout_s: 15 } } },
  )
  const a = await startService({ info: both, ownerRoot: "ses_A" })
  assert.equal(await get(a.url), "dev-server")
  await stopService({ info: both, callerRoot: "ses_A" })

  const none = await startService({ info: mkRepo(), ownerRoot: "ses_A" })
  assert.equal(none.status, "inconclusive")
  assert.match(none.reason, /no serve\/smoke contract/)

  const remote = mkRepo({ "server.js": SERVER() }, { serve: { start: `${node} server.js`, url: "http://example.com/", ready: { port: "${PORT}", timeout_s: 15 } } })
  const bad = await startService({ info: remote, ownerRoot: "ses_A" })
  assert.equal(bad.status, "error")
  assert.match(bad.reason, /must target localhost/)
  assert.equal(readService(remote), null)
})

test("env_file values reach the service and are never returned", async () => {
  const info = mkRepo(
    { "server.js": `const http=require("http");http.createServer((q,r)=>{r.writeHead(200);r.end(process.env.SECRET_X==="s3cr3t"?"has-secret":"no-secret")}).listen(Number(process.env.PORT),"127.0.0.1")`, ".env.serve": "SECRET_X=s3cr3t\n" },
    smoke({ env_file: ".env.serve" }),
  )
  const a = await startService({ info, ownerRoot: "ses_A" })
  assert.equal(await get(a.url), "has-secret")
  assert.ok(!JSON.stringify(a).includes("s3cr3t"))
  await stopService({ info, callerRoot: "ses_A" })
})

test("stopServicesOwnedBy stops only the service of the given root session", async () => {
  const info = mkRepo({ "server.js": SERVER() }, smoke())
  const a = await startService({ info, ownerRoot: "ses_A" })
  assert.equal(await stopServicesOwnedBy(info, "ses_other"), null)
  assert.equal(await get(a.url), "app")
  const res = await stopServicesOwnedBy(info, "ses_A")
  assert.equal(res.status, "stopped")
  assert.equal(await portFreeSoon(a.port), true)
})

test("a repository removed while the service runs does not get its state recreated", async () => {
  const info = mkRepo({ "server.js": SERVER() }, smoke())
  const a = await startService({ info, ownerRoot: "ses_A", ttlS: 2 })
  const rec = readService(info)
  fs.rmSync(info.top, { recursive: true, force: true })
  assert.equal(await portFreeSoon(a.port, 9000), true)
  assert.equal(await pidGoneSoon(rec.supervisorPid), true, "the supervisor must finish too")
  assert.equal(fs.existsSync(info.top), false)
})
