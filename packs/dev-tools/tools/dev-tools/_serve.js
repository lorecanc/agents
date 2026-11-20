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

import { ensureScratch, isInside, pidAlive, realpathLoose, redact, withLock } from "./_repo.js"
import {
  envHint, findFreePort, groupAlive, isPortFree, killTree, loadContract, LOCAL_HOST, parseEnvFile, portListening, resolveWorkspace, runtimeEnv, waitReady,
} from "./_run.js"
import { startManagedServices, stopManagedServices, SUPERVISOR } from "./_services.js"
import { checkBash, inlineCodeInvocation, tokenize } from "./_bash_guard.js"

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
  fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 })
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
  if (!rec || (!ending(rec) && alive(rec))) return false
  if (alive(rec)) await killTree(rec.supervisorPid, 500)
  if (rec.dependentServices?.length) await stopManagedServices(info, rec.dependentServices)
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

const validStart = (spec) => Boolean(spec && typeof spec.start === "string" && spec.start.trim())
const SERVE_WRAPPERS = new Set(["env", "command", "time", "nohup", "builtin", "nice", "setsid", "stdbuf", "timeout", "gtimeout"])

function directCommandTokens(command) {
  let tokens = tokenize(command).segments[0] || []
  for (;;) {
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(tokens[0])) tokens.shift()
    const wrapper = path.basename(tokens[0] || "")
    if (!SERVE_WRAPPERS.has(wrapper)) return tokens
    tokens.shift()
    if (wrapper === "env") {
      while (tokens.length) {
        const arg = tokens[0]
        if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(arg) || ["-i", "--ignore-environment"].includes(arg)
          || arg.startsWith("--unset=") || arg.startsWith("--chdir=")) {
          tokens.shift()
        } else if (arg === "-S" || arg === "--split-string" || /^-S.+/.test(arg) || arg.startsWith("--split-string=")) {
          const value = arg === "-S" || arg === "--split-string" ? tokens[1] || "" : arg.startsWith("-S") ? arg.slice(2) : arg.slice("--split-string=".length)
          const split = tokenize(value).segments.flat()
          const consumed = arg === "-S" || arg === "--split-string" ? 2 : 1
          tokens.splice(0, consumed, ...split)
        } else if (["-u", "--unset", "-C", "--chdir", "--argv0"].includes(arg)) {
          tokens.splice(0, 2)
        } else if (arg.startsWith("-")) tokens.shift()
        else break
      }
    } else {
      while (tokens.length && (tokens[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(tokens[0]))) tokens.shift()
      if ((wrapper === "timeout" || wrapper === "gtimeout") && tokens.length) tokens.shift()
    }
  }
}

function directCommandProblem(command) {
  if (/[;&|`<>()\n\r]/.test(command) || command.includes("$(")) {
    return "command must be a single server launch command without shell operators"
  }
  const [rawCmd, ...args] = directCommandTokens(command)
  const cmd = path.basename(rawCmd || "")
  if (inlineCodeInvocation(cmd, args)) return "inline interpreter or shell code is not allowed; pass a server script file instead"
  return null
}

/** The contract section used to serve: `serve`, `smoke`, or an autodetected script. */
function serveSpec(info, { workspace = null, command, withServices = false } = {}) {
  const { contract, problems, smokeHint, raw, workspaceSection } = loadContract(info.top, { workspace })
  const configured = (section) => {
    if (validStart(section?.serve)) return { spec: section.serve, from: "serve" }
    if (validStart(section?.smoke)) return { spec: section.smoke, from: "smoke" }
    return null
  }
  const workspaceConfigured = configured(workspaceSection)
  const rootConfigured = configured(raw)
  if (command !== undefined && command !== null) {
    const base = workspace ? workspaceConfigured?.spec || contract.smoke || contract.autodetected_smoke : rootConfigured?.spec || contract.smoke || contract.autodetected_smoke
    const services = Array.isArray(base?.services) ? base.services : withServices ? Object.keys(contract.services || {}) : undefined
    return {
      spec: { ...(base || {}), start: command.trim(), ...(services ? { services } : {}) },
      problems, smokeHint, from: "args", contract,
    }
  }
  if (workspace) {
    if (workspaceConfigured) return { ...workspaceConfigured, problems, smokeHint, contract }
    if (contract.smoke) return { spec: contract.smoke, problems, smokeHint, from: "smoke", contract }
    const auto = contract.autodetected_smoke || (validStart(smokeHint) ? smokeHint : null)
    return auto
      ? { spec: auto, problems, smokeHint, from: "autodetect", contract }
      : { spec: null, problems, smokeHint, from: "smoke", contract }
  }
  if (raw && raw.serve && typeof raw.serve.start === "string") return { spec: raw.serve, problems, smokeHint, from: "serve", contract }
  if (contract.smoke) return { spec: contract.smoke, problems, smokeHint, from: "smoke", contract }
  const auto = contract.autodetected_smoke || (validStart(smokeHint) ? smokeHint : null)
  return auto
    ? { spec: auto, problems, smokeHint, from: "autodetect", contract }
    : { spec: null, problems, smokeHint, from: "smoke", contract }
}

function describe(info, rec) {
  const remaining = Math.max(0, Math.round((rec.expiresAt - Date.now()) / 1000))
  const out = {
    status: "running",
    url: rec.url,
    port: rec.port,
    expires_in_s: remaining,
    owner_session: rec.ownerRoot,
    workspace: rec.workspace || null,
    started_at: new Date(rec.startedAt).toISOString(),
  }
  if (rec.servicesSummary !== undefined) out.services = rec.servicesSummary
  return out
}

function localHttpUrlProblem(value, label) {
  if (typeof value !== "string") return `${label} url must be a string`
  const resolved = value.replaceAll("${PORT}", "43000")
  let url
  try {
    url = new URL(resolved)
  } catch {
    return `invalid ${label} url ${value}`
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `${label} url must use http or https (got ${url.protocol})`
  if (!LOCAL_HOST.test(url.hostname)) return `${label} url must target localhost (got ${url.hostname})`
  return null
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
export async function startService({
  info, ownerRoot, ownerPid = process.pid, ttlS = DEFAULT_TTL_S, signal,
  withServices = false, serviceOptions, workspace, command, readyPath, readyUrl, readyTimeoutS,
}) {
  const ttl = Math.min(MAX_TTL_S, Math.max(1, Math.round(Number(ttlS) || DEFAULT_TTL_S)))
  const ws = resolveWorkspace(info, workspace)
  if (ws.error) return { status: "error", failure_class_hint: "harness", reason: ws.error }
  const cwd = ws.rel ? path.join(info.top, ws.rel) : info.top
  if (command !== undefined && command !== null && (typeof command !== "string" || !command.trim() || command.includes("\0"))) {
    return { status: "error", failure_class_hint: "harness", reason: "command must be a non-empty string without NUL characters" }
  }
  if (readyTimeoutS !== undefined && readyTimeoutS !== null && (typeof readyTimeoutS !== "number" || !Number.isFinite(readyTimeoutS))) {
    return { status: "error", failure_class_hint: "harness", reason: "ready_timeout_s must be a finite number" }
  }
  for (const [name, value] of [["ready_path", readyPath], ["ready_url", readyUrl]]) {
    if (value !== undefined && value !== null && (typeof value !== "string" || !value.trim() || value.includes("\0"))) {
      return { status: "error", failure_class_hint: "harness", reason: `${name} must be a non-empty string without NUL characters` }
    }
  }
  const explicitCommand = command !== undefined && command !== null ? command.trim() : null
  const { spec, problems, smokeHint, from, contract } = serveSpec(info, { workspace: ws.rel, command: explicitCommand, withServices })
  if (!spec) {
    return {
      status: "inconclusive",
      failure_class_hint: "harness",
      reason: "no serve/smoke contract: pass command (and optionally workspace) directly to dev_serve, or add an optional `serve` section to .opencode/pipeline.json",
      contract_problems: problems,
      suggested_serve: smokeHint,
    }
  }
  const serviceNames = Array.isArray(spec.services) ? spec.services : []
  if (spec.services !== undefined && !Array.isArray(spec.services)) {
    return { status: "error", failure_class_hint: "harness", reason: "serve.services must be an array of service names" }
  }
  if (withServices && serviceNames.length) {
    const defs = contract?.services || {}
    const unknown = serviceNames.filter((name) => typeof name !== "string" || !Object.hasOwn(defs, name))
    if (unknown.length) {
      return {
        status: "error",
        failure_class_hint: "harness",
        reason: `unknown service(s) ${unknown.join(", ")}; defined: ${Object.keys(defs).sort().join(", ") || "none"}`,
      }
    }
    for (const name of serviceNames) {
      const problem = defs[name]?.ready?.url === undefined ? null : localHttpUrlProblem(defs[name].ready.url, `services.${name}.ready`)
      if (problem) return { status: "error", failure_class_hint: "harness", reason: problem }
    }
  }
  const urlTemplate = typeof spec.url === "string" ? spec.url : "http://127.0.0.1:${PORT}/"
  const serviceUrlProblem = localHttpUrlProblem(urlTemplate, "serve")
  if (serviceUrlProblem) return { status: "error", failure_class_hint: "harness", reason: serviceUrlProblem }
  if (spec.ready !== undefined && (!spec.ready || typeof spec.ready !== "object" || Array.isArray(spec.ready))) {
    return { status: "error", failure_class_hint: "harness", reason: "serve.ready must be an object" }
  }
  const ready = { ...(spec.ready || {}) }
  if (spec.ready_url !== undefined && ready.url === undefined) ready.url = spec.ready_url
  if (readyUrl !== undefined && readyUrl !== null) ready.url = readyUrl
  else if (readyPath !== undefined && readyPath !== null) ready.url = `http://127.0.0.1:\${PORT}${readyPath.startsWith("/") ? readyPath : `/${readyPath}`}`
  const configuredTimeout = Number(spec.ready?.timeout_s) || 60
  const timeoutS = Math.min(180, Math.max(1, readyTimeoutS ?? configuredTimeout))
  ready.timeout_s = timeoutS
  if (ready.url !== undefined) {
    const readyUrlProblem = localHttpUrlProblem(ready.url, "ready")
    if (readyUrlProblem) return { status: "error", failure_class_hint: "harness", reason: readyUrlProblem }
  }
  if (from === "args") {
    const directProblem = directCommandProblem(spec.start)
    if (directProblem) return { status: "error", failure_class_hint: "harness", reason: directProblem }
    let scratch
    try {
      scratch = ensureScratch(info)
    } catch (e) {
      return { status: "error", failure_class_hint: "harness", reason: e.message }
    }
    const blocked = checkBash(spec.start.replaceAll("${PORT}", "43000"), "ops", { info, cwd, scratch })
    if (blocked) return { status: "error", failure_class_hint: "harness", reason: blocked }
  }
  const body = async () => {
    let managedRecords = null
    let serverPid = null
    let fd
    let log
    let rec
    let child
    const existing = readService(info)
    if (existing && (await reapIfEnding(info, existing))) {
      dropService(info, existing)
    } else if (existing && alive(existing)) {
      const optionsChanged = (existing.workspace || null) !== (ws.rel || null)
        || (existing.from || null) !== from
        || (from === "args" && (existing.command || null) !== (spec.start || null))
      const needsServiceUpgrade = withServices && serviceNames.length && !existing.dependentServices?.length
      if (optionsChanged || needsServiceUpgrade) {
        if (existing.ownerRoot !== ownerRoot && pidAlive(existing.ownerPid)) {
          return {
            status: "blocked", failure_class_hint: "harness",
            reason: optionsChanged
              ? `the running service belongs to another active session (${existing.ownerRoot}) and cannot be replaced`
              : `the running service belongs to another active session (${existing.ownerRoot}) and cannot be upgraded to manage declared services`,
          }
        }
        const stopped = await stopService({ info, callerRoot: ownerRoot, force: true })
        if (stopped.status !== "stopped" || stopped.port_free === false) {
          return { status: "blocked", failure_class_hint: "harness", reason: "the previous service could not be stopped cleanly; refusing to replace it" }
        }
      } else {
        return { ...describe(info, existing), reused: true, shared: existing.ownerRoot !== ownerRoot }
      }
    } else if (existing) dropService(info, existing)

    let port
    if (Number.isInteger(spec.port)) {
      port = spec.port
      if (!(await isPortFree(port))) {
        return { status: "blocked", failure_class_hint: "env", reason: `port ${port} is already in use by another process; refusing to kill it` }
      }
    } else port = await findFreePort()
    const subst = (s) => String(s).replaceAll("${PORT}", String(port))
    const startCommand = subst(spec.start)
    let scratch
    try {
      scratch = ensureScratch(info)
    } catch (e) {
      return { status: "error", failure_class_hint: "harness", reason: e.message }
    }
    if (from === "args") {
      const blocked = checkBash(startCommand, "ops", { info, cwd, scratch })
      if (blocked) return { status: "error", failure_class_hint: "harness", reason: blocked }
    }

    let fileEnv = {}
    if (spec.env_file) {
      const abs = realpathLoose(path.resolve(cwd, spec.env_file))
      if (!isInside(info.top, abs)) return { status: "error", failure_class_hint: "harness", reason: "env_file must be inside the repository" }
      fileEnv = parseEnvFile(abs)
    }
    const url = subst(urlTemplate)
    try {
      let managed = { env: {}, services: [], records: [] }
      if (withServices && serviceNames.length) {
        managed = await startManagedServices({
          info, defs: contract.services, names: serviceNames, cwd,
          signal, ttlS: ttl, minTtlS: 1, ownerPid, probe: serviceOptions || {},
        })
        if (!managed.ok) {
          return {
            status: managed.failed.status === "blocked" ? "blocked" : "fail",
            phase: "services",
            failure_class_hint: managed.failed.failure_class_hint || "env",
            reason: managed.failed.reason,
            services: managed.services,
          }
        }
        managedRecords = managed.records
      }
      const extra = {}
      for (const [k, v] of Object.entries(spec.env || {})) extra[k] = subst(v)
      const env = { ...runtimeEnv(info, { ...fileEnv, ...managed.env, ...extra, PORT: String(port) }), PIPELINE_SERVE_CMD: startCommand }

      log = path.join(scratch, `serve-${Date.now()}.log`)
      let exited = false
      fd = fs.openSync(log, "a")
      child = spawn("sh", ["-c", SUPERVISOR, "pipeline-supervisor", String(ownerPid), String(ttl)], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", fd, fd],
      })
      serverPid = child.pid
      child.unref()
      child.on("exit", () => {
        exited = true
      })
      child.on("error", () => {
        exited = true
      })
      fs.closeSync(fd)
      fd = undefined
      rec = {
        name: SERVICE, supervisorPid: child.pid, ownerPid, ownerRoot, port, url, workspace: ws.rel || null, command: spec.start, from, startedAt: Date.now(), expiresAt: Date.now() + ttl * 1000, ttlS: ttl, log, spec: from,
        ...(managedRecords?.length ? { dependentServices: managedRecords, servicesSummary: managed.services } : {}),
      }
      writeService(info, rec)

      const readiness = await waitReady(ready, {
        portNum: port, subst, readLog: () => { try { return fs.readFileSync(log, "utf8") } catch { return "" } }, isExited: () => exited, timeoutMs: timeoutS * 1000, signal,
      })
      if (!readiness.ok) {
        const text = readTail(log, 5000)
        await killTree(child.pid)
        serverPid = null
        if (managedRecords?.length) await stopManagedServices(info, managedRecords)
        managedRecords = null
        dropService(info, rec)
        rec = null
        return {
          status: "fail",
          phase: "ready",
          reason: readiness.reason,
          failure_class_hint: readiness.harness ? "harness" : envHint(text) ? "env" : readiness.exited ? "unclassified" : "harness",
          log_tail: text,
          ...(readiness.exited && !envHint(text) ? { note: "the service stopped at startup without an environment signature: read log_tail and decide between a code defect and an environment problem" } : {}),
        }
      }
      const deps = Array.isArray(spec.services) && spec.services.length && !managedRecords?.length
        ? ` The ${from} section declares services (${spec.services.join(", ")}): dev_serve does not start them, so they must already be reachable.`
        : ""
      return {
        ...describe(info, rec),
        ready_ms: readiness.ms,
        note: `Stops by itself in ${ttl}s, when this opencode process ends, or on dev_serve stop. Always call stop when you are done.${deps}`,
      }
    } catch (e) {
      if (fd !== undefined) {
        try { fs.closeSync(fd) } catch { /* already closed */ }
      }
      if (serverPid) {
        try { await killTree(serverPid) } catch { /* best-effort cleanup */ }
      }
      if (managedRecords?.length) {
        try { await stopManagedServices(info, managedRecords) } catch { /* best-effort cleanup */ }
      }
      try { dropService(info, rec) } catch { /* partial state may not have a writable parent */ }
      if (log) {
        try { fs.rmSync(log, { force: true }) } catch { /* best-effort cleanup */ }
      }
      return { status: "error", failure_class_hint: "harness", reason: e.message }
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
  if (rec.dependentServices?.length) await stopManagedServices(info, rec.dependentServices)
  dropService(info, rec)
  return { status: "stopped", process_stopped: stopped, port_free: free, log_tail: log }
}

/** Stop the service when it belongs to the given root session (used when that session goes idle). */
export async function stopServicesOwnedBy(info, rootId) {
  const rec = readService(info)
  if (!rec || rec.ownerRoot !== rootId) return null
  return stopService({ info, callerRoot: rootId })
}
