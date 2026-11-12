import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { resolvePythonPath } from "./_python.js"

// Tests inject a posix platform but may run on a Windows host, where
// path.join composes backslash separators; normalize before comparing.
const toPosix = (p) => p.split(path.sep).join("/")

test("win32 finds the venv interpreter at Scripts/python.exe", () => {
  const probed = []
  const p = resolvePythonPath({
    platform: "win32",
    exists: (candidate) => {
      probed.push(candidate)
      return true
    },
    venvRoot: "C:\\workspace\\venv"
  })
  assert.match(p, /Scripts[/\\]python\.exe$/)
  assert.ok(p.startsWith("C:\\workspace\\venv"))
  assert.deepEqual(probed, [p])
})

test("win32 without a venv falls back to python3", () => {
  const p = resolvePythonPath({
    platform: "win32",
    exists: () => false,
    venvRoot: "C:\\workspace\\venv"
  })
  assert.equal(p, "python3")
})

test("posix finds the venv interpreter at bin/python3", () => {
  const venvRoot = "/workspace/venv"
  const venvPython = path.join(venvRoot, "bin", "python3")
  const p = resolvePythonPath({
    platform: "linux",
    exists: (candidate) => candidate === venvPython,
    venvRoot
  })
  assert.equal(p, venvPython)
})

test("posix ignores a Scripts-only venv layout", () => {
  const probed = []
  const p = resolvePythonPath({
    platform: "darwin",
    exists: (candidate) => {
      probed.push(candidate)
      return false
    },
    venvRoot: "/workspace/venv"
  })
  assert.equal(p, "python3")
  assert.deepEqual(probed.map(toPosix), ["/workspace/venv/bin/python3"])
})
