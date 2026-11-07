// Pure logic for the flow-guard plugin (`flow-*` agents).
//
// Philosophy: block only what is destructive, escapes the repository, leaks secrets or hangs on an
// interactive editor. Everything else is governed by the agent permissions (allow / ask), so the
// model is not pushed into retry loops by style policies. Shell parsing and path checks are reused
// from `_pipeline_core.js`; only the git policy and the post-edit scan are specific to flow.

import path from "node:path"

import { bashWriteTargets, checkBash, checkGitCommand, checkWritePath, isInside, realpathLoose } from "./_pipeline_core.js"

// `flow-build`, or a stamped multi-provider copy such as `hybrid-flow-build`.
export const FLOW_AGENT_RE = /^(?:[A-Za-z0-9_-]+-)?flow-([A-Za-z0-9_]+)$/
/** Agents that must never modify the workspace (enforced by permissions too). */
export const FLOW_READ_ONLY = new Set(["plan", "explore", "review", "research", "eye", "ops"])

export function isFlowAgent(agent) {
  return typeof agent === "string" && FLOW_AGENT_RE.test(agent)
}

export function flowRole(agent) {
  const m = typeof agent === "string" ? FLOW_AGENT_RE.exec(agent) : null
  return m ? m[1] : null
}

const ASK_USER = "Ask the user to run it, or use a non-destructive alternative."
const NON_INTERACTIVE = "Interactive git commands hang the session; use the non-interactive form."
// The v1 role check says "managed by the pipeline" for workspace-management denials (branch, stash,
// switch, ...). Flow allows those: its permissions ask the user instead.
const V1_MANAGEMENT_HINT = "managed by the pipeline"
const DANGEROUS_GIT_CONFIG = /^(?:alias\.|core\.(?:hookspath|sshcommand|editor|pager|fsmonitor|gitproxy)|credential\.|url\.|http\.|protocol\.|include\.|includeif\.|filter\.|diff\.[^.]+\.textconv|merge\.[^.]+\.driver)/i

function gitSubcommand(args) {
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (a === "-C" || a === "-c") {
      i += 2
      continue
    }
    if (a.startsWith("-")) {
      i++
      continue
    }
    return { sub: a, rest: args.slice(i + 1) }
  }
  return { sub: undefined, rest: [] }
}

const hasFlag = (rest, ...flags) => rest.some((r) => flags.includes(r) || flags.some((f) => f.startsWith("--") && r.startsWith(`${f}=`)))
const shortFlag = (rest, letter) => rest.some((r) => /^-[A-Za-z]+$/.test(r) && r.includes(letter))

/** Git policy for flow agents. Returns null when allowed, else a reason. */
export function flowGitPolicy(args, ctx) {
  const v1 = checkGitCommand(args, "executor", ctx)
  if (v1 && !v1.includes(V1_MANAGEMENT_HINT)) return v1
  const { sub, rest } = gitSubcommand(args)
  const destructive = (what) => `git ${what} is destructive and blocked for flow agents. ${ASK_USER}`
  // Kept from the v1 check even though v1 words them as management denials: they run arbitrary
  // programs or write files outside the shell's redirect checks.
  if (rest.some((r) => /^--(?:upload-pack|receive-pack|exec)(?:=|$)/.test(r) || r.startsWith("ext::"))) return `git ${sub} with a custom transport program is not allowed.`
  if (rest.some((r) => r === "--output" || r.startsWith("--output="))) return `git ${sub} --output is not allowed; redirect stdout instead.`
  if (sub === "config") {
    const reading = rest.some((r) => ["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin"].includes(r))
    if (!reading && rest.some((r) => r === "--global" || r === "--system" || r === "--file" || r === "-f")) return "git config outside the repository is not allowed."
    if (!reading && rest.some((r) => DANGEROUS_GIT_CONFIG.test(r))) return "git config of hooks, editors, credentials, aliases or transports is not allowed."
    return null
  }
  switch (sub) {
    case "push":
      if (hasFlag(rest, "--force", "--force-with-lease", "--mirror", "--delete", "--prune") || shortFlag(rest, "f") || shortFlag(rest, "d")
        || rest.some((r) => !r.startsWith("-") && (r.startsWith("+") || r.startsWith(":")))) return destructive("push --force/--delete")
      return null
    case "reset":
      return hasFlag(rest, "--hard", "--merge", "--keep") ? destructive("reset --hard") : null
    case "clean":
      return hasFlag(rest, "--dry-run") || shortFlag(rest, "n") ? null : destructive("clean")
    case "checkout":
      if (hasFlag(rest, "--force") || shortFlag(rest, "f")) return destructive("checkout --force")
      return rest.some((r) => r === "." || r === ":/") ? destructive("checkout . (discards all changes)") : null
    case "restore": {
      const staged = hasFlag(rest, "--staged") || shortFlag(rest, "S")
      const worktree = hasFlag(rest, "--worktree") || shortFlag(rest, "W")
      return (!staged || worktree) && rest.some((r) => r === "." || r === ":/") ? destructive("restore . (discards all changes)") : null
    }
    case "branch":
      return shortFlag(rest, "D") || (hasFlag(rest, "--delete", "-d") && hasFlag(rest, "--force", "-f")) ? destructive("branch -D") : null
    case "stash":
      return rest[0] === "drop" || rest[0] === "clear" ? destructive(`stash ${rest[0]}`) : null
    case "filter-branch":
    case "filter-repo":
      return destructive(sub)
    case "update-ref":
      return hasFlag(rest, "-d") ? destructive("update-ref -d") : null
    case "reflog":
      return rest[0] === "expire" || rest[0] === "delete" ? destructive(`reflog ${rest[0]}`) : null
    case "gc":
      return rest.some((r) => r.startsWith("--prune")) ? destructive("gc --prune") : null
    case "rebase":
      return hasFlag(rest, "--interactive") || shortFlag(rest, "i") ? `git rebase -i is not allowed. ${NON_INTERACTIVE}` : null
    case "add":
      return hasFlag(rest, "--interactive", "--patch", "--edit") || shortFlag(rest, "i") || shortFlag(rest, "p") || shortFlag(rest, "e")
        ? `git add -i/-p is not allowed. ${NON_INTERACTIVE}` : null
    case "commit": {
      const hasMessage = hasFlag(rest, "--message", "--file", "--no-edit", "--reuse-message", "--fixup", "--squash")
        || rest.some((r) => /^-[A-Za-z]*[mFC]/.test(r))
      return hasMessage ? null : `git commit without -m opens an editor. ${NON_INTERACTIVE} Pass -m "<message>".`
    }
    default:
      return null
  }
}

/**
 * Check a shell command issued by a flow agent.
 * ctx: { info, cwd, scratch }. Returns null when allowed, else a reason.
 */
export function checkFlowBash(command, role, ctx) {
  if (FLOW_READ_ONLY.has(role)) {
    const targets = bashWriteTargets(command, ctx)
    if (targets.length) return `flow-${role} is read-only; this command would write ${targets.slice(0, 3).join(", ")}. Report the change instead.`
  }
  return checkBash(command, "executor", { ...ctx, gitPolicy: flowGitPolicy })
}

/** Check a file path an edit/write tool would modify. Returns null when allowed, else a reason. */
export function checkFlowWrite(target, role, ctx) {
  const planFile = role === "plan" && isInside(path.join(ctx.info.top, ".opencode", "plans"), realpathLoose(target))
  if (FLOW_READ_ONLY.has(role) && !planFile) return `flow-${role} is read-only and cannot edit files${role === "plan" ? " (only .opencode/plans/*.md)" : ""}.`
  return checkWritePath(target, ctx)
}

const ENV_FILE_RE = /^\.env(?:\..+)?$/i
const ENV_TEMPLATE_RE = /^\.env\.(?:example|sample|template|test|dist)$/i

/** True when a read targets a real dotenv file (templates are fine). */
export function isSecretEnvFile(filePath) {
  if (typeof filePath !== "string" || !filePath) return false
  const base = path.basename(filePath)
  return ENV_FILE_RE.test(base) && !ENV_TEMPLATE_RE.test(base)
}

// ---------------------------------------------------------------- post-edit scan

/** Text an edit-style tool call adds to the workspace. */
export function addedText(tool, args) {
  if (!args || typeof args !== "object") return ""
  if (tool === "write") return typeof args.content === "string" ? args.content : ""
  if (tool === "edit") {
    const s = args.newString ?? args.new_string
    return typeof s === "string" ? s : ""
  }
  if (tool === "multiedit") {
    return Array.isArray(args.edits) ? args.edits.map((e) => (e && typeof (e.newString ?? e.new_string) === "string" ? (e.newString ?? e.new_string) : "")).join("\n") : ""
  }
  if (tool === "apply_patch" || tool === "patch") {
    const text = typeof args.patchText === "string" ? args.patchText : typeof args.patch === "string" ? args.patch : ""
    return text.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n")
  }
  return ""
}

const CODE_EXT = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte", ".astro",
  ".py", ".rb", ".php", ".go", ".rs", ".java", ".kt", ".kts", ".swift", ".cs", ".scala", ".sh",
])
const TEST_PATH_RE = /(^|[\\/])(__tests__|tests?|spec|e2e|fixtures?|mocks?)([\\/])|\.(test|spec)\.[^.\\/]+$|_test\.(go|py)$/i
const PLACEHOLDER_RE = /^(?:x+|\*+|\.{3}|changeme|change-me|example|placeholder|your[-_].*|<.*>|\$\{.*\}|dummy|test|fake|secret|password|redacted)$/i

const SECRET_PATTERNS = [
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, "private key"],
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/, "Stripe live key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "GitHub token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/, "LLM provider API key"],
]
const GENERIC_SECRET_RE = /\b(?:api[_-]?key|secret|token|passwd|password|private[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["'`]([^"'`\s]{12,})["'`]/gi

const RISK_PATTERNS = [
  [/\beval\s*\(/, "eval(): code injection risk; parse the data instead"],
  [/\bnew\s+Function\s*\(/, "new Function(): code injection risk"],
  [/\.(?:inner|outer)HTML\s*\+?=/, "innerHTML assignment: XSS risk; use textContent or a sanitizer"],
  [/dangerouslySetInnerHTML/, "dangerouslySetInnerHTML: XSS risk unless the HTML is sanitized"],
  [/\bdocument\.write\s*\(/, "document.write(): XSS risk"],
  [/\bshell\s*=\s*True\b/, "subprocess with shell=True: command injection risk; pass an argument list"],
  [/\bos\.system\s*\(/, "os.system(): command injection risk; use subprocess with an argument list"],
  [/\bexecSync\s*\(\s*`[^`]*\$\{|\bexec\s*\(\s*`[^`]*\$\{/, "shell command built from a template string: command injection risk; use execFile with arguments"],
  [/\bpickle\.loads?\s*\(/, "pickle.load: unsafe on untrusted data"],
  [/\byaml\.load\s*\((?![^)]*Loader\s*=\s*yaml\.SafeLoader)/, "yaml.load without SafeLoader: use yaml.safe_load"],
  [/rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|\bverify\s*=\s*False\b|InsecureSkipVerify\s*:\s*true/, "TLS verification disabled"],
  [/`[^`]*\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^`]*\$\{/i, "SQL built with string interpolation: injection risk; use parameters"],
  [/["'][^"'\n]*\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^"'\n]*["']\s*(?:\+|%\s*[(\w])/i, "SQL built by concatenation: injection risk; use parameters"],
  [/\bf["'][^"'\n]*\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^"'\n]*\{/i, "SQL built with an f-string: injection risk; use parameters"],
]
const LEFTOVER_PATTERNS = [
  [/^\s*debugger\s*;?\s*$/m, "debugger statement left in code"],
  [/\bconsole\.log\s*\(/, "console.log left in code (use the project logger or remove)"],
  [/\b(?:breakpoint\s*\(\s*\)|pdb\.set_trace\s*\(\s*\))/, "debugger breakpoint left in code"],
  [/\b(?:TODO|FIXME|XXX|HACK)\b/, "new TODO/FIXME: finish the work or tell the user what is left"],
]

/**
 * Scan text an edit adds for secrets, risky sinks and leftovers.
 * Returns at most `limit` short warnings (strings). Never throws.
 */
export function scanAddedCode(text, filePath = "", limit = 6) {
  try {
    if (typeof text !== "string" || !text) return []
    const warnings = []
    const add = (w) => {
      if (!warnings.includes(w)) warnings.push(w)
    }
    for (const [re, label] of SECRET_PATTERNS) if (re.test(text)) add(`possible hardcoded secret (${label}): load it from the environment or a secret store`)
    for (const m of text.matchAll(GENERIC_SECRET_RE)) {
      if (!PLACEHOLDER_RE.test(m[1])) {
        add("possible hardcoded secret (credential literal): load it from the environment or a secret store")
        break
      }
    }
    const ext = path.extname(filePath).toLowerCase()
    if (CODE_EXT.has(ext)) {
      for (const [re, label] of RISK_PATTERNS) if (re.test(text)) add(label)
      if (!TEST_PATH_RE.test(filePath)) for (const [re, label] of LEFTOVER_PATTERNS) if (re.test(text)) add(label)
    }
    return warnings.slice(0, limit)
  } catch {
    return []
  }
}

/** One compact note for the model, or "" when there is nothing to say. */
export function formatScanNote(file, warnings) {
  if (!warnings.length) return ""
  return `[flow-guard] Check ${file || "this edit"}: ${warnings.join("; ")}. Fix it now or justify it in the final summary.`
}
