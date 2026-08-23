import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { extractFrontmatter, getExportDestination, isInGeneralAgents, parseAgentFile, saveAgentFile } from "./agents.js"

test("agent save is idempotent and keeps one blank line after frontmatter", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-save-workspace-"))
  const filePath = path.join(workspace, "general", "agents", "example.md")
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, [
    "---",
    "description: Example agent",
    "model: example/model",
    "---",
    "",
    "",
    "",
    "# Example",
    "",
    "Agent instructions.",
    ""
  ].join("\n"))

  for (let pass = 0; pass < 2; pass += 1) {
    const agent = parseAgentFile(filePath, workspace)
    assert.ok(agent)
    saveAgentFile(filePath, agent.frontmatter, agent.body)
  }

  assert.equal(fs.readFileSync(filePath, "utf8"), [
    "---",
    "description: Example agent",
    "model: example/model",
    "---",
    "",
    "# Example",
    "",
    "Agent instructions.",
    ""
  ].join("\n"))
})

test("export destination always uses XDG_CONFIG_HOME, regardless of platform", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-destination-"))
  const xdg = path.join(root, "xdg")
  const expected = path.join(xdg, "opencode", "agents")
  assert.equal(getExportDestination({ XDG_CONFIG_HOME: xdg }), expected)
  assert.equal(getExportDestination({ XDG_CONFIG_HOME: xdg, APPDATA: path.join(root, "AppData") }), expected)
})

test("export destination treats an empty XDG_CONFIG_HOME as absent", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-destination-"))
  t.mock.method(os, "homedir", () => root)
  assert.equal(getExportDestination({ XDG_CONFIG_HOME: "" }), path.join(root, ".config", "opencode", "agents"))
})

test("export destination uses homedir when XDG_CONFIG_HOME is absent", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-destination-"))
  t.mock.method(os, "homedir", () => root)
  assert.equal(getExportDestination({}), path.join(root, ".config", "opencode", "agents"))
})

test("export destination does not depend on directory existence", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-destination-"))
  t.mock.method(os, "homedir", () => root)
  const expected = path.join(root, ".config", "opencode", "agents")
  assert.equal(getExportDestination({}), expected)
  fs.mkdirSync(expected, { recursive: true })
  assert.equal(getExportDestination({}), expected)
})

test("isInGeneralAgents accepts POSIX, Windows and mixed separators", () => {
  assert.equal(isInGeneralAgents("/w/general/agents/x.md"), true)
  assert.equal(isInGeneralAgents("C:\\repo\\general\\agents\\x.md"), true)
  assert.equal(isInGeneralAgents("/w/general\\agents/x.md"), true)
})

test("isInGeneralAgents rejects suffix traps and unrelated directories", () => {
  assert.equal(isInGeneralAgents("/w/general/agents-old/x.md"), false)
  assert.equal(isInGeneralAgents("/w/categories/pipeline/x.md"), false)
})

test("extractFrontmatter splits LF frontmatter from body", () => {
  const content = "---\ndescription: X\n---\n\nBody line\n"
  const { yamlText, body } = extractFrontmatter(content)
  assert.equal(yamlText, "description: X")
  assert.equal(body, "\nBody line\n")
})

test("extractFrontmatter tolerates CRLF line endings", () => {
  const content = "---\r\ndescription: X\r\n---\r\n\r\nBody\r\n"
  const { yamlText, body } = extractFrontmatter(content)
  assert.equal(yamlText, "description: X")
  assert.equal(body, "\r\nBody\r\n")
})

test("extractFrontmatter returns null yamlText when the closer is missing", () => {
  const content = "---\ndescription: X\nno closing fence"
  const { yamlText, body } = extractFrontmatter(content)
  assert.equal(yamlText, null)
  assert.equal(body, content)
})

test("extractFrontmatter returns null yamlText when text precedes the opening fence", () => {
  const content = "intro text\n---\ndescription: X\n---\nbody"
  const { yamlText, body } = extractFrontmatter(content)
  assert.equal(yamlText, null)
  assert.equal(body, content)
})

test("extractFrontmatter does not mis-split on a literal --- inside a YAML value", () => {
  const content = [
    "---",
    "description: Multi",
    "note: |",
    "  ---",
    "  still value",
    "---",
    "",
    "body"
  ].join("\n")
  const { yamlText, body } = extractFrontmatter(content)
  assert.equal(yamlText, "description: Multi\nnote: |\n  ---\n  still value")
  assert.equal(body, "\nbody")
})

test("extractFrontmatter keeps --- separators inside the body intact", () => {
  const content = "---\nkey: value\n---\n\npara\n\n---\n\nafter-hr\n"
  const { yamlText, body } = extractFrontmatter(content)
  assert.equal(yamlText, "key: value")
  assert.equal(body, "\npara\n\n---\n\nafter-hr\n")
})

test("parseAgentFile parses frontmatter fields from a CRLF agent file", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-crlf-"))
  const filePath = path.join(workspace, "general", "agents", "crlf-agent.md")
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, [
    "---",
    "description: CRLF agent",
    "model: crlf/model",
    "permission:",
    "  task:",
    '    "*": deny',
    "    helper_agent: allow",
    "---",
    "",
    "# CRLF Body"
  ].join("\r\n"))

  const parsed = parseAgentFile(filePath, workspace)
  assert.ok(parsed)
  assert.equal(parsed.description, "CRLF agent")
  assert.equal(parsed.model, "crlf/model")
  assert.deepEqual(parsed.allowedSubagents, ["helper_agent"])
  assert.match(parsed.body, /# CRLF Body/)
})
