import assert from "node:assert/strict"
import test from "node:test"
import {
  isLocalServer,
  isServerDisabled,
  normalizeMcpConfig,
  readMcpServerNames,
  readMcpServers,
  setServerDisabled
} from "./opencodeMcp.js"

test("readMcpServers reads the V2 mcp.servers shape", () => {
  const servers = { fs: { type: "local", command: ["mcp-fs"] } }
  assert.deepEqual(readMcpServers({ mcp: { servers } }), servers)
})

test("readMcpServers reads the V1 flat mcp shape without the servers key", () => {
  const config = {
    mcp: {
      servers: "legacy marker",
      fs: { type: "local", command: ["mcp-fs"] },
      web: { type: "remote", url: "https://example.test/mcp" }
    }
  }
  assert.deepEqual(readMcpServers(config), {
    fs: { type: "local", command: ["mcp-fs"] },
    web: { type: "remote", url: "https://example.test/mcp" }
  })
})

test("readMcpServers prefers V2 mcp.servers when both shapes exist", () => {
  const config = { mcp: { v1: { type: "local" }, servers: { v2: { type: "local" } } } }
  assert.deepEqual(readMcpServers(config), { v2: { type: "local" } })
})

test("readMcpServers returns an empty object when mcp is missing or not an object", () => {
  assert.deepEqual(readMcpServers({}), {})
  assert.deepEqual(readMcpServers({ mcp: null }), {})
  assert.deepEqual(readMcpServers({ mcp: "nope" }), {})
})

test("isServerDisabled treats disabled:true and enabled:false as disabled", () => {
  assert.equal(isServerDisabled({ disabled: true }), true)
  assert.equal(isServerDisabled({ enabled: false }), true)
})

test("isServerDisabled treats a missing flag as enabled", () => {
  assert.equal(isServerDisabled({ type: "local" }), false)
  assert.equal(isServerDisabled({ disabled: false }), false)
  assert.equal(isServerDisabled({ enabled: true }), false)
})

test("setServerDisabled(true) emits only disabled:true and keeps unknown fields", () => {
  const server = { type: "local", command: ["mcp-fs"], enabled: true, codemode: true }
  assert.deepEqual(setServerDisabled(server, true), {
    type: "local",
    command: ["mcp-fs"],
    codemode: true,
    disabled: true
  })
})

test("setServerDisabled(false) removes disabled and never emits enabled", () => {
  const server = { type: "local", command: ["mcp-fs"], enabled: true, disabled: true }
  const next = setServerDisabled(server, false)
  assert.deepEqual(next, { type: "local", command: ["mcp-fs"] })
  assert.ok(!("enabled" in next))
  assert.ok(!("disabled" in next))
})

test("normalizeMcpConfig builds mcp.servers and is idempotent", () => {
  const config = {
    $schema: "https://opencode.ai/config.json",
    mcp: { fs: { type: "local", command: ["mcp-fs"], enabled: false } }
  }
  const once = normalizeMcpConfig(config)
  assert.deepEqual(once, {
    $schema: "https://opencode.ai/config.json",
    mcp: { servers: { fs: { type: "local", command: ["mcp-fs"], enabled: false } } }
  })
  assert.deepEqual(normalizeMcpConfig(once), once)
})

test("normalizeMcpConfig preserves non-MCP top-level keys and unknown server fields", () => {
  const config = {
    plugins: ["one", "two"],
    permission: { edit: "ask" },
    mcp: { fs: { type: "local", command: ["mcp-fs"], custom: { retries: 3 } } }
  }
  const normalized = normalizeMcpConfig(config)
  assert.deepEqual(normalized.plugins, ["one", "two"])
  assert.deepEqual(normalized.permission, { edit: "ask" })
  assert.deepEqual(normalized.mcp.servers.fs, { type: "local", command: ["mcp-fs"], custom: { retries: 3 } })
})

test("accessors and writers do not mutate their input", () => {
  const config = { mcp: { fs: { type: "local", enabled: true } } }
  readMcpServers(config)
  readMcpServerNames(config)
  const normalized = normalizeMcpConfig(config)
  const toggled = setServerDisabled(config.mcp.fs, true)
  assert.notEqual(normalized, config)
  assert.notEqual(toggled, config.mcp.fs)
  assert.notEqual(normalized.mcp.servers, config.mcp)
  assert.deepEqual(config, { mcp: { fs: { type: "local", enabled: true } } })
})

test("isLocalServer and readMcpServerNames expose type and sorted names", () => {
  const config = { mcp: { servers: { web: { type: "remote" }, fs: { type: "local" } } } }
  assert.equal(isLocalServer({ type: "local" }), true)
  assert.equal(isLocalServer({ type: "remote" }), false)
  assert.deepEqual(readMcpServerNames(config), ["fs", "web"])
})
