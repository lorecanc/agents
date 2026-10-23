// Read-only environment probe for the *-pipeline-* agents (tool: pipeline_env).
//
// Called once at session start so the planner writes a verification plan that matches what this
// machine can actually run (Docker, database binaries, declared services, pipeline tools, MCP
// servers), instead of agents discovering the limits by failing mid-session.
//
// Rules: never modifies anything, never throws (a failing probe degrades to "unknown" with a
// reason), bounded runtime (only `docker info` is executed, with a short timeout), never returns
// environment variable VALUES and never reads `.env` itself.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"

import { isInside, realpathLoose, repoInfo, rootRecordFor } from "./_pipeline_core.js"
import { CHECKS, CONTRACT_PATH, autodetect } from "./_pipeline_run.js"

export const BINARIES = [
  "psql", "pg_ctl", "initdb", "pg_isready", "postgres", "mysql", "mysqld", "redis-server", "mongod",
  "python3", "node", "npm", "pnpm", "yarn", "bun", "go", "cargo", "java", "mvn", "gradle", "uv", "poetry", "pytest",
  "docker", "podman",
]
export const EXPECTED_TOOLS = ["pipeline_env", "pipeline_state", "pipeline_commit", "pipeline_verify", "pipeline_smoke", "pipeline_serve"]
const KNOWN_CONTRACT_KEYS = new Set(["version", "setup", "verify", "smoke", "serve", "timeouts", "worktree", "services", "workspaces"])
const WORKSPACE_MARKERS = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts"]
const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "dist", "build", ".venv", "venv", "target", "__pycache__", ".next", "coverage"])
const ENV_TEMPLATES = [".env.example", ".env.sample"]

function toolsDirDefault() {
  try {
    return path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return typeof __dirname === "string" ? __dirname : null
  }
}

const unknown = (reason) => ({ status: "unknown", reason })

function safe(fn, label) {
  try {
    return fn()
  } catch (e) {
    return unknown(`${label} probe failed: ${e && e.message ? e.message : String(e)}`)
  }
}

const clip = (s, n = 200) => {
  const t = String(s ?? "").trim().replace(/\s+/g, " ")
  return t.length > n ? `${t.slice(0, n)}...` : t
}

// ----------------------------------------------------------------- binaries

export function whichBin(name, envPath = process.env.PATH || "") {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, name)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      if (fs.statSync(p).isFile()) return p
    } catch {
      /* next */
    }
  }
  return null
}

function probeBinaries(envPath) {
  const out = {}
  for (const b of BINARIES) out[b] = whichBin(b, envPath)
  // Keg-only / app-bundled Postgres installs are common on macOS and invisible on PATH.
  const offPath = []
  for (const base of ["/opt/homebrew/opt", "/usr/local/opt"]) {
    let names = []
    try {
      names = fs.readdirSync(base)
    } catch {
      continue
    }
    for (const n of names) if (/^(postgresql|libpq|mysql|redis|mongodb)/.test(n) && fs.existsSync(path.join(base, n, "bin"))) offPath.push(path.join(base, n, "bin"))
  }
  const pgApp = "/Applications/Postgres.app/Contents/Versions/latest/bin"
  if (fs.existsSync(pgApp)) offPath.push(pgApp)
  return { found: out, missing: BINARIES.filter((b) => !out[b]), ...(offPath.length ? { not_on_path_but_installed: offPath } : {}) }
}

// ------------------------------------------------------------------- docker

function isSocket(p) {
  try {
    return fs.statSync(p).isSocket()
  } catch {
    return false
  }
}

function runBounded(cmd, args, timeoutMs, env) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    try {
      const child = execFile(cmd, args, { timeout: timeoutMs, killSignal: "SIGKILL", env, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
        if (err) finish({ ok: false, timedOut: Boolean(err.killed || err.signal), stderr: String(stderr || err.message || "") })
        else finish({ ok: true, stdout: String(stdout || "") })
      })
      child.on("error", (e) => finish({ ok: false, stderr: e.message }))
    } catch (e) {
      finish({ ok: false, stderr: e.message })
    }
    setTimeout(() => finish({ ok: false, timedOut: true, stderr: "probe timeout" }), timeoutMs + 500).unref()
  })
}

async function probeDocker(env, binaries, timeoutMs) {
  const home = os.homedir()
  const candidates = []
  const dh = env.DOCKER_HOST
  if (dh && dh.startsWith("unix://")) candidates.push(dh.slice("unix://".length))
  candidates.push(
    "/var/run/docker.sock",
    path.join(home, ".docker/run/docker.sock"),
    path.join(home, ".docker/desktop/docker.sock"),
    path.join(home, ".colima/default/docker.sock"),
    path.join(home, ".colima/docker.sock"),
    path.join(home, ".orbstack/run/docker.sock"),
    path.join(home, ".rd/docker.sock"),
  )
  if (env.XDG_RUNTIME_DIR) candidates.push(path.join(env.XDG_RUNTIME_DIR, "docker.sock"), path.join(env.XDG_RUNTIME_DIR, "podman/podman.sock"))
  const sockets = [...new Set(candidates)].filter(isSocket)
  const cli = binaries.found.docker || null
  const out = {
    cli,
    docker_host: dh ? (dh.startsWith("unix://") ? dh : dh.replace(/\/\/[^@/]*@/, "//[REDACTED]@")) : null,
    sockets_found: sockets,
    daemon: null,
  }
  if (!cli) {
    out.daemon = { reachable: false, reason: "docker CLI not on PATH" }
    return out
  }
  const r = await runBounded(cli, ["info", "--format", "{{.ServerVersion}}"], timeoutMs, env)
  if (r.ok) out.daemon = { reachable: true, server_version: clip(r.stdout, 40) }
  else if (r.timedOut) out.daemon = { reachable: "unknown", reason: `docker info did not answer within ${timeoutMs} ms` }
  else out.daemon = { reachable: false, reason: clip(r.stderr) || "docker info failed" }
  return out
}

// ----------------------------------------------------------------- contract

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

function serviceKind(svc) {
  if (!svc || typeof svc !== "object") return "unknown"
  for (const k of ["kind", "type", "engine"]) if (typeof svc[k] === "string") return svc[k]
  if (svc.image || svc.docker) return "docker"
  if (svc.start || svc.cmd || svc.command) return "process"
  return "unknown"
}

function probeContract(top, wsDir) {
  const file = path.join(top, CONTRACT_PATH)
  const exists = fs.existsSync(file)
  const problems = []
  let raw = null
  if (exists) {
    raw = readJson(file)
    if (raw === undefined) problems.push(`${CONTRACT_PATH} is not valid JSON`)
    else if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      problems.push(`${CONTRACT_PATH} must be a JSON object`)
      raw = null
    }
  }
  raw = raw || {}
  const verifyDefined = []
  const verify = raw.verify && typeof raw.verify === "object" ? raw.verify : {}
  for (const k of CHECKS) {
    const v = verify[k]
    if (v === undefined || v === null) continue
    if (typeof v === "string" && v.trim()) verifyDefined.push(k)
    else problems.push(`verify.${k} must be a non-empty string`)
  }
  let detected = { verify: {}, smokeHint: null }
  try {
    detected = autodetect(wsDir || top)
  } catch (e) {
    problems.push(`autodetect failed: ${e.message}`)
  }
  const verifyAutodetected = CHECKS.filter((k) => !verifyDefined.includes(k) && detected.verify[k])
  const services = raw.services && typeof raw.services === "object" && !Array.isArray(raw.services)
    ? Object.entries(raw.services).map(([name, svc]) => {
      const image = svc && typeof svc.image === "string" ? svc.image : null
      return { name, kind: serviceKind(svc), ...(image ? { image: clip(image, 120) } : {}) }
    })
    : []
  const workspaces = raw.workspaces && typeof raw.workspaces === "object" && !Array.isArray(raw.workspaces) ? raw.workspaces : {}
  const workspaceEntries = Object.entries(workspaces).map(([dir, w]) => ({
    dir,
    verify: w && typeof w.verify === "object" && w.verify ? Object.keys(w.verify) : [],
    services: w && Array.isArray(w.services) ? w.services.filter((x) => typeof x === "string") : [],
  }))
  return {
    exists,
    path: CONTRACT_PATH,
    problems,
    setup: typeof raw.setup === "string",
    verify_defined: verifyDefined,
    verify_autodetected: verifyAutodetected,
    verify_missing: CHECKS.filter((k) => !verifyDefined.includes(k) && !verifyAutodetected.includes(k)),
    commands: Object.fromEntries(CHECKS.map((k) => [k, verifyDefined.includes(k) ? verify[k] : detected.verify[k]]).filter(([, v]) => v)),
    services,
    smoke: Boolean(raw.smoke),
    serve: Boolean(raw.serve),
    smoke_autodetected: !raw.smoke && Boolean(detected.smokeHint),
    workspaces: workspaceEntries,
    other_keys: Object.keys(raw).filter((k) => !KNOWN_CONTRACT_KEYS.has(k)),
  }
}

// --------------------------------------------------------------- workspaces

export function detectWorkspaces(top, maxDepth = 2, limit = 60) {
  const out = []
  let scanned = 0
  const visit = (dir, depth) => {
    if (out.length >= limit || scanned > 2000) return
    scanned++
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name))
    const markers = WORKSPACE_MARKERS.filter((m) => names.has(m))
    if (markers.length) out.push({ dir: path.relative(top, dir).split(path.sep).join("/") || ".", markers })
    if (depth >= maxDepth) return
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue
      visit(path.join(dir, e.name), depth + 1)
    }
  }
  visit(top, 0)
  return { dirs: out, truncated: out.length >= limit || scanned > 2000 }
}

// ------------------------------------------------------------------ env vars

export function envTemplateNames(file) {
  let body = ""
  try {
    body = fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
  const names = []
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    if (m && !names.includes(m[1])) names.push(m[1])
  }
  return names
}

function probeEnvVars(dirs, top, env) {
  const files = []
  const vars = []
  const seen = new Set()
  for (const dir of dirs) {
    for (const t of ENV_TEMPLATES) {
      const file = path.join(dir, t)
      const names = envTemplateNames(file)
      if (!names) continue
      files.push(path.relative(top, file).split(path.sep).join("/"))
      for (const n of names.slice(0, 200)) {
        if (seen.has(n)) continue
        seen.add(n)
        // only a boolean: values are never returned
        vars.push({ name: n, set: typeof env[n] === "string" && env[n] !== "" })
      }
    }
  }
  return { files, vars, unset: vars.filter((v) => !v.set).map((v) => v.name), note: "values are never read or returned; .env itself is not read" }
}

// ------------------------------------------------------------- mcp / pipeline

function stripJsonc(text) {
  let out = ""
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const n = text[i + 1]
    if (inStr) {
      out += c
      if (c === "\\") {
        out += n ?? ""
        i++
      } else if (c === '"') inStr = false
    } else if (c === '"') {
      inStr = true
      out += c
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (c === "/" && n === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++
    } else out += c
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

function probeMcp(top, env) {
  const cfgHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  const files = [
    path.join(cfgHome, "opencode", "opencode.json"),
    path.join(cfgHome, "opencode", "opencode.jsonc"),
    path.join(cfgHome, "opencode", "config.json"),
    env.OPENCODE_CONFIG || null,
    path.join(top, "opencode.json"),
    path.join(top, "opencode.jsonc"),
    path.join(top, ".opencode", "opencode.json"),
    path.join(top, ".opencode", "opencode.jsonc"),
  ].filter(Boolean)
  const servers = {}
  const read = []
  for (const f of files) {
    let text
    try {
      text = fs.readFileSync(f, "utf8")
    } catch {
      continue
    }
    let cfg
    try {
      cfg = JSON.parse(stripJsonc(text))
    } catch {
      read.push({ file: f, parsed: false })
      continue
    }
    read.push({ file: f, parsed: true })
    const mcp = cfg && typeof cfg.mcp === "object" && cfg.mcp ? cfg.mcp : {}
    // names, type and enabled flag only: commands, urls, headers and env may carry secrets
    for (const [name, v] of Object.entries(mcp)) {
      servers[name] = { name, type: v && typeof v.type === "string" ? v.type : null, enabled: !(v && v.enabled === false), source: f }
    }
  }
  return { config_files: read, servers: Object.values(servers) }
}

function probePipeline(info, sessionId, toolsDir) {
  const out = { guard_registered: "unknown", baseline: "unknown", root_session: null, tools_dir: toolsDir, tools_present: [], tools_missing: [], guard_plugin_file: "unknown" }
  if (info && sessionId) {
    let root = null
    try {
      root = rootRecordFor(info, sessionId)
    } catch {
      root = null
    }
    out.guard_registered = Boolean(root)
    out.baseline = Boolean(root && root.baseline)
    out.root_session = root ? root.sessionId : null
    if (!root) out.reason = "no session record for this session: the pipeline-guard plugin is not loaded or the agent is not a *-pipeline-* agent"
  } else if (!info) out.reason = "not a git repository"
  else out.reason = "no session id in the tool context"
  if (toolsDir) {
    try {
      const names = fs.readdirSync(toolsDir)
      out.tools_present = [...new Set(names.filter((n) => /^pipeline_[a-z_]+\.(ts|js|mjs)$/.test(n)).map((n) => n.replace(/\.[^.]+$/, "")))].sort()
      out.tools_missing = EXPECTED_TOOLS.filter((t) => !out.tools_present.includes(t))
    } catch (e) {
      out.tools_reason = `cannot list tools dir: ${e.message}`
    }
    out.guard_plugin_file = fs.existsSync(path.join(toolsDir, "..", "plugins", "pipeline-guard.js"))
  }
  return out
}

// ----------------------------------------------------------------- outlook

const RUNNER_BIN = [
  [/^(npm|npx)\b/, "npm"], [/^pnpm\b/, "pnpm"], [/^yarn\b/, "yarn"], [/^bun\b/, "bun"], [/^node\b/, "node"],
  [/^go\b/, "go"], [/^cargo\b/, "cargo"], [/^(python3?|pytest)\b/, "python3"], [/^uv\b/, "uv"], [/^poetry\b/, "poetry"],
  [/^mvn\b/, "mvn"], [/^(gradle|\.\/gradlew)\b/, "java"],
]

function runnerFor(command) {
  const cmd = String(command || "").replace(/^(\s*[A-Z_][A-Z0-9_]*=\S*\s+)+/, "").trim()
  for (const [re, bin] of RUNNER_BIN) if (re.test(cmd)) return bin
  return null
}

const DB_KINDS = [
  { kind: "postgres", re: /postg|^pg$|^pg_/i, local: ["pg_ctl", "initdb"], alt: ["postgres"] },
  { kind: "mysql", re: /mysql|maria/i, local: ["mysqld"] },
  { kind: "redis", re: /redis|valkey/i, local: ["redis-server"] },
  { kind: "mongo", re: /mongo/i, local: ["mongod"] },
]

function deriveOutlook(r) {
  const bins = (r.binaries && r.binaries.found) || {}
  const contract = r.contract && !r.contract.status ? r.contract : null
  const dockerOk = r.docker && r.docker.daemon && r.docker.daemon.reachable === true
  const outlook = {}

  // unit tests
  if (!contract) outlook.unit_tests = { feasible: "unknown", reason: "contract/autodetect probe failed" }
  else {
    const testKey = ["test_fast", "test_targeted", "test_full"].find((k) => contract.commands[k])
    if (!testKey) {
      const subs = r.workspaces_detected && Array.isArray(r.workspaces_detected.dirs) ? r.workspaces_detected.dirs.filter((d) => d.dir !== ".").map((d) => d.dir) : []
      const hint = subs.length && !r.workspace ? `; sub-projects detected (${subs.slice(0, 8).join(", ")}): call pipeline_env with workspace=<dir>` : ""
      outlook.unit_tests = { feasible: false, reason: `no test command defined in .opencode/pipeline.json or autodetected${hint}` }
    }
    else {
      const bin = runnerFor(contract.commands[testKey])
      if (bin && !bins[bin]) outlook.unit_tests = { feasible: false, reason: `${testKey} uses ${bin}, which is not on PATH` }
      else outlook.unit_tests = { feasible: true, reason: `${testKey}: ${contract.commands[testKey]}` }
    }
  }

  // db-backed tests
  const declared = contract ? contract.services : []
  const envNames = (r.env_vars && r.env_vars.vars ? r.env_vars.vars : []).map((v) => v.name)
  const needed = new Set()
  for (const s of declared) for (const d of DB_KINDS) if (d.re.test(s.kind) || d.re.test(s.name) || (s.image && d.re.test(s.image.split(/[:@]/)[0].split("/").pop()))) needed.add(d.kind)
  for (const n of envNames) {
    if (/^(DATABASE_URL|PG[A-Z]*|POSTGRES_[A-Z_]*)$/.test(n)) needed.add("postgres")
    else if (/^(MYSQL_[A-Z_]*)$/.test(n)) needed.add("mysql")
    else if (/^REDIS_[A-Z_]*$/.test(n)) needed.add("redis")
    else if (/^MONGO[A-Z_]*$/.test(n)) needed.add("mongo")
  }
  if (!needed.size && !declared.length) outlook.db_backed_tests = { feasible: "n/a", reason: "no services declared and no database variables in .env.example/.env.sample" }
  else {
    const missing = []
    for (const kind of needed) {
      const d = DB_KINDS.find((x) => x.kind === kind)
      const local = d.local.every((b) => bins[b]) || (d.alt || []).some((b) => bins[b])
      if (!local && !dockerOk) missing.push(kind)
    }
    const via = dockerOk ? "Docker daemon reachable" : "local binaries"
    if (missing.length) outlook.db_backed_tests = { feasible: false, needs: [...needed], reason: `no local server binaries for ${missing.join(", ")} and no reachable Docker daemon${r.binaries && r.binaries.not_on_path_but_installed ? " (some installs exist off PATH, see binaries.not_on_path_but_installed)" : ""}` }
    else outlook.db_backed_tests = { feasible: needed.size ? true : "unknown", needs: [...needed], services: declared.map((s) => s.name), reason: needed.size ? `via ${via}` : "services declared but their kind is not a known database" }
  }

  // runtime smoke
  if (!contract) outlook.runtime_smoke = { feasible: "unknown", reason: "contract probe failed" }
  else if (contract.smoke || contract.serve) outlook.runtime_smoke = { feasible: fs.existsSync("/bin/sh"), reason: fs.existsSync("/bin/sh") ? "smoke/serve section in the contract" : "/bin/sh missing" }
  else if (contract.smoke_autodetected) outlook.runtime_smoke = { feasible: true, reason: "autodetected dev/start script (draft: may ignore PORT)" }
  else outlook.runtime_smoke = { feasible: false, reason: "no smoke/serve section and no dev/start script to autodetect" }

  // browser
  const mcp = r.mcp && Array.isArray(r.mcp.servers) ? r.mcp.servers : null
  const browserMcp = mcp ? mcp.filter((s) => s.enabled && /chrome|browser|playwright|puppeteer/i.test(s.name)) : []
  if (outlook.runtime_smoke.feasible !== true) outlook.browser = { feasible: false, reason: "nothing to serve (see runtime_smoke)" }
  else if (!mcp) outlook.browser = { feasible: "unknown", reason: "opencode MCP configuration not readable" }
  else if (!browserMcp.length) outlook.browser = { feasible: false, reason: "no enabled browser MCP server (chrome/playwright/puppeteer) in the opencode config files read" }
  else outlook.browser = { feasible: true, reason: `MCP: ${browserMcp.map((s) => s.name).join(", ")}` }

  return outlook
}

// -------------------------------------------------------------------- entry

export async function collectEnv({ directory, workspace, sessionId, toolsDir = toolsDirDefault(), env = process.env, dockerTimeoutMs = 3000 } = {}) {
  const started = Date.now()
  const r = { generated_at: new Date(started).toISOString() }
  let info = null
  try {
    info = directory ? repoInfo(directory) : null
  } catch {
    info = null
  }
  const top = info ? info.top : directory ? realpathLoose(directory) : process.cwd()
  r.repository = { top, git: Boolean(info) }
  let wsDir = null
  if (workspace) {
    const abs = realpathLoose(path.resolve(top, workspace))
    if (!isInside(top, abs)) r.workspace = { requested: workspace, error: "outside the repository, ignored" }
    else if (!fs.existsSync(abs)) r.workspace = { requested: workspace, error: "does not exist, ignored" }
    else {
      wsDir = abs
      r.workspace = { requested: workspace, dir: path.relative(top, abs).split(path.sep).join("/") || "." }
    }
  }
  r.docker = null // filled below, kept first for readability
  r.binaries = safe(() => probeBinaries(env.PATH || ""), "binaries")
  const dockerP = r.binaries.found
    ? probeDocker(env, r.binaries, dockerTimeoutMs).catch((e) => unknown(`docker probe failed: ${e.message}`))
    : Promise.resolve(unknown("binaries probe failed"))
  r.contract = safe(() => probeContract(top, wsDir), "contract")
  r.workspaces_detected = safe(() => detectWorkspaces(top), "workspaces")
  r.pipeline = safe(() => probePipeline(info, sessionId, toolsDir), "pipeline")
  r.mcp = safe(() => probeMcp(top, env), "mcp")
  r.env_vars = safe(() => probeEnvVars(wsDir && wsDir !== top ? [wsDir, top] : [top], top, env), "env_vars")
  r.docker = await Promise.race([
    dockerP,
    new Promise((resolve) => setTimeout(() => resolve(unknown("docker probe exceeded its time budget")), dockerTimeoutMs + 1500).unref()),
  ])
  r.verification_outlook = safe(() => deriveOutlook(r), "outlook")
  r.elapsed_ms = Date.now() - started
  return r
}
