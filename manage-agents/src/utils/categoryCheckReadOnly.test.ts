import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

// Source-level contract: `category check` and `category status` compare the
// on-disk bundle with what the renderer would produce, but never persist it.
// `category build` is the only writer, so its branch is intentionally not
// scanned: a writer call there must not be reported.

const here = path.dirname(fileURLToPath(import.meta.url))
const cliPath = path.join(here, "..", "index.tsx")

/** Blank out comments and string literals while preserving offsets. */
function sanitize(source: string): string {
  let out = ""
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " "
        i++
      }
      continue
    }
    if (ch === "/" && next === "*") {
      out += "  "
      i += 2
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " "
        i++
      }
      if (i < source.length) {
        out += "  "
        i += 2
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      out += " "
      i++
      while (i < source.length) {
        if (source[i] === "\\") {
          out += "  "
          i += 2
          continue
        }
        const current = source[i]
        out += current === "\n" ? "\n" : " "
        i++
        if (current === ch) break
      }
      continue
    }
    out += ch
    i++
  }
  return out
}

function matchBrace(sanitized: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < sanitized.length; i++) {
    if (sanitized[i] === "{") depth++
    else if (sanitized[i] === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function matchParen(sanitized: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < sanitized.length; i++) {
    if (sanitized[i] === "(") depth++
    else if (sanitized[i] === ")") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Braced bodies of every `if (...)` whose condition dispatches on `actions`. */
function actionBodies(source: string, actions: string[]): string[] {
  const sanitized = sanitize(source)
  const bodies: string[] = []
  const pattern = /\bif\s*\(([^)]*)\)\s*\{/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    const condition = match[1]
    if (!/\baction\b/.test(condition)) continue
    if (!actions.some(action => new RegExp(`["'\`]${action}["'\`]`).test(condition))) continue
    const open = match.index + match[0].length - 1
    const close = matchBrace(sanitized, open)
    if (close < 0) continue
    bodies.push(source.slice(open + 1, close))
  }
  return bodies
}

function writerViolations(source: string): string[] {
  const violations: string[] = []
  const bodies = actionBodies(source, ["check", "status"])
  if (bodies.length === 0) {
    violations.push("index.tsx: no identifiable check/status branch; cannot verify the read-only path")
    return violations
  }
  for (const body of bodies) {
    const sanitized = sanitize(body)
    for (const writer of ["saveAgentFile", "writeFileSync"]) {
      if (new RegExp(`\\b${writer}\\s*\\(`).test(sanitized)) {
        violations.push(`check/status path calls ${writer}(...)`)
      }
    }
    const callPattern = /\brefreshPipelines\s*\(/g
    let call: RegExpExecArray | null
    while ((call = callPattern.exec(sanitized)) !== null) {
      const open = call.index + call[0].length - 1
      const close = matchParen(sanitized, open)
      const args = close < 0 ? "" : body.slice(open + 1, close).trim()
      if (!/dry[-_]?run/i.test(args)) {
        violations.push(`check/status path calls refreshPipelines(${args}) without a dry-run flag`)
      }
    }
  }
  return violations
}

test("category check/status branch never reaches a writer", () => {
  assert.deepEqual(writerViolations(readFileSync(cliPath, "utf8")), [])
})

test("category check/status still compares the bundle against the renderer", () => {
  const bodies = actionBodies(readFileSync(cliPath, "utf8"), ["check", "status"])
  assert.equal(bodies.length, 1)
  assert.match(sanitize(bodies[0]), /refreshPipelines\s*\([^)]*dry[-_]?run/i)
})

test("the writer scan reports an unguarded check branch and ignores build", () => {
  const build = `if (parsed.action === "build") {\n  refreshPipelines(id)\n  saveAgentFile(file, frontmatter, body)\n}`
  const unguarded = `${build}\nif (parsed.action === "check" || parsed.action === "status") {\n  refreshPipelines(id)\n  saveAgentFile(file, frontmatter, body)\n}`
  assert.deepEqual(writerViolations(unguarded), [
    "check/status path calls saveAgentFile(...)",
    "check/status path calls refreshPipelines(id) without a dry-run flag",
  ])
  const dry = `${build}\nif (parsed.action === "check" || parsed.action === "status") {\n  refreshPipelines(id, { dryRun: true })\n}`
  assert.deepEqual(writerViolations(dry), [])
})
