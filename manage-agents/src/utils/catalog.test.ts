import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { tempDir, writePack } from "../../test/helpers.js"
import { packDir, packsDir, readManifest, resolvePackClosure } from "./catalog.js"

function catalog(t: test.TestContext, packs: Record<string, Record<string, string>>) {
  const root = tempDir(t, "catalog-")
  for (const [name, requires] of Object.entries(packs)) writePack(path.join(root, "packs", name), {}, { name, requires })
  return root
}

test("packDir finds packs/<name> in a catalog and null for packs that are not there", (t) => {
  const root = catalog(t, { alpha: {}, beta: {} })
  fs.mkdirSync(path.join(root, "packs", "no-manifest"), { recursive: true })

  assert.equal(packsDir(root), path.join(root, "packs"))
  assert.equal(packDir(root, "alpha"), path.join(root, "packs", "alpha"))
  assert.equal(packDir(root, "beta"), path.join(root, "packs", "beta"))
  assert.equal(packDir(root, "gamma"), null)
  assert.equal(packDir(root, "no-manifest"), null)
  assert.equal(readManifest(packDir(root, "alpha")!).name, "alpha")
})

test("packDir in a single pack matches only the manifest name, never a nested packs/ directory", (t) => {
  const root = writePack(tempDir(t, "catalog-single-"), {}, { name: "solo" })
  writePack(path.join(root, "packs", "inner"), {}, { name: "inner" })

  assert.equal(packDir(root, "solo"), root)
  assert.equal(packDir(root, "inner"), null)
  assert.equal(packDir(root, "other"), null)
})

test("packDir rejects names that are not pack names before touching the filesystem", (t) => {
  const root = catalog(t, { alpha: {} })
  writePack(path.join(root, "outside"), {}, { name: "outside" })

  for (const name of ["", "../outside", "packs/alpha", "Alpha", "-alpha", "alpha-", "alpha_beta", ".", "..", `a${"b".repeat(64)}`]) {
    assert.equal(packDir(root, name), null, JSON.stringify(name))
  }
})

test("resolvePackClosure lists the dependencies first, depth first in name order, each once", (t) => {
  const root = catalog(t, {
    app: { zeta: "*", mid: "*" },
    mid: { base: "*" },
    zeta: { base: "*" },
    base: {},
    unrelated: {}
  })

  assert.deepEqual(resolvePackClosure(root, "app"), ["base", "mid", "zeta", "app"])
  assert.deepEqual(resolvePackClosure(root, "mid"), ["base", "mid"])
  assert.deepEqual(resolvePackClosure(root, "base"), ["base"])
})

test("resolvePackClosure names the missing pack and the pack that requires it", (t) => {
  const root = catalog(t, { app: { mid: "*" }, mid: { ghost: "^1.0.0" } })

  assert.throws(() => resolvePackClosure(root, "app"), { message: "mid requires ghost, which is not in the catalog" })
  assert.throws(() => resolvePackClosure(root, "nope"), { message: "no pack nope in the catalog" })
})

test("resolvePackClosure reports dependency cycles, including self-reachable ones", (t) => {
  const root = catalog(t, { a: { b: "*" }, b: { c: "*" }, c: { a: "*" }, top: { a: "*" } })

  assert.throws(() => resolvePackClosure(root, "a"), /dependency cycle through a/)
  assert.throws(() => resolvePackClosure(root, "top"), /dependency cycle through a/)
})

test("resolvePackClosure of a single pack is the pack itself", (t) => {
  const root = writePack(tempDir(t, "catalog-single-"), {}, { name: "solo" })

  assert.deepEqual(resolvePackClosure(root, "solo"), ["solo"])
})

test("packDir refuses a pack directory that is a symlink", { skip: process.platform === "win32" }, (t) => {
  const root = catalog(t, {})
  const outside = writePack(tempDir(t, "catalog-outside-"), {}, { name: "linked" })
  fs.mkdirSync(path.join(root, "packs"), { recursive: true })
  fs.symlinkSync(outside, path.join(root, "packs", "linked"))

  assert.equal(packDir(root, "linked"), null)
})
