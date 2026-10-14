#!/usr/bin/env node
// opencode-wt: opt-in isolated worktree for a pipeline run.
//
//   opencode-wt start <slug> [--base <branch>] [--no-setup] [-- <opencode args...>]
//   opencode-wt finish <slug>        rebase on the base branch, fast-forward merge it, clean up
//   opencode-wt abort <slug>         discard the worktree and its branch
//   opencode-wt list                 known worktrees and their state
//   opencode-wt gc [--dry-run]       prune stale metadata and merged pipeline/* branches
//
// The worktree lives in <git-common-dir>/opencode-worktrees/<slug> (invisible to `git status`,
// ripgrep and build tools of the main checkout) on the branch pipeline/<slug>. Nothing is ever
// pushed, and `finish` only fast-forwards: if the base moved in a conflicting way, or the main
// checkout is not on the base branch, the branch is left in place and the reason is printed.
//
// Shared mode (one working tree, file claims) stays the default; use this for large or risky work.

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { addInfoExclude, git, gitT, realpathLoose, repoInfo } from "../tools/_pipeline_core.js"
import { runCommand, runtimeEnv } from "../tools/_pipeline_run.js"

const BRANCH_PREFIX = "pipeline/"

export function slugify(input) {
  const s = String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "")
  if (!s) throw new Error("slug must contain letters or digits")
  return s
}

const metaDir = (info) => path.join(info.stateDir, "worktrees")
const metaFile = (info, slug) => path.join(metaDir(info), `${slug}.json`)
const worktreePath = (info, slug) => path.join(info.common, "opencode-worktrees", slug)
const mainTop = (info) => path.dirname(info.common)

function readMeta(info, slug) {
  try {
    return JSON.parse(fs.readFileSync(metaFile(info, slug), "utf8"))
  } catch {
    return null
  }
}

function writeMeta(info, meta) {
  fs.mkdirSync(metaDir(info), { recursive: true })
  fs.writeFileSync(metaFile(info, meta.slug), JSON.stringify(meta, null, 2))
}

function listMeta(info) {
  try {
    return fs.readdirSync(metaDir(info)).filter((n) => n.endsWith(".json")).map((n) => readMeta(info, n.slice(0, -5))).filter(Boolean)
  } catch {
    return []
  }
}

function mustInfo(cwd) {
  const info = repoInfo(cwd)
  if (!info) throw new Error("not inside a git repository")
  return info
}

/** Files to copy into a new worktree (e.g. untracked .env files) and the setup command. */
function readWorktreeContract(top) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(top, ".opencode", "pipeline.json"), "utf8"))
    return {
      setup: typeof raw.setup === "string" ? raw.setup : null,
      copy: Array.isArray(raw.worktree && raw.worktree.copy) ? raw.worktree.copy.filter((p) => typeof p === "string") : [],
    }
  } catch {
    return { setup: null, copy: [] }
  }
}

export async function startWorktree(cwd, rawSlug, { base, setup = true, log = () => {} } = {}) {
  const info = mustInfo(cwd)
  if (info.isLinked) throw new Error("already inside a linked worktree; run opencode-wt from the main checkout")
  const slug = slugify(rawSlug)
  const branch = BRANCH_PREFIX + slug
  const baseBranch = base || gitT(info.top, ["branch", "--show-current"], { allowFail: true })
  if (!baseBranch) throw new Error("detached HEAD: pass --base <branch>")
  if (git(info.top, ["rev-parse", "--verify", "-q", `refs/heads/${baseBranch}`], { allowFail: true }) === null) {
    throw new Error(`base branch "${baseBranch}" does not exist`)
  }
  const target = worktreePath(info, slug)
  if (fs.existsSync(target) || readMeta(info, slug)) throw new Error(`worktree "${slug}" already exists (opencode-wt list)`)
  if (git(info.top, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { allowFail: true }) !== null) {
    throw new Error(`branch ${branch} already exists; pick another slug or run opencode-wt gc`)
  }
  const baseHead = gitT(info.top, ["rev-parse", baseBranch])
  fs.mkdirSync(path.dirname(target), { recursive: true })
  git(info.top, ["worktree", "add", "-q", target, "-b", branch, baseBranch])
  addInfoExclude(info, ".opencode-scratch/")
  const contract = readWorktreeContract(info.top)
  const copied = []
  for (const rel of contract.copy) {
    const src = realpathLoose(path.join(info.top, rel))
    const dst = path.join(target, rel)
    if (!src.startsWith(info.top + path.sep) || !fs.existsSync(src)) continue
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    copied.push(rel)
  }
  const meta = { slug, branch, base: baseBranch, baseHead, path: realpathLoose(target), createdAt: Date.now(), copied }
  writeMeta(info, meta)
  let setupResult = null
  if (setup && contract.setup) {
    log(`running setup in the worktree: ${contract.setup}`)
    const wtInfo = repoInfo(target)
    setupResult = await runCommand(contract.setup, { cwd: target, env: runtimeEnv(wtInfo), timeoutMs: 15 * 60 * 1000 })
  }
  const dirty = gitT(info.top, ["status", "--porcelain"], { allowFail: true })
  return { ...meta, setupResult, mainTreeDirty: Boolean(dirty) }
}

function worktreeState(info, meta) {
  const exists = fs.existsSync(meta.path)
  const branchExists = git(info.common, ["rev-parse", "--verify", "-q", `refs/heads/${meta.branch}`], { allowFail: true }) !== null
  let ahead = 0
  let dirty = false
  if (branchExists) {
    ahead = Number(gitT(info.common, ["rev-list", "--count", `${meta.base}..${meta.branch}`], { allowFail: true }) || 0)
  }
  if (exists) {
    const out = gitT(meta.path, ["status", "--porcelain", "-uall"], { allowFail: true }) || ""
    dirty = out.split("\n").some((l) => l && !l.slice(3).startsWith(".opencode-scratch"))
  }
  return { exists, branchExists, ahead, dirty }
}

export function listWorktrees(cwd) {
  const info = mustInfo(cwd)
  return listMeta(info).map((m) => ({ ...m, ...worktreeState(info, m) }))
}

function removeWorktree(info, meta) {
  fs.rmSync(path.join(meta.path, ".opencode-scratch"), { recursive: true, force: true })
  if (fs.existsSync(meta.path)) git(info.common, ["worktree", "remove", "--force", meta.path])
  git(info.common, ["worktree", "prune"], { allowFail: true })
}

export function finishWorktree(cwd, rawSlug) {
  const info = mustInfo(cwd)
  const slug = slugify(rawSlug)
  const meta = readMeta(info, slug)
  if (!meta) throw new Error(`unknown worktree "${slug}" (opencode-wt list)`)
  const state = worktreeState(info, meta)
  if (!state.exists || !state.branchExists) throw new Error("worktree or branch is missing; run opencode-wt gc")
  if (state.dirty) {
    return { status: "left", reason: "the worktree has uncommitted changes: commit them (pipeline_commit) or run `opencode-wt abort`", path: meta.path }
  }
  const main = mainTop(info)
  const current = gitT(main, ["branch", "--show-current"], { allowFail: true })
  if (current !== meta.base) {
    return { status: "left", reason: `the main checkout is on "${current || "detached HEAD"}", not on the base branch "${meta.base}"`, path: meta.path }
  }
  if (state.ahead === 0) {
    removeWorktree(info, meta)
    git(info.common, ["branch", "-D", meta.branch], { allowFail: true })
    fs.rmSync(metaFile(info, slug), { force: true })
    return { status: "removed", reason: "no commits on the branch; nothing to merge" }
  }
  if (git(meta.path, ["rebase", meta.base], { allowFail: true }) === null) {
    git(meta.path, ["rebase", "--abort"], { allowFail: true })
    return { status: "left", reason: `rebase on ${meta.base} has conflicts; resolve in ${meta.path} (git rebase ${meta.base}) and run finish again`, path: meta.path }
  }
  const merge = git(main, ["merge", "--ff-only", meta.branch], { allowFail: true })
  if (merge === null) {
    return { status: "left", reason: `cannot fast-forward ${meta.base} (the main checkout has local changes that overlap, or ${meta.base} moved); the branch ${meta.branch} is intact`, path: meta.path }
  }
  const commits = state.ahead
  removeWorktree(info, meta)
  git(info.common, ["branch", "-d", meta.branch], { allowFail: true })
  fs.rmSync(metaFile(info, slug), { force: true })
  return { status: "merged", commits, into: meta.base }
}

export function abortWorktree(cwd, rawSlug) {
  const info = mustInfo(cwd)
  const slug = slugify(rawSlug)
  const meta = readMeta(info, slug)
  if (!meta) throw new Error(`unknown worktree "${slug}"`)
  const state = worktreeState(info, meta)
  removeWorktree(info, meta)
  git(info.common, ["branch", "-D", meta.branch], { allowFail: true })
  fs.rmSync(metaFile(info, slug), { force: true })
  return { status: "discarded", commits: state.ahead, hadUncommitted: state.dirty }
}

export function gcWorktrees(cwd, { dryRun = false } = {}) {
  const info = mustInfo(cwd)
  const actions = []
  for (const m of listMeta(info)) {
    const st = worktreeState(info, m)
    if (!st.exists && !st.branchExists) {
      actions.push({ action: "drop_metadata", slug: m.slug })
      if (!dryRun) fs.rmSync(metaFile(info, m.slug), { force: true })
    }
  }
  if (!dryRun) git(info.common, ["worktree", "prune"], { allowFail: true })
  const known = new Set(listMeta(info).map((m) => m.branch))
  const branches = (gitT(info.common, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${BRANCH_PREFIX}`], { allowFail: true }) || "").split("\n").filter(Boolean)
  const checkedOut = new Set((git(info.common, ["worktree", "list", "--porcelain"], { allowFail: true }) || "").split("\n").filter((l) => l.startsWith("branch ")).map((l) => l.replace("branch refs/heads/", "").trim()))
  for (const b of branches) {
    if (checkedOut.has(b)) continue
    const merged = git(info.common, ["branch", "--merged", "HEAD", "--list", b], { allowFail: true })
    if (merged && merged.trim()) {
      actions.push({ action: "delete_merged_branch", branch: b })
      if (!dryRun) git(info.common, ["branch", "-d", b], { allowFail: true })
    } else if (!known.has(b)) {
      actions.push({ action: "orphan_branch_kept", branch: b, note: "not merged and has no worktree record; inspect before deleting" })
    }
  }
  return actions
}

// ------------------------------------------------------------------ CLI

function usage() {
  return [
    "opencode-wt start <slug> [--base <branch>] [--no-setup] [-- <opencode args...>]",
    "opencode-wt finish <slug>",
    "opencode-wt abort <slug>",
    "opencode-wt list",
    "opencode-wt gc [--dry-run]",
  ].join("\n")
}

export async function main(argv, cwd = process.cwd()) {
  const [cmd, ...rest] = argv
  const dd = rest.indexOf("--")
  const own = dd >= 0 ? rest.slice(0, dd) : rest
  const passthrough = dd >= 0 ? rest.slice(dd + 1) : []
  const opt = (name) => {
    const i = own.indexOf(name)
    return i >= 0 ? own[i + 1] : undefined
  }
  const positional = own.filter((a, i) => !a.startsWith("-") && own[i - 1] !== "--base")
  try {
    switch (cmd) {
      case "start": {
        if (!positional[0]) throw new Error("missing <slug>")
        const r = await startWorktree(cwd, positional[0], { base: opt("--base"), setup: !own.includes("--no-setup"), log: (m) => console.error(m) })
        console.error(`worktree ${r.path}\nbranch   ${r.branch} (from ${r.base} @ ${r.baseHead.slice(0, 8)})`)
        if (r.mainTreeDirty) console.error("note: uncommitted changes in the main checkout are NOT part of this worktree")
        if (r.setupResult && r.setupResult.exitCode !== 0) console.error(`setup failed (exit ${r.setupResult.exitCode}):\n${r.setupResult.output.slice(-2000)}`)
        const res = spawnSync(process.env.OPENCODE_BIN || "opencode", passthrough, { cwd: r.path, stdio: "inherit" })
        console.error(`\nback from opencode. Next: opencode-wt finish ${r.slug}   (or: opencode-wt abort ${r.slug})`)
        return res.status ?? 0
      }
      case "finish":
        console.log(JSON.stringify(finishWorktree(cwd, positional[0]), null, 2))
        return 0
      case "abort":
        console.log(JSON.stringify(abortWorktree(cwd, positional[0]), null, 2))
        return 0
      case "list":
        console.log(JSON.stringify(listWorktrees(cwd), null, 2))
        return 0
      case "gc":
        console.log(JSON.stringify(gcWorktrees(cwd, { dryRun: own.includes("--dry-run") }), null, 2))
        return 0
      default:
        console.error(usage())
        return cmd ? 2 : 0
    }
  } catch (e) {
    console.error(`opencode-wt: ${e.message}`)
    return 1
  }
}

// Compare real paths: when invoked through a symlink, argv[1] is the link, import.meta.url the target.
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
