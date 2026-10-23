// Deterministic runners for pipeline verification (verify) and runtime smoke tests (smoke).
//
// Why this exists: letting a model improvise "how do I start this service" and "kill it
// afterwards" through raw bash is the main source of hangs (foreground servers, orphaned
// processes holding a port, EADDRINUSE on retry, guessed ports and env). These runners
// make start / ready / check / stop a single bounded, always-cleaned-up operation and
// return a structured result with a failure-class hint.

import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { spawn } from "node:child_process"

import { ensureScratch, isInside, realpathLoose, redact, toRel, withLock } from "./_pipeline_core.js"
import { serviceProblem, withServices } from "./_pipeline_services.js"

export const CHECKS = ["lint", "typecheck", "test_targeted", "test_filter", "test_fast", "test_full", "build"]
export const DEFAULT_TIMEOUT_S = { lint: 120, typecheck: 180, test_targeted: 180, test_filter: 180, test_fast: 300, test_full: 900, build: 600 }
export const CONTRACT_PATH = ".opencode/pipeline.json"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------- contract

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function detectPackageManager(top) {
  if (fs.existsSync(path.join(top, "pnpm-lock.yaml"))) return "pnpm"
  if (fs.existsSync(path.join(top, "yarn.lock"))) return "yarn"
  if (fs.existsSync(path.join(top, "bun.lock")) || fs.existsSync(path.join(top, "bun.lockb"))) return "bun"
  return "npm"
}

/** Command prefix that runs a locally installed package binary without installing anything. */
function pmExec(pm) {
  return pm === "pnpm" ? "pnpm exec" : pm === "yarn" ? "yarn exec" : pm === "bun" ? "bunx" : "npx --no-install"
}

const PY_MARKERS = ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini", "conftest.py"]

/** Python interpreter for pytest: the project's virtualenv when there is one. */
function pythonFor(top) {
  for (const rel of [".venv/bin/python", "venv/bin/python"]) if (fs.existsSync(path.join(top, rel))) return rel
  return "python3"
}

function setPytest(verify, top) {
  const py = pythonFor(top)
  verify.test_fast ??= `${py} -m pytest -q -x`
  verify.test_targeted ??= `${py} -m pytest -q {files}`
  verify.test_filter ??= `${py} -m pytest -q {files} -k {filter}`
}

/** Best-effort detection of verify commands. Never used to start services. */
export function autodetect(top) {
  const verify = {}
  let smokeHint = null
  const pkg = readJson(path.join(top, "package.json"))
  if (pkg) {
    const pm = detectPackageManager(top)
    const run = (name) => (pm === "npm" ? `npm run ${name}` : `${pm} run ${name}`)
    const scripts = pkg.scripts || {}
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    if (scripts.lint) verify.lint = run("lint")
    if (scripts.typecheck) verify.typecheck = run("typecheck")
    else if (fs.existsSync(path.join(top, "tsconfig.json"))) verify.typecheck = "npx --no-install tsc --noEmit"
    if (scripts.test && !/no test specified/.test(scripts.test)) verify.test_fast = pm === "npm" ? "npm test --silent" : `${pm} test`
    if (deps.vitest) {
      verify.test_targeted = `${pmExec(pm)} vitest run {files}`
      verify.test_filter = `${pmExec(pm)} vitest run {files} -t {filter}`
    } else if (deps.jest) {
      verify.test_targeted = `${pmExec(pm)} jest {files}`
      verify.test_filter = `${pmExec(pm)} jest {files} -t {filter}`
    }
    if (scripts.build) verify.build = run("build")
    // A Python project with a package.json only for frontend tooling.
    if (!verify.test_fast && !verify.test_targeted && PY_MARKERS.some((f) => fs.existsSync(path.join(top, f)))) setPytest(verify, top)
    const startScript = scripts.dev ? "dev" : scripts.start ? "start" : null
    if (startScript) {
      const start = scripts[startScript]
      const addPort = /\b(?:vite|astro)\b/.test(start) && !/(?:^|\s)--port(?:\s|=|$)/.test(start)
      smokeHint = {
        start: `PORT=\${PORT} ${run(startScript)}${addPort ? " -- --port ${PORT}" : ""}`,
        ready: { port: "${PORT}", timeout_s: 60 },
        checks: [{ name: "root responds", url: "http://127.0.0.1:${PORT}/", expect_status: 200 }],
        note: "Draft only: many dev servers ignore PORT (e.g. pass --port). Review before saving to .opencode/pipeline.json.",
      }
    }
  } else if (fs.existsSync(path.join(top, "go.mod"))) {
    verify.typecheck = "go vet ./..."
    verify.test_fast = "go test ./..."
    verify.test_targeted = "go test {packages}"
    verify.test_filter = "go test {packages} -run {filter}"
    verify.build = "go build ./..."
  } else if (fs.existsSync(path.join(top, "Cargo.toml"))) {
    verify.typecheck = "cargo check"
    verify.test_fast = "cargo test"
    verify.test_filter = "cargo test {filter}"
    verify.build = "cargo build"
  } else if (PY_MARKERS.some((f) => fs.existsSync(path.join(top, f))) || fs.existsSync(path.join(top, "tests"))) {
    setPytest(verify, top)
  }
  return { verify, smokeHint }
}

const normWs = (k) => String(k).replace(/^\.\//, "").replace(/\/+$/, "")

function parseVerify(rawVerify, prefix, contract, problems) {
  for (const k of CHECKS) {
    const v = rawVerify && rawVerify[k]
    if (v === undefined || v === null) continue
    if (typeof v !== "string" || !v.trim()) problems.push(`${prefix}verify.${k} must be a non-empty string`)
    else if (k === "test_filter" && !v.includes("{filter}")) problems.push(`${prefix}verify.test_filter must contain {filter}`)
    else contract.verify[k] = v
  }
}

function parseServices(rawServices, prefix, cwd, contract, problems) {
  if (rawServices === undefined || rawServices === null) return
  if (typeof rawServices !== "object" || Array.isArray(rawServices)) {
    problems.push(`${prefix}services must be an object of named services`)
    return
  }
  for (const [name, spec] of Object.entries(rawServices)) {
    const problem = serviceProblem(name, spec)
    if (problem) problems.push(prefix + problem)
    else contract.services[name] = { ...spec, _cwd: cwd }
  }
}

/**
 * Load `.opencode/pipeline.json`, filling verify gaps by autodetection.
 * workspace: repo-relative subdirectory (already validated). Its verify/timeouts/services come from
 * `workspaces.<workspace>` and autodetection inside that directory; top-level services stay available.
 */
export function loadContract(top, { workspace = null } = {}) {
  const file = path.join(top, CONTRACT_PATH)
  const dir = workspace ? path.join(top, workspace) : top
  const problems = []
  const raw = fs.existsSync(file) ? readJson(file) : null
  if (fs.existsSync(file) && !raw) problems.push(`${CONTRACT_PATH} is not valid JSON`)
  const detected = autodetect(dir)
  const contract = { version: 1, setup: null, verify: {}, smoke: null, timeouts: {}, services: {}, workspace }
  let source = "none"
  if (raw && typeof raw === "object") {
    if (typeof raw.setup === "string") contract.setup = raw.setup
    parseServices(raw.services, "", top, contract, problems)
    if (raw.timeouts && typeof raw.timeouts === "object") {
      for (const [k, v] of Object.entries(raw.timeouts)) if (Number.isFinite(v) && v > 0) contract.timeouts[k] = v
    }
    if (workspace) {
      const wsMap = raw.workspaces && typeof raw.workspaces === "object" ? raw.workspaces : {}
      const key = Object.keys(wsMap).find((k) => normWs(k) === workspace)
      const ws = key !== undefined ? wsMap[key] : null
      if (ws && typeof ws === "object") {
        source = "file"
        const prefix = `workspaces.${key}.`
        parseVerify(ws.verify, prefix, contract, problems)
        parseServices(ws.services, prefix, dir, contract, problems)
        if (ws.timeouts && typeof ws.timeouts === "object") {
          for (const [k, v] of Object.entries(ws.timeouts)) if (Number.isFinite(v) && v > 0) contract.timeouts[k] = v
        }
      } else if (ws !== null) problems.push(`workspaces.${key} must be an object`)
    } else {
      source = "file"
      parseVerify(raw.verify, "", contract, problems)
    }
    if (raw.smoke) {
      if (typeof raw.smoke === "object" && typeof raw.smoke.start === "string" && raw.smoke.start.trim()) contract.smoke = raw.smoke
      else problems.push("smoke.start must be a non-empty string")
    }
  }
  // Fill verify gaps from autodetect only for checks the file does not define.
  let detectedUsed = false
  for (const k of CHECKS) {
    if (!contract.verify[k] && detected.verify[k]) {
      contract.verify[k] = detected.verify[k]
      detectedUsed = true
    }
  }
  if (source === "none" && detectedUsed) source = "autodetect"
  else if (source === "file" && detectedUsed) source = "file+autodetect"
  contract.autodetected_smoke = contract.smoke ? null : detected.smokeHint ? {
    start: detected.smokeHint.start,
    ready_url: "http://127.0.0.1:${PORT}/",
    ready_timeout_ms: 30000,
    checks: [{ name: "root", method: "GET", path: "/", expect_status: [200, 201, 202, 204, 301, 302, 303, 307, 308] }],
  } : null
  return { contract, source, problems, smokeHint: contract.smoke ? null : detected.smokeHint }
}

// ---------------------------------------------------------- processes

export function runtimeEnv(info, extra = {}) {
  const scratch = ensureScratch(info)
  const env = {
    ...process.env,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    PIPELINE_SCRATCH: scratch,
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    ...extra,
  }
  // When we run inside `node --test`, this variable makes a nested `node --test` act as a child
  // reporter and exit 0 even when its tests fail: a silent false pass. Child runs must be independent.
  delete env.NODE_TEST_CONTEXT
  return env
}

export function groupAlive(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (e) {
    return e.code === "EPERM"
  }
}

/** Terminate a process group: SIGTERM, grace period, SIGKILL. Resolves when gone. */
export async function killTree(pid, graceMs = 2500) {
  if (!Number.isInteger(pid) || pid <= 1) return
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      /* already gone */
    }
  }
  const t0 = Date.now()
  while (Date.now() - t0 < graceMs) {
    if (!groupAlive(pid)) return
    await sleep(100)
  }
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    /* gone */
  }
  await sleep(150)
}

/** Run a shell command with a hard timeout; the whole process group is killed on timeout/abort. */
export function runCommand(command, { cwd, env, timeoutMs, signal, maxOutput = 48 * 1024 }) {
  return new Promise((resolve) => {
    const started = Date.now()
    let out = ""
    let truncated = false
    let timedOut = false
    let aborted = false
    const child = spawn("sh", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    const onData = (d) => {
      out += d.toString("utf8")
      if (out.length > maxOutput * 2) {
        out = out.slice(-maxOutput)
        truncated = true
      }
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    const timer = setTimeout(() => {
      timedOut = true
      void killTree(child.pid)
    }, timeoutMs)
    const onAbort = () => {
      aborted = true
      void killTree(child.pid)
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    }
    let done = false
    let exitRec = null
    const finish = (exitCode, sig) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener("abort", onAbort)
      resolve({
        exitCode,
        signal: sig,
        timedOut,
        aborted,
        truncated,
        durationMs: Date.now() - started,
        output: out.length > maxOutput ? out.slice(-maxOutput) : out,
      })
    }
    child.on("error", (e) => {
      out += `\nspawn error: ${e.message}`
      finish(127, null)
    })
    // The shell exited: anything it left running in the background must not outlive the
    // command (it would also keep the pipes open and make us wait for nothing).
    child.on("exit", (code, sig) => {
      exitRec = { code, sig }
      if (groupAlive(child.pid)) void killTree(child.pid, 500)
      setTimeout(() => finish(code, sig), 2500).unref()
    })
    child.on("close", (code, sig) => finish(exitRec ? exitRec.code : code, exitRec ? exitRec.sig : sig))
  })
}

// --------------------------------------------------------------- ports

function tryListen(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once("error", (e) => resolve(e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT" ? "skip" : false))
    srv.listen({ port, host }, () => srv.close(() => resolve(true)))
  })
}

export async function isPortFree(port) {
  for (const host of ["127.0.0.1", "::1", "0.0.0.0"]) {
    if ((await tryListen(port, host)) === false) return false
  }
  return true
}

export async function findFreePort(from = 43000, to = 43999) {
  const span = to - from + 1
  const start = from + Math.floor(Math.random() * span)
  for (let i = 0; i < span; i++) {
    const port = from + ((start - from + i) % span)
    if (await isPortFree(port)) return port
  }
  throw new Error(`no free port in ${from}-${to}`)
}

export function portListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" })
    s.once("connect", () => {
      s.destroy()
      resolve(true)
    })
    s.once("error", () => resolve(false))
    s.setTimeout(1000, () => {
      s.destroy()
      resolve(false)
    })
  })
}

// ------------------------------------------------------ failure hints

const ENV_PATTERNS = [
  /EADDRINUSE|address already in use/i,
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i,
  /command not found|is not recognized as an internal|not found in PATH|spawn \S+ ENOENT/i,
  /(?:environment variable|env var)\b.{0,60}\b(?:not set|is required|missing|undefined)/i,
  /\bmissing (?:required )?(?:env|environment|credentials?|api[_ -]?key)/i,
  /password authentication failed|authentication failed|invalid credentials|access denied for user|permission denied \(publickey\)/i,
  /could not connect to (?:server|database)|connection to (?:server|database) .{0,40} failed/i,
]

export function envHint(output) {
  return typeof output === "string" && ENV_PATTERNS.some((re) => re.test(output))
}

export function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

const tail = (s, n) => redact(s.length > n ? "…" + s.slice(-n) : s)

// --------------------------------------------------------------- verify

/**
 * Validate a repo-relative workspace directory. Returns { rel } (null rel = repository root) or { error }.
 */
export function resolveWorkspace(info, workspace) {
  if (workspace === undefined || workspace === null || workspace === "") return { rel: null }
  if (typeof workspace !== "string") return { error: "workspace must be a repo-relative directory path" }
  const abs = realpathLoose(path.resolve(info.top, workspace))
  if (!isInside(info.top, abs)) return { error: `workspace ${workspace} is outside the repository` }
  const rel = path.relative(info.top, abs).split(path.sep).join("/")
  if (rel === ".git" || rel.startsWith(".git/")) return { error: "workspace may not point into .git" }
  let isDir = false
  try {
    isDir = fs.statSync(abs).isDirectory()
  } catch {
    /* missing */
  }
  if (!isDir) return { error: `workspace ${workspace} is not an existing directory` }
  return { rel: rel || null }
}

/** Unique `./dir` package paths of the given (cwd-relative) files, for go-style runners. */
function packagesOf(files) {
  const dirs = [...new Set(files.map((f) => path.posix.dirname(f)))]
  return dirs.map((d) => (d === "." ? "." : `./${d}`))
}

const MAX_FILTER_LEN = 500

/**
 * checks: names from CHECKS (default: test_filter when filter is given, else test_targeted when files are
 * given, else test_fast). filter: test name / expression for test_filter. workspace: repo-relative subdir
 * used as cwd. withServices: contract service names started before the checks and always stopped after.
 */
export async function runVerify({
  info, checks, files = [], filter, workspace, withServices: serviceNames = [], stopOnFail = true, timeoutScale = 1, signal, owner, serviceOptions,
}) {
  const ws = resolveWorkspace(info, workspace)
  if (ws.error) return { status: "error", failure_class_hint: "harness", reason: ws.error, results: [] }
  const cwd = ws.rel ? path.join(info.top, ws.rel) : info.top
  const { contract, source, problems } = loadContract(info.top, { workspace: ws.rel })
  if (filter !== undefined && filter !== null && (typeof filter !== "string" || !filter.trim() || filter.length > MAX_FILTER_LEN || /[\n\r\0]/.test(filter))) {
    return { status: "error", failure_class_hint: "harness", reason: `filter must be a single-line, non-empty string of at most ${MAX_FILTER_LEN} characters`, results: [] }
  }
  const hasFilter = typeof filter === "string" && filter.trim() !== ""
  if (!Array.isArray(checks) || !checks.length) checks = hasFilter ? ["test_filter"] : files.length ? ["test_targeted"] : ["test_fast"]
  const names = Array.isArray(serviceNames) ? serviceNames : []
  const unknown = names.filter((n) => !Object.prototype.hasOwnProperty.call(contract.services, n))
  if (unknown.length) {
    return {
      status: "error",
      failure_class_hint: "harness",
      reason: `unknown service(s) ${unknown.join(", ")}; defined: ${Object.keys(contract.services).join(", ") || "none"} (add them to services in ${CONTRACT_PATH})`,
      contract_problems: problems,
      results: [],
    }
  }
  const results = []
  const rels = []
  const rejected = []
  for (const f of files) {
    const rel = toRel(info, f)
    if (!rel) rejected.push(f)
    else if (!ws.rel) rels.push(rel)
    else if (rel.startsWith(ws.rel + "/")) rels.push(rel.slice(ws.rel.length + 1))
    else rejected.push(f)
  }
  let totalS = 0
  for (const c of checks) totalS += (contract.timeouts[c] || DEFAULT_TIMEOUT_S[c] || 0) * timeoutScale
  let stopped = false
  const runChecks = async (serviceEnv) => {
    const env = runtimeEnv(info, serviceEnv)
    for (const check of checks) {
      if (!CHECKS.includes(check)) {
        results.push({ check, status: "error", reason: `unknown check; valid: ${CHECKS.join(", ")}` })
        continue
      }
      if (stopped) {
        results.push({ check, status: "not_run", reason: "an earlier check failed" })
        continue
      }
      let cmd = contract.verify[check]
      if (!cmd) {
        const where = ws.rel ? `workspaces.${ws.rel}.verify.${check}` : `verify.${check}`
        results.push({ check, status: "skipped", reason: `no command defined (add ${where} to ${CONTRACT_PATH})` })
        continue
      }
      if (check === "test_targeted" && !rels.length && /\{(files|packages)\}/.test(cmd)) {
        results.push({ check, status: "skipped", reason: "no files given for the targeted command" })
        continue
      }
      if (check === "test_filter") {
        if (!hasFilter) {
          results.push({ check, status: "skipped", reason: "no filter given" })
          continue
        }
        cmd = cmd.replaceAll("{filter}", shQuote(filter))
      }
      if (check === "test_targeted" || check === "test_filter") {
        cmd = cmd
          .replaceAll("{files}", rels.map(shQuote).join(" "))
          .replaceAll("{packages}", rels.length ? packagesOf(rels).map(shQuote).join(" ") : "./...")
      }
      const timeoutS = (contract.timeouts[check] || DEFAULT_TIMEOUT_S[check]) * timeoutScale
      const r = await runCommand(cmd, { cwd, env, timeoutMs: timeoutS * 1000, signal })
      const status = r.aborted ? "aborted" : r.timedOut ? "timeout" : r.exitCode === 0 ? "pass" : "fail"
      const res = {
        check,
        command: cmd,
        status,
        exit_code: r.exitCode,
        duration_ms: r.durationMs,
        output_tail: tail(r.output, status === "pass" ? 800 : 7000),
      }
      if (status === "timeout") {
        res.failure_class_hint = "timeout"
        res.note = `exceeded ${timeoutS}s; narrow the scope instead of repeating the same command`
      } else if (status === "fail") {
        res.failure_class_hint = envHint(r.output) ? "env" : "unclassified"
      }
      results.push(res)
      if (status !== "pass" && stopOnFail) stopped = true
    }
  }
  let svc = null
  const run = async () => {
    if (!names.length) return runChecks({})
    svc = await withServices(
      { info, defs: contract.services, names, cwd, signal, ttlS: totalS + 600, probe: serviceOptions },
      (serviceEnv) => runChecks(serviceEnv),
    )
  }
  const base = {
    contract_source: source,
    contract_problems: problems,
    ...(ws.rel ? { workspace: ws.rel } : {}),
    ...(hasFilter ? { filter } : {}),
    rejected_files: rejected,
  }
  try {
    await withLock(info, "verify", run, { owner: owner || "verify", timeoutMs: 10 * 60 * 1000 })
  } catch (e) {
    if (e.code === "LOCK_TIMEOUT") {
      return { status: "error", failure_class_hint: "harness", reason: e.message, ...base, results }
    }
    throw e
  }
  if (svc && !svc.ok) {
    const f = svc.failed
    return {
      status: f.status === "aborted" ? "aborted" : "blocked",
      phase: "services",
      failure_class_hint: f.failure_class_hint || "harness",
      reason: `service ${f.name} could not be started: ${f.reason || f.status}`,
      ...base,
      services: svc.services,
      results: checks.map((check) => ({ check, status: "not_run", reason: "a required service did not start" })),
    }
  }
  const bad = results.some((r) => ["fail", "timeout", "error", "aborted"].includes(r.status))
  const ran = results.some((r) => r.status === "pass")
  const skipped = results.some((r) => ["skipped", "not_run"].includes(r.status))
  return {
    status: bad ? "fail" : ran ? (skipped ? "partial" : "pass") : "inconclusive",
    ...base,
    ...(svc ? { services: svc.services } : {}),
    results,
  }
}

// ---------------------------------------------------------------- smoke

export function parseEnvFile(file) {
  const out = {}
  let text = ""
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return out
  }
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!m) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

export const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/

async function checkUrl(spec, subst, timeoutMs) {
  const url = subst(spec.url)
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { status: "error", detail: `invalid url ${url}` }
  }
  if (!LOCAL_HOST.test(parsed.hostname)) return { status: "error", detail: `smoke checks may only target localhost (got ${parsed.hostname})` }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    const body = await res.text()
    const wanted = Array.isArray(spec.expect_status) ? spec.expect_status : [spec.expect_status ?? 200]
    if (!wanted.includes(res.status)) return { status: "fail", detail: `expected status ${wanted.join("|")}, got ${res.status}`, body_excerpt: redact(body.slice(0, 500)) }
    if (spec.expect_body && !new RegExp(spec.expect_body).test(body)) {
      return { status: "fail", detail: `body did not match /${spec.expect_body}/`, body_excerpt: redact(body.slice(0, 500)) }
    }
    return { status: "pass", detail: `HTTP ${res.status}` }
  } catch (e) {
    return { status: "error", detail: `request failed: ${e.message}` }
  }
}

export async function waitReady(ready, { portNum, subst, readLog, isExited, timeoutMs, signal }) {
  const t0 = Date.now()
  const spec = ready || { port: portNum }
  const re = spec.log ? new RegExp(spec.log) : null
  while (Date.now() - t0 < timeoutMs) {
    if (signal && signal.aborted) return { ok: false, reason: "aborted", ms: Date.now() - t0 }
    if (isExited()) return { ok: false, reason: "process exited before it became ready", exited: true, ms: Date.now() - t0 }
    if (re) {
      if (re.test(readLog())) return { ok: true, ms: Date.now() - t0 }
    } else if (spec.url) {
      try {
        const u = subst(spec.url)
        if (!LOCAL_HOST.test(new URL(u).hostname)) return { ok: false, reason: "ready.url must target localhost", ms: 0, harness: true }
        const res = await fetch(u, { signal: AbortSignal.timeout(2000) })
        await res.arrayBuffer()
        const okStatus = spec.status ? res.status === spec.status : res.status < 500
        if (okStatus) return { ok: true, ms: Date.now() - t0 }
      } catch {
        /* not up yet */
      }
    } else {
      const p = Number(subst(String(spec.port ?? portNum)))
      if (await portListening(p)) return { ok: true, ms: Date.now() - t0 }
    }
    await sleep(400)
  }
  return { ok: false, reason: `not ready after ${Math.round(timeoutMs / 1000)}s`, timeout: true, ms: Date.now() - t0 }
}

export async function runSmoke({ info, signal, owner, serviceOptions }) {
  const { contract, source, problems, smokeHint } = loadContract(info.top)
  const smoke = contract.smoke || contract.autodetected_smoke
  if (!smoke) {
    return {
      status: "inconclusive",
      failure_class_hint: "harness",
      reason: `no smoke contract: add a "smoke" section to ${CONTRACT_PATH}`,
      contract_problems: problems,
      suggested_smoke: smokeHint,
    }
  }
  const scratch = ensureScratch(info)
  const logPath = path.join(scratch, `smoke-${Date.now()}.log`)
  const detectedSmoke = !contract.smoke && contract.autodetected_smoke
  const contractSource = detectedSmoke ? source === "file" ? "file+autodetect" : "autodetect" : source
  const result = { status: "fail", contract_source: contractSource, phase: "start", checks: [], cleanup: {} }

  const serviceNames = smoke.services === undefined ? [] : smoke.services
  if (!Array.isArray(serviceNames) || serviceNames.some((n) => typeof n !== "string")) {
    return { ...result, status: "error", failure_class_hint: "harness", reason: "smoke.services must be an array of service names" }
  }
  const unknown = serviceNames.filter((n) => !Object.prototype.hasOwnProperty.call(contract.services, n))
  if (unknown.length) {
    return {
      ...result, status: "error", failure_class_hint: "harness", contract_problems: problems,
      reason: `unknown service(s) ${unknown.join(", ")} in smoke.services; defined: ${Object.keys(contract.services).join(", ") || "none"}`,
    }
  }

  const body = async (serviceEnv = {}) => {
    let portNum
    if (Number.isInteger(smoke.port)) {
      portNum = smoke.port
      if (!(await isPortFree(portNum))) {
        return { ...result, status: "blocked", failure_class_hint: "env", reason: `port ${portNum} is already in use by another process; refusing to kill it` }
      }
    } else {
      portNum = await findFreePort()
    }
    result.port = portNum
    const subst = (s) => String(s).replaceAll("${PORT}", String(portNum))
    let fileEnv = {}
    if (smoke.env_file) {
      const abs = realpathLoose(path.resolve(info.top, smoke.env_file))
      if (!isInside(info.top, abs)) return { ...result, status: "error", failure_class_hint: "harness", reason: "smoke.env_file must be inside the repository" }
      fileEnv = parseEnvFile(abs)
    }
    const extra = {}
    for (const [k, v] of Object.entries(smoke.env || {})) extra[k] = subst(v)
    const env = runtimeEnv(info, { ...fileEnv, ...serviceEnv, ...extra, PORT: String(portNum) })

    const fd = fs.openSync(logPath, "a")
    let exited = false
    let exitInfo = null
    const child = spawn("sh", ["-c", subst(smoke.start)], { cwd: info.top, env, detached: true, stdio: ["ignore", fd, fd] })
    child.on("exit", (code, sig) => {
      exited = true
      exitInfo = { code, signal: sig }
    })
    child.on("error", (e) => {
      exited = true
      exitInfo = { code: 127, error: e.message }
    })
    const readLog = () => {
      try {
        return fs.readFileSync(logPath, "utf8")
      } catch {
        return ""
      }
    }
    try {
      result.phase = "ready"
      const readySpec = smoke.ready || (smoke.ready_url ? { url: smoke.ready_url, timeout_s: smoke.ready_timeout_ms / 1000 } : null)
      const timeoutS = Math.min(Number(readySpec && readySpec.timeout_s) || 60, 180)
      const ready = await waitReady(readySpec, { portNum, subst, readLog, isExited: () => exited, timeoutMs: timeoutS * 1000, signal })
      result.ready_ms = ready.ms
      if (!ready.ok) {
        const log = readLog()
        if (ready.reason === "aborted" || (signal && signal.aborted)) {
          const spec = (smoke.checks || [])[0]
          if (spec) result.checks.push({ name: spec.name || spec.url || spec.cmd || "check", status: "aborted", detail: "aborted" })
          result.status = "aborted"
          result.reason = "aborted"
          result.failure_class_hint = "harness"
          result.log_tail = tail(log, 5000)
          return result
        }
        result.reason = ready.reason
        result.exit = exitInfo
        result.log_tail = tail(log, 5000)
        result.failure_class_hint = ready.harness ? "harness" : envHint(log) ? "env" : ready.exited ? "unclassified" : "harness"
        if (ready.exited && !envHint(log)) result.note = "the service crashed at startup without an environment signature: read log_tail and decide between a code defect and an environment problem"
        return result
      }
      if (signal && signal.aborted) {
        const spec = (smoke.checks || [])[0]
        if (spec) result.checks.push({ name: spec.name || spec.url || spec.cmd || "check", status: "aborted", detail: "aborted" })
        result.status = "aborted"
        result.reason = "aborted"
        result.failure_class_hint = "harness"
        result.log_tail = tail(readLog(), 3000)
        return result
      }
      result.phase = "checks"
      let allPass = true
      let codeFailure = false
      for (const rawSpec of smoke.checks || []) {
        const spec = rawSpec.path ? { ...rawSpec, url: `http://127.0.0.1:\${PORT}${rawSpec.path}` } : rawSpec
        const name = spec.name || spec.url || spec.cmd || "check"
        if (signal && signal.aborted) {
          result.checks.push({ name, status: "aborted", detail: "aborted" })
          result.status = "aborted"
          result.reason = "aborted"
          result.failure_class_hint = "harness"
          result.log_tail = tail(readLog(), 3000)
          return result
        }
        let r
        if (spec.url) {
          r = await checkUrl(spec, subst, 10000)
          if (signal && signal.aborted) {
            result.checks.push({ name, status: "aborted", detail: "aborted" })
            result.status = "aborted"
            result.reason = "aborted"
            result.failure_class_hint = "harness"
            result.log_tail = tail(readLog(), 3000)
            return result
          }
        } else if (spec.cmd) {
          const c = await runCommand(subst(spec.cmd), { cwd: info.top, env, timeoutMs: (spec.timeout_s || 30) * 1000, signal })
          if (c.aborted || (signal && signal.aborted)) {
            result.checks.push({ name, status: "aborted", detail: "aborted", ...(c.output ? { output_excerpt: tail(c.output, 1000) } : {}) })
            result.status = "aborted"
            result.reason = "aborted"
            result.failure_class_hint = "harness"
            result.log_tail = tail(readLog(), 3000)
            return result
          }
          const okExit = c.exitCode === 0
          const okOut = !spec.expect_output || new RegExp(spec.expect_output).test(c.output)
          r = okExit && okOut ? { status: "pass", detail: "exit 0" } : { status: c.timedOut ? "error" : "fail", detail: `exit ${c.exitCode}${okOut ? "" : `, output did not match /${spec.expect_output}/`}`, output_excerpt: tail(c.output, 1000) }
        } else r = { status: "error", detail: "check needs url or cmd" }
        result.checks.push({ name, ...r })
        if (r.status !== "pass") {
          allPass = false
          if (r.status === "fail") codeFailure = true
        }
        if (exited) break
      }
      if (exited) {
        result.exit = exitInfo
        result.log_tail = tail(readLog(), 4000)
        result.failure_class_hint = envHint(readLog()) ? "env" : "unclassified"
        result.note = "the service stopped while checks were running"
        return result
      }
      if (allPass) {
        result.status = "pass"
        result.log_tail = tail(readLog(), 600)
        return result
      }
      result.failure_class_hint = codeFailure ? "code" : "harness"
      result.log_tail = tail(readLog(), 3000)
      return result
    } finally {
      await killTree(child.pid)
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
      let free = false
      for (let i = 0; i < 20 && !free; i++) {
        free = await isPortFree(portNum)
        if (!free) await sleep(250)
      }
      result.cleanup = { process_stopped: !groupAlive(child.pid), port_free: free }
      try {
        fs.rmSync(logPath, { force: true })
      } catch {
        /* ignore */
      }
    }
  }

  const withDeps = async () => {
    if (!serviceNames.length) return body()
    const svc = await withServices({ info, defs: contract.services, names: serviceNames, cwd: info.top, signal, ttlS: 900, probe: serviceOptions }, body)
    if (!svc.ok) {
      const f = svc.failed
      return {
        ...result,
        status: f.status === "aborted" ? "aborted" : "blocked",
        phase: "services",
        failure_class_hint: f.failure_class_hint || "harness",
        reason: `service ${f.name} could not be started: ${f.reason || f.status}`,
        services: svc.services,
      }
    }
    return { ...svc.value, services: svc.services }
  }

  try {
    return await withLock(info, "smoke", withDeps, { owner: owner || "smoke", timeoutMs: 3 * 60 * 1000 })
  } catch (e) {
    if (e.code === "LOCK_TIMEOUT") return { ...result, status: "blocked", failure_class_hint: "harness", reason: `another session is running a smoke test (${e.message})` }
    return { ...result, status: "error", failure_class_hint: "harness", reason: e.message }
  }
}
