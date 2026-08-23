import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { assertInsideRealWorkspace, realpathThroughExistingAncestor } from "./pathValidation.js"

test("realpathThroughExistingAncestor resolves through symlinks when the leaf is missing", () => {
  // os.tmpdir() sits behind a symlink on macOS (/var -> /private/var), so the
  // resolved tail must hang off the real temp root, not the literal one.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "path-validation-"))
  const missingLeaf = path.join(root, "bridges", "codex", "decent-pipeline")
  assert.ok(!fs.existsSync(missingLeaf))
  assert.equal(
    realpathThroughExistingAncestor(missingLeaf),
    path.join(fs.realpathSync(root), "bridges", "codex", "decent-pipeline")
  )
})

test("assertInsideRealWorkspace accepts paths inside the workspace including the root itself", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "path-validation-"))
  const realRoot = fs.realpathSync(root)
  assert.doesNotThrow(() => assertInsideRealWorkspace(root, path.join(realRoot, "bridges", "out"), path.join(root, "bridges", "out")))
  assert.doesNotThrow(() => assertInsideRealWorkspace(root, realRoot, root))
})

test("assertInsideRealWorkspace rejects sibling directories with the canonical message", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "path-validation-"))
  const root = path.join(parent, "workspace")
  fs.mkdirSync(root)
  const sibling = path.join(parent, "sibling")
  assert.throws(
    () => assertInsideRealWorkspace(root, sibling, sibling),
    (error: any) => error.message === `Invalid plugin output path outside workspace: ${sibling}`
  )
})
