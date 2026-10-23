// Dependent services for verification and smoke runs (a throwaway Postgres, a fake API, a cache...).
//
// Same rules as the rest of the runners: a service started here never outlives the run that needed it.
//   - every service runs under the sh supervisor (own process group, owner-death watch, hard TTL), so even
//     a kill -9 of the tool host stops it within about a second;
//   - withServices() ALWAYS stops what it started (also on failure, timeout and abort) and removes scratch
//     data directories;
//   - nothing that this module did not start is ever signalled (a fixed port already in use is `blocked`).
//
// Two kinds of service in the contract (`services: { <name>: {...} }`):
//   custom:   { start, ready: { port|url|log, timeout_s }, env: { KEY: "...${PORT}..." }, stop?, port? }
//   postgres: { kind: "postgres", version?, env_var?: "DATABASE_URL", bin_dir? }
//             native ephemeral cluster (initdb + postgres in a scratch dir) first, docker as a fallback,
//             `blocked` with failure class `env` and the exact places looked at when neither is usable.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"

import { ensureScratch, pidAlive, redact } from "./_pipeline_core.js"
import {
  envHint, findFreePort, groupAlive, isPortFree, killTree, portListening, runCommand, runtimeEnv, shQuote, waitReady,
} from "./_pipeline_run.js"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tail = (s, n) => redact(s.length > n ? "…" + s.slice(-n) : s)
const MAX_READY_S = 180
export const DEFAULT_SERVICE_TTL_S = 1800
export const MAX_SERVICE_TTL_S = 3600

// $1 = owner pid, $2 = ttl seconds, the service command arrives in $PIPELINE_SERVE_CMD.
// The service starts BEFORE the TERM trap so it does not inherit an ignored TERM.
// Shared with _pipeline_serve.js.
export const SUPERVISOR = `
OWNER="$1"; TTL="$2"
START=$(date +%s)
sh -c "$PIPELINE_SERVE_CMD" &
CHILD=$!
while :; do
  sleep 1
  kill -0 "$CHILD" 2>/dev/null || break
  kill -0 "$OWNER" 2>/dev/null || break
  [ $(( $(date +%s) - START )) -ge "$TTL" ] && break
done
trap '' TERM
kill -TERM -- "-$$" 2>/dev/null
sleep 2
kill -KILL -- "-$$" 2>/dev/null
exit 0
`

// ------------------------------------------------------------ contract

/** Validate one `services.<name>` entry; returns a problem string or null. */
export function serviceProblem(name, spec) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return `services.${name}: name may only contain letters, digits, '_', '-', '.'`
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return `services.${name} must be an object`
  if (spec.kind !== undefined && spec.kind !== "postgres") return `services.${name}.kind must be "postgres" (or omitted for a custom service)`
  if (spec.kind === "postgres") {
    if (spec.version !== undefined && !/^[A-Za-z0-9._-]+$/.test(String(spec.version))) return `services.${name}.version is not a valid version/tag`
    if (spec.env_var !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(spec.env_var))) return `services.${name}.env_var is not a valid variable name`
  } else if (typeof spec.start !== "string" || !spec.start.trim()) return `services.${name}.start must be a non-empty string`
  if (spec.env !== undefined && (typeof spec.env !== "object" || Array.isArray(spec.env) || Object.values(spec.env).some((v) => typeof v !== "string"))) {
    return `services.${name}.env must be an object of strings`
  }
  if (spec.stop !== undefined && typeof spec.stop !== "string") return `services.${name}.stop must be a string`
  return null
}

// ------------------------------------------------------------- probing

const splitPath = (p) => String(p || "").split(path.delimiter).filter(Boolean)

function findBin(dirs, name) {
  for (const d of dirs) {
    const p = path.join(d, name)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      if (fs.statSync(p).isFile()) return p
    } catch {
      /* not here */
    }
  }
  return null
}

const verNum = (s) => {
  const m = /(\d+)/.exec(s)
  return m ? Number(m[1]) : s === "latest" ? Infinity : -1
}

/** Directories where PostgreSQL is commonly installed but often not on PATH (keg-only brew, Debian, RHEL, Postgres.app). */
export function wellKnownPostgresDirs() {
  const out = []
  const scan = (parent, re, sub) => {
    try {
      const names = fs.readdirSync(parent).filter((n) => re.test(n)).sort((a, b) => verNum(b) - verNum(a))
      for (const n of names) out.push(path.join(parent, n, sub))
    } catch {
      /* not present */
    }
  }
  scan("/opt/homebrew/opt", /^postgresql(@\d+)?$/, "bin")
  scan("/usr/local/opt", /^postgresql(@\d+)?$/, "bin")
  scan("/usr/lib/postgresql", /^\d+$/, "bin")
  scan("/usr", /^pgsql-\d+$/, "bin")
  scan("/Applications/Postgres.app/Contents/Versions", /^(latest|\d+)$/, "bin")
  out.push("/usr/local/pgsql/bin")
  return out
}

function majorOf(postgresBin) {
  try {
    const out = execFileSync(postgresBin, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })
    const m = /(\d+)(?:\.\d+)?/.exec(out)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** Native PostgreSQL detection: { found, binDir, version, looked, reason }. Never starts anything. */
export function detectPostgresNative({ pathEnv = process.env.PATH, wellKnownDirs = wellKnownPostgresDirs(), binDir, version } = {}) {
  const dirs = binDir ? [binDir] : [...new Set([...splitPath(pathEnv), ...wellKnownDirs])]
  const candidates = []
  for (const d of dirs) {
    const initdb = findBin([d], "initdb")
    const postgres = findBin([d], "postgres")
    if (initdb && postgres) candidates.push({ binDir: d, initdb, postgres, pgIsready: findBin([d], "pg_isready") || findBin(splitPath(pathEnv), "pg_isready") })
  }
  const looked = binDir ? `${binDir} (services.*.bin_dir)` : `PATH (${splitPath(pathEnv).join(":") || "empty"}) and ${wellKnownDirs.length ? wellKnownDirs.join(", ") : "no well-known directories"}`
  if (!candidates.length) return { found: false, looked, reason: `initdb + postgres not found in ${looked}` }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return { found: false, looked, reason: "PostgreSQL refuses to run as root, so a native cluster cannot be started by this process" }
  }
  for (const c of candidates) c.version = majorOf(c.postgres)
  const wanted = version !== undefined && version !== null ? String(version).split(".")[0] : null
  const match = wanted ? candidates.find((c) => c.version === wanted) : null
  const pick = match || candidates[0]
  return { found: true, ...pick, looked, versionMismatch: Boolean(wanted && !match), wanted }
}

const dockerSockets = () => [
  process.env.DOCKER_HOST ? `${process.env.DOCKER_HOST} (DOCKER_HOST)` : null,
  "/var/run/docker.sock",
  path.join(os.homedir(), ".docker/run/docker.sock"),
  path.join(os.homedir(), ".colima/default/docker.sock"),
  path.join(os.homedir(), ".orbstack/run/docker.sock"),
  process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, "docker.sock") : null,
].filter(Boolean)

/** Docker detection: the CLI must exist and `docker info` must reach a daemon. */
export async function detectDocker({ info, pathEnv = process.env.PATH, signal } = {}) {
  const sockets = dockerSockets()
  const present = sockets.filter((s) => !s.endsWith("(DOCKER_HOST)") && fs.existsSync(s))
  const bin = findBin(splitPath(pathEnv), "docker")
  if (!bin) return { ok: false, reason: `docker CLI not found in PATH (sockets checked: ${sockets.join(", ")}; present: ${present.join(", ") || "none"})` }
  const r = await runCommand(`${shQuote(bin)} info --format '{{.ServerVersion}}'`, {
    cwd: info.top, env: runtimeEnv(info, { PATH: pathEnv }), timeoutMs: 15000, signal,
  })
  if (r.exitCode !== 0) {
    return { ok: false, bin, reason: `docker daemon not reachable (\`docker info\` ${r.timedOut ? "timed out" : `exit ${r.exitCode}`}: ${tail(r.output.trim(), 300)}; sockets checked: ${sockets.join(", ")}; present: ${present.join(", ") || "none"})` }
  }
  return { ok: true, bin }
}

// ------------------------------------------------------------ processes

/** Run `cmd` under the supervisor: own process group, dies with the owner process or at the TTL. */
function spawnSupervised(cmd, { cwd, env, log, ttlS }) {
  const fd = fs.openSync(log, "a")
  const state = { exited: false, exitInfo: null }
  const child = spawn("sh", ["-c", SUPERVISOR, "pipeline-supervisor", String(process.pid), String(ttlS)], {
    cwd, env: { ...env, PIPELINE_SERVE_CMD: cmd }, detached: true, stdio: ["ignore", fd, fd],
  })
  child.unref()
  child.on("exit", (code, sig) => {
    state.exited = true
    state.exitInfo = { code, signal: sig }
  })
  child.on("error", (e) => {
    state.exited = true
    state.exitInfo = { code: 127, error: e.message }
  })
  fs.closeSync(fd)
  state.pid = child.pid
  return state
}

const readFile = (f) => {
  try {
    return fs.readFileSync(f, "utf8")
  } catch {
    return ""
  }
}

async function waitPortFree(port, ms = 5000) {
  const t0 = Date.now()
  for (;;) {
    if (await isPortFree(port)) return true
    if (Date.now() - t0 > ms) return false
    await sleep(250)
  }
}

async function allocPort(h, spec) {
  if (Number.isInteger(spec.port)) {
    if (!(await isPortFree(spec.port))) {
      h.status = "blocked"
      h.failure_class_hint = "env"
      h.reason = `port ${spec.port} is already in use by another process; refusing to kill it`
      return null
    }
    return spec.port
  }
  return findFreePort()
}

function readyFailure(h, ready, log) {
  h.status = ready.reason === "aborted" ? "aborted" : "fail"
  h.reason = ready.reason
  h.failure_class_hint = ready.reason === "aborted" ? "harness" : ready.harness ? "harness" : envHint(log) ? "env" : ready.exited ? "unclassified" : "harness"
  h.log_tail = tail(log, 3000)
}

// --------------------------------------------------------------- custom

async function startCustom(h, spec, ctx) {
  h.how = "custom"
  const port = await allocPort(h, spec)
  if (port === null) return
  h.port = port
  const subst = (s) => String(s).replaceAll("${PORT}", String(port))
  const exported = {}
  for (const [k, v] of Object.entries(spec.env || {})) exported[k] = subst(v)
  const env = runtimeEnv(ctx.info, { ...ctx.inherited, ...exported, PORT: String(port) })
  const log = path.join(ensureScratch(ctx.info), `service-${h.name}-${Date.now()}.log`)
  const proc = spawnSupervised(subst(spec.start), { cwd: ctx.cwd, env, log, ttlS: ctx.ttlS })
  h.started = true
  h.stop = async () => {
    if (spec.stop && groupAlive(proc.pid)) {
      await runCommand(subst(spec.stop), { cwd: ctx.cwd, env, timeoutMs: 30000 })
    }
    await killTree(proc.pid)
    const free = await waitPortFree(port)
    h.cleanup = { process_stopped: !groupAlive(proc.pid), port_free: free }
    fs.rmSync(log, { force: true })
  }
  const timeoutS = Math.min(Number(spec.ready && spec.ready.timeout_s) || 60, MAX_READY_S)
  const ready = await waitReady(spec.ready, {
    portNum: port, subst, readLog: () => readFile(log), isExited: () => proc.exited, timeoutMs: timeoutS * 1000, signal: ctx.signal,
  })
  h.ready_ms = ready.ms
  if (!ready.ok) return readyFailure(h, ready, readFile(log))
  h.ready = true
  h.status = "ready"
  h.env = exported
}

// ------------------------------------------------------------- postgres

function postgresEnv(spec, port) {
  const url = `postgresql://postgres@127.0.0.1:${port}/postgres`
  const env = { PGHOST: "127.0.0.1", PGPORT: String(port), PGUSER: "postgres", PGDATABASE: "postgres", [spec.env_var || "DATABASE_URL"]: url }
  for (const [k, v] of Object.entries(spec.env || {})) env[k] = String(v).replaceAll("${PORT}", String(port)).replaceAll("${DATABASE_URL}", url)
  return env
}

/** Short socket directory: unix socket paths are limited to ~104 bytes (macOS). */
function socketDir(base) {
  const fits = (d) => path.join(d, ".s.PGSQL.65535.lock").length <= 100
  const local = path.join(base, "s")
  if (fits(local)) {
    fs.mkdirSync(local)
    return { dir: local, own: false }
  }
  for (const root of [os.tmpdir(), "/tmp"]) {
    try {
      const d = fs.mkdtempSync(path.join(root, "opg-"))
      if (fits(d)) return { dir: d, own: true }
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* try the next root */
    }
  }
  return null
}

async function startPostgresNative(h, spec, ctx, native) {
  h.how = "native"
  h.version = native.version
  if (native.versionMismatch) h.note = `requested PostgreSQL ${native.wanted}, using native ${native.version} (no docker fallback available)`
  const scratch = ensureScratch(ctx.info)
  const base = fs.mkdtempSync(path.join(scratch, `pg-${h.name}-`))
  const data = path.join(base, "data")
  const log = path.join(base, "postgres.log")
  const sock = socketDir(base)
  const removeData = () => {
    fs.rmSync(base, { recursive: true, force: true })
    if (sock && sock.own) fs.rmSync(sock.dir, { recursive: true, force: true })
    h.cleanup = { ...(h.cleanup || {}), data_removed: !fs.existsSync(base) }
  }
  h.stop = async () => removeData()
  if (!sock) {
    h.status = "blocked"
    h.failure_class_hint = "env"
    h.reason = "no directory with a short enough path for the PostgreSQL unix socket"
    return
  }
  const env = runtimeEnv(ctx.info, { LC_ALL: "C", LANG: "C" })
  const init = await runCommand(
    `${shQuote(native.initdb)} -D ${shQuote(data)} -U postgres -A trust -E UTF8 --no-locale --no-sync`,
    { cwd: base, env, timeoutMs: 120000, signal: ctx.signal },
  )
  if (init.exitCode !== 0 || init.aborted) {
    h.status = init.aborted ? "aborted" : "fail"
    h.failure_class_hint = init.aborted ? "harness" : "env"
    h.reason = init.aborted ? "aborted" : init.timedOut ? "initdb timed out" : `initdb failed (exit ${init.exitCode})`
    h.log_tail = tail(init.output, 2000)
    return
  }
  const port = await allocPort(h, spec)
  if (port === null) return
  h.port = port
  const cmd = [
    "exec", shQuote(native.postgres), "-D", shQuote(data), "-p", String(port), "-k", shQuote(sock.dir),
    "-c", "listen_addresses=127.0.0.1", "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off",
  ].join(" ")
  const proc = spawnSupervised(cmd, { cwd: base, env, log, ttlS: ctx.ttlS })
  h.started = true
  h.stop = async () => {
    // Fast shutdown of the postmaster we started (its pid comes from OUR data directory), then the group.
    const pid = Number(readFile(path.join(data, "postmaster.pid")).split("\n")[0])
    if (Number.isInteger(pid) && pid > 1 && pidAlive(pid) && groupAlive(proc.pid)) {
      try {
        process.kill(pid, "SIGINT")
      } catch {
        /* gone */
      }
      for (let i = 0; i < 40 && pidAlive(pid); i++) await sleep(250)
    }
    await killTree(proc.pid)
    const free = await waitPortFree(port)
    h.cleanup = { process_stopped: !groupAlive(proc.pid), port_free: free }
    removeData()
  }
  const timeoutS = Math.min(Number(spec.ready && spec.ready.timeout_s) || 60, MAX_READY_S)
  const t0 = Date.now()
  const isready = native.pgIsready
    ? `${shQuote(native.pgIsready)} -h 127.0.0.1 -p ${port} -U postgres -d postgres -t 2`
    : null
  for (;;) {
    if (ctx.signal && ctx.signal.aborted) return readyFailure(h, { reason: "aborted" }, readFile(log))
    if (proc.exited) return readyFailure(h, { reason: "postgres exited before it became ready", exited: true }, readFile(log))
    let ok
    if (isready) ok = (await runCommand(isready, { cwd: base, env, timeoutMs: 5000 })).exitCode === 0
    else ok = /ready to accept connections/.test(readFile(log)) && (await portListening(port))
    if (ok) break
    if (Date.now() - t0 > timeoutS * 1000) return readyFailure(h, { reason: `postgres not ready after ${timeoutS}s` }, readFile(log))
    await sleep(300)
  }
  h.ready_ms = Date.now() - t0
  h.ready = true
  h.status = "ready"
  h.env = postgresEnv(spec, port)
}

async function startPostgresDocker(h, spec, ctx, docker) {
  h.how = "docker"
  const tag = String(spec.version || "16")
  h.version = tag
  const port = await allocPort(h, spec)
  if (port === null) return
  h.port = port
  const name = `opencode-pipeline-pg-${process.pid}-${randomBytes(4).toString("hex")}`
  const env = runtimeEnv(ctx.info, { PATH: ctx.pathEnv })
  const log = path.join(ensureScratch(ctx.info), `service-${h.name}-${Date.now()}.log`)
  // Foreground `docker run --rm`: when the supervisor group is signalled, the CLI proxies the signal and the
  // container is removed, so the owner-death / TTL watch also covers the container.
  const cmd = `exec ${shQuote(docker.bin)} run --rm --name ${name} --label opencode-pipeline=1 -p 127.0.0.1:${port}:5432 -e POSTGRES_HOST_AUTH_METHOD=trust ${shQuote(`postgres:${tag}`)}`
  const proc = spawnSupervised(cmd, { cwd: ctx.info.top, env, log, ttlS: ctx.ttlS })
  h.started = true
  h.stop = async () => {
    // Only the container this run created (unique name).
    await runCommand(`${shQuote(docker.bin)} rm -f ${name}`, { cwd: ctx.info.top, env, timeoutMs: 30000 })
    await killTree(proc.pid)
    const free = await waitPortFree(port)
    h.cleanup = { process_stopped: !groupAlive(proc.pid), port_free: free, container_removed: true }
    fs.rmSync(log, { force: true })
  }
  // Allow for an image pull.
  const timeoutS = Math.min(Number(spec.ready && spec.ready.timeout_s) || MAX_READY_S, MAX_READY_S)
  const t0 = Date.now()
  for (;;) {
    if (ctx.signal && ctx.signal.aborted) return readyFailure(h, { reason: "aborted" }, readFile(log))
    if (proc.exited) return readyFailure(h, { reason: "docker run exited before postgres became ready", exited: true }, readFile(log))
    // -h 127.0.0.1: the image's init phase runs a socket-only temporary server; TCP means the real one.
    const r = await runCommand(`${shQuote(docker.bin)} exec ${name} pg_isready -h 127.0.0.1 -U postgres -t 2`, { cwd: ctx.info.top, env, timeoutMs: 8000 })
    if (r.exitCode === 0 && (await portListening(port))) break
    if (Date.now() - t0 > timeoutS * 1000) return readyFailure(h, { reason: `postgres container not ready after ${timeoutS}s` }, readFile(log))
    await sleep(500)
  }
  h.ready_ms = Date.now() - t0
  h.ready = true
  h.status = "ready"
  h.env = postgresEnv(spec, port)
}

async function startPostgres(h, spec, ctx) {
  const native = detectPostgresNative({
    pathEnv: ctx.pathEnv, wellKnownDirs: ctx.wellKnownDirs, binDir: spec.bin_dir, version: spec.version,
  })
  if (native.found && !native.versionMismatch) return startPostgresNative(h, spec, ctx, native)
  const docker = await detectDocker({ info: ctx.info, pathEnv: ctx.pathEnv, signal: ctx.signal })
  if (docker.ok) return startPostgresDocker(h, spec, ctx, docker)
  if (native.found) return startPostgresNative(h, spec, ctx, native)
  h.how = "none"
  h.status = "blocked"
  h.failure_class_hint = "env"
  h.reason = `no PostgreSQL available. Native: ${native.reason}. Docker: ${docker.reason}. ` +
    "Install PostgreSQL (e.g. `brew install postgresql@16`, `apt install postgresql`), start a Docker daemon, " +
    "or set services.<name>.bin_dir to the directory containing initdb and postgres."
}

// ------------------------------------------------------------ lifecycle

function publicView(h) {
  const out = {
    name: h.name, kind: h.kind, how: h.how || null, status: h.status || "not_started",
    started: h.started, ready: h.ready, stopped: h.stopped, port: h.port ?? null,
  }
  for (const k of ["version", "ready_ms", "reason", "failure_class_hint", "note", "log_tail", "cleanup"]) if (h[k] !== undefined) out[k] = h[k]
  out.env_keys = Object.keys(h.env || {})
  return out
}

/**
 * Start `names` (in order) from `defs`, run fn(env), then ALWAYS stop them (reverse order).
 * Returns { ok: true, value, services } or { ok: false, failed, services } (fn is not called).
 *   defs: { name: { ...spec, _cwd } }   probe: { path, wellKnownDirs } (tests / unusual installs)
 */
export async function withServices({ info, defs, names, cwd, signal, ttlS = DEFAULT_SERVICE_TTL_S, probe = {} }, fn) {
  const handles = []
  const ttl = Math.min(MAX_SERVICE_TTL_S, Math.max(60, Math.round(Number(ttlS) || DEFAULT_SERVICE_TTL_S)))
  const pathEnv = probe.path ?? process.env.PATH
  let failed = null
  let value
  const inherited = {}
  try {
    for (const name of names) {
      const spec = defs[name]
      const h = { name, kind: spec.kind || "custom", started: false, ready: false, stopped: false, env: {} }
      handles.push(h)
      if (signal && signal.aborted) {
        h.status = "aborted"
        h.failure_class_hint = "harness"
        h.reason = "aborted"
        failed = h
        break
      }
      const ctx = {
        info, cwd: spec._cwd || cwd || info.top, signal, ttlS: ttl, pathEnv, wellKnownDirs: probe.wellKnownDirs, inherited: { ...inherited },
      }
      try {
        if (spec.kind === "postgres") await startPostgres(h, spec, ctx)
        else await startCustom(h, spec, ctx)
      } catch (e) {
        h.status = "error"
        h.failure_class_hint = "harness"
        h.reason = e.message
      }
      if (h.status !== "ready") {
        failed = h
        break
      }
      // Later services see the env of earlier ones (an API that needs the database).
      Object.assign(inherited, h.env)
    }
    if (!failed) value = await fn({ ...inherited })
  } finally {
    for (const h of [...handles].reverse()) {
      try {
        if (h.stop) await h.stop()
      } catch (e) {
        h.cleanup = { ...(h.cleanup || {}), error: e.message }
      }
      h.stopped = h.started ? Boolean(h.cleanup && h.cleanup.process_stopped !== false) : false
    }
  }
  const services = handles.map(publicView)
  return failed ? { ok: false, failed: publicView(failed), services } : { ok: true, value, services }
}
