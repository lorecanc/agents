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

export function isPosixTempAlias(rawArg) {
  if (typeof rawArg !== "string") return false
  const slash = rawArg.replaceAll("\\", "/")
  if (!slash.startsWith("/") || slash.startsWith("//")) return false
  const norm = path.posix.normalize(slash).replace(/\/+$/, "")
  for (const prefix of ["/tmp/", "/private/tmp/"]) {
    if (norm.startsWith(prefix)) {
      const first = norm.slice(prefix.length).split("/")[0]
      return Boolean(first) && !first.startsWith("pipe-")
    }
  }
  return false
}

function isSystemTempPath(rawArg, absPath, top) {
  if (typeof rawArg !== "string" || !path.isAbsolute(rawArg) || rawArg.trim().startsWith("~")) return false
  if (isInside(top, path.resolve(top, rawArg))) return false
  if (isInside(top, absPath)) return false
  if (process.platform === "win32" && isPosixTempAlias(rawArg)) return true
  const tempRoots = process.platform === "win32"
    ? [os.tmpdir(), realpathLoose(os.tmpdir())]
    : ["/tmp", "/private/tmp", os.tmpdir(), realpathLoose("/tmp"), realpathLoose("/private/tmp"), realpathLoose(os.tmpdir())]
  return tempRoots.some((root) => {
    const tempRoot = realpathLoose(root)
    if (!isInside(tempRoot, absPath) || absPath === tempRoot) return false
    if (isInside(tempRoot, top) && (isInside(absPath, top) || path.relative(tempRoot, absPath).split(path.sep)[0].startsWith("pipe-"))) return false
    return true
  })
}

function isOpsRepositoryWritePath(rawArg, ctx) {
  if (typeof rawArg !== "string" || !rawArg || !ctx?.info?.top) return false
  let expanded = expandArg(rawArg, ctx)
  if (expanded.includes("$")) return false
  const glob = expanded.search(/[*?[]/)
  if (glob >= 0) expanded = expanded.slice(0, glob) || "."
  const abs = realpathLoose(path.resolve(ctx.cwd || ctx.info.top, expanded))
  const scratchPaths = [ctx.scratch, ctx.info.scratchDir, scratchDir(ctx.info), path.join(ctx.info.top, ".git", "opencode-scratch")]
    .filter(Boolean)
    .map(realpathLoose)
  if (scratchPaths.some((scratch) => isInside(scratch, abs))) return false
  if (isSystemTempPath(String(rawArg).trim().startsWith("~") ? "" : expanded, abs, ctx.info.top)) return false
  return isInside(realpathLoose(ctx.info.top), abs)
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
    if (isSecretEnvFile(positional[i]) && !(templateCopy && i === 1)) {
      return "Guard: reading or accessing '.env' secret files is blocked."
    }
  }
  if (cmd === "sed") {
    for (const target of sedReadTargets(args)) {
      if (isSecretEnvFile(target)) return "Guard: reading or accessing '.env' secret files is blocked."
    }
  }
  return null
}

function isSecretEnvFile(file) {
  const basename = path.basename(file.replace(/\[([^\]]{1})\]/g, "$1"))
  return /^\.env(?:\..+)?$/i.test(basename) && !/^\.env\.(?:example|sample|template|test)$/i.test(basename)
}

function envSplitTokens(arg, value) {
  const command = arg === "-S" || arg === "--split-string" ? value || ""
    : arg.startsWith("-S") ? arg.slice(2)
      : arg.startsWith("--split-string=") ? arg.slice("--split-string=".length) : null
  if (!command) return []
  return tokenize(command).segments.flat()
}

function bareEnvProblem(tokens) {
  const t = tokens.slice()
  for (;;) {
    while (t.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(t[0])) t.shift()
    const wrapper = path.basename(t[0] || "")
    if (!WRAPPERS.has(wrapper)) return null
    if (wrapper === "env") {
      t.shift()
      let i = 0
      while (i < t.length) {
        const arg = t[i]
        if (arg === "-0" || arg === "--null") return "Guard: env null-output and environment dumps are not allowed."
        if (arg === "--") {
          i++
          break
        }
        if (arg === "-i" || arg === "--ignore-environment" || arg.startsWith("--unset=") || arg.startsWith("--chdir=")) {
          i++
          continue
        }
        if (arg === "-S" || arg === "--split-string" || /^-S.+/.test(arg) || arg.startsWith("--split-string=")) {
          const split = envSplitTokens(arg, t[i + 1])
          const consumed = arg === "-S" || arg === "--split-string" ? 2 : 1
          t.splice(i, consumed, ...split)
          continue
        }
        if (["-u", "--unset", "-C", "--chdir", "--argv0"].includes(arg)) {
          i += 2
          continue
        }
        if (/^-[uCS].+/.test(arg) || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(arg)) {
          i++
          continue
        }
        if (arg.startsWith("-")) {
          i++
          continue
        }
        break
      }
      while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(t[i])) i++
      if (i >= t.length) return "Guard: bare env / environment dumps are not allowed; provide a command to run."
      if (path.basename(t[i]) === "env") {
        t.splice(0, i)
        continue
      }
      return null
    }
    t.shift()
    while (t.length && (t[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(t[0]))) t.shift()
    if ((wrapper === "timeout" || wrapper === "gtimeout") && t.length) t.shift()
  }
}

export function inlineCodeInvocation(cmd, args) {
  const flags = (pattern) => args.some((arg) => pattern.test(arg))
  if (["eval", "exec", "source", "."].includes(cmd)) return true
  if (SHELLS.has(cmd) && flags(/^-[A-Za-z]*c/)) return true
  if (["python", "python3"].includes(cmd) && flags(/^(?:-[A-Za-z]*c|-)$/)) return true
  if (["node", "bun", "tsx"].includes(cmd) && (args.includes("-") || flags(/^(?:-[A-Za-z]*[ep]|--(?:eval|print)(?:=|$))/))) return true
  if (cmd === "deno" && args.includes("eval")) return true
  if (cmd === "ruby" && flags(/^-[A-Za-z]*e/)) return true
  if (cmd === "perl" && flags(/^-[A-Za-z]*[eE]/)) return true
  if (cmd === "php" && flags(/^-[A-Za-z]*r/)) return true
  if (["lua", "osascript"].includes(cmd) && flags(/^-[A-Za-z]*e/)) return true
  if (cmd === "sed" && sedScriptArgs(args).some((script) => sedScriptExec(script))) return true
  return false
}

function interpreterScriptInvocation(cmd, args) {
  const valueOptions = {
    python: new Set(["-W", "-X"]),
    python3: new Set(["-W", "-X"]),
    node: new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--conditions", "--inspect-port", "--input-type", "--test-reporter", "--test-reporter-destination", "--test-name-pattern"]),
    bun: new Set(["--preload", "--define", "--conditions", "--env-file"]),
    tsx: new Set(["--tsconfig", "--conditions"]),
    deno: new Set(["--config", "--import-map", "--lock", "--cert", "--ext", "--seed", "--v8-flags"]),
    ruby: new Set(["-I", "-r", "-W", "-E", "--encoding", "--external-encoding", "--internal-encoding", "--disable", "--enable"]),
    perl: new Set(["-I", "-M", "-m", "-F", "-C"]),
    php: new Set(["-d", "-z", "-c"]),
    lua: new Set(["-l"]),
    osascript: new Set(["-l"]),
  }[cmd]
  if (!valueOptions) return false
  if (["python", "python3"].includes(cmd) && args.includes("-m")) return false
  if (cmd === "node" && args.includes("--check")) return false
  if (cmd === "deno" && ["check", "fmt", "lint", "doc", "info", "help", "types"].includes(args[0])) return false
  let denoCommand = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--") return i + 1 < args.length
    if (arg.startsWith("--") && arg.includes("=")) continue
    if (arg.startsWith("-")) {
      if (valueOptions.has(arg)) i++
      continue
    }
    if (cmd === "deno" && !denoCommand && ["run", "test", "bench"].includes(arg)) {
      denoCommand = true
      continue
    }
    if (cmd === "deno" && !denoCommand) return true
    return true
  }
  return false
}

function isAllowedTemplateEnvCopy(cmd, args, role) {
  if (cmd !== "cp" || !ENV_TEMPLATE_COPY_ROLES.has(role)) return false
  const positional = nonFlags(args)
  if (positional.length !== 2) return false
  const source = path.basename(positional[0].replace(/\[([^\]]{1})\]/g, "$1")).toLowerCase()
  const destination = path.basename(positional[1].replace(/\[([^\]]{1})\]/g, "$1"))
  return ENV_TEMPLATE_FILES.has(source) && /^\.env(?:\..+)?$/i.test(destination)
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

function stripWrappers(tokens, { preserveExec = false } = {}) {
  const t = tokens.slice()
  for (;;) {
    while (t.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(t[0])) t.shift()
    const wrapper = path.basename(t[0] || "")
    if (t.length && WRAPPERS.has(wrapper)) {
      if (preserveExec && wrapper === "exec") break
      t.shift()
      if (wrapper === "env") {
        while (t.length) {
          const arg = t[0]
          if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(arg) || ["-i", "--ignore-environment"].includes(arg)
            || arg.startsWith("--unset=") || arg.startsWith("--chdir=")) {
            t.shift()
          } else if (arg === "-S" || arg === "--split-string" || /^-S.+/.test(arg) || arg.startsWith("--split-string=")) {
            const split = envSplitTokens(arg, t[1])
            const consumed = arg === "-S" || arg === "--split-string" ? 2 : 1
            t.splice(0, consumed, ...split)
          } else if (["-u", "--unset", "-C", "--chdir", "--argv0"].includes(arg)) {
            t.splice(0, 2)
          } else if (arg.startsWith("-")) t.shift()
          else break
        }
        continue
      }
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
  return inPlaceTargets(cmd, args).length > 0 || sedWriteTargets(cmd, args).length > 0
}

// sed commands that touch files or execute: the target of "w file"/"W file" and the "s/…/…/w file"
// flag are write targets, "r file"/"R file" reads a file, and "e command"/"s/…/…/e" runs a shell command.
const SED_WRITE_TARGET_RE = /(?:^|[^A-Za-z])[wW][ \t]+([^;{}]+)/g
const SED_READ_TARGET_RE = /(?:^|[^A-Za-z])[rR][ \t]+([^;{}]+)/g
// Backstop for the exec forms the procedural scan does not own: `e cmd`, the address form
// `/regex/e`, an `e` command at a command position (a bare `e` executes the pattern space,
// anything after it on the line is its shell text). Matches overlapping a literal span
// recorded by sedScriptScan are ignored: GNU sed executes nothing from those positions.
const SED_EXEC_RE = /(?:^|[^A-Za-z])e[ \t]|\/e(?:[ \t;\n}]|$)|\/[ \t]+e(?:[ \t;\n}]|$)|(?:(?:^|[;{}!$\n])[ \t]*)e/g

/** True when position i starts a sed command: not inside a word, escape or label context. */
function sedCommandStart(script, i) {
  return i === 0 || !/[A-Za-z\\:]/.test(script[i - 1])
}

function inSedLiteralSpan(spans, start, end) {
  return spans.some(([from, to]) => start < to && from < end)
}

/**
 * Procedural scan of a sed script, following GNU sed's compile.c. Collects:
 * - exec: a flag group of an `s` command containing `e`; mark_subst_opts reads the flags
 *   as blank-separated alphanumeric runs, so `ge`, `g e`, `s;a;b;ge`, `sXaXbXge` all
 *   shell-execute the substituted pattern space;
 * - writeTargets: the file name of an `s` `w` flag and of a `w`/`W` command, read to the
 *   end of the line (GNU read_filename does not stop at `;` and needs no blank after the
 *   command letter, so `s/a/b/wout.txt` and `w/etc/x` are targets too);
 * - readTargets: the file name of an `r`/`R` command, same read_filename semantics
 *   (`r.env` reads `.env`);
 * - literalSpans: text GNU treats as literal (regex/replacement of `s`/`y`, `s` flag
 *   groups, a/i/c text, comments, w/r file names), used to keep the regex backstops
 *   from firing on it.
 */
function sedScriptScan(script) {
  const result = { exec: false, writeTargets: [], readTargets: [], literalSpans: [] }
  if (typeof script !== "string") return result
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]
    if (!sedCommandStart(script, i)) continue
    if (ch === "#") {
      // comment to end of line
      const end = script.indexOf("\n", i)
      const stop = end < 0 ? script.length : end
      result.literalSpans.push([i, stop])
      i = stop - 1
      continue
    }
    if (ch === "a" || ch === "i" || ch === "c") {
      // a/i/c: the text runs to the end of the line (backslash-newline continues it)
      let end = script.indexOf("\n", i)
      while (end > 0 && script[end - 1] === "\\") end = script.indexOf("\n", end + 1)
      const stop = end < 0 ? script.length : end
      result.literalSpans.push([i + 1, stop])
      i = stop - 1
      continue
    }
    if (ch === "/") {
      // /regex/ address: the body is literal; GNU aborts the script when the closing
      // delimiter is missing, so an unterminated address makes the rest inert too
      let j = i + 1
      while (j < script.length && script[j] !== "\n") {
        if (script[j] === "\\") { j += 2; continue }
        if (script[j] === "/") break
        j++
      }
      const stop = j < script.length && script[j] === "/" ? j : script.length
      result.literalSpans.push([i + 1, stop])
      i = stop
      continue
    }
    if (ch === "w" || ch === "W" || ch === "r" || ch === "R") {
      // w/W/r/R command: GNU read_filename takes the file name to the end of the line,
      // with no blank required after the command letter
      const nl = script.indexOf("\n", i)
      const stop = nl < 0 ? script.length : nl
      const file = script.slice(i + 1, stop).trim()
      if (file) {
        if (ch === "w" || ch === "W") result.writeTargets.push(file)
        else result.readTargets.push(file)
        result.literalSpans.push([i + 1, stop])
      }
      i = stop - 1
      continue
    }
    if (ch !== "s" && ch !== "y") continue
    // any character but backslash and newline is a valid delimiter (POSIX, compile.c)
    const delim = script[i + 1]
    if (!delim || delim === "\\" || delim === "\n") continue
    const closeDelim = (from) => {
      for (let j = from; j < script.length; j++) {
        if (script[j] === "\\") { j++; continue }
        if (script[j] === delim) return j + 1
      }
      return null
    }
    const afterRegex = closeDelim(i + 2) // regex part of the s/y command
    if (afterRegex === null) continue
    const afterRepl = closeDelim(afterRegex) // replacement part; ends at the last unescaped delimiter
    if (afterRepl === null) continue
    result.literalSpans.push([i + 2, afterRepl])
    if (ch === "y") {
      i = afterRepl - 1
      continue
    }
    // s flag group, following mark_subst_opts: skip blanks, consume one alphanumeric run, repeat
    let j = afterRepl
    for (;;) {
      while (j < script.length && (script[j] === " " || script[j] === "\t")) j++
      let run = ""
      while (j < script.length && /[0-9A-Za-z]/.test(script[j])) run += script[j++]
      if (!run) break
      if (run.includes("e")) result.exec = true
      if (run.includes("w")) {
        // GNU reads the w flag file name to the end of the line; the flag group ends there
        const nl = script.indexOf("\n", j)
        const stop = nl < 0 ? script.length : nl
        const file = script.slice(j, stop).trim()
        if (file) {
          result.writeTargets.push(file)
          result.literalSpans.push([j, stop])
        }
        j = stop
        break
      }
    }
    if (j >= script.length) break
    if (!/[;}\n]/.test(script[j])) {
      // unknown option: GNU aborts the whole script, nothing after it can run
      result.literalSpans.push([j, script.length])
      break
    }
    i = j - 1 // resume at the ;, } or newline that closed the command
  }
  return result
}

/**
 * True when a sed script runs shell code: an `e command`, an address in exec form
 * (`/regex/e`), an `e` command at a command position (including a bare `e`, which
 * executes the pattern space), or an `s` command whose flag group contains `e` —
 * in any order, and with any delimiter but backslash and newline.
 */
function sedScriptExec(script) {
  if (typeof script !== "string") return false
  const { exec, literalSpans } = sedScriptScan(script)
  if (exec) return true
  for (const m of script.matchAll(SED_EXEC_RE)) {
    if (!inSedLiteralSpan(literalSpans, m.index, m.index + m[0].length)) return true
  }
  return false
}

/** Inline script strings of a sed invocation: -e/--expression values and the first positional script. */
function sedScriptArgs(args) {
  const scripts = []
  let haveScript = false
  let endOfFlags = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--") { endOfFlags = true; continue } // `--` ends the flags: parsing continues, the next positional is the script
    if (!endOfFlags) {
      if (arg === "-e" || arg === "--expression") {
        scripts.push(args[i + 1] ?? "")
        haveScript = true
        i++
      } else if (/^-e.+/.test(arg)) {
        scripts.push(arg.slice(2))
        haveScript = true
      } else if (arg.startsWith("--expression=")) {
        scripts.push(arg.slice("--expression=".length))
        haveScript = true
      } else if (arg === "-f" || arg === "--file") {
        haveScript = true // script file: its content is not visible to the guard
        i++
      } else if (/^-f.+/.test(arg) || arg.startsWith("--file=")) {
        haveScript = true
      } else if (arg === "-i" && args[i + 1] === "") {
        i++ // BSD in-place suffix argument
        continue
      } else if (arg.startsWith("-")) {
        continue
      }
    }
    if (!haveScript && arg !== "") {
      scripts.push(arg)
      haveScript = true
    }
  }
  return scripts
}

/** Write targets of a sed script: `w file`, `W file`, the `s/…/…/w file` flag, and their blankless forms. */
function sedWriteTargets(cmd, args) {
  if (cmd !== "sed") return []
  const targets = new Set()
  for (const script of sedScriptArgs(args)) {
    if (typeof script !== "string") continue
    const { writeTargets, literalSpans } = sedScriptScan(script)
    for (const target of writeTargets) targets.add(target)
    for (const m of script.matchAll(SED_WRITE_TARGET_RE)) {
      if (inSedLiteralSpan(literalSpans, m.index, m.index + m[0].length)) continue
      const target = m[1].replace(/\s+$/, "")
      if (target) targets.add(target)
    }
  }
  return [...targets]
}

/** Read targets of a sed script: `r file`, `R file`, and their blankless forms (`r.env`). */
function sedReadTargets(args) {
  const targets = new Set()
  for (const script of sedScriptArgs(args)) {
    if (typeof script !== "string") continue
    const { readTargets, literalSpans } = sedScriptScan(script)
    for (const target of readTargets) targets.add(target)
    for (const m of script.matchAll(SED_READ_TARGET_RE)) {
      if (inSedLiteralSpan(literalSpans, m.index, m.index + m[0].length)) continue
      const target = m[1].replace(/\s+$/, "")
      if (target) targets.add(target)
    }
  }
  return [...targets]
}

function downloadWritePaths(cmd, args) {
  const paths = []
  const addPath = (value) => {
    if (typeof value === "string" && value && value !== "-") paths.push(value)
  }
  if (cmd === "curl") {
    let outputDir = null
    let remoteName = false
    let stdout = false
    for (let k = 0; k < args.length; k++) {
      const arg = args[k]
      if (["-O", "--remote-name", "--remote-name-all"].includes(arg)) remoteName = true
      else if (arg === "--output-dir") outputDir = args[++k]
      else if (arg.startsWith("--output-dir=")) outputDir = arg.slice("--output-dir=".length)
      else if (["-o", "--output", "-D", "--dump-header", "-c", "--cookie-jar"].includes(arg)) {
        const value = args[++k]
        if (value === "-") stdout = true
        else addPath(value)
      } else if (["--output", "--dump-header", "--cookie-jar"].some((flag) => arg.startsWith(`${flag}=`))) {
        const value = arg.slice(arg.indexOf("=") + 1)
        if (value === "-") stdout = true
        else addPath(value)
      } else if (/^-[oDc].+/.test(arg)) {
        const value = arg.slice(2)
        if (value === "-") stdout = true
        else addPath(value)
      }
    }
    if (remoteName) addPath(outputDir || ".")
    else if (outputDir && !stdout) addPath(outputDir)
  } else if (cmd === "wget") {
    let outputDocument
    let directoryPrefix = null
    let hasOutputDocument = false
    const spider = args.includes("--spider")
    for (let k = 0; k < args.length; k++) {
      const arg = args[k]
      if (["-O", "--output-document"].includes(arg)) {
        hasOutputDocument = true
        outputDocument = args[++k]
      } else if (arg.startsWith("--output-document=")) {
        hasOutputDocument = true
        outputDocument = arg.slice("--output-document=".length)
      } else if (arg.startsWith("--directory-prefix=")) {
        directoryPrefix = arg.slice("--directory-prefix=".length)
      } else if (arg === "-P" || arg === "--directory-prefix") {
        directoryPrefix = args[++k]
      } else if (arg.startsWith("-") && !arg.startsWith("--") && /[OP]/.test(arg.slice(1))) {
        const outputIndex = arg.indexOf("O", 1)
        const prefixIndex = arg.indexOf("P", 1)
        if (outputIndex >= 0) {
          hasOutputDocument = true
          outputDocument = arg.slice(outputIndex + 1) || args[++k]
        } else if (prefixIndex >= 0) {
          directoryPrefix = arg.slice(prefixIndex + 1) || args[++k]
        }
      }
    }
    if (hasOutputDocument) {
      if (outputDocument !== "-") addPath(directoryPrefix && outputDocument ? path.join(directoryPrefix, outputDocument || "") : outputDocument)
    } else if (!spider && args.some((arg) => /^https?:\/\//i.test(arg) || /^ftp:\/\//i.test(arg))) {
      addPath(directoryPrefix || ".")
    }
  }
  return paths
}

function curlToStdout(args) {
  return args.some((arg, i) => ["-o", "--output", "-D", "--dump-header", "-c", "--cookie-jar"].includes(arg) && args[i + 1] === "-"
    || ["--output=-", "--dump-header=-", "--cookie-jar=-", "-o-", "-D-", "-c-"].includes(arg))
}

function wgetToStdout(args) {
  return args.some((arg, i) => arg === "-O" && args[i + 1] === "-"
    || arg === "--output-document" && args[i + 1] === "-"
    || arg === "--output-document=-"
    || /^-[a-zA-Z]*O-$/.test(arg))
}

function tarExtracts(args) {
  return args.some((arg) => arg === "--extract" || arg === "--get"
    || (!arg.startsWith("--") && /^-[a-zA-Z]*x[a-zA-Z]*$/.test(arg)))
}

function tarToStdout(args) {
  return args.some((arg) => arg === "--to-stdout"
    || (!arg.startsWith("--") && /^-[a-zA-Z]*O[a-zA-Z]*$/.test(arg)))
}

function tarLists(args) {
  return args.some((arg) => arg === "--list" || (!arg.startsWith("--") && /^-[a-zA-Z]*t[a-zA-Z]*$/.test(arg)))
}

function unzipStreamsOrLists(args) {
  return args.some((arg) => ["-l", "-t", "-p", "-c", "-Z"].includes(arg)
    || /^-[a-zA-Z]*[ltpc][a-zA-Z]*$/.test(arg)
    || /^-Z/.test(arg))
}

function readOnlyStdoutCommand(cmd, args, cwd) {
  if (["curl", "wget", "tar", "unzip", "tee"].includes(cmd)
    && segmentWritePaths([cmd, ...args], cwd).rawPaths.length) return false
  if (cmd === "curl") return curlToStdout(args)
  if (cmd === "wget") return wgetToStdout(args) || args.includes("--spider")
  if (cmd === "tee") return nonFlags(args).length === 0
  if (cmd === "tar") return tarToStdout(args) || tarLists(args)
  if (cmd === "unzip") return unzipStreamsOrLists(args)
  return false
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
      rawPaths.push(...downloadWritePaths(cmd, args))
      break
    case "wget":
      rawPaths.push(...downloadWritePaths(cmd, args))
      break
    case "tar":
      if (tarExtracts(args) && !tarToStdout(args)) {
        const directories = []
        for (let k = 0; k < args.length; k++) {
          if (args[k] === "-C" || args[k] === "--directory") directories.push(args[++k])
          else if (args[k].startsWith("--directory=")) directories.push(args[k].slice("--directory=".length))
          else if (args[k].startsWith("-C") && args[k].length > 2) directories.push(args[k].slice(2))
        }
        rawPaths.push(...(directories.length ? directories : ["."]))
      }
      break
    case "unzip":
      if (!unzipStreamsOrLists(args)) {
        const directories = []
        for (let k = 0; k < args.length; k++) {
          if (args[k] === "-d") directories.push(args[++k])
          else if (args[k].startsWith("-d") && args[k].length > 2) directories.push(args[k].slice(2))
        }
        rawPaths.push(...(directories.length ? directories : ["."]))
      }
      break
    case "sed": case "perl":
      rawPaths.push(...inPlaceTargets(cmd, args), ...sedWriteTargets(cmd, args))
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

function isOutputDirectoryArg(cmd, args, target) {
  if (cmd === "curl") return args.some((arg, i) => arg === "--output-dir" && args[i + 1] === target || arg.startsWith("--output-dir=") && arg.slice("--output-dir=".length) === target)
  if (cmd === "wget") return args.some((arg, i) => ["-P", "--directory-prefix"].includes(arg) && args[i + 1] === target
    || arg.startsWith("--directory-prefix=") && arg.slice("--directory-prefix=".length) === target
    || arg.startsWith("-P") && arg.length > 2 && arg.slice(2) === target)
  if (cmd === "tar") return args.some((arg, i) => ["-C", "--directory"].includes(arg) && args[i + 1] === target
    || arg.startsWith("--directory=") && arg.slice("--directory=".length) === target
    || arg.startsWith("-C") && arg.length > 2 && arg.slice(2) === target)
  if (cmd === "unzip") return args.some((arg, i) => arg === "-d" && args[i + 1] === target
    || arg.startsWith("-d") && arg.length > 2 && arg.slice(2) === target)
  return false
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

/** Patch location allowed to post_session 'git apply': inside the repository, or a scratch directory. */
function isApplyPatchPath(arg, ctx) {
  if (typeof arg !== "string" || !arg || !ctx || !ctx.info || !ctx.info.top) return false
  if (arg.startsWith(":") || /[*?\[\]]/.test(arg)) return false
  const expanded = expandArg(arg, ctx)
  if (expanded.includes("$") || expanded.startsWith("~")) return false
  const abs = realpathLoose(path.resolve(ctx.cwd || ctx.info.top, expanded))
  const scratchPaths = [ctx.scratch, ctx.info.scratchDir, scratchDir(ctx.info), path.join(ctx.info.top, ".git", "opencode-scratch")]
    .filter(Boolean)
    .map(realpathLoose)
  if (scratchPaths.some((scratch) => isInside(scratch, abs))) return true
  if (ctx.info.gitDir && isInside(realpathLoose(ctx.info.gitDir), abs)) return false
  return isInside(realpathLoose(ctx.info.top), abs)
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
  if (["fetch", "mv", "rm", "add", "apply", "checkout", "restore", "commit", "pull", "merge", "rebase", "cherry-pick"].includes(sub)
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
       if (files.some((file) => isSecretEnvFile(file.replace(/^:\([^)]*\)/, "").replace(/^:\//, "")))) return "Guard: reading or accessing '.env' secret files is blocked."
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
      if (role === "post_session") return flags.length && flags.every((f) => f === "--staged" || f === "-S") && files.length && files.every((f) => isGitExplicitFile(f, gitCtx)) ? null : "git restore is only allowed with --staged and explicit file paths."
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
    case "apply": {
      if (role !== "post_session") return deny("apply")
      const flags = rest.filter((r) => r.startsWith("-") && r !== "--")
      const badFlag = flags.find((f) => f !== "--cached" && f !== "--check")
      if (badFlag) return `git apply flag '${badFlag}' is not permitted: post_session may only use --cached and --check.`
      if (!flags.includes("--cached")) return "git apply requires --cached."
      const files = gitFileArgs(rest)
      if (files.length !== 1) return "git apply requires exactly one explicit patch file (no stdin, pipes, or multiple files)."
      if (!isApplyPatchPath(files[0], gitCtx)) return `"${files[0]}" is not a permitted patch location: patches must be inside the repository or the scratch directory.`
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
  const envProblem = bareEnvProblem(tokens)
  if (envProblem) return envProblem
  const readOnly = READ_ONLY_BASH_ROLES.has(role)
  const t = stripWrappers(tokens, { preserveExec: readOnly })
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
  if (readOnly && inlineCodeInvocation(cmd, args)) {
    return `Guard: role '${role}' cannot execute inline interpreter code or builtins.`
  }
  if (readOnly && SHELLS.has(cmd)) {
    return `Guard: role '${role}' cannot invoke shells or shell scripts.`
  }
  if (readOnly && interpreterScriptInvocation(cmd, args)) {
    return `Guard: role '${role}' cannot execute interpreter script files.`
  }
  if (SHELLS.has(cmd)) {
    const subcmd = shellCommandArg(cmd, args)
    if (subcmd) return checkBash(subcmd, role, ctx, depth + 1)
  }
  if (NEVER.has(cmd)) return `${cmd} is not allowed.`
  const secretEnvErr = checkSecretEnvArgs(cmd, args, role)
  if (secretEnvErr) return secretEnvErr
  const readonlyWrite = WRITE_CMDS.has(cmd) && !readOnlyStdoutCommand(cmd, args, ctx?.cwd || ctx?.info?.top || process.cwd())
  if (READ_ONLY_BASH_ROLES.has(role) && (hasOutputRedirect(rawSeg) || readonlyWrite || inPlaceEdit(cmd, args)
    || (cmd === "find" && args.some((a) => /^-(?:exec|execdir|ok|okdir|delete|fprint0?|fls|fprintf)$/.test(a)))
    || (cmd === "fd" && args.some((a) => /^(?:-[xX]|--exec(?:-batch)?)(?:=|$)/.test(a)))
    || (cmd === "sort" && args.some((a) => /^(?:-o|--output)(?:=|$)/.test(a))))) {
    return `Guard: role '${role}' is read-only and cannot modify files.`
  }
  if (role === "ops" && cmd !== "git" && !isAllowedTemplateEnvCopy(cmd, args, role)) {
    const write = segmentWritePaths(tokens, ctx?.cwd || ctx?.info?.top || process.cwd())
    if (write.rawPaths.some((p) => isOpsRepositoryWritePath(p, ctx))) {
      return "Guard: role 'ops' cannot modify repository files; write temporary files to $PIPELINE_SCRATCH or /tmp."
    }
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
      paths.push(...downloadWritePaths(cmd, args))
      break
    case "wget":
      paths.push(...downloadWritePaths(cmd, args))
      break
    case "tar":
      for (let k = 0; k < args.length; k++) if (args[k] === "-C" || args[k] === "--directory") paths.push(args[k + 1])
      break
    case "unzip":
      for (let k = 0; k < args.length; k++) if (args[k] === "-d") paths.push(args[k + 1])
      break
    case "sed": case "perl":
      paths.push(...inPlaceTargets(cmd, args), ...sedWriteTargets(cmd, args))
      break
    default:
      break
  }
  for (const p of paths) {
    const probe = isOutputDirectoryArg(cmd, args, p) ? path.join(p, "__pipeline_output__") : p
    const reason = checkWritePath(probe, ctx)
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
      if (role === "ops" && isOpsRepositoryWritePath(target, segmentCtx)) {
        return "Guard: role 'ops' cannot modify repository files; write temporary files to $PIPELINE_SCRATCH or /tmp."
      }
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
      if (rel !== null) targets.add(rel || ".")
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
