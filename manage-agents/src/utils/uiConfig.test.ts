import test, { afterEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DEFAULT_UI_CONFIG, loadUiConfig } from "./uiConfig.js"

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

test("uses the default when UI config is missing and accepts valid custom shares", () => {
  const root = tempRoot()
  assert.deepEqual(loadUiConfig(root).config, DEFAULT_UI_CONFIG)
  fs.mkdirSync(path.join(root, ".agent-manager"))
  for (const listShare of [0.60, 0.75]) {
    fs.writeFileSync(path.join(root, ".agent-manager", "ui-config.json"), JSON.stringify({ version: 1, listShare }))
    assert.equal(loadUiConfig(root).config.listShare, listShare)
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
})
