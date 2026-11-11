import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { getExtension, loadExtension, runAfterExport, setExtension } from "./extensions.js"

function temporaryDirectory(t: test.TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "manager-extension-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test("a missing extension file is the normal case: no extension and no output", async (t) => {
  const directory = temporaryDirectory(t)
  const errors: string[] = []
  t.mock.method(console, "error", (message: string) => errors.push(message))
  setExtension(null)

  assert.equal(await loadExtension(path.join(directory, "extensions.js")), null)
  assert.equal(getExtension(), null)
  assert.deepEqual(errors, [])
})

test("loadExtension reads the default export and registers it", async (t) => {
  const directory = temporaryDirectory(t)
  t.after(() => setExtension(null))
  const file = path.join(directory, "extensions.mjs")
  fs.writeFileSync(file, `export default { commands: { hello: () => {} }, afterExport: () => ({ extras: { seen: true } }) }\n`)

  const extension = await loadExtension(file)

  assert.ok(extension)
  assert.equal(typeof extension.commands?.hello, "function")
  assert.equal(getExtension(), extension)
})

test("loadExtension accepts a named extension export", async (t) => {
  const directory = temporaryDirectory(t)
  t.after(() => setExtension(null))
  const file = path.join(directory, "named.mjs")
  fs.writeFileSync(file, `export const extension = { commands: {} }\n`)

  assert.ok(await loadExtension(file))
})

test("a broken or invalid extension is reported once and ignored", async (t) => {
  const directory = temporaryDirectory(t)
  const errors: string[] = []
  t.mock.method(console, "error", (message: string) => errors.push(message))
  setExtension(null)
  const broken = path.join(directory, "broken.mjs")
  const invalid = path.join(directory, "invalid.mjs")
  fs.writeFileSync(broken, `throw new Error("boom")\n`)
  fs.writeFileSync(invalid, `export default { afterExport: "not a function" }\n`)

  assert.equal(await loadExtension(broken), null)
  assert.equal(await loadExtension(invalid), null)
  assert.equal(getExtension(), null)
  assert.equal(errors.length, 2)
  assert.match(errors[0]!, /boom/)
  assert.match(errors[1]!, /valid manager extension/)
})

test("runAfterExport returns extras and sanitized warnings, and never throws", () => {
  const context = { destinationPath: "/tmp/agents", exported: ["a.md"], agents: [], options: {} }

  assert.deepEqual(runAfterExport(undefined, context), { warnings: [] })
  assert.deepEqual(runAfterExport(() => {}, context), { warnings: [] })
  assert.deepEqual(
    runAfterExport(() => ({ extras: { version: "v1" }, warnings: ["careful\u001b[31m"] }), context).extras,
    { version: "v1" }
  )
  const warnings = runAfterExport(() => ({ warnings: ["careful\u001b[31m"] }), context).warnings
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]!.includes("\u001b"), false)
  const failed = runAfterExport(() => { throw new Error("disk full") }, context)
  assert.equal(failed.warnings.length, 1)
  assert.match(failed.warnings[0]!, /afterExport failed: disk full/)
})
