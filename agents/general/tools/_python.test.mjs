import assert from "node:assert/strict"
import { test } from "node:test"
import { resolvePythonPath } from "./_python.js"

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
  const p = resolvePythonPath({
    platform: "linux",
    exists: (candidate) => candidate.endsWith("bin/python3"),
    venvRoot: "/workspace/venv"
  })
  assert.equal(p, "/workspace/venv/bin/python3")
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
  assert.deepEqual(probed, ["/workspace/venv/bin/python3"])
})
