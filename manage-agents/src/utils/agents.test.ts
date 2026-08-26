import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import test from "node:test"
import { extractFrontmatter, getExportDestination, isInGeneralAgents, parseAgentFile, saveAgentFile, repairAgentModels, updateAgentsModel, forkCategory } from "./agents.js"
import { AUTO_COMMIT_MESSAGES, repositoryTransaction } from "./repositoryTransaction.js"

function fixtureAgent(filePath: string, workspace: string, model: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const frontmatter: any = { description: "x" }
  if (model !== undefined) frontmatter.model = model
  saveAgentFile(filePath, frontmatter, "body")
  return parseAgentFile(filePath, workspace)!
}

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
}

function gitAgentRepository() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-model-git-")))
  git(root, "init", "-q")
  git(root, "config", "user.name", "Test")
  git(root, "config", "user.email", "test@example.com")
  const paths = ["general/agents/one.md", "general/agents/two.md"].map(name => path.join(root, name))
  for (const [index, filePath] of paths.entries()) fixtureAgent(filePath, root, `old/model-${index}`)
  git(root, "add", ".")
  git(root, "commit", "-qm", "initial")
  return { root, paths }
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

test("model update applies atomically to two agents and synchronizes memory", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-update-"))
  const a = fixtureAgent(path.join(workspace, "general/agents/a.md"), workspace, "old/model")
  const b = fixtureAgent(path.join(workspace, "general/agents/b.md"), workspace, "old/model")

  updateAgentsModel([a, b], "new/model", ["new/model"])

  for (const agent of [a, b]) {
    assert.equal(agent.model, "new/model")
    assert.equal(agent.frontmatter.model, "new/model")
    assert.equal(agent.rawContent, fs.readFileSync(agent.currentPath, "utf8"))
    assert.equal(parseAgentFile(agent.currentPath, workspace)!.model, "new/model")
  }
})

test("model update uses one repository transaction for real agent files", () => {
  const { root, paths } = gitAgentRepository()
  const agents = paths.map(filePath => parseAgentFile(filePath, root)!)
  const head = git(root, "rev-parse", "HEAD")
  process.env.AGENT_MANAGER_AUTO_COMMIT = "1"

  const result = repositoryTransaction(root, paths, AUTO_COMMIT_MESSAGES.tune, () => {
    updateAgentsModel(agents, "verified/model", ["verified/model"])
  })

  assert.equal(result.commit, "committed")
  assert.ok(result.commitHash)
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "2")
  assert.notEqual(git(root, "rev-parse", "HEAD"), head)
  assert.equal(git(root, "show", "--format=", "--name-only", "HEAD"), "general/agents/one.md\ngeneral/agents/two.md")
  assert.equal(git(root, "status", "--porcelain"), "")
  for (const filePath of paths) assert.equal(parseAgentFile(filePath, root)!.model, "verified/model")
})

test("dirty unrelated work is preserved and model transaction does not stage it", () => {
  const { root, paths } = gitAgentRepository()
  const agents = paths.map(filePath => parseAgentFile(filePath, root)!)
  const unrelated = path.join(root, "unrelated.txt")
  fs.writeFileSync(unrelated, "keep dirty\n")
  process.env.AGENT_MANAGER_AUTO_COMMIT = "1"

  const result = repositoryTransaction(root, paths, AUTO_COMMIT_MESSAGES.tune, () => updateAgentsModel(agents, "verified/model", ["verified/model"]))

  assert.equal(result.commit, "skipped")
  assert.equal(result.warning?.code, "dirty-repository")
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "1")
  assert.equal(git(root, "diff", "--cached", "--name-only"), "")
  assert.equal(fs.readFileSync(unrelated, "utf8"), "keep dirty\n")
  for (const filePath of paths) assert.equal(parseAgentFile(filePath, root)!.model, "verified/model")
})

test("dirty auto-commit updates both real model files, skips with a warning, and does not stage them", () => {
  const { root, paths } = gitAgentRepository()
  const agents = paths.map(filePath => parseAgentFile(filePath, root)!)
  fs.writeFileSync(path.join(root, "unrelated.txt"), "pre-existing work\n")
  process.env.AGENT_MANAGER_AUTO_COMMIT = "1"

  const result = repositoryTransaction(root, paths, AUTO_COMMIT_MESSAGES.tune, () => {
    updateAgentsModel(agents, "verified/model", ["verified/model"])
  })

  assert.equal(result.commit, "skipped")
  assert.equal(result.warning?.code, "dirty-repository")
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "1")
  assert.equal(git(root, "diff", "--cached", "--name-only"), "")
  assert.match(git(root, "status", "--porcelain"), /unrelated\.txt/)
  for (const filePath of paths) assert.equal(parseAgentFile(filePath, root)!.model, "verified/model")
})

test("CLI auto-commit warnings are written to stderr only", () => {
  const { root } = gitAgentRepository()
  fs.writeFileSync(path.join(root, "unrelated.txt"), "dirty\n")
  const cli = spawnSync(process.execPath, [path.resolve("dist/index.js"), "tune", "--steps", "10"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, AGENT_MANAGER_AUTO_COMMIT: "1" }
  })

  assert.equal(cli.status, 0, cli.stderr)
  assert.match(cli.stderr, /AUTO-COMMIT WARNING:/)
  assert.doesNotMatch(cli.stdout, /AUTO-COMMIT WARNING:/)
})

test("index.lock failure returns a warning without throwing and keeps both model files", () => {
  const { root, paths } = gitAgentRepository()
  const agents = paths.map(filePath => parseAgentFile(filePath, root)!)
  process.env.AGENT_MANAGER_AUTO_COMMIT = "1"
  const indexLock = path.join(root, ".git", "index.lock")

  const result = repositoryTransaction(root, paths, AUTO_COMMIT_MESSAGES.tune, () => {
    updateAgentsModel(agents, "verified/model", ["verified/model"])
    fs.writeFileSync(indexLock, "held\n")
  })

  assert.equal(result.commit, "failed")
  assert.equal(result.warning?.code, "git-failure")
  for (const filePath of paths) assert.equal(parseAgentFile(filePath, root)!.model, "verified/model")
  assert.match(git(root, "status", "--porcelain"), /general\/agents\/(one|two)\.md/)
  fs.rmSync(indexLock)
})

test("model transaction stays dirty when auto-commit is disabled", () => {
  const { root, paths } = gitAgentRepository()
  const agents = paths.map(filePath => parseAgentFile(filePath, root)!)
  delete process.env.AGENT_MANAGER_AUTO_COMMIT

  const result = repositoryTransaction(root, paths, AUTO_COMMIT_MESSAGES.tune, () => updateAgentsModel(agents, "verified/model", ["verified/model"]))

  assert.equal(result.commit, "off")
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "1")
  assert.match(git(root, "status", "--porcelain"), /general\/agents\/(one|two)\.md/)
  for (const filePath of paths) assert.equal(parseAgentFile(filePath, root)!.model, "verified/model")
})

test("model update restores both raw files and in-memory agents when the second writer fails", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-update-"))
  const a = fixtureAgent(path.join(workspace, "general/agents/a.md"), workspace, "old/one")
  const b = fixtureAgent(path.join(workspace, "general/agents/b.md"), workspace, "old/two")
  const originals = [a, b].map(agent => ({ bytes: fs.readFileSync(agent.currentPath), model: agent.model, raw: agent.rawContent, frontmatter: agent.frontmatter }))
  let writes = 0

  assert.throws(() => updateAgentsModel([a, b], "new/model", ["new/model"], (filePath, frontmatter, body) => {
    writes += 1
    saveAgentFile(filePath, frontmatter, body)
    if (writes === 2) throw new Error("second writer failed")
  }), /second writer failed; rollback completed/)

  for (const [index, agent] of [a, b].entries()) {
    assert.deepEqual(fs.readFileSync(agent.currentPath), originals[index].bytes)
    assert.equal(agent.model, originals[index].model)
    assert.equal(agent.rawContent, originals[index].raw)
    assert.strictEqual(agent.frontmatter, originals[index].frontmatter)
  }
})

test("atomic agent writes preserve mode and clean temporary siblings", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-atomic-"))
  const filePath = path.join(workspace, "agent.md")
  fs.writeFileSync(filePath, "old\n")
  fs.chmodSync(filePath, 0o755)
  saveAgentFile(filePath, { description: "x" }, "new")
  assert.equal(fs.statSync(filePath).mode & 0o7777, 0o755)
  assert.deepEqual(fs.readdirSync(workspace).filter(name => name.endsWith(".tmp")), [])
})

test("rollback conflict preserves bytes changed after the manager write", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-rollback-conflict-"))
  const agent = fixtureAgent(path.join(workspace, "general/agents/a.md"), workspace, "old/model")
  const original = fs.readFileSync(agent.currentPath)
  assert.throws(() => updateAgentsModel([agent], "new/model", ["new/model"], (filePath, frontmatter, body) => {
    saveAgentFile(filePath, frontmatter, body)
    fs.writeFileSync(filePath, "external change\n")
    throw new Error("writer failed")
  }), /rollback incomplete: .*rollback conflict: file changed after manager write/)
  assert.notDeepEqual(fs.readFileSync(agent.currentPath), original)
  assert.equal(fs.readFileSync(agent.currentPath, "utf8"), "external change\n")
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
  const renameSync = fs.renameSync
  let renames = 0
  t.mock.method(fs, "renameSync", function (oldPath: fs.PathLike, newPath: fs.PathLike) {
    renames += 1
    if (newPath === a.currentPath && renames >= 4) throw new Error("restore a failed")
    return renameSync.call(fs, oldPath, newPath)
  })
  assert.throws(() => repairAgentModels([a, b], [
    { oldModel: "bad/model", newModel: "real/one", agentPaths: [a.currentPath] },
    { oldModel: "other/model", newModel: "real/two", agentPaths: [b.currentPath] }
  ], ["real/one", "real/two"], (filePath, frontmatter, body) => {
    saveAgentFile(filePath, frontmatter, body)
    if (filePath === b.currentPath) throw new Error("writer failed")
  }), /(rollback incomplete: .*restore a failed|restore a failed; rollback incomplete)/)
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
