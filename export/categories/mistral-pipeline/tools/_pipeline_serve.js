// Controlled lifecycle for a long-running local service (a dev server the browser needs).
//
// The rule that shapes every line here: a service started for the pipeline must NEVER outlive its
// purpose. Three independent mechanisms stop it, and the first to fire wins:
//   1. explicit stop (the agent that started it, or the plugin when the owning session goes idle);
//   2. the supervisor notices the owning opencode process is gone (even after kill -9);
//   3. a hard TTL (default 15 minutes, at most 60).
// The supervisor is a tiny POSIX sh process in its own session. It runs the service in the same process
// group, so "stop" means "kill the group": the service and everything it spawned die together.

import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"

import { ensureScratch, isInside, pidAlive, realpathLoose, redact, withLock } from "./_pipeline_core.js"
import {
  envHint, findFreePort, groupAlive, isPortFree, killTree, loadContract, parseEnvFile, portListening, runtimeEnv, waitReady,
} from "./_pipeline_run.js"
import { SUPERVISOR } from "./_pipeline_services.js"

export const DEFAULT_TTL_S = 900
export const MAX_TTL_S = 3600
const SERVICE = "default"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const serveDir = (info) => path.join(info.stateDir, "serve")
const recordFile = (info) => path.join(serveDir(info), `${SERVICE}.json`)

export function readService(info) {
  try {
    return JSON.parse(fs.readFileSync(recordFile(info), "utf8"))
  } catch {
    return null
  }
}

function writeService(info, rec) {
  if (!fs.existsSync(info.common)) return
  fs.mkdirSync(serveDir(info), { recursive: true })
  const tmp = `${recordFile(info)}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(rec))
  fs.renameSync(tmp, recordFile(info))
}

function dropService(info, rec) {
  fs.rmSync(recordFile(info), { force: true })
  if (rec && rec.log) fs.rmSync(rec.log, { force: true })
}

const alive = (rec) => Boolean(rec && groupAlive(rec.supervisorPid))

/**
 * The supervisor stops the service when the TTL expires or the owner process is gone, but it needs up to
 * ~3 seconds to finish (TERM, grace, KILL). In that window the group is still alive although the service
 * is already ending: report it as ended, and finish the job.
 */
const ending = (rec, now = Date.now()) => Boolean(rec && (now >= rec.expiresAt || !pidAlive(rec.ownerPid)))

async function reapIfEnding(info, rec) {
  if (!rec || !ending(rec)) return false
  if (alive(rec)) await killTree(rec.supervisorPid, 500)
  return true
}
const tail = (text, n) => redact(text.length > n ? "…" + text.slice(-n) : text)

function readTail(file, n = 3000) {
  try {
    return tail(fs.readFileSync(file, "utf8"), n)
  } catch {
    return ""
  }
}

/** The contract section used to serve: `serve`, `smoke`, or an autodetected script. */
function serveSpec(info) {
  const { contract, problems, smokeHint } = loadContract(info.top)
  const raw = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(info.top, ".opencode", "pipeline.json"), "utf8"))
    } catch {
      return null
    }
  })()
  const spec = raw && raw.serve && typeof raw.serve.start === "string" ? raw.serve : contract.smoke
  if (spec) return { spec, problems, smokeHint, from: raw && raw.serve && typeof raw.serve.start === "string" ? "serve" : "smoke" }
  const auto = contract.autodetected_smoke || (smokeHint && typeof smokeHint.start === "string" && smokeHint.start.trim() ? smokeHint : null)
  if (auto) return { spec: auto, problems, smokeHint, from: "autodetect" }
  return { spec: null, problems, smokeHint, from: "smoke" }
}

function describe(info, rec) {
  const remaining = Math.max(0, Math.round((rec.expiresAt - Date.now()) / 1000))
  return {
    status: "running",
    url: rec.url,
    port: rec.port,
    expires_in_s: remaining,
    owner_session: rec.ownerRoot,
    started_at: new Date(rec.startedAt).toISOString(),
  }
}

export async function serviceStatus(info) {
  const rec = readService(info)
  if (!rec) return { status: "stopped" }
  const wasEnding = await reapIfEnding(info, rec)
  if (wasEnding || !alive(rec)) {
    const log = readTail(rec.log, 2000)
    dropService(info, rec)
    return { status: "stopped", note: "the service had already ended (TTL, crash, or owner gone)", log_tail: log }
  }
  const listening = await portListening(rec.port)
  return { ...describe(info, rec), listening, log_tail: readTail(rec.log, 1500) }
}

/**
 * Start the service (idempotent: an already running one is reused).
 * ownerRoot: root session that owns it. ownerPid: process whose death stops it (opencode itself).
 */
export async function startService({ info, ownerRoot, ownerPid = process.pid, ttlS = DEFAULT_TTL_S, signal }) {
  const ttl = Math.min(MAX_TTL_S, Math.max(1, Math.round(Number(ttlS) || DEFAULT_TTL_S)))
  const { spec, problems, smokeHint, from } = serveSpec(info)
  if (!spec) {
    return {
      status: "inconclusive",
      failure_class_hint: "harness",
      reason: "no serve/smoke contract: add a `serve` (or `smoke`) section to .opencode/pipeline.json",
      contract_problems: problems,
      suggested_serve: smokeHint,
    }
  }
  const body = async () => {
    const existing = readService(info)
    if (existing && (await reapIfEnding(info, existing))) {
      dropService(info, existing)
    } else if (existing && alive(existing)) {
      return { ...describe(info, existing), reused: true, shared: existing.ownerRoot !== ownerRoot }
    } else if (existing) dropService(info, existing)

    let port
    if (Number.isInteger(spec.port)) {
      port = spec.port
      if (!(await isPortFree(port))) {
        return { status: "blocked", failure_class_hint: "env", reason: `port ${port} is already in use by another process; refusing to kill it` }
      }
    } else port = await findFreePort()
    const subst = (s) => String(s).replaceAll("${PORT}", String(port))

    let fileEnv = {}
    if (spec.env_file) {
      const abs = realpathLoose(path.resolve(info.top, spec.env_file))
      if (!isInside(info.top, abs)) return { status: "error", failure_class_hint: "harness", reason: "env_file must be inside the repository" }
      fileEnv = parseEnvFile(abs)
    }
    const extra = {}
    for (const [k, v] of Object.entries(spec.env || {})) extra[k] = subst(v)
    const env = { ...runtimeEnv(info, { ...fileEnv, ...extra, PORT: String(port) }), PIPELINE_SERVE_CMD: subst(spec.start) }

    const scratch = ensureScratch(info)
    const log = path.join(scratch, `serve-${Date.now()}.log`)
    const fd = fs.openSync(log, "a")
    let exited = false
    const child = spawn("sh", ["-c", SUPERVISOR, "pipeline-supervisor", String(ownerPid), String(ttl)], {
      cwd: info.top,
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
    })
    child.unref()
    child.on("exit", () => {
      exited = true
    })
    child.on("error", () => {
      exited = true
    })
    fs.closeSync(fd)
    const urlTemplate = typeof spec.url === "string" ? spec.url : "http://127.0.0.1:${PORT}/"
    const url = subst(urlTemplate)
    try {
      if (!new URL(url).hostname.match(/^(localhost|127\.0\.0\.1|\[::1\]|::1)$/)) {
        await killTree(child.pid)
        fs.rmSync(log, { force: true })
        return { status: "error", failure_class_hint: "harness", reason: `serve url must target localhost (got ${url})` }
      }
    } catch {
      await killTree(child.pid)
      fs.rmSync(log, { force: true })
      return { status: "error", failure_class_hint: "harness", reason: `invalid serve url ${url}` }
    }
    const rec = {
      name: SERVICE, supervisorPid: child.pid, ownerPid, ownerRoot, port, url, startedAt: Date.now(), expiresAt: Date.now() + ttl * 1000, ttlS: ttl, log, spec: from,
    }
    writeService(info, rec)

    const timeoutS = Math.min(Number(spec.ready && spec.ready.timeout_s) || 60, 180)
    const ready = await waitReady(spec.ready, {
      portNum: port, subst, readLog: () => { try { return fs.readFileSync(log, "utf8") } catch { return "" } }, isExited: () => exited, timeoutMs: timeoutS * 1000, signal,
    })
    if (!ready.ok) {
      const text = readTail(log, 5000)
      await killTree(child.pid)
      dropService(info, rec)
      return {
        status: "fail",
        phase: "ready",
        reason: ready.reason,
        failure_class_hint: ready.harness ? "harness" : envHint(text) ? "env" : ready.exited ? "unclassified" : "harness",
        log_tail: text,
        ...(ready.exited && !envHint(text) ? { note: "the service stopped at startup without an environment signature: read log_tail and decide between a code defect and an environment problem" } : {}),
      }
    }
    const deps = Array.isArray(spec.services) && spec.services.length
      ? ` The ${from} section declares services (${spec.services.join(", ")}): pipeline_serve does not start them, so they must already be reachable.`
      : ""
    return {
      ...describe(info, rec),
      ready_ms: ready.ms,
      note: `Stops by itself in ${ttl}s, when this opencode process ends, or on pipeline_serve stop. Always call stop when you are done.${deps}`,
    }
  }
  try {
    return await withLock(info, "serve", body, { owner: ownerRoot || "serve", timeoutMs: 60 * 1000 })
  } catch (e) {
    if (e.code === "LOCK_TIMEOUT") return { status: "blocked", failure_class_hint: "harness", reason: `another session is starting the service (${e.message})` }
    return { status: "error", failure_class_hint: "harness", reason: e.message }
  }
}

/** Stop the service. Only the owner session may stop a live service owned by another live session. */
export async function stopService({ info, callerRoot, force = false }) {
  const rec = readService(info)
  if (!rec) return { status: "stopped", note: "nothing was running" }
  if (alive(rec) && !force && rec.ownerRoot && callerRoot && rec.ownerRoot !== callerRoot && pidAlive(rec.ownerPid)) {
    return { ...describe(info, rec), status: "refused", reason: `the service belongs to another active session (${rec.ownerRoot}); only its owner can stop it` }
  }
  const log = readTail(rec.log, 1500)
  await killTree(rec.supervisorPid)
  let free = false
  for (let i = 0; i < 20 && !free; i++) {
    free = await isPortFree(rec.port)
    if (!free) await sleep(250)
  }
  const stopped = !groupAlive(rec.supervisorPid)
  dropService(info, rec)
  return { status: "stopped", process_stopped: stopped, port_free: free, log_tail: log }
}

/** Stop the service when it belongs to the given root session (used when that session goes idle). */
export async function stopServicesOwnedBy(info, rootId) {
  const rec = readService(info)
  if (!rec || rec.ownerRoot !== rootId) return null
  return stopService({ info, callerRoot: rootId })
}
