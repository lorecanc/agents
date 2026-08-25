import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { extractFrontmatter, getExportDestination, isInGeneralAgents, parseAgentFile, saveAgentFile, repairAgentModels, forkCategory } from "./agents.js"

function fixtureAgent(filePath: string, workspace: string, model: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const frontmatter: any = { description: "x" }
  if (model !== undefined) frontmatter.model = model
  saveAgentFile(filePath, frontmatter, "body")
  return parseAgentFile(filePath, workspace)!
}

test("grouped model repair validates all groups and applies one old value to N agents", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-repair-"))
  const a = fixtureAgent(path.join(workspace, "general/agents/a.md"), workspace, "bad/model")
  const b = fixtureAgent(path.join(workspace, "general/agents/b.md"), workspace, "bad/model")
  const c = fixtureAgent(path.join(workspace, "general/agents/c.md"), workspace, "other/model")
  const result = repairAgentModels([a, b, c], [
    { oldModel: "bad/model", newModel: "real/one", agentPaths: [a.currentPath, b.currentPath] },
    { oldModel: "other/model", newModel: "real/two", agentPaths: [c.currentPath] }
  ], ["real/one", "real/two"])
  assert.deepEqual(result, { groups: 2, agentsChanged: 3 })
  assert.equal(parseAgentFile(a.currentPath, workspace)!.model, "real/one")
})

test("grouped repair synchronizes raw content for an immediate second repair", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-repair-"))
  const agent = fixtureAgent(path.join(workspace, "general/agents/a.md"), workspace, "bad/model")
  const mappings = [{ oldModel: "bad/model", newModel: "real/one", agentPaths: [agent.currentPath] }]

  repairAgentModels([agent], mappings, ["real/one", "real/two"])
  assert.equal(agent.rawContent, fs.readFileSync(agent.currentPath, "utf8"))

  repairAgentModels([agent], [{ oldModel: "real/one", newModel: "real/two", agentPaths: [agent.currentPath] }], ["real/one", "real/two"])
  assert.equal(agent.rawContent, fs.readFileSync(agent.currentPath, "utf8"))
})

test("grouped repair rejects invented or stale values before writing", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-repair-"))
  const a = fixtureAgent(path.join(workspace, "general/agents/a.md"), workspace, "bad/model")
  const b = fixtureAgent(path.join(workspace, "general/agents/b.md"), workspace, "bad/model")
  const original = fs.readFileSync(a.currentPath, "utf8")
  assert.throws(() => repairAgentModels([a, b], [{ oldModel: "bad/model", newModel: "made/up", agentPaths: [a.currentPath, b.currentPath] }], ["real/one"]))
  fs.writeFileSync(b.currentPath, fs.readFileSync(b.currentPath, "utf8").replace("bad/model", "changed/model"))
  assert.throws(() => repairAgentModels([a, b], [{ oldModel: "bad/model", newModel: "real/one", agentPaths: [a.currentPath, b.currentPath] }], ["real/one"]))
  assert.equal(fs.readFileSync(a.currentPath, "utf8"), original)
})

test("grouped repair rejects body changes with an unchanged model before writing", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-repair-"))
  const a = fixtureAgent(path.join(workspace, "general/agents/a.md"), workspace, "bad/model")
  const b = fixtureAgent(path.join(workspace, "general/agents/b.md"), workspace, "bad/model")
  const originalB = fs.readFileSync(b.currentPath)
  const originalAModel = a.model
  const originalAFrontmatter = a.frontmatter
  const originalARawContent = a.rawContent
  fs.writeFileSync(a.currentPath, fs.readFileSync(a.currentPath, "utf8").replace("body", "new body"))
  const changedA = fs.readFileSync(a.currentPath)

  assert.throws(() => repairAgentModels([a, b], [
    { oldModel: "bad/model", newModel: "real/one", agentPaths: [a.currentPath, b.currentPath] }
  ], ["real/one"]))

  assert.deepEqual(fs.readFileSync(a.currentPath), changedA)
  assert.deepEqual(fs.readFileSync(b.currentPath), originalB)
  assert.equal(a.model, originalAModel)
  assert.strictEqual(a.frontmatter, originalAFrontmatter)
  assert.equal(a.rawContent, originalARawContent)
})

test("grouped repair rolls back a writer that changes a file before throwing", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-repair-"))
  const agent = fixtureAgent(path.join(workspace, "general/agents/a.md"), workspace, "bad/model")
  const originalBytes = fs.readFileSync(agent.currentPath)
  const originalFrontmatter = agent.frontmatter
  const originalRawContent = agent.rawContent
  assert.throws(() => repairAgentModels([agent], [
    { oldModel: "bad/model", newModel: "real/one", agentPaths: [agent.currentPath] }
  ], ["real/one"], (filePath, frontmatter, body) => {
    saveAgentFile(filePath, frontmatter, body)
    agent.model = "wrong/model"
    agent.frontmatter = { model: "wrong/model" }
    agent.rawContent = "wrong"
    throw new Error("writer failed")
  }), /writer failed; rollback completed/)
  assert.deepEqual(fs.readFileSync(agent.currentPath), originalBytes)
  assert.equal(agent.model, "bad/model")
  assert.strictEqual(agent.frontmatter, originalFrontmatter)
  assert.deepEqual(agent.frontmatter, { description: "x", model: "bad/model" })
  assert.equal(agent.rawContent, originalRawContent)
})

test("grouped repair rolls back all attempted files and memory after a later writer fails", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-repair-"))
  const a = fixtureAgent(path.join(workspace, "general/agents/a.md"), workspace, "bad/model")
  const b = fixtureAgent(path.join(workspace, "general/agents/b.md"), workspace, "other/model")
  const originalA = fs.readFileSync(a.currentPath)
  const originalB = fs.readFileSync(b.currentPath)
  const originalAFrontmatter = a.frontmatter
  const originalBFrontmatter = b.frontmatter
  assert.throws(() => repairAgentModels([a, b], [
    { oldModel: "bad/model", newModel: "real/one", agentPaths: [a.currentPath] },
    { oldModel: "other/model", newModel: "real/two", agentPaths: [b.currentPath] }
  ], ["real/one", "real/two"], (filePath, frontmatter, body) => {
    saveAgentFile(filePath, frontmatter, body)
    if (filePath === b.currentPath) throw new Error("second writer failed")
  }), /second writer failed; rollback completed/)
  assert.deepEqual(fs.readFileSync(a.currentPath), originalA)
  assert.deepEqual(fs.readFileSync(b.currentPath), originalB)
  assert.equal(a.model, "bad/model")
  assert.equal(b.model, "other/model")
  assert.strictEqual(a.frontmatter, originalAFrontmatter)
  assert.strictEqual(b.frontmatter, originalBFrontmatter)
})

test("grouped repair continues disk rollback after one restore fails", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-repair-"))
  const a = fixtureAgent(path.join(workspace, "general/agents/a.md"), workspace, "bad/model")
  const b = fixtureAgent(path.join(workspace, "general/agents/b.md"), workspace, "other/model")
  const originalA = fs.readFileSync(a.currentPath)
  const originalB = fs.readFileSync(b.currentPath)
  const writeFileSync = fs.writeFileSync
  t.mock.method(fs, "writeFileSync", function (filePath: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, ...args: any[]) {
    if (filePath === a.currentPath && Buffer.isBuffer(data)) throw new Error("restore a failed")
    return writeFileSync.call(fs, filePath, data, ...args)
  })
  assert.throws(() => repairAgentModels([a, b], [
    { oldModel: "bad/model", newModel: "real/one", agentPaths: [a.currentPath] },
    { oldModel: "other/model", newModel: "real/two", agentPaths: [b.currentPath] }
  ], ["real/one", "real/two"], (filePath, frontmatter, body) => {
    saveAgentFile(filePath, frontmatter, body)
    if (filePath === b.currentPath) throw new Error("writer failed")
  }), /rollback incomplete: .*restore a failed/)
  assert.notDeepEqual(fs.readFileSync(a.currentPath), originalA)
  assert.deepEqual(fs.readFileSync(b.currentPath), originalB)
  assert.equal(a.model, "bad/model")
  assert.equal(b.model, "other/model")
})

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
