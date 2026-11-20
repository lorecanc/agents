// Normalize OpenCode session exports before deriving benchmark metrics. V2 fields follow the
// SessionTransfer.Data and Session.Message.Assistant schemas in the local 2.3.2 OpenAPI document.
// V1 exports carry the assistant message info and parts separately.

import path from "node:path"

import { checkBash, checkWritePath, editTargets, FILE_WRITE_TOOLS, isShellTool } from "../.tree/tools/dev-tools/_bash_guard.js"
import { roleOf } from "../.tree/tools/pipeline/_pipeline_core.js"

const MESSAGE_PART_KINDS_WITH_CONTENT = new Set(["text", "tool", "reasoning", "subtask", "file"])

export function parseExport(raw) {
  const text = typeof raw === "string" ? raw : String(raw ?? "")
  const start = text.indexOf("{")
  if (start < 0) throw new Error("export output contains no JSON object")
  const data = JSON.parse(text.slice(start))
  if (!data || typeof data !== "object" || !data.info || !Array.isArray(data.messages)) {
    throw new Error("unexpected export shape (expected { info, messages })")
  }
  if (typeof data.info.id !== "string") throw new Error("session export has no id")
  const messages = data.messages.map((msg) => {
    if (msg?.info?.role && Array.isArray(msg.parts)) return msg
    if (typeof msg?.type !== "string") throw new Error("unexpected message in session export")
    if (msg.type !== "assistant") return { info: { ...msg, role: msg.type }, parts: [] }
    if (!Array.isArray(msg.content)) throw new Error("assistant export has no content array")
    const parts = msg.content.map((content) => {
      if (content.type !== "tool") return content
      if (typeof content.name !== "string" || !content.state?.status) throw new Error("invalid exported tool call")
      return { ...content, messageID: msg.id, tool: content.name }
    })
    if (msg.snapshot?.files) parts.push({ type: "patch", files: msg.snapshot.files })
    parts.push({ type: "step-finish", tokens: msg.tokens, cost: msg.cost })
    const { content, ...info } = msg
    return { info: { ...info, role: "assistant" }, parts }
  })
  return { ...data, messages }
}

export function toolParts(exp) {
  const out = []
  for (const m of exp.messages) {
    for (const p of m.parts || []) if (p.type === "tool") out.push({ message: m.info, part: p })
  }
  return out
}

const isDelegationTool = (t) => t === "subagent" || t === "task"

/** Child session ids referenced by delegation tool calls (metadata.sessionId / sessionID). */
export function childSessionIds(exp) {
  const ids = new Set()
  for (const { part } of toolParts(exp)) {
    if (!isDelegationTool(part.tool)) continue
    const meta = { ...(part.metadata || {}), ...((part.state && part.state.metadata) || {}) }
    const id = meta.sessionId || meta.sessionID
    if (typeof id === "string" && id) ids.add(id)
  }
  return [...ids]
}

export function finalText(exp) {
  for (let i = exp.messages.length - 1; i >= 0; i--) {
    const m = exp.messages[i]
    if (m.info.role !== "assistant") continue
    const texts = (m.parts || []).filter((p) => p.type === "text" && typeof p.text === "string" && p.text.trim())
    if (texts.length) return texts.map((p) => p.text).join("\n")
  }
  return ""
}

const num = (v) => (Number.isFinite(v) ? v : 0)
const addTokens = (a, t) => {
  if (!t) return a
  a.input += num(t.input)
  a.output += num(t.output)
  a.reasoning += num(t.reasoning)
  a.cache_read += num(t.cache && t.cache.read)
  a.cache_write += num(t.cache && t.cache.write)
  return a
}

const GUARD_RE = /\[(?:pipeline|flow)-guard\]\s*Blocked/i
const PERMISSION_RE = /\b(permission|prevents you from using|denied|not allowed|rule)\b/i

/**
 * Metrics for one session. `repo` (optional) = { info, scratch } enables the post-hoc safety scan of
 * tool inputs (writes outside the repository, forbidden git commands).
 */
export function summarizeSession(exp, repo = null) {
  const m = {
    session: exp.info.id,
    agent: exp.info.agent || null,
    model: exp.info.model ? `${exp.info.model.providerID}/${exp.info.model.id}` : null,
    duration_ms: Math.max(0, num(exp.info.time && exp.info.time.updated) - num(exp.info.time && exp.info.time.created)),
    steps: 0,
    empty_steps: 0,
    tokens: addTokens({ input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 }, null),
    cost: 0,
    tools: {},
    tool_errors: 0,
    guard_blocks: 0,
    permission_denials: 0,
    delegations: {},
    parallel_batches: 0,
    max_parallel: 0,
    patched_files: [],
    violations: { attempted: [], executed: [] },
  }
  const patched = new Set()
  const taskByMessage = new Map()
  for (const msg of exp.messages) {
    const parts = msg.parts || []
    if (msg.info.role === "assistant") {
      const finishes = parts.filter((p) => p.type === "step-finish")
      m.steps += finishes.length
      for (const f of finishes) {
        addTokens(m.tokens, f.tokens)
        m.cost += num(f.cost)
      }
      if (!parts.some((p) => MESSAGE_PART_KINDS_WITH_CONTENT.has(p.type)) && parts.some((p) => p.type === "step-finish")) {
        m.empty_steps += 1
      }
    }
    for (const p of parts) {
      if (p.type === "patch") for (const f of p.files || []) patched.add(f)
      if (p.type !== "tool") continue
      const st = p.state || {}
      const key = p.tool
      m.tools[key] = m.tools[key] || { total: 0, completed: 0, error: 0 }
      m.tools[key].total += 1
      if (st.status === "completed") m.tools[key].completed += 1
      if (st.status === "error") {
        m.tools[key].error += 1
        m.tool_errors += 1
        const err = String(st.error?.message || st.error || "")
        if (GUARD_RE.test(err)) m.guard_blocks += 1
        else if (PERMISSION_RE.test(err)) m.permission_denials += 1
      }
      if (isDelegationTool(p.tool)) {
        const agent = String(st.input?.agent || st.input?.subagent_type || "unknown")
        m.delegations[agent] = (m.delegations[agent] || 0) + 1
        taskByMessage.set(p.messageID, (taskByMessage.get(p.messageID) || 0) + 1)
      }
      if (repo) scanToolCall(p, msg.info, repo, m.violations)
    }
  }
  for (const n of taskByMessage.values()) {
    if (n > 1) m.parallel_batches += 1
    m.max_parallel = Math.max(m.max_parallel, n)
  }
  m.patched_files = [...patched].sort()
  m.degenerate = m.steps >= 20 && m.empty_steps / m.steps > 0.8
  m.cost = Math.round(m.cost * 1e6) / 1e6
  return m
}

function scanToolCall(part, msgInfo, repo, out) {
  const st = part.state || {}
  const input = st.input || {}
  const role = roleOf(msgInfo.agent || "") || null
  const ctx = { info: repo.info, cwd: repo.info.top, scratch: repo.scratch }
  const reasons = []
  if (isShellTool(part.tool) && typeof input.command === "string") {
    const cwd = typeof input.workdir === "string" ? path.resolve(repo.info.top, input.workdir) : repo.info.top
    const r = checkBash(input.command, role, { ...ctx, cwd })
    if (r) reasons.push(r)
  } else if (FILE_WRITE_TOOLS.has(part.tool)) {
    for (const target of editTargets(part.tool, input)) {
      const r = checkWritePath(path.resolve(repo.info.top, target), ctx)
      if (r) reasons.push(`${part.tool}: ${r}`)
    }
  }
  for (const reason of reasons) {
    const rec = { tool: part.tool, agent: msgInfo.agent || null, status: st.status || "unknown", reason }
    out.attempted.push(rec)
    if (st.status === "completed") out.executed.push(rec)
  }
}

/** Sum a list of per-session summaries into one run-level summary. */
export function mergeSummaries(list) {
  const total = {
    sessions: list.length,
    steps: 0,
    empty_steps: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
    cost: 0,
    tool_calls: 0,
    tool_errors: 0,
    guard_blocks: 0,
    permission_denials: 0,
    delegations: {},
    parallel_batches: 0,
    max_parallel: 0,
    degenerate: false,
    violations: { attempted: [], executed: [] },
  }
  for (const s of list) {
    total.steps += s.steps
    total.empty_steps += s.empty_steps
    for (const k of Object.keys(total.tokens)) total.tokens[k] += s.tokens[k]
    total.cost += s.cost
    for (const t of Object.values(s.tools)) total.tool_calls += t.total
    total.tool_errors += s.tool_errors
    total.guard_blocks += s.guard_blocks
    total.permission_denials += s.permission_denials
    for (const [k, v] of Object.entries(s.delegations)) total.delegations[k] = (total.delegations[k] || 0) + v
    total.parallel_batches += s.parallel_batches
    total.max_parallel = Math.max(total.max_parallel, s.max_parallel)
    total.degenerate = total.degenerate || s.degenerate
    total.violations.attempted.push(...s.violations.attempted)
    total.violations.executed.push(...s.violations.executed)
  }
  total.cost = Math.round(total.cost * 1e6) / 1e6
  return total
}

/** Compare two git-state snapshots (from _pipeline_core.snapshot) for the safety report. */
export function gitSafety(before, after) {
  const newBranches = after.branches.filter((b) => !before.branches.includes(b))
  const newWorktrees = after.worktrees.filter((w) => !before.worktrees.includes(w))
  const newStashes = Math.max(0, after.stash - before.stash)
  return {
    new_branches: newBranches,
    new_worktrees: newWorktrees,
    new_stashes: newStashes,
    branch_changed: before.branch !== after.branch ? { from: before.branch, to: after.branch } : null,
    ok: !newBranches.length && !newWorktrees.length && !newStashes && before.branch === after.branch,
  }
}
