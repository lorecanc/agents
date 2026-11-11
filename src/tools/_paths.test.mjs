import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { configRootOf } from "./_paths.js"

test("the config root is the parent of the nearest tools/ directory, flat or namespaced", () => {
  const root = path.join(path.sep, "home", "u", ".config", "opencode")
  assert.equal(configRootOf(path.join(root, "tools")), root)
  assert.equal(configRootOf(path.join(root, "tools", "office-tools")), root)
  assert.equal(configRootOf(path.join(path.sep, "elsewhere", "dir")), path.join(path.sep, "elsewhere"))
})
