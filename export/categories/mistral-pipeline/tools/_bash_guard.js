// Bash, git and write-path guards shared by the agent-family guard plugins (flow-guard, pipeline-guard).
//
// Every guard here is defense in depth. Permissions in the agent files are the primary control;
// these checks give precise error messages and cover what permission patterns cannot express.
// Guards fail OPEN on anything they cannot parse or resolve. Roles are the agent role names
// (explorer, executor, ops, ...) that each guard plugin derives from its own agents.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isInside, realpathLoose, scratchDir, toRel } from "./_repo.js"

// ------------------------------------------------------------ bash guard

// Role-based git denials for workspace management (branch, stash, worktree, ...) carry this text, so a
// guard with its own git policy (flow-guard) can recognise and relax them.
export const WORKSPACE_MANAGED_HINT = "managed by the pipeline"

const WRAPPERS = new Set(["env", "command", "time", "nohup", "exec", "builtin", "xargs", "nice", "setsid", "stdbuf", "timeout", "gtimeout"])
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
const NEVER = new Set(["sudo", "doas", "su", "pkexec", "sudoedit"])
const READ_ONLY_BASH_ROLES = new Set(["explorer", "code_reviewer", "critic", "hitl", "security_auditor"])
const WRITE_CMDS = new Set([
  "rm", "rmdir", "mkdir", "touch", "truncate", "chmod", "chown", "chgrp", "tee", "unlink", "shred", "mktemp",
  "mv", "cp", "ln", "install", "rsync", "ditto", "dd", "curl", "wget", "tar", "unzip",
])
const DANGEROUS_GIT_ENV = /^GIT_(?:SSH|SSH_COMMAND|ASKPASS|EXEC_PATH|TEMPLATE_DIR|CONFIG|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_NOSYSTEM|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|EXTERNAL_DIFF|DIFF_OPTS|DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PROXY_COMMAND|UPLOAD_PACK|RECEIVE_PACK|EDITOR|SEQUENCE_EDITOR|MERGE_AUTOEDIT)\+?=/i
const DANGEROUS_EXEC_ENV = /^(?:LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z0-9_]*|BASH_ENV|ENV|PROMPT_COMMAND|PYTHONSTARTUP|PYTHONINSPECT|RUBYOPT|PERL5OPT)\+?=/i
const ENV_TEMPLATE_FILES = new Set([".env.example", ".env.sample", ".env.template", ".env.test"])
const ENV_TEMPLATE_COPY_ROLES = new Set(["executor", "fast_lane", "refactorer", "tester", "ops"])

const GIT_READ = new Set([
  "status", "diff", "log", "show", "ls-files", "rev-parse", "blame", "grep", "ls-tree", "cat-file",
  "describe", "shortlog", "rev-list", "for-each-ref", "merge-base", "name-rev", "diff-tree", "diff-index",
  "show-ref", "check-ignore", "count-objects", "version", "help", "whatchanged", "ls-remote", "show-branch",
  "range-diff", "cherry", "var", "verify-commit", "verify-tag",
])
const GIT_ALWAYS_BLOCKED_CFG = /^(alias\.|core\.(hookspath|sshcommand|editor|pager|fsmonitor)|credential\.|url\.|http\.|protocol\.)/i
const GIT_SYNC_ROLES = new Set(["ops", "fast_lane", "executor", "refactorer"])
const GIT_SAFE_EDITOR_CFG = /^core\.editor=(true|:|\/(?:usr\/)?bin\/true)$/i

/**
 * Tokenize a shell command into segments (best effort, not a full parser).
 * Returns { segments: string[][], redirects: string[], nested: string[] }.
 */
export function tokenize(command) {
  const segments = []
  const redirects = []
  const segmentRedirects = []
  const nested = []
  let tokens = []
  let curRedirects = []
  let cur = ""
  let has = false
  let expectRedirect = false
  let invalidAnsiC = false
  const pendingHeredocs = []
  const pushToken = () => {
    if (!has) return
    if (expectRedirect) {
      redirects.push(cur)
      curRedirects.push(cur)
      expectRedirect = false
    } else {
      tokens.push(cur)
    }
    cur = ""
    has = false
  }
  const pushSegment = () => {
    pushToken()
    if (tokens.length || curRedirects.length) {
      segments.push(tokens)
      segmentRedirects.push(curRedirects)
    }
    tokens = []
    curRedirects = []
  }
  const grabNested = (i, open, close) => {
    let depth = 1
    let j = i
    while (j < command.length && depth > 0) {
      const ch = command[j]
      if (ch === open && open !== close) depth++
      else if (ch === close) depth--
      j++
    }
    nested.push(command.slice(i, depth === 0 ? j - 1 : j))
    return j
  }
  let i = 0
  let quote = null
  while (i < command.length) {
    const c = command[i]
    if (quote === "'") {
      if (c === "'") quote = null
      else cur += c
      i++
      continue
    }
    if (c === "\\" && quote !== "'") {
      if (i + 1 < command.length) {
        cur += command[i + 1]
        has = true
      }
      i += 2
      continue
    }
    if (quote === null && c === "$" && command[i + 1] === "'") {
      let j = i + 2
      let value = ""
      let closed = false
      while (j < command.length) {
        const ch = command[j]
        if (ch === "'") {
          closed = true
          j++
          break
        }
        if (ch !== "\\") {
          value += ch
          j++
          continue
        }
        j++
        if (j >= command.length) break
        const escaped = command[j]
        const simpleEscapes = {
          "\\": "\\", "'": "'", '"': '"', n: "\n", r: "\r", t: "\t",
          v: "\v", f: "\f", b: "\b", a: "\x07", e: "\x1b", E: "\x1b",
        }
        if (Object.hasOwn(simpleEscapes, escaped)) {
          value += simpleEscapes[escaped]
          j++
          continue
        }
        const digitCount = escaped === "x" ? 2 : escaped === "u" ? 4 : escaped === "U" ? 8 : 0
        if (digitCount) {
          let end = j + 1
          while (end < command.length && end <= j + digitCount && /[0-9a-fA-F]/.test(command[end])) end++
          if (end === j + 1) {
            invalidAnsiC = true
            break
          }
          const codePoint = Number.parseInt(command.slice(j + 1, end), 16)
          if (codePoint > 0x10ffff) {
            invalidAnsiC = true
            break
          }
          value += String.fromCodePoint(codePoint)
          j = end
          continue
        }
        if (/[0-7]/.test(escaped)) {
          let end = j + 1
          while (end < command.length && end < j + 3 && /[0-7]/.test(command[end])) end++
          value += String.fromCharCode(Number.parseInt(command.slice(j, end), 8))
          j = end
          continue
        }
        invalidAnsiC = true
        break
      }
      if (!closed) invalidAnsiC = true
      cur += value
      has = true
      i = j
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = null
      else if (c === "$" && command[i + 1] === "(") {
        i = grabNested(i + 2, "(", ")")
        cur += "$(…)"
        continue
      } else if (c === "`") {
        i = grabNested(i + 1, "`", "`")
        cur += "$(…)"
        continue
      } else cur += c
      i++
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      has = true
      i++
      continue
    }
    if (c === "$" && command[i + 1] === "(") {
      i = grabNested(i + 2, "(", ")")
      cur += "$(…)"
      has = true
      continue
    }
    if (c === "`") {
      i = grabNested(i + 1, "`", "`")
      cur += "$(…)"
      has = true
      continue
    }
    if (c === "#" && !has) {
      while (i < command.length && command[i] !== "\n") i++
      continue
    }
    if (c === "$" && command[i + 1] === "{") {
      const end = command.indexOf("}", i)
      const stop = end < 0 ? command.length : end + 1
      cur += command.slice(i, stop)
      has = true
      i = stop
      continue
    }
    if (c === "\n" && pendingHeredocs.length) {
      pushSegment()
      i++
      for (const delim of pendingHeredocs.splice(0)) {
        while (i < command.length) {
          let e = command.indexOf("\n", i)
          if (e < 0) e = command.length
          const lineText = command.slice(i, e).trim()
          i = Math.min(e + 1, command.length)
          if (lineText === delim) break
        }
      }
      continue
    }
    if (c === "\n" || c === ";" || c === "(" || c === ")") {
      pushSegment()
      i++
      continue
    }
    if (c === "|" || c === "&") {
      if (c === "&" && command[i + 1] === ">") {
        pushToken()
        i += command[i + 2] === ">" ? 3 : 2
        expectRedirect = true
        continue
      }
      pushSegment()
      i += command[i + 1] === c ? 2 : 1
      continue
    }
    if (c === ">" || c === "<") {
      if (has && /^\d+$/.test(cur)) {
        cur = ""
        has = false
      } else pushToken()
      let j = i + 1
      if (command[j] === ">" || command[j] === "|") j++
      if (c === ">" && command[j] === "&") {
        // fd duplication (>&2, >&-): no file target
        j++
        while (j < command.length && /[0-9-]/.test(command[j])) j++
        i = j
        continue
      }
      if (c === "<" && command[j] === "<") {
        // heredoc (<<EOF, <<-EOF, <<'EOF') or herestring (<<<): skip the delimiter token
        j++
        const herestring = command[j] === "<"
        if (herestring) j++
        if (command[j] === "-") j++
        while (command[j] === " ") j++
        let delim = ""
        while (j < command.length && !/[\s;&|)]/.test(command[j])) {
          if (command[j] !== "'" && command[j] !== '"' && command[j] !== "\\") delim += command[j]
          j++
        }
        if (!herestring && delim) pendingHeredocs.push(delim)
        i = j
        continue
      }
      i = j
      expectRedirect = c === ">"
      if (c === "<") {
        // input redirect: consume its target without checking
        while (command[i] === " ") i++
        while (i < command.length && !/[\s;&|]/.test(command[i])) i++
      }
      continue
    }
    if (c === " " || c === "\t") {
      pushToken()
      i++
      continue
    }
    cur += c
    has = true
    i++
  }
  pushSegment()
  return { segments, redirects, segmentRedirects, nested, invalidAnsiC }
}

function expandArg(arg, ctx) {
  let a = arg
  if (a === "~" || a.startsWith("~/")) a = os.homedir() + a.slice(1)
  a = a.replace(/^\$\{?HOME\}?(?=\/|$)/, os.homedir())
  if (ctx.scratch) a = a.replace(/^\$\{?(TMPDIR|PIPELINE_SCRATCH)\}?(?=\/|$)/, ctx.scratch)
  return a
}

function isSystemTempPath(rawArg, absPath, top) {
  if (typeof rawArg !== "string" || !path.isAbsolute(rawArg) || rawArg.trim().startsWith("~")) return false
  if (isInside(top, path.resolve(top, rawArg))) return false
  if (isInside(top, absPath)) return false
  const tempRoots = ["/tmp", "/private/tmp", os.tmpdir(), realpathLoose("/tmp"), realpathLoose(os.tmpdir())]
  return tempRoots.some((root) => {
    const tempRoot = realpathLoose(root)
    if (!isInside(tempRoot, absPath) || absPath === tempRoot) return false
    if (isInside(tempRoot, top) && (isInside(absPath, top) || path.relative(tempRoot, absPath).split(path.sep)[0].startsWith("pipe-"))) return false
    return true
  })
}

/** Returns null if the path is acceptable (or unresolvable), else a reason string. */
export function checkWritePath(arg, ctx) {
  if (typeof arg !== "string" || !arg) return null
  if (/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(arg)) return null
  let a = expandArg(arg, ctx)
  if (a.includes("$")) return null // unknown variable: cannot decide
  const expanded = a
  const glob = a.search(/[*?[]/)
  if (glob >= 0) a = a.slice(0, glob) || "."
  const abs = realpathLoose(path.resolve(ctx.cwd || ctx.info.top, a))
  const scratch = ctx.scratch ? realpathLoose(ctx.scratch) : null
  if (scratch && isInside(scratch, abs)) return null
  if (isSystemTempPath(String(arg).trim().startsWith("~") ? "" : expanded, abs, ctx.info.top)) return null
  const internals = `"${arg}" is inside the git internals. Do not modify .git; use the scratch directory for throwaway files.`
  if (isInside(ctx.info.top, abs)) {
    return isInside(path.join(ctx.info.top, ".git"), abs) ? internals : null
  }
  if (isInside(ctx.info.common, abs) || isInside(ctx.info.gitDir, abs)) return internals
  return `"${arg}" resolves outside the repository (${abs}). Stay inside the repo; throwaway files go in $PIPELINE_SCRATCH${scratch ? ` (${scratch})` : ""}.`
}

function nonFlags(args) {
  return args.filter((a) => !a.startsWith("-"))
}

function checkSecretEnvArgs(cmd, args, role) {
  if (cmd === "git") return null
  const positional = nonFlags(args)
  const templateCopy = cmd === "cp" && ENV_TEMPLATE_COPY_ROLES.has(role) && positional.length === 2
    && ENV_TEMPLATE_FILES.has(path.basename(positional[0].replace(/\[([^\]]{1})\]/g, "$1")).toLowerCase())
  for (let i = 0; i < positional.length; i++) {
    const basename = path.basename(positional[i].replace(/\[([^\]]{1})\]/g, "$1"))
    if (/^\.env(?:\..+)?$/i.test(basename) && !/^\.env\.(?:example|sample|template|test)$/i.test(basename)
      && !(templateCopy && i === 1)) {
      return "Guard: reading or accessing '.env' secret files is blocked."
    }
  }
  return null
}

function shellCommandArg(cmd, args) {
  if (!SHELLS.has(cmd)) return null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--") break
    if (arg === "-c" || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) return typeof args[i + 1] === "string" ? args[i + 1] : null
    if (/^[-+][oO]$/.test(arg)) i++
    else if (arg.startsWith("-") || arg.startsWith("+")) continue
    else break
  }
  return null
}

function stripWrappers(tokens) {
  const t = tokens.slice()
  for (;;) {
    while (t.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(t[0])) t.shift()
    if (t.length && WRAPPERS.has(t[0])) {
      const wrapper = t.shift()
      while (t.length && (t[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(t[0]))) t.shift()
      if ((wrapper === "timeout" || wrapper === "gtimeout") && t.length) t.shift()
      continue
    }
    break
  }
  return t
}

function takeLeadingAssigns(tokens) {
  const t = tokens.slice()
  const assigns = []
  for (;;) {
    while (t.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(t[0])) assigns.push(t.shift())
    if (t.length && WRAPPERS.has(t[0])) {
      const wrapper = t.shift()
      while (t.length && (t[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(t[0]))) {
        if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(t[0])) assigns.push(t[0])
        t.shift()
      }
      if ((wrapper === "timeout" || wrapper === "gtimeout") && t.length) t.shift()
      continue
    }
    break
  }
  return assigns
}

function isDangerousEnvAssignment(assignment) {
  if (/^GIT_MERGE_AUTOEDIT=(?:true|:|no)$/i.test(assignment)) return false
  return DANGEROUS_GIT_ENV.test(assignment) || DANGEROUS_EXEC_ENV.test(assignment)
    || (/^NODE_OPTIONS\+?=/i.test(assignment) && /--require|-r|--import|--loader|--experimental-loader/i.test(assignment))
}

function inPlaceTargets(cmd, args) {
  if (!args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === "-i" || a.startsWith("--in-place"))) return []
  const positional = []
  let hasExplicitScript = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "-e" || arg === "-f") {
      hasExplicitScript = true
      i++
    } else if (arg === "-i" && args[i + 1] === "") {
      i++
    } else if (arg.startsWith("-") || arg.startsWith("+")) {
      continue
    } else if (arg !== "") positional.push(arg)
  }
  if (hasExplicitScript) return positional
  if (positional.length <= 1) return []
  let scriptIndex = 0
  if (positional.length >= 3 && /^\.[^/]*$/.test(positional[0])) scriptIndex = 1
  return positional.slice(scriptIndex + 1)
}

function inPlaceEdit(cmd, args) {
  return inPlaceTargets(cmd, args).length > 0
}

function hasOutputRedirect(rawSeg) {
  return Array.isArray(rawSeg) && rawSeg.length > 0
}

function segmentWritePaths(tokens, cwd = process.cwd()) {
  const t = stripWrappers(tokens)
  if (!t.length) return { rawPaths: [], subcommands: [], cwdChange: null }
  const cmd = path.basename(t[0])
  const args = t.slice(1)
  const rawPaths = []
  const subcommands = []
  let cwdChange = null
  const dest = (list) => (list.length ? [list[list.length - 1]] : [])
  if (SHELLS.has(cmd)) {
    const subcmd = shellCommandArg(cmd, args)
    if (subcmd) subcommands.push(subcmd)
  }
  if (cmd === "cd" || cmd === "pushd") {
    cwdChange = args.find((a) => !a.startsWith("-")) || null
  }
  switch (cmd) {
    case "rm": case "rmdir": case "mkdir": case "touch": case "truncate": case "chmod":
    case "chown": case "chgrp": case "tee": case "unlink": case "shred": case "mktemp":
      rawPaths.push(...(cmd === "chmod" || cmd === "chown" || cmd === "chgrp" ? nonFlags(args).slice(1) : nonFlags(args)))
      break
    case "mv":
      rawPaths.push(...nonFlags(args))
      break
    case "cp": case "ln": case "install": case "rsync": case "ditto":
      rawPaths.push(...dest(nonFlags(args)))
      break
    case "dd":
      for (const a of args) if (a.startsWith("of=")) rawPaths.push(a.slice(3))
      break
    case "curl":
      for (let k = 0; k < args.length; k++) {
        if (["-o", "--output", "-D", "--dump-header", "-c", "--cookie-jar"].includes(args[k])) rawPaths.push(args[k + 1])
        else if (["--output", "--dump-header", "--cookie-jar"].some((flag) => args[k].startsWith(`${flag}=`))) rawPaths.push(args[k].slice(args[k].indexOf("=") + 1))
      }
      break
    case "wget":
      for (let k = 0; k < args.length; k++) {
        if (args[k] === "-O" || args[k] === "--output-document") rawPaths.push(args[k + 1])
        else if (args[k].startsWith("--output-document=")) rawPaths.push(args[k].slice(18))
      }
      break
    case "tar":
      for (let k = 0; k < args.length; k++) if (args[k] === "-C" || args[k] === "--directory") rawPaths.push(args[k + 1])
      break
    case "unzip":
      for (let k = 0; k < args.length; k++) if (args[k] === "-d") rawPaths.push(args[k + 1])
      break
    case "sed": case "perl":
      rawPaths.push(...inPlaceTargets(cmd, args))
      break
    case "git": {
      let i = 0
      let gitCwd = null
      while (i < args.length) {
        const a = args[i]
        if (a === "-C") {
          gitCwd = path.resolve(gitCwd === null ? cwd : gitCwd, args[i + 1] || "")
          i += 2
          continue
        }
        if (a.startsWith("-C") && a.length > 2) {
          gitCwd = path.resolve(gitCwd === null ? cwd : gitCwd, a.slice(2))
          i++
          continue
        }
        if (a === "-c" || (a.startsWith("-c") && a.length > 2)) {
          i += a === "-c" ? 2 : 1
          continue
        }
        if (a.startsWith("--git-dir") || a.startsWith("--work-tree") || a === "--bare" || a.startsWith("-")) {
          i++
          continue
        }
        break
      }
      const sub = args[i]
      if (["mv", "rm", "add", "checkout", "restore"].includes(sub)) {
        const files = gitFileArgs(args.slice(i + 1))
        rawPaths.push(...files.map((file) => gitCwd ? path.resolve(gitCwd, file) : file))
      }
      break
    }
  }
  return { rawPaths, subcommands, cwdChange }
}

function isGitExplicitFile(file, ctx) {
  if (!file || file === "." || file === "./" || file === ".." || file.endsWith("/") || file.startsWith(":") || file.includes("$") || file.startsWith("~") || /[*?\[\]]/.test(file)) return false
  if (!ctx) return true
  if (checkWritePath(file, ctx)) return false
  try {
    const abs = realpathLoose(path.resolve(ctx.cwd || ctx.info.top, file))
    if (!isInside(ctx.info.top, abs) || fs.statSync(abs).isDirectory()) return false
  } catch {
    // New files can be staged before they exist.
  }
  return true
}

function isGitExplicitPath(arg, ctx) {
  if (!arg || arg === "." || arg === "./" || arg === ".." || arg.startsWith(":") || arg.includes("$") || arg.startsWith("~") || /[*?\[\]]/.test(arg)) return false
  if (checkWritePath(arg, ctx)) return false
  const abs = realpathLoose(path.resolve(ctx.cwd || ctx.info.top, arg))
  return isInside(ctx.info.top, abs) && abs !== realpathLoose(ctx.info.top)
}

function gitFileArgs(args) {
  const separator = args.indexOf("--")
  return separator >= 0 ? args.slice(separator + 1) : args.filter((r) => !r.startsWith("-"))
}

export function checkGitCommand(args, role, ctx) {
  let effectiveCwd = (ctx && ctx.cwd) || (ctx && ctx.info && ctx.info.top) || process.cwd()
  let gitDirError = null
  let i = 0
  while (i < args.length) {
    const a = args[i]
    if (a === "-C" || (a.startsWith("-C") && a.length > 2)) {
      const d = a === "-C" ? args[i + 1] : a.slice(2)
      if (d !== undefined) {
        const gitDirCtx = ctx ? { ...ctx, cwd: effectiveCwd } : null
        if (gitDirCtx && checkWritePath(d, gitDirCtx)) gitDirError = `git -C ${d} points outside the repository.`
        effectiveCwd = path.resolve(effectiveCwd, expandArg(d, ctx || {}))
      }
      i += a === "-C" ? 2 : 1
      continue
    }
    if (a === "-c" || (a.startsWith("-c") && a.length > 2)) {
      const v = a === "-c" ? args[i + 1] || "" : a.slice(2)
      if (GIT_ALWAYS_BLOCKED_CFG.test(v) && !GIT_SAFE_EDITOR_CFG.test(v)) return `git -c ${v.split("=")[0]} is not allowed.`
      i += a === "-c" ? 2 : 1
      continue
    }
    if (a === "--config-env" || a.startsWith("--config-env=") || a === "--exec-path" || a.startsWith("--exec-path=")) {
      return `Guard: 'git ${a.split("=")[0]}' is blocked.`
    }
    if (a.startsWith("--git-dir") || a.startsWith("--work-tree") || a === "--bare") {
      return `${a.split("=")[0]} is not allowed: operate on the repository you were started in.`
    }
    if (a.startsWith("-")) {
      i++
      continue
    }
    break
  }
  const sub = args[i]
  if (sub === undefined) return gitDirError
  const gitCtx = ctx ? { ...ctx, cwd: effectiveCwd } : { cwd: effectiveCwd }
  if (["fetch", "mv", "rm", "add", "checkout", "restore", "commit", "pull", "merge", "rebase", "cherry-pick"].includes(sub)
    && ctx && ctx.info && !isInside(realpathLoose(ctx.info.top), realpathLoose(effectiveCwd))) {
    return "Guard: 'git -C' for mutating git commands must stay inside the repository root."
  }
  if (gitDirError) return gitDirError
  const rest = args.slice(i + 1)
  const hint = ` Branches, worktrees, stashes, resets and commits are ${WORKSPACE_MANAGED_HINT}; report what you need instead.`
  const deny = (what) => `git ${what} is not allowed for ${role || "this agent"} in a pipeline session.${hint}`
  if (GIT_READ.has(sub)) {
    if ((sub === "diff" || sub === "show" || sub === "log") && rest.some((r) => r.startsWith("--output"))) return deny(`${sub} --output`)
    return null
  }
  switch (sub) {
    case "branch": {
      const mutating = ["-d", "-D", "-m", "-M", "-c", "-C", "-f", "-u", "--delete", "--move", "--copy", "--force", "--set-upstream-to", "--unset-upstream", "--edit-description"]
      if (rest.some((r) => mutating.includes(r))) return deny("branch (renaming, deleting or reconfiguring)")
      const listing = ["--show-current", "--list", "-l", "-a", "-r", "-v", "-vv", "--all", "--remotes", "--contains", "--merged", "--no-merged"]
      return rest.length === 0 || rest.some((r) => listing.includes(r)) ? null : deny("branch (creating)")
    }
    case "tag":
      return rest.length === 0 || rest[0] === "-l" || rest[0] === "--list" ? null : deny("tag")
    case "config":
      return rest.some((r) => ["--get", "--get-all", "--list", "-l", "--get-regexp"].includes(r)) ? null : deny("config (writing)")
    case "remote":
      return rest.length === 0 || rest[0] === "-v" || rest[0] === "--verbose" || rest[0] === "show" || rest[0] === "get-url" ? null : deny("remote (modifying)")
    case "fetch":
      return rest.some((r) => r === "--upload-pack" || r.startsWith("--upload-pack=") || r.startsWith("ext::")) ? deny("fetch --upload-pack or ext:: transport") : null
    case "pull":
      if (!GIT_SYNC_ROLES.has(role)) return deny("pull")
      return rest.some((r) => r === "--upload-pack" || r.startsWith("--upload-pack=") || r.startsWith("ext::")) ? deny("pull --upload-pack or ext:: transport")
        : rest.some((r) => ["--rebase=interactive", "--rebase=i", "-r=interactive", "-r=i"].includes(r)) ? deny("pull --rebase=interactive") : null
    case "merge":
    case "cherry-pick":
      if (!GIT_SYNC_ROLES.has(role)) return deny(sub)
      return rest.some((r) => r === "-e" || r === "--edit") ? deny(`${sub} --edit`) : null
    case "rebase":
      if (!GIT_SYNC_ROLES.has(role)) return deny("rebase")
      return rest.some((r) => r === "-i" || r === "--interactive" || r.startsWith("--interactive=") || r === "-x" || r === "--exec" || r.startsWith("--exec=") || (!r.startsWith("--") && r.startsWith("-") && (/[ix]/.test(r.slice(1).replace(/[^a-zA-Z].*$/, "")) || /^-[a-zA-Z]*x.+/.test(r)))) ? deny("rebase -i/--exec") : null
    case "checkout": {
      if (!GIT_SYNC_ROLES.has(role)) return deny("checkout")
      const conflictFlags = rest.some((r) => r === "--ours" || r === "--theirs" || r === "-m" || r === "--merge" || r.startsWith("--conflict="))
      const prohibitedFlags = rest.some((r) => ["-b", "-B", "-d", "--detach", "-f", "--force", "-p", "--patch", "-t", "--track", "--orphan"].includes(r) || (/^-[a-zA-Z]+$/.test(r) && /[bBdfpt]/.test(r)))
      const separator = rest.indexOf("--")
      const files = separator >= 0 ? rest.slice(separator + 1) : rest.filter((r) => !r.startsWith("-"))
      if (!conflictFlags || prohibitedFlags || !files.length || files.some((f) => !isGitExplicitFile(f, gitCtx))) return deny("checkout")
      return null
    }
    case "stash":
      return rest[0] === "list" || rest[0] === "show" ? null : deny("stash")
    case "worktree":
      return rest[0] === "list" ? null : deny("worktree")
    case "reflog":
      return rest.length === 0 || rest[0] === "show" ? null : deny("reflog (modifying)")
    case "add": {
      if (role !== "post_session" && !GIT_SYNC_ROLES.has(role)) return deny("add")
      const files = gitFileArgs(rest)
      if (rest.some((r) => ["-A", "--all", "--no-ignore-removal", "-u", "--update", "-p", "--patch", "-i", "--interactive"].includes(r) || (/^-[a-zA-Z]+$/.test(r) && /[Aupi]/.test(r))) || !files.length || files.some((f) => !isGitExplicitFile(f, gitCtx))) {
        return "git add requires explicit file paths (no -A, -u, -p, or .)"
      }
      return null
    }
    case "commit": {
      if (role !== "post_session") return deny("commit")
      const flags = rest.filter((r) => r.startsWith("-"))
      if (flags.some((f) => ["--amend", "-a", "--all", "--no-verify", "-n"].includes(f) || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(f))) {
        return "git commit must not use --amend, -a/--all or --no-verify."
      }
      return null
    }
    case "restore": {
      const flags = rest.filter((r) => r.startsWith("-"))
      const files = gitFileArgs(rest)
      if (role === "post_session") return flags.some((f) => f === "--staged" || f === "-S") && files.length && files.every((f) => isGitExplicitFile(f, gitCtx)) ? null : "git restore is only allowed with --staged and explicit file paths."
      if (GIT_SYNC_ROLES.has(role)) {
        const conflictFlags = rest.some((r) => r === "--staged" || r === "-S" || r === "--ours" || r === "--theirs" || r === "--merge" || r === "-m" || r.startsWith("--conflict="))
        return conflictFlags && files.length && files.every((f) => isGitExplicitFile(f, gitCtx)) ? null : deny("restore (working-tree discard)")
      }
      return deny("restore (working-tree discard)")
    }
    case "mv": {
      if (!GIT_SYNC_ROLES.has(role)) return deny("mv")
      const files = gitFileArgs(rest)
      return files.length >= 2 && files.every((f) => isGitExplicitPath(f, gitCtx)) ? null : deny("mv")
    }
    case "rm": {
      const flags = rest.filter((r) => r.startsWith("-"))
      if (!GIT_SYNC_ROLES.has(role) && !(role === "post_session" && flags.includes("--cached"))) return deny("rm")
      const files = gitFileArgs(rest)
      const recursive = flags.some((f) => f === "--recursive" || /^-[^-]*[rR]/.test(f))
      if (!files.length || files.some((f) => !(recursive && GIT_SYNC_ROLES.has(role) ? isGitExplicitPath(f, gitCtx) : isGitExplicitFile(f, gitCtx)))) {
        return "git rm requires explicit file paths (or explicit directories with -r)."
      }
      return null
    }
    default:
      return deny(sub)
  }
}

const RM_CODING_ROLES = new Set(["executor", "refactorer", "fast_lane", "tester"])

function checkSegment(tokens, role, ctx, depth = 0, rawSeg = []) {
  for (const assignment of takeLeadingAssigns(tokens)) {
    if (isDangerousEnvAssignment(assignment)) {
      return "Guard: dangerous environment variable assignments are blocked."
    }
  }
  const t = stripWrappers(tokens)
  if (!t.length) return null
  const cmd = path.basename(t[0])
  const args = t.slice(1)
  if (["export", "declare", "typeset", "env"].includes(cmd)) {
    for (const assignment of args) {
      if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(assignment) && isDangerousEnvAssignment(assignment)) {
        return `Guard: dangerous environment override '${assignment.split(/\+?=/, 1)[0]}' is blocked.`
      }
    }
  }
  if (SHELLS.has(cmd)) {
    const subcmd = shellCommandArg(cmd, args)
    if (subcmd) return checkBash(subcmd, role, ctx, depth + 1)
  }
  if (NEVER.has(cmd)) return `${cmd} is not allowed.`
  const secretEnvErr = checkSecretEnvArgs(cmd, args, role)
  if (secretEnvErr) return secretEnvErr
  if (READ_ONLY_BASH_ROLES.has(role) && (hasOutputRedirect(rawSeg) || WRITE_CMDS.has(cmd) || inPlaceEdit(cmd, args)
    || (cmd === "find" && args.some((a) => /^-(?:exec|execdir|ok|okdir|delete|fprint0?|fls|fprintf)$/.test(a)))
    || (cmd === "fd" && args.some((a) => /^(?:-[xX]|--exec(?:-batch)?)(?:=|$)/.test(a)))
    || (cmd === "sort" && args.some((a) => /^(?:-o|--output)(?:=|$)/.test(a))))) {
    return `Guard: role '${role}' is read-only and cannot modify files.`
  }
  if (cmd === "rm" || cmd === "rmdir") {
    const hasRecursiveOrForce = cmd === "rm" && args.some((a) => /^--(?:recursive|force)$/.test(a) || (/^-[^-]/.test(a) && /[rRfF]/.test(a)))
    const targets = nonFlags(args)
    if (!targets.length) return `Guard: '${cmd}' requires at least one explicit path target.`
    for (const raw of targets) {
      if (/[*?\[\]]/.test(raw)) return `Guard: '${cmd}' does not allow wildcard targets.`
      if (!raw || /^(?:\.|\.\.|\.\.?\/|\/|~|~\/.*|\*|\.\*|\.\.?\/\*)$/.test(raw) || raw.endsWith("/.") || raw.endsWith("/..") || raw.endsWith("/*")) {
        return `Guard: '${cmd}' requires an explicit path target inside the repository or scratch directory.`
      }
      const expanded = expandArg(raw, ctx)
      if (expanded.includes("$") || expanded.startsWith("~")) return `Guard: '${cmd}' requires an explicit path target.`
      const base = (ctx && ctx.cwd) || (ctx && ctx.info && ctx.info.top) || process.cwd()
      const abs = realpathLoose(path.resolve(base, expanded))
      const writeErr = checkWritePath(raw, ctx)
      if (writeErr) return writeErr
      const scratch = ctx && ctx.info ? realpathLoose(scratchDir(ctx.info)) : null
      if (scratch && isInside(scratch, abs) && abs !== scratch) continue
      if (ctx && ctx.info && isSystemTempPath(raw, abs, ctx.info.top) && abs !== "/tmp" && abs !== "/private/tmp") continue
      if (scratch && abs === scratch) return "Guard: rm or rmdir cannot target the scratch root."
      if (ctx && ctx.info && !isInside(realpathLoose(ctx.info.top), abs)) return writeErr || `Guard: '${cmd}' target must be inside the repository or an allowed temporary directory.`
      if (ctx && ctx.info) {
        const topReal = realpathLoose(ctx.info.top)
        if (abs === topReal) return `Guard: '${cmd}' cannot target the repository root.`
        if (hasRecursiveOrForce && !RM_CODING_ROLES.has(role)) {
          return "Guard: recursive or forced 'rm' on repository paths is only permitted for coding roles (executor, refactorer, fast_lane, tester)."
        }
      }
    }
  }
  if (cmd === "git") return typeof ctx?.gitPolicy === "function" ? ctx.gitPolicy(args, ctx) : checkGitCommand(args, role, ctx)
  if (cmd === "cd" || cmd === "pushd") {
    const target = args.find((a) => !a.startsWith("-"))
    if (target && checkWritePath(target, ctx)) return `cd "${target}" leaves the repository. Stay inside the repo.`
    return null
  }
  const paths = []
  const dest = (list) => (list.length ? [list[list.length - 1]] : [])
  switch (cmd) {
    case "rm": case "rmdir": case "mkdir": case "touch": case "truncate": case "chmod":
    case "chown": case "chgrp": case "tee": case "unlink": case "shred": case "mktemp":
      paths.push(...(cmd === "chmod" || cmd === "chown" || cmd === "chgrp" ? nonFlags(args).slice(1) : nonFlags(args)))
      break
    case "mv":
      paths.push(...nonFlags(args))
      break
    case "cp": case "ln": case "install": case "rsync": case "ditto":
      paths.push(...dest(nonFlags(args)))
      break
    case "dd":
      for (const a of args) if (a.startsWith("of=")) paths.push(a.slice(3))
      break
    case "curl":
      for (let k = 0; k < args.length; k++) {
        if (args[k] === "-o" || args[k] === "--output" || args[k] === "--output-dir") paths.push(args[k + 1])
        else if (args[k].startsWith("--output=")) paths.push(args[k].slice(9))
      }
      break
    case "wget":
      for (let k = 0; k < args.length; k++) {
        if (args[k] === "-O" || args[k] === "-P" || args[k] === "--directory-prefix") paths.push(args[k + 1])
        else if (args[k].startsWith("--output-document=")) paths.push(args[k].slice(18))
      }
      break
    case "tar":
      for (let k = 0; k < args.length; k++) if (args[k] === "-C" || args[k] === "--directory") paths.push(args[k + 1])
      break
    case "unzip":
      for (let k = 0; k < args.length; k++) if (args[k] === "-d") paths.push(args[k + 1])
      break
    case "sed": case "perl":
      paths.push(...inPlaceTargets(cmd, args))
      break
    default:
      break
  }
  for (const p of paths) {
    const reason = checkWritePath(p, ctx)
    if (reason) return `${cmd}: ${reason}`
  }
  return null
}

/**
 * Check a bash command issued by an agent.
 * ctx: { info, cwd, scratch, gitPolicy? }, role: guard role such as "executor".
 * gitPolicy(args, ctx), when given, replaces the role-based git check for every git segment.
 * Returns null when acceptable, otherwise a human-readable reason.
 */
export function checkBash(command, role, ctx, depth = 0) {
  if (typeof command !== "string") return null
  if (depth > 4) return "Shell command nesting exceeds the validation limit."
  let parsed
  try {
    parsed = tokenize(command)
  } catch {
    return null
  }
  if (parsed.invalidAnsiC) return "Unable to safely parse ANSI-C quoted string."
  let cwd = ctx.cwd || ctx.info.top
  for (let i = 0; i < parsed.segments.length; i++) {
    const segmentCtx = { ...ctx, cwd }
    for (const target of parsed.segmentRedirects[i] || []) {
      const reason = checkWritePath(target, segmentCtx)
      if (reason) return `output redirection to ${reason}`
    }
    const seg = parsed.segments[i]
    const reason = checkSegment(seg, role, segmentCtx, depth, parsed.segmentRedirects[i] || [])
    if (reason) return reason
    const command = segmentWritePaths(seg, cwd)
    if (command.cwdChange) {
      const next = command.cwdChange === "-" ? cwd : path.resolve(cwd, expandArg(command.cwdChange, { scratch: ctx.scratch }))
      if (!next.includes("$")) cwd = next
    }
  }
  for (const inner of parsed.nested) {
    const reason = checkBash(inner, role, { ...ctx, cwd }, depth + 1)
    if (reason) return reason
  }
  return null
}

/** Repo-relative files a bash command may modify. */
export function bashWriteTargets(command, ctx, depth = 0) {
  if (typeof command !== "string" || depth > 4) return []
  const info = ctx?.info || ctx || {
    top: process.cwd(),
    gitDir: path.join(process.cwd(), ".git"),
    common: process.cwd(),
    isLinked: false,
  }
  if (!info.top) return []
  const baseCwd = ctx?.cwd || info.top
  const scratchPath = ctx?.scratch || info.scratchDir || scratchDir(info)
  let parsed
  try {
    parsed = tokenize(command)
  } catch {
    return []
  }
  const targets = new Set()
  let cwd = baseCwd
  const collect = (rawPaths, atCwd = cwd) => {
    for (const raw of rawPaths) {
      if (typeof raw !== "string" || !raw || raw === "-" || raw.startsWith("&") || raw.startsWith("/dev/")) continue
      const expanded = expandArg(raw, { scratch: scratchPath })
      if (expanded.includes("$")) continue
      const abs = realpathLoose(path.resolve(atCwd, expanded))
      if (isSystemTempPath(String(raw).trim().startsWith("~") ? "" : expanded, abs, info.top)) continue
      if (isInside(realpathLoose(scratchPath), abs)) continue
      if (info.gitDir && isInside(realpathLoose(info.gitDir), abs)) continue
      const rel = toRel(info, abs)
      if (rel && rel !== "") targets.add(rel)
    }
  }
  for (let i = 0; i < parsed.segments.length; i++) {
    const seg = parsed.segments[i]
    collect(parsed.segmentRedirects[i] || [], cwd)
    const result = segmentWritePaths(seg, cwd)
    collect(result.rawPaths, cwd)
    for (const sub of result.subcommands) {
      for (const rel of bashWriteTargets(sub, { ...ctx, info, cwd, scratch: scratchPath }, depth + 1)) targets.add(rel)
    }
    if (result.cwdChange) {
      const next = result.cwdChange === "-" ? cwd : path.resolve(cwd, expandArg(result.cwdChange, { scratch: scratchPath }))
      if (!next.includes("$")) cwd = next
    }
  }
  for (const inner of parsed.nested) {
    for (const rel of bashWriteTargets(inner, { ...ctx, info, cwd, scratch: scratchPath }, depth + 1)) targets.add(rel)
  }
  return [...targets]
}

/** Paths written by an edit/write/apply_patch style tool call. */
export function editTargets(tool, args) {
  if (!args || typeof args !== "object") return []
  if (tool === "edit" || tool === "write" || tool === "multiedit") {
    const fp = args.filePath ?? args.file_path ?? args.path
    return typeof fp === "string" && fp ? [fp] : []
  }
  if (tool === "apply_patch" || tool === "patch") {
    const text = typeof args.patchText === "string" ? args.patchText : typeof args.patch === "string" ? args.patch : ""
    const out = []
    for (const m of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) out.push(m[1].trim())
    for (const m of text.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)) out.push(m[1].trim())
    return out
  }
  return []
}

export const FILE_WRITE_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch", "patch"])

/** Tools that run a shell command: `bash` in V1, `shell` in V2. */
export const SHELL_TOOLS = new Set(["bash", "shell"])

export function isShellTool(tool) {
  return SHELL_TOOLS.has(tool)
}
