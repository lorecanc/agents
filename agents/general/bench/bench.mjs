#!/usr/bin/env node
// Benchmark runner for the *-pipeline-* agent families.
//
//   node bench.mjs list
//   node bench.mjs run [--family hybrid] [--task <id>]... [--config-dir <dir>] [--model <provider/model>]
//                      [--timeout-min 20] [--out results.json] [--keep] [--dry-run]
//   node bench.mjs compare <a.json> <b.json>
//
// Each task runs in a throwaway git repository created from a fixture (a temp directory outside this
// repository), with `opencode run --agent <family>-pipeline-orchestrator --auto`. Checks use hidden tests
// the agent never sees. Besides pass/fail, the result records cost, steps, delegations, guard blocks,
// and safety facts: new branches/worktrees/stashes, writes outside the repository, honest verification.
//
// Use --config-dir to benchmark a variant (a separate OPENCODE_CONFIG_DIR with a different agent set or
// model) against the installed one with `compare`.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { git, gitT, repoInfo, scratchDir, snapshot } from "../tools/_pipeline_core.js"
import { killTree, runCommand, runtimeEnv } from "../tools/_pipeline_run.js"
import { childSessionIds, finalText, gitSafety, mergeSummaries, parseExport, summarizeSession } from "./metrics.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MAX_CHILD_SESSIONS = 80

export function loadTasks(file = path.join(HERE, "tasks.json")) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!Array.isArray(data.tasks)) throw new Error("tasks.json: missing tasks array")
  for (const t of data.tasks) {
    for (const k of ["id", "fixture", "prompt", "checks"]) if (!t[k]) throw new Error(`task ${t.id || "?"}: missing ${k}`)
  }
  return data.tasks
}

// ------------------------------------------------------------ workspace

export function prepareWorkspace(task, { root = os.tmpdir() } = {}) {
  const src = path.join(HERE, "fixtures", task.fixture)
  if (!fs.existsSync(src)) throw new Error(`unknown fixture "${task.fixture}"`)
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, `bench-${task.id}-`)))
  fs.cpSync(src, dir, { recursive: true })
  const run = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
  run("init", "-q", "-b", "main")
  run("config", "user.email", "bench@example.com")
  run("config", "user.name", "bench")
  run("config", "commit.gpgsign", "false")
  run("add", "-A")
  run("commit", "-qm", "fixture")
  return dir
}

function installHiddenTests(task, dir) {
  const hidden = path.join(HERE, "hidden", task.id, "hidden.test.js")
  if (fs.existsSync(hidden)) fs.copyFileSync(hidden, path.join(dir, "test", `zz_hidden_${task.id}.test.js`))
}

// --------------------------------------------------------------- checks

function changedSince(dir, base) {
  const committed = (gitT(dir, ["diff", "--name-only", base, "HEAD"], { allowFail: true }) || "").split("\n").filter(Boolean)
  const working = (git(dir, ["status", "--porcelain=v1", "-z", "-uall"], { allowFail: true }) || "")
    .split("\0")
    .filter(Boolean)
    .map((e) => e.slice(3))
  return [...new Set([...committed, ...working])].filter((f) => !f.startsWith(".opencode-scratch") && !/^test\/zz_hidden_/.test(f))
}

function globToRegex(glob) {
  return new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$")
}

export async function evaluateChecks(task, ctx) {
  const results = []
  const changed = changedSince(ctx.dir, ctx.baseCommit)
  for (const c of task.checks) {
    const label = c.label || c.type
    let pass = false
    let detail = ""
    if (c.type === "command") {
      const r = await runCommand(c.cmd, { cwd: ctx.dir, env: runtimeEnv(repoInfo(ctx.dir)), timeoutMs: (c.timeout_s || 120) * 1000 })
      pass = r.exitCode === 0 && !r.timedOut
      detail = pass ? "exit 0" : `exit ${r.exitCode}${r.timedOut ? " (timeout)" : ""}: ${r.output.slice(-400).replace(/\s+/g, " ")}`
    } else if (c.type === "file_changed") {
      const re = globToRegex(c.path)
      const hits = changed.filter((f) => re.test(f))
      pass = hits.length >= (c.min ?? 1)
      detail = hits.length ? hits.join(", ") : "no matching changed file"
    } else if (c.type === "regex_count") {
      const file = path.join(ctx.dir, c.file)
      const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
      const n = (text.match(new RegExp(c.regex, "g")) || []).length
      pass = n >= (c.min ?? 0) && n <= (c.max ?? Infinity)
      detail = `${n} match(es) of /${c.regex}/ in ${c.file}`
    } else if (c.type === "text_contains") {
      pass = new RegExp(c.pattern, "i").test(ctx.finalText || "")
      detail = pass ? "found in the final answer" : "not found in the final answer"
    } else if (c.type === "delegated") {
      const n = (ctx.metrics && ctx.metrics.delegations && Object.entries(ctx.metrics.delegations).filter(([k]) => k.endsWith(`-${c.agent}`) || k === c.agent).reduce((a, [, v]) => a + v, 0)) || 0
      pass = n >= (c.min ?? 1)
      detail = `${n} call(s) to ${c.agent}`
    } else detail = `unknown check type ${c.type}`
    results.push({ label, type: c.type, pass, detail })
  }
  return results
}

// ---------------------------------------------------------------- opencode

function runOpencode(bin, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let out = ""
    let err = ""
    let timedOut = false
    const child = spawn(bin, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (err += d))
    const timer = setTimeout(() => {
      timedOut = true
      void killTree(child.pid, 3000)
    }, timeoutMs)
    child.on("error", (e) => {
      clearTimeout(timer)
      resolve({ out, err: err + String(e.message), code: 127, timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      // opencode must not leave helpers behind in the group
      void killTree(child.pid, 300)
      resolve({ out, err, code, timedOut })
    })
  })
}

export function rootSessionId(stdout) {
  for (const line of stdout.split("\n")) {
    const t = line.trim()
    if (!t.startsWith("{")) continue
    try {
      const e = JSON.parse(t)
      const id = e.sessionID || (e.part && e.part.sessionID) || (e.properties && e.properties.sessionID)
      if (typeof id === "string" && id.startsWith("ses_")) return id
    } catch {
      /* not an event line */
    }
  }
  return null
}

async function exportTree(bin, env, cwd, rootId) {
  const exports = []
  const seen = new Set()
  const queue = [rootId]
  while (queue.length && seen.size < MAX_CHILD_SESSIONS) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    const r = await runOpencode(bin, ["export", id, "--sanitize"], { cwd, env, timeoutMs: 120000 })
    if (r.code !== 0) {
      exports.push({ id, error: `export failed: ${r.err.slice(0, 200)}` })
      continue
    }
    try {
      const exp = parseExport(r.out)
      exports.push({ id, exp })
      for (const child of childSessionIds(exp)) if (!seen.has(child)) queue.push(child)
    } catch (e) {
      exports.push({ id, error: e.message })
    }
  }
  return exports
}

// ----------------------------------------------------------------- one task

export async function runTask(task, opts) {
  const started = Date.now()
  const dir = prepareWorkspace(task, { root: opts.workRoot })
  const info = repoInfo(dir)
  const baseCommit = gitT(dir, ["rev-parse", "HEAD"])
  const before = snapshot(info)
  const agent = `${opts.family}-pipeline-orchestrator`
  const args = ["run", "--agent", agent, "--auto", "--format", "json", "--dir", dir]
  if (opts.model) args.push("-m", opts.model)
  args.push(task.prompt)
  const env = { ...process.env, ...(opts.configDir ? { OPENCODE_CONFIG_DIR: opts.configDir } : {}) }
  const record = { task: task.id, kind: task.kind || null, agent, workspace: opts.keep ? dir : null }
  try {
    if (opts.dryRun) {
      return { ...record, dry_run: true, command: [opts.bin, ...args], workspace: null, wall_ms: 0 }
    }
    const run = await runOpencode(opts.bin, args, { cwd: dir, env, timeoutMs: opts.timeoutMs })
    record.exit_code = run.code
    record.timed_out = run.timedOut
    const rootId = rootSessionId(run.out)
    record.root_session = rootId
    let metrics = null
    let text = ""
    if (rootId) {
      const exports = await exportTree(opts.bin, env, dir, rootId)
      const repo = { info, scratch: scratchDir(info) }
      const sums = exports.filter((e) => e.exp).map((e) => summarizeSession(e.exp, repo))
      record.export_errors = exports.filter((e) => e.error).map((e) => ({ session: e.id, error: e.error }))
      metrics = mergeSummaries(sums)
      const root = exports.find((e) => e.id === rootId && e.exp)
      if (root) {
        text = finalText(root.exp)
        record.model = sums.find((s) => s.session === rootId)?.model || null
        record.session_duration_ms = sums.find((s) => s.session === rootId)?.duration_ms || 0
      }
    } else record.export_errors = [{ error: "no session id found in the run output" }]
    const after = snapshot(info)
    record.git = gitSafety(before, after)
    record.commits_made = Number(gitT(dir, ["rev-list", "--count", `${baseCommit}..HEAD`], { allowFail: true }) || 0)
    installHiddenTests(task, dir)
    record.checks = await evaluateChecks(task, { dir, baseCommit, finalText: text, metrics })
    record.metrics = metrics
    record.final_text_excerpt = text.slice(0, 600)
    const safe = record.git.ok && (!metrics || metrics.violations.executed.length === 0)
    record.safety_ok = safe
    record.degenerate = Boolean(metrics && metrics.degenerate)
    record.pass = record.checks.every((c) => c.pass) && safe && !record.timed_out && !record.degenerate
    record.wall_ms = Date.now() - started
    return record
  } finally {
    if (!opts.keep || opts.dryRun) fs.rmSync(dir, { recursive: true, force: true })
  }
}

// -------------------------------------------------------------- reporting

const fmt = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : "-")

export function renderTable(results) {
  const rows = [["task", "pass", "steps", "tokens(in/out)", "cost", "sec", "delegs", "par", "guard", "git", "failed checks"]]
  for (const r of results) {
    const m = r.metrics
    rows.push([
      r.task,
      r.dry_run ? "dry" : r.pass ? "PASS" : "FAIL",
      m ? String(m.steps) : "-",
      m ? `${m.tokens.input}/${m.tokens.output}` : "-",
      m ? fmt(m.cost, 4) : "-",
      fmt((r.wall_ms || 0) / 1000),
      m ? String(Object.values(m.delegations).reduce((a, b) => a + b, 0)) : "-",
      m ? String(m.max_parallel) : "-",
      m ? String(m.guard_blocks) : "-",
      r.git ? (r.git.ok ? "clean" : "DIRTY") : "-",
      (r.checks || []).filter((c) => !c.pass).map((c) => c.label).join("; ") || (r.timed_out ? "timeout" : r.degenerate ? "degenerate run" : ""),
    ])
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => String(row[i]).length)))
  return rows.map((row) => row.map((c, i) => String(c).padEnd(widths[i])).join("  ").trimEnd()).join("\n")
}

export function compareResults(a, b) {
  const idx = (x) => new Map(x.results.map((r) => [r.task, r]))
  const A = idx(a)
  const B = idx(b)
  const out = []
  for (const id of new Set([...A.keys(), ...B.keys()])) {
    const ra = A.get(id)
    const rb = B.get(id)
    const d = (f) => (ra && rb && ra.metrics && rb.metrics ? f(rb.metrics) - f(ra.metrics) : null)
    out.push({
      task: id,
      pass: [ra ? ra.pass : null, rb ? rb.pass : null],
      regression: Boolean(ra && rb && ra.pass && !rb.pass),
      improvement: Boolean(ra && rb && !ra.pass && rb.pass),
      delta: ra && rb ? { steps: d((m) => m.steps), cost: d((m) => m.cost), tokens_out: d((m) => m.tokens.output), guard_blocks: d((m) => m.guard_blocks) } : null,
    })
  }
  return out
}

// -------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const o = { tasks: [], family: "hybrid", timeoutMin: 20, keep: false, dryRun: false }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === "--task") o.tasks.push(next())
    else if (a === "--family") o.family = next()
    else if (a === "--config-dir") o.configDir = path.resolve(next())
    else if (a === "--model") o.model = next()
    else if (a === "--timeout-min") o.timeoutMin = Number(next())
    else if (a === "--out") o.out = path.resolve(next())
    else if (a === "--keep") o.keep = true
    else if (a === "--dry-run") o.dryRun = true
    else rest.push(a)
  }
  return { o, rest }
}

export async function main(argv) {
  const [cmd, ...tail] = argv
  const { o, rest } = parseArgs(tail)
  try {
    if (cmd === "list") {
      for (const t of loadTasks()) console.log(`${t.id.padEnd(22)} ${String(t.kind || "").padEnd(22)} ${t.prompt.slice(0, 80)}`)
      return 0
    }
    if (cmd === "run") {
      const all = loadTasks()
      const chosen = o.tasks.length ? all.filter((t) => o.tasks.includes(t.id)) : all
      const missing = o.tasks.filter((id) => !all.some((t) => t.id === id))
      if (missing.length) throw new Error(`unknown task(s): ${missing.join(", ")}`)
      const bin = process.env.OPENCODE_BIN || "opencode"
      let version = null
      try {
        version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim()
      } catch {
        /* version is informational */
      }
      const results = []
      for (const t of chosen) {
        console.error(`running ${t.id} ...`)
        results.push(await runTask(t, { ...o, bin, timeoutMs: o.timeoutMin * 60000, workRoot: os.tmpdir() }))
      }
      const doc = { meta: { when: new Date().toISOString(), opencode: version, family: o.family, config_dir: o.configDir || null, model: o.model || null, dry_run: o.dryRun }, results }
      if (o.out) fs.writeFileSync(o.out, JSON.stringify(doc, null, 2))
      console.log(renderTable(results))
      if (o.out) console.error(`results written to ${o.out}`)
      return results.some((r) => r.pass === false) ? 1 : 0
    }
    if (cmd === "compare") {
      if (rest.length < 2) throw new Error("usage: compare <a.json> <b.json>")
      const [a, b] = rest.map((f) => JSON.parse(fs.readFileSync(f, "utf8")))
      console.log(JSON.stringify(compareResults(a, b), null, 2))
      return 0
    }
    console.error("usage: bench.mjs list | run [options] | compare <a.json> <b.json>")
    return cmd ? 2 : 0
  } catch (e) {
    console.error(`bench: ${e.message}`)
    return 1
  }
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isMain) main(process.argv.slice(2)).then((code) => process.exit(code))
