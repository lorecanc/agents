import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import { REPO_ROOT, SNAPSHOT, exportToTemp, inventory } from "./inventory.js"

test("global export keeps the frozen structure: files, IDs and config entries", (t) => {
  const exported = exportToTemp(REPO_ROOT)
  t.after(exported.cleanup)
  const expected = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")).structure

  assert.deepEqual(inventory(exported.configDir).structure, expected)
})
