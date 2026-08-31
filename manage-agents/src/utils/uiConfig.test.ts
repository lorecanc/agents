import test, { afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { DEFAULT_UI_CONFIG, loadUiConfig, MISSING_UI_CONFIG_REVISION, saveUiConfig } from "./uiConfig.js"

const roots: string[] = []
const originalOverride = process.env.AGENT_MANAGER_UI_CONFIG

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  if (originalOverride === undefined) delete process.env.AGENT_MANAGER_UI_CONFIG
  else process.env.AGENT_MANAGER_UI_CONFIG = originalOverride
})

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-manager-ui-"))
  roots.push(root)
  return root
}

function assertPosixMode(actual: number, expected: number) {
  if (process.platform !== "win32") assert.equal(actual, expected)
}

test("uses the default when UI config is missing and accepts valid custom shares", () => {
  const root = tempRoot()
   assert.deepEqual(loadUiConfig(root).config, DEFAULT_UI_CONFIG)
   assert.equal(loadUiConfig(root).source, "default")
   assert.equal(loadUiConfig(root).readOnly, false)
  fs.mkdirSync(path.join(root, ".agent-manager"))
  for (const listShare of [0.60, 0.75]) {
    fs.writeFileSync(path.join(root, ".agent-manager", "ui-config.json"), JSON.stringify({ version: 1, listShare }))
     const result = loadUiConfig(root)
     assert.equal(result.config.listShare, listShare)
     assert.equal(result.source, "workspace")
     assert.equal(result.readOnly, false)
  }
})

test("falls back safely for invalid config and honors the external path override", () => {
  const root = tempRoot()
  fs.mkdirSync(path.join(root, ".agent-manager"))
  fs.writeFileSync(path.join(root, ".agent-manager", "ui-config.json"), JSON.stringify({ version: 1, listShare: 0.9 }))
  assert.ok(loadUiConfig(root).warning)
  const external = path.join(root, "external.json")
  fs.writeFileSync(external, JSON.stringify({ version: 1, listShare: 0.60 }))
  const previous = process.env.AGENT_MANAGER_UI_CONFIG
  process.env.AGENT_MANAGER_UI_CONFIG = external
  try {
    assert.equal(loadUiConfig(root).config.listShare, 0.60)
  } finally {
    if (previous === undefined) delete process.env.AGENT_MANAGER_UI_CONFIG
    else process.env.AGENT_MANAGER_UI_CONFIG = previous
  }
})

test("warns and falls back for malformed, wrong-version, unsafe, and oversized configs", () => {
  const root = tempRoot()
  const configDir = path.join(root, ".agent-manager")
  fs.mkdirSync(configDir)
  const configPath = path.join(configDir, "ui-config.json")
  for (const content of ["{not json", JSON.stringify({ version: 2, listShare: 2 / 3 }), JSON.stringify({ version: 1, listShare: 0.59 }), JSON.stringify({ version: 1, listShare: 0.76 }), JSON.stringify({ version: 1, listShare: "0.60" })]) {
    fs.writeFileSync(configPath, content)
    const result = loadUiConfig(root)
    assert.deepEqual(result.config, DEFAULT_UI_CONFIG)
    assert.match(result.warning || "", /using defaults/)
  }
  fs.rmSync(configPath)
  fs.mkdirSync(configPath)
  assert.match(loadUiConfig(root).warning || "", /regular file/)
  fs.rmSync(configPath, { recursive: true })
  const target = path.join(root, "target.json")
  fs.writeFileSync(target, JSON.stringify({ version: 1, listShare: 0.6 }))
  fs.symlinkSync(target, configPath)
  assert.match(loadUiConfig(root).warning || "", /regular file/)
  fs.rmSync(configPath)
  fs.writeFileSync(configPath, "x".repeat(64 * 1024 + 1))
  assert.match(loadUiConfig(root).warning || "", /regular file/)
})

test("an external override takes precedence over the workspace config", () => {
  const root = tempRoot()
  fs.mkdirSync(path.join(root, ".agent-manager"))
  fs.writeFileSync(path.join(root, ".agent-manager", "ui-config.json"), JSON.stringify({ version: 1, listShare: 0.75 }))
  const external = path.join(root, "external.json")
  fs.writeFileSync(external, JSON.stringify({ version: 1, listShare: 0.6 }))
  process.env.AGENT_MANAGER_UI_CONFIG = external
  const result = loadUiConfig(root)
   assert.equal(result.config.listShare, 0.6)
   assert.equal(result.warning, undefined)
   assert.equal(result.source, "environment")
   assert.equal(result.readOnly, true)
})

test("creates and replaces a workspace config while preserving the target mode", () => {
  const root = tempRoot()
  saveUiConfig(root, 0.60)
  const configPath = path.join(root, ".agent-manager", "ui-config.json")
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), { version: 1, listShare: 0.6 })
  assertPosixMode(fs.statSync(configPath).mode & 0o777, 0o600)

  fs.chmodSync(configPath, 0o640)
  saveUiConfig(root, 0.75)
  assert.equal(loadUiConfig(root).config.listShare, 0.75)
  assertPosixMode(fs.statSync(configPath).mode & 0o777, 0o640)
  assert.equal(fs.readdirSync(path.dirname(configPath)).filter(name => name.startsWith(".ui-config.json.tmp-")).length, 0)
})

test("refuses invalid values, environment writes, and symlinked parents or targets", () => {
  const root = tempRoot()
  for (const value of [Number.NaN, Infinity, 0.59, 0.76]) assert.throws(() => saveUiConfig(root, value), /listShare/)

  const external = path.join(root, "external.json")
  fs.writeFileSync(external, JSON.stringify({ version: 1, listShare: 0.6 }))
  process.env.AGENT_MANAGER_UI_CONFIG = external
  assert.throws(() => saveUiConfig(root, 0.6), /read-only/)
  delete process.env.AGENT_MANAGER_UI_CONFIG

  const realDir = path.join(root, "real-manager")
  fs.mkdirSync(realDir)
  fs.symlinkSync(realDir, path.join(root, ".agent-manager"))
  assert.throws(() => saveUiConfig(root, 0.6), /real directory/)
  fs.unlinkSync(path.join(root, ".agent-manager"))

  fs.mkdirSync(path.join(root, ".agent-manager"))
  const target = path.join(root, "target.json")
  fs.writeFileSync(target, "old")
  fs.symlinkSync(target, path.join(root, ".agent-manager", "ui-config.json"))
  assert.throws(() => saveUiConfig(root, 0.6), /regular file/)
})

test("keeps the old config and cleans its temporary file when rename fails", () => {
  const root = tempRoot()
  const dir = path.join(root, ".agent-manager")
  fs.mkdirSync(dir)
  const target = path.join(dir, "ui-config.json")
  fs.writeFileSync(target, JSON.stringify({ version: 1, listShare: 0.6 }) + "\n")
  assert.throws(
    () => saveUiConfig(root, 0.75, { renameSync: () => { throw new Error("injected rename failure") } }),
    /injected rename failure/
  )
  assert.equal(fs.readFileSync(target, "utf8"), JSON.stringify({ version: 1, listShare: 0.6 }) + "\n")
  assert.equal(fs.readdirSync(dir).filter(name => name.startsWith(".ui-config.json.tmp-")).length, 0)
  assert.equal(fs.existsSync(path.join(dir, "ui-config.lock")), false)
})

test("does not replace a target created after the bounded read", () => {
  const root = tempRoot()
  const dir = path.join(root, ".agent-manager")
  fs.mkdirSync(dir)
  const target = path.join(dir, "ui-config.json")
  assert.throws(
    () => saveUiConfig(root, 0.75, { beforeRename: () => fs.writeFileSync(target, "external") }),
    /configuration target changed/
  )
  assert.equal(fs.readFileSync(target, "utf8"), "external")
  assert.equal(fs.readdirSync(dir).filter(name => name.startsWith(".ui-config.json.tmp-")).length, 0)
  assert.equal(fs.existsSync(path.join(dir, "ui-config.lock")), false)
})

test("does not recreate a target deleted after the bounded read", () => {
  const root = tempRoot()
  const dir = path.join(root, ".agent-manager")
  fs.mkdirSync(dir)
  const target = path.join(dir, "ui-config.json")
  fs.writeFileSync(target, "old")
  assert.throws(
    () => saveUiConfig(root, 0.75, { beforeRename: () => fs.unlinkSync(target) }),
    /configuration target changed/
  )
  assert.equal(fs.existsSync(target), false)
  assert.equal(fs.readdirSync(dir).filter(name => name.startsWith(".ui-config.json.tmp-")).length, 0)
  assert.equal(fs.existsSync(path.join(dir, "ui-config.lock")), false)
})

test("cleans a newly created lock when fstat fails", () => {
  const root = tempRoot()
  assert.throws(
    () => saveUiConfig(root, 0.60, { fstatSync: () => { throw new Error("injected fstat failure") } }),
    /injected fstat failure/
  )
  assert.equal(fs.existsSync(path.join(root, ".agent-manager", "ui-config.lock")), false)
})

test("exposes exact revisions for missing, valid, and malformed files", () => {
  const root = tempRoot()
  const missing = loadUiConfig(root)
  assert.equal(missing.revision, MISSING_UI_CONFIG_REVISION)
  fs.mkdirSync(path.join(root, ".agent-manager"))
  const configPath = path.join(root, ".agent-manager", "ui-config.json")
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, listShare: 0.6 }))
  const valid = loadUiConfig(root)
  assert.notEqual(valid.revision, MISSING_UI_CONFIG_REVISION)
  assert.equal(valid.revision, loadUiConfig(root).revision)
  fs.writeFileSync(configPath, "{malformed")
  const malformed = loadUiConfig(root)
  assert.equal(malformed.revision, requireHash(fs.readFileSync(configPath)))
  assert.ok(malformed.warning)
})

function requireHash(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

test("returns a new revision and rejects stale saves without changing newer bytes", () => {
  const root = tempRoot()
  const first = saveUiConfig(root, 0.60)
  const second = saveUiConfig(root, 0.75, first)
  const target = path.join(root, ".agent-manager", "ui-config.json")
  const bytes = fs.readFileSync(target)
  assert.notEqual(first, second)
  assert.throws(() => saveUiConfig(root, 0.65, first), /changed; reload and retry/)
  assert.deepEqual(fs.readFileSync(target), bytes)
})

test("honors pre-existing locks and cleans locks across sequential writers", () => {
  const root = tempRoot()
  const dir = path.join(root, ".agent-manager")
  fs.mkdirSync(dir)
  const lock = path.join(dir, "ui-config.lock")
  fs.writeFileSync(lock, "held")
  assert.throws(() => saveUiConfig(root, 0.60), /configuration is busy/)
  fs.unlinkSync(lock)
  const first = saveUiConfig(root, 0.60)
  assert.equal(fs.existsSync(lock), false)
  saveUiConfig(root, 0.61, first)
  assert.equal(fs.existsSync(lock), false)
})

test("preserves a lock replaced during rename", () => {
  const root = tempRoot()
  const dir = path.join(root, ".agent-manager")
  const lock = path.join(dir, "ui-config.lock")
  const replacement = Buffer.from("foreign lock")
  saveUiConfig(root, 0.60, {
    renameSync: (temporary, target) => {
      fs.unlinkSync(lock)
      fs.writeFileSync(lock, replacement)
      fs.renameSync(temporary, target)
    }
  })
  assert.deepEqual(fs.readFileSync(lock), replacement)
})

test("supports repeated save/reload and external read-only copies", () => {
  const root = tempRoot()
  let revision = saveUiConfig(root, 0.60)
  for (const value of [0.61, 0.62, 0.63]) {
    revision = saveUiConfig(root, value, revision)
    const restarted = loadUiConfig(root)
    assert.equal(restarted.config.listShare, value)
    assert.equal(restarted.revision, revision)
  }
  const external = path.join(root, "external.json")
  fs.copyFileSync(path.join(root, ".agent-manager", "ui-config.json"), external)
  process.env.AGENT_MANAGER_UI_CONFIG = external
  assert.equal(loadUiConfig(root).readOnly, true)
  assert.throws(() => saveUiConfig(root, 0.64), /read-only/)
})
