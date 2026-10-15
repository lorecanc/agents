import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import test from "node:test"
import { extractFrontmatter, exportAgents, getExportDestination, isInGeneralAgents, parseAgentFile, saveAgentFile, repairAgentModels, updateAgentsModel, forkCategory, parseForkReplacements, compareCompanionResources, previewImport, importAgents, discoverAgentResources, updateAgentResourcesAndMcp, updateAgentParams, AGENT_EFFORT_VARIANTS } from "./agents.js"
import * as agentsMod from "./agents.js"
import { AUTO_COMMIT_MESSAGES, repositoryTransaction } from "./repositoryTransaction.js"
import { updateCategoryCompanionLinks } from "./companionLinks.js"

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

function assertPosixMode(actual: number, expected: number) {
  if (process.platform !== "win32") assert.equal(actual, expected)
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
  const cli = spawnSync(process.execPath, [path.resolve("manage-agents.mjs"), "tune", "--steps", "10"], {
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
  assertPosixMode(fs.statSync(filePath).mode & 0o7777, 0o755)
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

function forkWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fork-"))
  const source = [
    fixtureAgent(path.join(workspace, "general/agents/foo-one.md"), workspace, "source/one"),
    fixtureAgent(path.join(workspace, "general/agents/foo-two.md"), workspace, "source/two")
  ]
  return { workspace, source }
}

function backupDirectories(workspace: string) {
  const backups = path.join(workspace, "backups")
  return fs.existsSync(backups) ? fs.readdirSync(backups) : []
}

test("fork replacement parser keeps scalar compatibility for single and empty input", () => {
  assert.equal(parseForkReplacements("plain"), "plain")
  assert.equal(parseForkReplacements(""), "")
  assert.equal(parseForkReplacements("   "), "")
})

test("fork replacement parser parses unbracketed comma-separated targets", () => {
  assert.deepEqual(parseForkReplacements("go-, kimi-, hybrid-, free-"), ["go-", "kimi-", "hybrid-", "free-"])
  assert.deepEqual(parseForkReplacements("  one ,  two  , three  "), ["one", "two", "three"])
  assert.deepEqual(parseForkReplacements("  [ one, two ]  "), ["one", "two"])
})

test("fork replacement parser rejects malformed lists and duplicates", () => {
  for (const input of ["[one, two", "one, two]", "[]", "[one,[two]]"]) {
    assert.throws(() => parseForkReplacements(input), /matching outer brackets|malformed brackets|cannot be empty/)
  }
  for (const input of [",one", "one,", "one,,two", "[one, ]", "[ ,one]"]) {
    assert.throws(() => parseForkReplacements(input), /empty items/)
  }
  for (const input of ["one, one", "[one, one]", " one,  one "]) {
    assert.throws(() => parseForkReplacements(input), /duplicates/)
  }
})

test("fork rejects malformed parsed replacement input before mutation", () => {
  for (const input of ["[one, two", "one, two]", "[]", ",one", "one,", "one,,two", "one, one"]) {
    const { workspace } = forkWorkspace()
    const original = fs.readFileSync(path.join(workspace, "general/agents/foo-one.md"))
    assert.throws(() => forkCategory(workspace, "foo", "foo", parseForkReplacements(input)), /matching outer brackets|cannot be empty|empty items|duplicates/)
    assert.deepEqual(fs.readFileSync(path.join(workspace, "general/agents/foo-one.md")), original)
    assert.deepEqual(backupDirectories(workspace), [])
  }
})

test("fork accepts unbracketed comma-separated targets and produces every output", () => {
  const { workspace } = forkWorkspace()
  const replacements = parseForkReplacements("go-, kimi-, hybrid-, free-")
  assert.deepEqual(replacements, ["go-", "kimi-", "hybrid-", "free-"])
  const result = forkCategory(workspace, "foo", "foo", replacements)
  assert.deepEqual(result.copied, [
    "foo-one.md -> go--one.md", "foo-one.md -> kimi--one.md", "foo-one.md -> hybrid--one.md", "foo-one.md -> free--one.md",
    "foo-two.md -> go--two.md", "foo-two.md -> kimi--two.md", "foo-two.md -> hybrid--two.md", "foo-two.md -> free--two.md"
  ])
  assert.equal(result.copied.length, 8)
  for (const target of ["go--one.md", "kimi--two.md", "hybrid--one.md", "free--two.md"]) {
    assert.equal(fs.existsSync(path.join(workspace, "general/agents", target)), true)
  }
})

test("fork accepts an empty replacement and removes find text from filename and content", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fork-empty-"))
  for (const suffix of ["one", "two"]) {
    const sourcePath = path.join(workspace, `general/agents/foo-${suffix}.md`)
    fixtureAgent(sourcePath, workspace, `source/${suffix}`)
    saveAgentFile(sourcePath, { description: "foo description", model: `source/${suffix}` }, "foo body")
  }

  const result = forkCategory(workspace, "foo", "foo", parseForkReplacements(""))
  const targetPath = path.join(workspace, "general/agents/-one.md")
  assert.deepEqual(result.copied, ["foo-one.md -> -one.md", "foo-two.md -> -two.md"])
  assert.equal(fs.existsSync(targetPath), true)
  const target = parseAgentFile(targetPath, workspace)!
  assert.equal(target.description, "description")
  assert.equal(target.body, "\n body")
})

test("fork keeps single-target compatibility and aggregates multiple target mappings", () => {
  const { workspace } = forkWorkspace()
  const single = forkCategory(workspace, "foo", "foo", "bar")
  assert.deepEqual(single.copied, ["foo-one.md -> bar-one.md", "foo-two.md -> bar-two.md"])
  assert.equal(parseAgentFile(path.join(workspace, "general/agents/bar-one.md"), workspace)!.model, "source/one")

  const multi = forkCategory(workspace, "foo", "foo", ["baz", "qux"])
  assert.deepEqual(multi.copied, [
    "foo-one.md -> baz-one.md", "foo-one.md -> qux-one.md",
    "foo-two.md -> baz-two.md", "foo-two.md -> qux-two.md"
  ])
  assert.equal(multi.copied.length, 4)
  assert.equal(parseAgentFile(path.join(workspace, "general/agents/qux-two.md"), workspace)!.model, "source/two")
})

test("fork filters selected sources across every replacement", () => {
  const { workspace, source } = forkWorkspace()
  const result = forkCategory(workspace, "foo", "foo", ["bar", "baz"], [source[0].currentPath])
  assert.deepEqual(result.copied, ["foo-one.md -> bar-one.md", "foo-one.md -> baz-one.md"])
  assert.equal(fs.existsSync(path.join(workspace, "general/agents/bar-two.md")), false)
  assert.equal(fs.existsSync(path.join(workspace, "general/agents/baz-two.md")), false)
})

test("fork preserves each existing target model independently", () => {
  const { workspace } = forkWorkspace()
  fixtureAgent(path.join(workspace, "general/agents/bar-one.md"), workspace, "target/one")
  fixtureAgent(path.join(workspace, "general/agents/bar-two.md"), workspace, "target/two")
  const result = forkCategory(workspace, "foo", "foo", ["bar", "baz"])
  assert.equal(result.copied.length, 4)
  assert.equal(parseAgentFile(path.join(workspace, "general/agents/bar-one.md"), workspace)!.model, "target/one")
  assert.equal(parseAgentFile(path.join(workspace, "general/agents/bar-two.md"), workspace)!.model, "target/two")
})

test("fork rejects duplicate or unsafely colliding full-matrix targets before backup", () => {
  const { workspace } = forkWorkspace()
  const before = fs.readFileSync(path.join(workspace, "general/agents/foo-one.md"))
  assert.throws(() => forkCategory(workspace, "foo", "foo", ["bar", "bar"]), /duplicates/)
  assert.throws(() => forkCategory(workspace, "foo", "foo", ["bar/"]), /Invalid filename/)
  assert.deepEqual(fs.readFileSync(path.join(workspace, "general/agents/foo-one.md")), before)
  assert.deepEqual(backupDirectories(workspace), [])
})

test("fork rejects a target occupied by an unselected source-category file", () => {
  const { workspace, source } = forkWorkspace()
  assert.throws(() => forkCategory(workspace, "foo", "one", "two", [source[0].currentPath]), /another source-category/)
  assert.deepEqual(backupDirectories(workspace), [])
  assert.equal(fs.existsSync(path.join(workspace, "general/agents/foo-one-two.md")), false)
})

test("fork rejects symlink and non-regular targets before writes or backup", () => {
  for (const kind of ["symlink", "directory"] as const) {
    const { workspace } = forkWorkspace()
    const target = path.join(workspace, "general/agents/bar-one.md")
    const original = fs.readFileSync(path.join(workspace, "general/agents/foo-one.md"))
    if (kind === "symlink") fs.symlinkSync(path.join(workspace, "general/agents/foo-one.md"), target)
    else fs.mkdirSync(target)
    assert.throws(() => forkCategory(workspace, "foo", "foo", "bar"), /symlink|non-regular/i)
    assert.deepEqual(fs.readFileSync(path.join(workspace, "general/agents/foo-one.md")), original)
    assert.deepEqual(backupDirectories(workspace), [])
  }
})

test("fork skips self-source no-op and leaves failed preflight outputs untouched", () => {
  const { workspace } = forkWorkspace()
  const noOp = forkCategory(workspace, "foo", "foo", "foo")
  assert.equal(noOp.copied.length, 0)
  assert.equal(noOp.skipped.length, 2)
  assert.deepEqual(backupDirectories(workspace), [])

  const before = fs.readFileSync(path.join(workspace, "general/agents/foo-two.md"))
  assert.throws(() => forkCategory(workspace, "foo", "foo", ["bar", "bar/"]), /Invalid filename/)
  assert.deepEqual(fs.readFileSync(path.join(workspace, "general/agents/foo-two.md")), before)
  assert.equal(fs.existsSync(path.join(workspace, "general/agents/bar-one.md")), false)
  assert.deepEqual(backupDirectories(workspace), [])
})

test("fork rejects case-equivalent targets across the full replacement matrix before backup", () => {
  const { workspace } = forkWorkspace()
  const sourceBytes = fs.readFileSync(path.join(workspace, "general/agents/foo-one.md"))

  assert.throws(() => forkCategory(workspace, "foo", "foo", ["bar", "BAR"]), /Duplicate fork target|collision/i)

  assert.deepEqual(fs.readFileSync(path.join(workspace, "general/agents/foo-one.md")), sourceBytes)
  assert.equal(fs.existsSync(path.join(workspace, "general/agents/bar-one.md")), false)
  assert.equal(fs.existsSync(path.join(workspace, "general/agents/BAR-one.md")), false)
  assert.deepEqual(backupDirectories(workspace), [])
})

test("fork rejects a case-equivalent selected source target instead of self-skipping", () => {
  const { workspace, source } = forkWorkspace()
  const original = fs.readFileSync(source[0].currentPath)
  const entriesBefore = fs.readdirSync(path.dirname(source[0].currentPath)).sort()

  assert.throws(() => forkCategory(workspace, "foo", "foo", "FOO", [source[0].currentPath]), /source-category|collision|differently spelled/i)

  assert.deepEqual(fs.readFileSync(source[0].currentPath), original)
  assert.deepEqual(fs.readdirSync(path.dirname(source[0].currentPath)).sort(), entriesBefore)
  assert.deepEqual(backupDirectories(workspace), [])
})

test("fork rejects a case-equivalent unselected source-category target", () => {
  const { workspace, source } = forkWorkspace()
  const original = fs.readFileSync(source[1].currentPath)
  const entriesBefore = fs.readdirSync(path.dirname(source[1].currentPath)).sort()

  assert.throws(() => forkCategory(workspace, "foo", "one", "TWO", [source[0].currentPath]), /source-category|collision|differently spelled/i)

  assert.deepEqual(fs.readFileSync(source[1].currentPath), original)
  assert.deepEqual(fs.readdirSync(path.dirname(source[1].currentPath)).sort(), entriesBefore)
  assert.deepEqual(backupDirectories(workspace), [])
})

test("fork rejects a case-equivalent existing target without overwrite or sibling creation", () => {
  const { workspace } = forkWorkspace()
  const existing = path.join(workspace, "general/agents/BAR-one.md")
  fixtureAgent(existing, workspace, "target/existing")
  const original = fs.readFileSync(existing)
  const entriesBefore = fs.readdirSync(path.dirname(existing)).sort()

  assert.throws(() => forkCategory(workspace, "foo", "foo", "bar"), /collision|target|differently spelled/i)

  assert.deepEqual(fs.readFileSync(existing), original)
  assert.deepEqual(fs.readdirSync(path.dirname(existing)).sort(), entriesBefore)
  assert.deepEqual(backupDirectories(workspace), [])
})

test("agent params set effort variants and preserve other frontmatter and body", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-variant-"))
  const filePath = path.join(workspace, "general/agents/a.md")
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  saveAgentFile(filePath, { description: "Example", model: "test/model", steps: 12 }, "Agent body.")
  const agent = parseAgentFile(filePath, workspace)!

  assert.deepEqual(AGENT_EFFORT_VARIANTS, ["low", "medium", "high", "max"])
  for (const variant of ["high", "max", "thinking"]) {
    updateAgentParams([agent], { variant })
    const content = fs.readFileSync(filePath, "utf8")
    assert.match(content, new RegExp(`\\nmodel: test/model#${variant}\\n`))
    assert.deepEqual(agent.frontmatter, { description: "Example", model: "test/model", max_steps: 12, variant })
    assert.match(content, /Agent body\./)
  }
  assert.throws(() => updateAgentParams([agent], { variant: "extreme" }), /Invalid agent variant/)
})

test("legacy V1 max_steps survives parsing and tuning updates", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-legacy-steps-"))
  const filePath = path.join(workspace, "general/agents/legacy-agent.md")
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, [
    "---",
    "description: Legacy agent",
    "max_steps: 12",
    "permission:",
    "  read: allow",
    "---",
    "",
    "Agent body."
  ].join("\n"))

  const agent = parseAgentFile(filePath, workspace)!
  assert.equal(agent.frontmatterVersion, "v1")
  assert.equal(agent.frontmatter.max_steps, 12)
  assert.equal(Object.hasOwn(agent.frontmatter, "steps"), false)

  updateAgentParams([agent], { temperature: 0.5 })
  let content = fs.readFileSync(filePath, "utf8")
  assert.match(content, /\nmax_steps: 12\n/)
  assert.doesNotMatch(content, /\nsteps:/)
  assert.equal(parseAgentFile(filePath, workspace)!.frontmatterVersion, "v1")

  updateAgentParams([agent], { steps: 20 })
  content = fs.readFileSync(filePath, "utf8")
  assert.match(content, /\nmax_steps: 20\n/)
  assert.doesNotMatch(content, /\nsteps:/)
  const updated = parseAgentFile(filePath, workspace)!
  assert.equal(updated.frontmatterVersion, "v1")
  assert.equal(updated.frontmatter.max_steps, 20)
  assert.equal(Object.hasOwn(updated.frontmatter, "steps"), false)
})

test("multi-agent parameter tuning summarizes mixed values and only updates dirty fields", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-multi-tuning-"))
  const subagentPath = path.join(workspace, "general/agents/go-pipeline-executor.md")
  const orchestratorPath = path.join(workspace, "general/agents/go-pipeline-orchestrator.md")
  for (const [filePath, frontmatter] of [
    [orchestratorPath, { description: "Pipeline orchestrator", mode: "primary", steps: 120, temperature: 1, hidden: false }],
    [subagentPath, { description: "Pipeline executor", mode: "subagent", steps: 50, temperature: 0.2, hidden: true }]
  ] as const) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    saveAgentFile(filePath, frontmatter, "Agent body.")
  }
  const subagent = parseAgentFile(subagentPath, workspace)!
  const orchestrator = parseAgentFile(orchestratorPath, workspace)!

  assert.equal(typeof (agentsMod as any).inspectTuningTargets, "function")
  assert.equal(typeof (agentsMod as any).buildTuningUpdateParams, "function")
  const summary = (agentsMod as any).inspectTuningTargets([subagent, orchestrator])
  assert.equal(summary.steps.mixed, true)
  assert.equal(summary.steps.displayMixed, "(mixed: 50, 120 — unchanged)")
  assert.equal(summary.temp.mixed, true)
  assert.equal(summary.temp.displayMixed, "(mixed: 0.2, 1 — unchanged)")
  assert.equal(summary.mode.mixed, true)
  assert.equal(summary.mode.displayMixed, "(mixed: PRIMARY, SUBAGENT — unchanged)")
  assert.equal(summary.hidden.mixed, true)
  assert.equal(summary.hidden.displayMixed, "(mixed: FALSE, TRUE — unchanged)")

  const params = (agentsMod as any).buildTuningUpdateParams(
    { steps: "50", temp: "0.2", variant: "high", mode: "subagent", hidden: true },
    new Set(["variant"])
  )
  assert.deepEqual(params, { variant: "high" })

  updateAgentParams([subagent, orchestrator], params)
  const updatedSubagent = parseAgentFile(subagentPath, workspace)!
  const updatedOrchestrator = parseAgentFile(orchestratorPath, workspace)!
  assert.equal(updatedSubagent.frontmatter.variant, "high")
  assert.equal(updatedOrchestrator.frontmatter.variant, "high")
  assert.equal(updatedOrchestrator.frontmatter.mode, "primary")
  assert.equal(updatedOrchestrator.frontmatter.max_steps, 120)
  assert.equal(updatedOrchestrator.frontmatter.temperature, 1)
  assert.equal(updatedOrchestrator.frontmatter.hidden, false)
})

test("agent params accept known model variants and model-specific allowed variants", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-variant-model-"))
  const agent = fixtureAgent(path.join(workspace, "general/agents/a.md"), workspace, "test/model")

  for (const variant of ["minimal", "xhigh", "thinking"]) updateAgentParams([agent], { variant })
  updateAgentParams([agent], { variant: "custom-mode", allowedVariants: ["custom-mode"] })
  assert.equal(agent.frontmatter.variant, "custom-mode")
  assert.throws(() => updateAgentParams([agent], { variant: "another-mode", allowedVariants: ["custom-mode"] }), /Expected one of: custom-mode/)
})

test("agent params preserve or clear an existing effort variant", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-variant-"))
  const agent = fixtureAgent(path.join(workspace, "general/agents/a.md"), workspace, "test/model")
  agent.frontmatter.variant = "high"
  agent.frontmatter.steps = 12
  agent.frontmatterVersion = "v2"
  saveAgentFile(agent.currentPath, agent.frontmatter, agent.body, "v2")
  agent.rawContent = fs.readFileSync(agent.currentPath, "utf8")

  updateAgentParams([agent], { variant: undefined })
  assert.equal(agent.frontmatter.variant, "high")
  assert.match(fs.readFileSync(agent.currentPath, "utf8"), /\nmodel: test\/model#high\n/)

  updateAgentParams([agent], { variant: null })
  assert.equal(Object.hasOwn(agent.frontmatter, "variant"), false)
  assert.equal(Object.hasOwn(parseAgentFile(agent.currentPath, workspace)!.frontmatter, "variant"), false)
  assert.doesNotMatch(fs.readFileSync(agent.currentPath, "utf8"), /\nmodel: test\/model#high\n/)
})

test("agent params reject blank variants before modifying any agent", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-variant-"))
  const a = fixtureAgent(path.join(workspace, "general/agents/a.md"), workspace, "test/model")
  const b = fixtureAgent(path.join(workspace, "general/agents/b.md"), workspace, "test/model")
  const originalContents = [a, b].map(agent => fs.readFileSync(agent.currentPath, "utf8"))
  const originalFrontmatter = [a.frontmatter, b.frontmatter]

  assert.throws(() => updateAgentParams([a, b], { variant: "   " }), {
    message: "Agent variant cannot be empty. Pass null to clear variant."
  })
  for (const [index, agent] of [a, b].entries()) {
    assert.equal(fs.readFileSync(agent.currentPath, "utf8"), originalContents[index])
    assert.strictEqual(agent.frontmatter, originalFrontmatter[index])
  }
})

test("selected export installs matching domain resources, backs up replacements, and preserves unrelated files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-domain-export-"))
  const xdg = path.join(root, "custom-xdg")
  const opencodeRoot = path.join(xdg, "opencode")
  const destination = path.join(opencodeRoot, "agents")
  const sourceRoot = path.join(root, "resource-source")
  const workspace = path.join(root, "workspace")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = xdg

  const slidesAgent = fixtureAgent(path.join(workspace, "general/agents/slides-orchestrator.md"), workspace, "test/model")
  fixtureAgent(path.join(workspace, "general/agents/docs-writer.md"), workspace, "test/model")
  fs.mkdirSync(destination, { recursive: true })
  fs.writeFileSync(path.join(destination, "unrelated-agent.md"), "keep agent file\n")
  fs.writeFileSync(path.join(opencodeRoot, "unrelated.txt"), "keep config file\n")
  fs.mkdirSync(path.join(opencodeRoot, "skills", "slides-design"), { recursive: true })
  fs.mkdirSync(path.join(opencodeRoot, "tools", "slides"), { recursive: true })
  fs.writeFileSync(path.join(opencodeRoot, "skills", "slides-design", "SKILL.md"), "old design skill\n")
  fs.writeFileSync(path.join(opencodeRoot, "tools", "slides", "existing.py"), "old build tool\n")
  fs.writeFileSync(path.join(opencodeRoot, "tools", "slides", "unrelated.py"), "preserve this tool\n")

  for (const [skill, contents] of [["slides-design", "new design skill\n"]]) {
    const source = path.join(sourceRoot, "skills", skill, "SKILL.md")
    fs.mkdirSync(path.dirname(source), { recursive: true })
    fs.writeFileSync(source, contents)
  }
  const unrelatedSkill = path.join(sourceRoot, "skills", "slide-show", "SKILL.md")
  fs.mkdirSync(path.dirname(unrelatedSkill), { recursive: true })
  fs.writeFileSync(unrelatedSkill, "unrelated skill\n")
  const nestedTool = path.join(sourceRoot, "tools", "slides", "nested", "build.py")
  fs.mkdirSync(path.dirname(nestedTool), { recursive: true })
  fs.writeFileSync(nestedTool, "new build tool\n")
  fs.writeFileSync(path.join(sourceRoot, "tools", "slides", "new.py"), "another new tool\n")
  fs.writeFileSync(path.join(sourceRoot, "tools", "slides", "existing.py"), "replacement build tool\n")

  const result = exportAgents([slidesAgent], new Set([slidesAgent.currentPath]), sourceRoot)

  assert.equal(result.destinationPath, destination)
  assert.deepEqual(result.exported, [slidesAgent.filename])
  assert.deepEqual(result.skipped, [])
  assert.equal(fs.readFileSync(path.join(destination, slidesAgent.filename), "utf8"), fs.readFileSync(slidesAgent.currentPath, "utf8"))
  assert.equal(fs.existsSync(path.join(destination, "docs-writer.md")), false, "unselected agent must not be exported")
  assert.equal(fs.readFileSync(path.join(destination, "unrelated-agent.md"), "utf8"), "keep agent file\n")
  assert.equal(fs.readFileSync(path.join(opencodeRoot, "unrelated.txt"), "utf8"), "keep config file\n")
  assert.equal(fs.readFileSync(path.join(opencodeRoot, "skills", "slides-design", "SKILL.md"), "utf8"), "new design skill\n")
  assert.equal(fs.existsSync(path.join(opencodeRoot, "skills", "slide-show", "SKILL.md")), false, "a directory without the '<domain>-' boundary must not match")
  assert.equal(fs.readFileSync(path.join(opencodeRoot, "tools", "slides", "nested", "build.py"), "utf8"), "new build tool\n")
  assert.equal(fs.readFileSync(path.join(opencodeRoot, "tools", "slides", "new.py"), "utf8"), "another new tool\n")
  assert.equal(fs.readFileSync(path.join(opencodeRoot, "tools", "slides", "existing.py"), "utf8"), "replacement build tool\n")
  assert.equal(fs.readFileSync(path.join(opencodeRoot, "tools", "slides", "unrelated.py"), "utf8"), "preserve this tool\n")
  assert.ok(result.domainResources.includes(path.join(opencodeRoot, "skills", "slides-design", "SKILL.md")))
  assert.ok(result.domainResources.includes(path.join(opencodeRoot, "tools", "slides", "nested", "build.py")))
  assert.ok(result.domainBackupPath)
  assert.equal(fs.readFileSync(path.join(result.domainBackupPath!, "skills", "slides-design", "SKILL.md"), "utf8"), "old design skill\n")
  assert.equal(fs.readFileSync(path.join(result.domainBackupPath!, "tools", "slides", "existing.py"), "utf8"), "old build tool\n")
  assert.equal(fs.existsSync(path.join(result.domainBackupPath!, "tools", "slides", "nested", "build.py")), false, "new files are not part of the replacement backup")
  assert.equal(fs.readFileSync(path.join(result.backupPath, "unrelated-agent.md"), "utf8"), "keep agent file\n")
})

test("export rolls back agent and companion resource changes after a mid-install failure", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-domain-rollback-"))
  const xdg = path.join(root, "xdg")
  const opencodeRoot = path.join(xdg, "opencode")
  const sourceRoot = path.join(root, "resource-source")
  const workspace = path.join(root, "workspace")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = xdg

  const slidesAgent = fixtureAgent(path.join(workspace, "general/agents/slides-orchestrator.md"), workspace, "test/model")
  const newAgent = fixtureAgent(path.join(workspace, "general/agents/slides-writer.md"), workspace, "test/model")
  fs.mkdirSync(path.join(opencodeRoot, "agents"), { recursive: true })
  fs.writeFileSync(path.join(opencodeRoot, "agents", slidesAgent.filename), "old exported agent\n")
  fs.mkdirSync(path.join(opencodeRoot, "skills", "slides-design"), { recursive: true })
  fs.mkdirSync(path.join(opencodeRoot, "tools", "slides"), { recursive: true })
  fs.writeFileSync(path.join(opencodeRoot, "skills", "slides-design", "SKILL.md"), "original design skill\n")
  fs.writeFileSync(path.join(opencodeRoot, "tools", "slides", "existing.py"), "original build tool\n")
  const sourceSkill = path.join(sourceRoot, "skills", "slides-design", "SKILL.md")
  fs.mkdirSync(path.dirname(sourceSkill), { recursive: true })
  fs.writeFileSync(sourceSkill, "replacement design skill\n")
  const replacementTool = path.join(sourceRoot, "tools", "slides", "existing.py")
  const firstTool = path.join(sourceRoot, "tools", "slides", "first.py")
  const secondTool = path.join(sourceRoot, "tools", "slides", "second.py")
  fs.mkdirSync(path.dirname(replacementTool), { recursive: true })
  fs.writeFileSync(replacementTool, "replacement build tool\n")
  fs.writeFileSync(firstTool, "new first tool\n")
  fs.writeFileSync(secondTool, "new second tool\n")

  const originalRename = fs.renameSync
  let stagedRenames = 0
  t.mock.method(fs, "renameSync", function (oldPath: fs.PathLike, newPath: fs.PathLike) {
    if (String(oldPath).includes(".resource-export-stage-")) {
      stagedRenames += 1
      if (stagedRenames === 4) throw new Error("simulated mid-install failure")
    }
    return originalRename.call(fs, oldPath, newPath)
  })

  assert.throws(
    () => exportAgents([slidesAgent, newAgent], new Set([slidesAgent.currentPath, newAgent.currentPath]), sourceRoot),
    /simulated mid-install failure; rollback completed; backup:/
  )
  assert.equal(stagedRenames, 4, "failure occurs after replacements and a newly created file were installed")
  assert.equal(fs.readFileSync(path.join(opencodeRoot, "agents", slidesAgent.filename), "utf8"), "old exported agent\n")
  assert.equal(fs.existsSync(path.join(opencodeRoot, "agents", newAgent.filename)), false)
  assert.equal(fs.readFileSync(path.join(opencodeRoot, "skills", "slides-design", "SKILL.md"), "utf8"), "original design skill\n")
  assert.equal(fs.readFileSync(path.join(opencodeRoot, "tools", "slides", "existing.py"), "utf8"), "original build tool\n")
  assert.equal(fs.existsSync(path.join(opencodeRoot, "tools", "slides", "first.py")), false)
  assert.equal(fs.existsSync(path.join(opencodeRoot, "tools", "slides", "second.py")), false)
  assert.deepEqual(fs.readdirSync(opencodeRoot).filter(name => name.startsWith(".resource-export-stage-")), [])
})

test("manifest, linked resources and reachable dependencies export without unrelated helpers", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-manifest-export-"))
  const xdg = path.join(root, "xdg")
  const opencodeRoot = path.join(xdg, "opencode")
  const workspace = path.join(root, "workspace")
  const sourceRoot = path.join(workspace, "general")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = xdg

  const slidesAgent = fixtureAgent(path.join(workspace, "general/agents/slides-orchestrator.md"), workspace, "test/model")
  const manifest = {
    resources: [
      { kind: "file", source: "general/commands/new-slides.md", target: "commands/new-slides.md" },
      { kind: "directory", source: "general/tools/pptx", target: "tools/pptx" },
      { kind: "file", source: "general/skills/slides-composition/THIRD_PARTY_NOTICES.md", target: "THIRD_PARTY_NOTICES.md" }
    ]
  }
  const manifestPath = path.join(workspace, ".agent-manager/categories/slides.json")
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  fs.writeFileSync(manifestPath, JSON.stringify(manifest))

  const sourceFiles: Record<string, string> = {
    "commands/new-slides.md": "manifest command\n",
    "tools/pptx/build.py": "manifest tool\n",
    "tools/slide_build_pptx.ts": 'import "./_safeName.js";\n',
    "tools/_safeName.js": "export const safeName = true\n",
    "tools/_other.js": "export const unrelated = true\n",
    "skills/pptx/SKILL.md": "linked skill\n",
    "skills/slides-composition/THIRD_PARTY_NOTICES.md": "supplemental notice\n",
    "commands/docs-extra.md": "unrelated command\n"
  }
  for (const [relative, contents] of Object.entries(sourceFiles)) {
    const filePath = path.join(sourceRoot, relative)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, contents)
  }
  updateCategoryCompanionLinks(workspace, "slides", {
    commands: ["commands/new-slides.md"],
    skills: ["skills/pptx"],
    tools: ["tools/slide_build_pptx.ts"]
  })

  const result = exportAgents([slidesAgent], new Set([slidesAgent.currentPath]), sourceRoot)
  const installedPaths = [
    "tools/pptx/build.py",
    "commands/new-slides.md",
    "skills/slides-composition/THIRD_PARTY_NOTICES.md",
    "tools/slide_build_pptx.ts",
    "tools/_safeName.js",
    "skills/pptx/SKILL.md"
  ].map(relative => path.join(opencodeRoot, relative))
  for (const [relative, contents] of Object.entries({
    "tools/pptx/build.py": "manifest tool\n",
    "commands/new-slides.md": "manifest command\n",
    "skills/slides-composition/THIRD_PARTY_NOTICES.md": "supplemental notice\n",
    "tools/slide_build_pptx.ts": 'import "./_safeName.js";\n',
    "tools/_safeName.js": "export const safeName = true\n",
    "skills/pptx/SKILL.md": "linked skill\n"
  })) assert.equal(fs.readFileSync(path.join(opencodeRoot, relative), "utf8"), contents)
  assert.equal(new Set(result.domainResources).size, result.domainResources.length, "resource paths must be deduplicated")
  for (const installed of installedPaths) assert.equal(result.domainResources.filter(resource => resource === installed).length, 1)
  assert.equal(fs.existsSync(path.join(opencodeRoot, "tools", "_other.js")), false, "unrelated helpers must not be installed")
  assert.equal(fs.existsSync(path.join(opencodeRoot, "commands", "slides-extra.md")), false, "unlinked domain resources must not be installed")
  assert.equal(fs.existsSync(path.join(opencodeRoot, "commands", "docs-extra.md")), false, "unrelated domains must not be installed")
})

test("agent permissions derive tool resources and trace relative helper imports", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-derived-resources-"))
  const agent = fixtureAgent(path.join(workspace, "general/agents/custom-agent.md"), workspace, "test/model")
  agent.frontmatter.permission = { custom_tool: "allow" }
  saveAgentFile(agent.currentPath, agent.frontmatter, agent.body)
  fs.mkdirSync(path.join(workspace, "general/tools"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "general/tools/custom_tool.ts"), 'import { helper } from "./_custom_helper.js";\nexport default helper\n')
  fs.writeFileSync(path.join(workspace, "general/tools/_custom_helper.js"), "export const helper = true\n")

  const catalog = discoverAgentResources(workspace, agent)
  assert.ok(catalog.companionFiles.some(file => file.replace(/\\/g, "/") === "tools/custom_tool.ts"))
  assert.ok(catalog.companionFiles.some(file => file.replace(/\\/g, "/") === "tools/_custom_helper.js"))
})

test("category companion link changes control linked companion discovery", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-category-links-"))
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = path.join(workspace, "xdg")
  const agent = fixtureAgent(path.join(workspace, "general/agents/custom-agent.md"), workspace, "test/model")
  const files = [
    "plugins/linked-plugin.js",
    "skills/linked-skill/SKILL.md",
    "tools/linked_tool.ts"
  ]
  for (const relative of files) {
    const filePath = path.join(workspace, "general", relative)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, "linked\n")
  }

  updateCategoryCompanionLinks(workspace, "custom", {
    plugins: ["plugins/linked-plugin.js"], skills: ["skills/linked-skill"], tools: ["tools/linked_tool.ts"]
  })
  const linked = compareCompanionResources(workspace, [agent]).map(item => item.relativePath.replace(/\\/g, "/"))
  for (const relative of files) assert.ok(linked.includes(relative), `${relative} should be discovered while linked`)

  updateCategoryCompanionLinks(workspace, "custom", { plugins: [], skills: [], tools: [] })
  const unlinked = compareCompanionResources(workspace, [agent]).map(item => item.relativePath.replace(/\\/g, "/"))
  for (const relative of files) assert.equal(unlinked.includes(relative), false, `${relative} should no longer be discovered`)
})

test("unchanged companion resources are skipped while content or mode changes are replaced", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-resource-skip-"))
  const xdg = path.join(root, "xdg")
  const opencodeRoot = path.join(xdg, "opencode")
  const sourceRoot = path.join(root, "source")
  const workspace = path.join(root, "workspace")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = xdg
  const slidesAgent = fixtureAgent(path.join(workspace, "general/agents/slides-orchestrator.md"), workspace, "test/model")
  const source = path.join(sourceRoot, "tools/slides/build.ts")
  const destination = path.join(opencodeRoot, "tools/slides/build.ts")
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(source, "same resource\n")
  fs.writeFileSync(destination, "same resource\n")
  fs.chmodSync(source, 0o755)
  fs.chmodSync(destination, 0o755)

  const unchanged = exportAgents([slidesAgent], new Set([slidesAgent.currentPath]), sourceRoot)
  assert.deepEqual(unchanged.domainResources, [])
  assert.equal(unchanged.domainBackupPath, null)

  fs.writeFileSync(source, "changed content\n")
  const contentChanged = exportAgents([slidesAgent], new Set([slidesAgent.currentPath]), sourceRoot)
  assert.deepEqual(contentChanged.domainResources, [destination])
  assert.ok(contentChanged.domainBackupPath)
  assert.equal(fs.readFileSync(destination, "utf8"), "changed content\n")

  fs.chmodSync(source, 0o700)
  const modeChanged = exportAgents([slidesAgent], new Set([slidesAgent.currentPath]), sourceRoot)
  assert.deepEqual(modeChanged.domainResources, [destination])
  assert.ok(modeChanged.domainBackupPath)
  assertPosixMode(fs.statSync(destination).mode & 0o7777, 0o700)
})

test("unchanged exported agents are reported without copying", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-export-skip-"))
  const xdg = path.join(root, "xdg")
  const workspace = path.join(root, "workspace")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = xdg
  const agent = fixtureAgent(path.join(workspace, "general/agents/slides-orchestrator.md"), workspace, "test/model")
  const target = path.join(getExportDestination(), agent.filename)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(agent.currentPath, target)
  fs.chmodSync(target, fs.statSync(agent.currentPath).mode & 0o7777)
  const copyFileSync = fs.copyFileSync
  let agentCopies = 0
  t.mock.method(fs, "copyFileSync", function (source: fs.PathLike, destination: fs.PathLike, mode?: number) {
    if (source === agent.currentPath) agentCopies += 1
    return copyFileSync.call(fs, source, destination, mode)
  })

  const result = exportAgents([agent], new Set([agent.currentPath]))

  assert.deepEqual(result.exported, [agent.filename])
  assert.deepEqual(result.skipped, [])
  assert.equal(agentCopies, 0)
})

test("resource replacement retains only the five newest backups", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-resource-retention-"))
  const xdg = path.join(root, "xdg")
  const opencodeRoot = path.join(xdg, "opencode")
  const sourceRoot = path.join(root, "source")
  const workspace = path.join(root, "workspace")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = xdg
  fs.mkdirSync(opencodeRoot, { recursive: true })
  const seeded = Array.from({ length: 6 }, (_, index) => {
    const directory = path.join(opencodeRoot, `resource_export_backup_${index}`)
    fs.mkdirSync(directory)
    const timestamp = new Date(1_000 + index * 1_000)
    fs.utimesSync(directory, timestamp, timestamp)
    return directory
  })
  const unrelated = path.join(opencodeRoot, "unrelated-backup")
  fs.mkdirSync(unrelated)
  const slidesAgent = fixtureAgent(path.join(workspace, "general/agents/slides-orchestrator.md"), workspace, "test/model")
  const source = path.join(sourceRoot, "tools/slides/build.ts")
  const destination = path.join(opencodeRoot, "tools/slides/build.ts")
  fs.mkdirSync(path.dirname(source), { recursive: true })
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(source, "new\n")
  fs.writeFileSync(destination, "old\n")

  const result = exportAgents([slidesAgent], new Set([slidesAgent.currentPath]), sourceRoot)
  const retained = fs.readdirSync(opencodeRoot).filter(name => name.startsWith("resource_export_backup_"))
  assert.equal(retained.length, 5)
  assert.equal(fs.existsSync(unrelated), true)
  assert.ok(result.domainBackupPath)
  assert.ok(seeded.slice(0, 2).every(directory => retained.includes(path.basename(directory)) === false))
  assert.ok(seeded.slice(2).every(directory => retained.includes(path.basename(directory))))
})

test("export rejects a symlinked resource source root and agent destination", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-export-symlink-"))
  const xdg = path.join(root, "xdg")
  const opencodeRoot = path.join(xdg, "opencode")
  const sourceRoot = path.join(root, "source")
  const sourceLink = path.join(root, "source-link")
  const workspace = path.join(root, "workspace")
  const outside = path.join(root, "outside.md")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = xdg
  const agent = fixtureAgent(path.join(workspace, "general/agents/slides-orchestrator.md"), workspace, "test/model")
  fs.mkdirSync(sourceRoot)
  fs.symlinkSync(sourceRoot, sourceLink)
  assert.throws(() => exportAgents([agent], new Set([agent.currentPath]), sourceLink), /symlink/i)

  fs.mkdirSync(path.join(opencodeRoot, "agents"), { recursive: true })
  fs.writeFileSync(outside, "must not change\n")
  fs.symlinkSync(outside, path.join(opencodeRoot, "agents", agent.filename))
  assert.throws(() => exportAgents([agent], new Set([agent.currentPath])), /symlink|non-regular/i)
  assert.equal(fs.readFileSync(outside, "utf8"), "must not change\n")
})

test("companion resource comparison and import are symmetric, read-only in preview, and skip unchanged files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-resource-import-"))
  const xdg = path.join(root, "xdg")
  const opencodeRoot = path.join(xdg, "opencode")
  const exportDir = path.join(opencodeRoot, "agents")
  const workspace = path.join(root, "workspace")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = xdg
  const localChangedAgent = fixtureAgent(path.join(workspace, "general/agents/slides-orchestrator.md"), workspace, "local/model")
  const unchangedAgent = fixtureAgent(path.join(workspace, "general/agents/slides-writer.md"), workspace, "same/model")
  fs.mkdirSync(exportDir, { recursive: true })
  fs.writeFileSync(path.join(exportDir, localChangedAgent.filename), "exported agent version\n")
  fs.writeFileSync(path.join(exportDir, unchangedAgent.filename), fs.readFileSync(unchangedAgent.currentPath))
  fs.writeFileSync(path.join(exportDir, "slides-new.md"), "new exported agent\n")

  const localResources: Record<string, string> = {
    "tools/slides/changed.ts": "local resource version\n",
    "tools/slides/unchanged.ts": "same resource\n"
  }
  const exportedResources: Record<string, string> = {
    "tools/slides/changed.ts": "export resource version\n",
    "tools/slides/unchanged.ts": "same resource\n",
    "tools/slides/new.ts": "new exported resource\n"
  }
  for (const [relative, contents] of Object.entries(localResources)) {
    const filePath = path.join(workspace, "general", relative)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, contents)
  }
  for (const [relative, contents] of Object.entries(exportedResources)) {
    const filePath = path.join(opencodeRoot, relative)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, contents)
  }

  const companionDiffs = compareCompanionResources(workspace)
  const changedResourceDiff = companionDiffs.find((diff: any) => diff.path?.endsWith("changed.ts") || diff.relativePath?.endsWith("changed.ts"))
  const newResourceDiff = companionDiffs.find((diff: any) => diff.path?.endsWith("new.ts") || diff.relativePath?.endsWith("new.ts"))
  const unchangedResourceDiff = companionDiffs.find((diff: any) => diff.path?.endsWith("unchanged.ts") || diff.relativePath?.endsWith("unchanged.ts"))
  assert.ok(changedResourceDiff)
  assert.equal(changedResourceDiff.existsLocally, true)
  assert.equal(changedResourceDiff.existsInExport, true)
  assert.equal(changedResourceDiff.hasDifferences, true)
  assert.ok(newResourceDiff)
  assert.equal(newResourceDiff.existsLocally, false)
  assert.equal(newResourceDiff.existsInExport, true)
  assert.equal(newResourceDiff.hasDifferences, true)
  assert.ok(unchangedResourceDiff)
  assert.equal(unchangedResourceDiff.existsLocally, true)
  assert.equal(unchangedResourceDiff.existsInExport, true)
  assert.equal(unchangedResourceDiff.hasDifferences, false)

  const preview = previewImport(workspace)
  assert.equal(fs.existsSync(path.join(workspace, "backups")), false, "preview must not create backups")
  const agentDiffs = preview.agents
  const changedAgentDiff = agentDiffs.find((diff: any) => diff.filename === localChangedAgent.filename)
  assert.equal(changedAgentDiff.existsLocally, true)
  assert.equal(changedAgentDiff.existsInExport, true)
  assert.equal(changedAgentDiff.hasDifferences, true)
  const missingAgentDiff = agentDiffs.find((diff: any) => diff.filename === "slides-new.md")
  assert.equal(missingAgentDiff.existsLocally, false)
  assert.equal(missingAgentDiff.existsInExport, true)
  assert.equal(missingAgentDiff.hasDifferences, true)
  const previewResourceDiff = preview.companionResources.find((diff: any) => diff.path?.endsWith("changed.ts") || diff.relativePath?.endsWith("changed.ts"))
  assert.ok(previewResourceDiff)
  assert.equal(previewResourceDiff.existsLocally, true)
  assert.equal(previewResourceDiff.existsInExport, true)
  assert.equal(previewResourceDiff.hasDifferences, true)

  const imported = importAgents(workspace)
  assert.ok(imported.imported.includes(localChangedAgent.filename))
  assert.ok(imported.imported.includes("slides-new.md"))
  assert.equal(imported.imported.includes(unchangedAgent.filename), false, "unchanged agents must be skipped")
  assert.equal(fs.readFileSync(localChangedAgent.currentPath, "utf8"), "exported agent version\n")
  assert.equal(fs.readFileSync(path.join(workspace, "general/agents/slides-new.md"), "utf8"), "new exported agent\n")
  assert.equal(fs.readFileSync(path.join(workspace, "general", "tools/slides/changed.ts"), "utf8"), "export resource version\n")
  assert.equal(fs.readFileSync(path.join(workspace, "general", "tools/slides/new.ts"), "utf8"), "new exported resource\n")
  assert.equal(fs.readFileSync(path.join(workspace, "general", "tools/slides/unchanged.ts"), "utf8"), "same resource\n")

  const noChanges = importAgents(workspace)
  assert.equal(noChanges.backupPath, null)
  assert.deepEqual(noChanges.imported, [])
})

test("manifest-declared resources missing locally remain import candidates", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-manifest-import-"))
  const xdg = path.join(root, "xdg")
  const opencodeRoot = path.join(xdg, "opencode")
  const workspace = path.join(root, "workspace")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = xdg
  fixtureAgent(path.join(workspace, "general/agents/slides-orchestrator.md"), workspace, "test/model")
  const manifestPath = path.join(workspace, ".agent-manager/categories/slides.json")
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  fs.writeFileSync(manifestPath, JSON.stringify({ resources: [
    { kind: "file", source: "general/commands/new-slides.md", target: "commands/new-slides.md" }
  ] }))
  const exportedResource = path.join(opencodeRoot, "commands/new-slides.md")
  fs.mkdirSync(path.dirname(exportedResource), { recursive: true })
  fs.writeFileSync(exportedResource, "exported manifest command\n")

  const preview = previewImport(workspace)
  const diff = preview.companionResources.find(resource => resource.relativePath === "commands/new-slides.md")
  assert.ok(diff)
  assert.equal(diff.existsLocally, false)
  assert.equal(diff.existsInExport, true)
  assert.equal(diff.hasDifferences, true)

  const result = importAgents(workspace)
  assert.ok(result.importedResources.includes("commands/new-slides.md"))
  assert.equal(fs.readFileSync(path.join(workspace, "general/commands/new-slides.md"), "utf8"), "exported manifest command\n")
})

test("import rolls back overwritten files and removes newly created files after a mid-import failure", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-import-rollback-"))
  const xdg = path.join(root, "xdg")
  const opencodeRoot = path.join(xdg, "opencode")
  const exportAgentsDir = path.join(opencodeRoot, "agents")
  const workspace = path.join(root, "workspace")
  const localAgentPath = path.join(workspace, "general/agents/slides-existing.md")
  const localResourcePath = path.join(workspace, "general/tools/slides/changed.ts")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = xdg
  fixtureAgent(localAgentPath, workspace, "local/model")
  const originalAgent = fs.readFileSync(localAgentPath)
  fs.mkdirSync(path.dirname(localResourcePath), { recursive: true })
  fs.writeFileSync(localResourcePath, "original local resource\n")
  fs.chmodSync(localResourcePath, 0o751)
  fs.mkdirSync(exportAgentsDir, { recursive: true })
  fs.writeFileSync(path.join(exportAgentsDir, "slides-existing.md"), "exported agent replacement\n")
  fs.writeFileSync(path.join(exportAgentsDir, "slides-new.md"), "new exported agent\n")
  for (const [relative, contents] of [
    ["tools/slides/changed.ts", "exported resource replacement\n"],
    ["tools/slides/new.ts", "new exported resource\n"],
    ["tools/slides/z-last.ts", "last exported resource\n"]
  ]) {
    const exportedResource = path.join(opencodeRoot, relative)
    fs.mkdirSync(path.dirname(exportedResource), { recursive: true })
    fs.writeFileSync(exportedResource, contents)
  }

  const renameSync = fs.renameSync
  let appliedRenames = 0
  t.mock.method(fs, "renameSync", function (oldPath: fs.PathLike, newPath: fs.PathLike) {
    if (String(oldPath).includes(".import-stage-") && ++appliedRenames === 5) {
      throw new Error("simulated import failure")
    }
    return renameSync.call(fs, oldPath, newPath)
  })

  assert.throws(() => importAgents(workspace), /simulated import failure; rollback completed/)
  assert.equal(appliedRenames, 5)
  assert.deepEqual(fs.readFileSync(localAgentPath), originalAgent)
  assert.equal(fs.existsSync(path.join(workspace, "general/agents/slides-new.md")), false)
  assert.equal(fs.readFileSync(localResourcePath, "utf8"), "original local resource\n")
  assertPosixMode(fs.statSync(localResourcePath).mode & 0o7777, 0o751)
  assert.equal(fs.existsSync(path.join(workspace, "general/tools/slides/new.ts")), false)
  assert.equal(fs.existsSync(path.join(workspace, "general/tools/slides/z-last.ts")), false)
  assert.deepEqual(fs.readdirSync(path.join(workspace, "general")).filter(name => name.startsWith(".import-stage-")), [])
})

test("agent export validation failure rolls back earlier agent writes and preserves mode", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-export-agent-rollback-"))
  const xdg = path.join(root, "xdg")
  const workspace = path.join(root, "workspace")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = xdg
  const first = fixtureAgent(path.join(workspace, "general/agents/slides-first.md"), workspace, "test/model")
  const second = fixtureAgent(path.join(workspace, "general/agents/slides-second.md"), workspace, "test/model")
  const destination = path.join(xdg, "opencode/agents")
  const firstTarget = path.join(destination, first.filename)
  fs.mkdirSync(destination, { recursive: true })
  fs.writeFileSync(firstTarget, "previous export\n")
  fs.chmodSync(firstTarget, 0o751)
  const secondSource = second.currentPath
  fs.rmSync(secondSource)
  fs.symlinkSync(path.join(root, "missing-second-agent.md"), secondSource)

  assert.throws(
    () => exportAgents([first, second], new Set([first.currentPath, second.currentPath])),
    /Refusing to export symlink or non-regular agent file/
  )
  assert.equal(fs.readFileSync(firstTarget, "utf8"), "previous export\n")
  assertPosixMode(fs.statSync(firstTarget).mode & 0o7777, 0o751)
})

test("preview and import reject symlinked agent and companion import paths", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-import-symlink-"))
  const xdg = path.join(root, "xdg")
  const opencodeRoot = path.join(xdg, "opencode")
  const workspace = path.join(root, "workspace")
  const outside = path.join(root, "outside.md")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = xdg
  fixtureAgent(path.join(workspace, "general/agents/slides-orchestrator.md"), workspace, "test/model")
  fs.mkdirSync(path.join(opencodeRoot, "agents"), { recursive: true })
  fs.writeFileSync(outside, "outside content\n")
  fs.symlinkSync(outside, path.join(opencodeRoot, "agents/slides-orchestrator.md"))
  assert.throws(() => previewImport(workspace), /symlink|non-regular/i)
  assert.throws(() => importAgents(workspace), /symlink|non-regular/i)

  fs.rmSync(path.join(opencodeRoot, "agents/slides-orchestrator.md"))
  fs.writeFileSync(path.join(opencodeRoot, "agents/slides-orchestrator.md"), "changed agent\n")
  const resourceSource = path.join(opencodeRoot, "tools/slides/build.ts")
  fs.mkdirSync(path.dirname(resourceSource), { recursive: true })
  fs.writeFileSync(resourceSource, "exported resource\n")
  const localTools = path.join(workspace, "general/tools")
  fs.symlinkSync(path.join(root, "outside-tools"), localTools)
  assert.throws(() => previewImport(workspace), /symlink/i)
  assert.throws(() => importAgents(workspace), /symlink/i)
})

test("CLI import --dry-run reports companion changes without modifying general/ or creating backups", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-import-cli-dry-run-"))
  const xdg = path.join(root, "xdg")
  const workspace = path.join(root, "workspace")
  const agentPath = path.join(workspace, "general", "agents", "slides-orchestrator.md")
  const localResource = path.join(workspace, "general", "tools", "slides", "build.ts")
  const exportedAgent = path.join(xdg, "opencode", "agents", "slides-orchestrator.md")
  const exportedResource = path.join(xdg, "opencode", "tools", "slides", "build.ts")
  const content = "---\ndescription: Test agent\n---\n\nBody\n"
  fs.mkdirSync(path.dirname(agentPath), { recursive: true })
  fs.mkdirSync(path.dirname(localResource), { recursive: true })
  fs.mkdirSync(path.dirname(exportedAgent), { recursive: true })
  fs.mkdirSync(path.dirname(exportedResource), { recursive: true })
  fs.writeFileSync(agentPath, content)
  fs.writeFileSync(exportedAgent, content)
  fs.writeFileSync(localResource, "local companion version\n")
  fs.writeFileSync(exportedResource, "local companion version\n")

  const runDryRun = () => spawnSync(process.execPath, [path.resolve("manage-agents.mjs"), "import", "--dry-run"], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: xdg }
  })

  const inSync = runDryRun()
  assert.equal(inSync.status, 0, inSync.stderr)
  assert.match(inSync.stdout, /No changes to import/)
  assert.equal(fs.existsSync(path.join(workspace, "backups")), false)

  fs.writeFileSync(exportedResource, "exported companion version\n")
  const changed = runDryRun()
  assert.equal(changed.status, 0, changed.stderr)
  assert.match(changed.stdout, /Preview: 0 agent\(s\), 1 companion resource\(s\) will be imported\./)
  assert.match(changed.stdout, /modified resource: general[\\/]tools[\\/]slides[\\/]build\.ts/)
  assert.equal(fs.readFileSync(localResource, "utf8"), "local companion version\n", "dry-run must not modify general/")
  assert.equal(fs.existsSync(path.join(workspace, "backups")), false, "dry-run must not create backups")
})

test("export without a resource source root installs no companion resources and uses XDG destination", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-no-resource-export-"))
  const xdg = path.join(root, "custom-xdg")
  const opencodeRoot = path.join(xdg, "opencode")
  const destination = path.join(opencodeRoot, "agents")
  const workspace = path.join(root, "workspace")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = xdg

  const docsAgent = fixtureAgent(path.join(workspace, "general/agents/docs-writer.md"), workspace, "test/model")
  fs.mkdirSync(path.join(opencodeRoot, "skills", "slides-design"), { recursive: true })
  fs.mkdirSync(path.join(opencodeRoot, "tools", "slides"), { recursive: true })
  fs.writeFileSync(path.join(opencodeRoot, "skills", "slides-design", "SKILL.md"), "keep skill\n")
  fs.writeFileSync(path.join(opencodeRoot, "tools", "slides", "existing.py"), "keep tool\n")

  const result = exportAgents([docsAgent], new Set([docsAgent.currentPath]))

  assert.equal(result.destinationPath, destination)
  assert.deepEqual(result.exported, [docsAgent.filename])
  assert.deepEqual(result.domainResources, [])
  assert.equal(result.domainBackupPath, null)
  assert.equal(fs.readFileSync(path.join(opencodeRoot, "skills", "slides-design", "SKILL.md"), "utf8"), "keep skill\n")
  assert.equal(fs.readFileSync(path.join(opencodeRoot, "tools", "slides", "existing.py"), "utf8"), "keep tool\n")
})

test("export bundles tools, commands and skills for any domain by directory prefix", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-generic-export-"))
  const xdg = path.join(root, "custom-xdg")
  const opencodeRoot = path.join(xdg, "opencode")
  const sourceRoot = path.join(root, "source")
  const workspace = path.join(root, "workspace")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = xdg

  const slidesAgent = fixtureAgent(path.join(workspace, "general/agents/slides-orchestrator.md"), workspace, "test/model")
  for (const [rel, contents] of [
    ["tools/slides/build.py", "slides tool\n"],
    ["commands/slides/new.md", "slides command\n"],
    ["skills/slides-design/SKILL.md", "slides design skill\n"],
    ["skills/docs-html/SKILL.md", "unrelated docs skill\n"],
    ["tools/presentation/render.py", "unrelated tool\n"],
  ]) {
    const source = path.join(sourceRoot, rel)
    fs.mkdirSync(path.dirname(source), { recursive: true })
    fs.writeFileSync(source, contents)
  }

  const result = exportAgents([slidesAgent], new Set([slidesAgent.currentPath]), sourceRoot)

  assert.deepEqual(result.exported, [slidesAgent.filename])
  assert.equal(fs.readFileSync(path.join(opencodeRoot, "tools", "slides", "build.py"), "utf8"), "slides tool\n")
  assert.equal(fs.readFileSync(path.join(opencodeRoot, "commands", "slides", "new.md"), "utf8"), "slides command\n")
  assert.equal(fs.readFileSync(path.join(opencodeRoot, "skills", "slides-design", "SKILL.md"), "utf8"), "slides design skill\n")
  assert.equal(fs.existsSync(path.join(opencodeRoot, "skills", "docs-html", "SKILL.md")), false, "another domain's skills must not be bundled")
  assert.equal(fs.existsSync(path.join(opencodeRoot, "tools", "presentation", "render.py")), false, "a tool dir not named after the domain must not be bundled")
  assert.equal(result.domainBackupPath, null, "no replacements means no backup")
  assert.ok(result.domainResources.includes(path.join(opencodeRoot, "tools", "slides", "build.py")))
  assert.ok(result.domainResources.includes(path.join(opencodeRoot, "commands", "slides", "new.md")))
  assert.ok(result.domainResources.includes(path.join(opencodeRoot, "skills", "slides-design", "SKILL.md")))
})

test("export does not install domain resources when the matching agent copy fails", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-failed-copy-export-"))
  const xdg = path.join(root, "xdg")
  const opencodeRoot = path.join(xdg, "opencode")
  const sourceRoot = path.join(root, "source")
  const workspace = path.join(root, "workspace")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = xdg

  const slidesAgent = fixtureAgent(path.join(workspace, "general/agents/slides-orchestrator.md"), workspace, "test/model")
  const sourceTool = path.join(sourceRoot, "tools", "slides", "build.py")
  fs.mkdirSync(path.dirname(sourceTool), { recursive: true })
  fs.writeFileSync(sourceTool, "slides tool\n")

  const copyFileSync = fs.copyFileSync
  t.mock.method(fs, "copyFileSync", function (source: fs.PathLike, destination: fs.PathLike, mode?: number) {
    if (source === slidesAgent.currentPath) throw new Error("simulated agent copy failure")
    return copyFileSync.call(fs, source, destination, mode)
  })

  const result = exportAgents([slidesAgent], new Set([slidesAgent.currentPath]), sourceRoot)

  assert.deepEqual(result.exported, [])
  assert.match(result.skipped[0] ?? "", /simulated agent copy failure/)
  assert.equal(fs.existsSync(path.join(opencodeRoot, "tools", "slides", "build.py")), false, "resources must not be installed without their agent")
})

test("resource discovery lists skills, tool families and tools, MCP servers, and companion files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-resource-catalog-"))
  const workspace = path.join(root, "workspace")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg")

  const agent = fixtureAgent(path.join(workspace, "general/agents/slides-orchestrator.md"), workspace, "test/model")
  const permission = {
    read: "allow",
    skill: { "*": "allow", "missing-skill": "allow" },
    "slide_*": "allow",
    slide_build: "deny",
    "doc_*": "deny",
    "chrome-devtools_*": "allow",
    "unknown-mcp_*": "deny"
  }
  saveAgentFile(agent.currentPath, { ...agent.frontmatter, permission }, agent.body)
  const updatedAgent = parseAgentFile(agent.currentPath, workspace)!

  for (const skill of ["slides-design", "slides-composition", "other-skill"]) {
    const skillPath = path.join(workspace, "general/skills", skill, "SKILL.md")
    fs.mkdirSync(path.dirname(skillPath), { recursive: true })
    fs.writeFileSync(skillPath, `# ${skill}\n`)
  }
  fs.mkdirSync(path.join(workspace, "general/tools"), { recursive: true })
  for (const [tool, contents] of Object.entries({
    "slide_build.ts": "export default {}\n",
    "slide_preview.ts": "export default {}\n",
    "doc_render.ts": "export default {}\n"
  })) fs.writeFileSync(path.join(workspace, "general/tools", tool), contents)

  const opencodePath = path.join(workspace, "general/opencode.json")
  fs.mkdirSync(path.dirname(opencodePath), { recursive: true })
  const opencodeRawContent = JSON.stringify({ mcp: {
    "chrome-devtools": { type: "local", command: ["devtools"], enabled: false },
    "another-server": { type: "local", command: ["another"], enabled: true }
  } }, null, 2)
  fs.writeFileSync(opencodePath, opencodeRawContent)

  const catalog = discoverAgentResources(workspace, updatedAgent, [updatedAgent])

  assert.equal(catalog.skills[0].kind, "skill-wildcard")
  assert.equal(catalog.skills[0].permissionKey, "*")
  assert.equal(catalog.skills[0].allowed, true)
  const discoveredSkill = catalog.skills.find(resource => resource.name === "slides-design")
  assert.ok(discoveredSkill)
  assert.equal(discoveredSkill.kind, "skill")
  assert.equal(discoveredSkill.exists, true)
  assert.equal(discoveredSkill.allowed, true)
  assert.ok(discoveredSkill.relativePath?.endsWith(path.join("skills", "slides-design", "SKILL.md")))
  const deadSkill = catalog.skills.find(resource => resource.name === "missing-skill")
  assert.ok(deadSkill)
  assert.equal(deadSkill.exists, false)
  assert.equal(deadSkill.allowed, true)

  const slideFamily = catalog.tools.find(resource => resource.kind === "tool-family" && resource.permissionKey === "slide_*")
  const docFamily = catalog.tools.find(resource => resource.kind === "tool-family" && resource.permissionKey === "doc_*")
  const slideBuild = catalog.tools.find(resource => resource.kind === "tool" && resource.name.includes("slide_build"))
  const slidePreview = catalog.tools.find(resource => resource.kind === "tool" && resource.name.includes("slide_preview"))
  assert.ok(slideFamily)
  assert.equal(slideFamily.allowed, true)
  assert.ok(docFamily)
  assert.equal(docFamily.allowed, false)
  assert.ok(slideBuild)
  assert.equal(slideBuild.allowed, false, "individual permission overrides its family")
  assert.ok(slidePreview)
  assert.equal(slidePreview.allowed, true, "individual tools inherit the family permission")
  assert.equal(slidePreview.familyKey, "slide_*")

  const configuredMcp = catalog.mcpServers.find(resource => resource.serverKey === "chrome-devtools")
  assert.ok(configuredMcp)
  assert.equal(configuredMcp.configuredInOpencode, true)
  assert.equal(configuredMcp.serverEnabled, false)
  assert.equal(configuredMcp.allowed, true)
  const unconfiguredMcp = catalog.mcpServers.find(resource => resource.serverKey === "unknown-mcp")
  assert.ok(unconfiguredMcp)
  assert.equal(unconfiguredMcp.configuredInOpencode, false)
  assert.equal(unconfiguredMcp.allowed, false)
  assert.equal(catalog.opencodeRawContent, opencodeRawContent)
  assert.ok(catalog.companionFiles.some(file => file.replace(/\\/g, "/").endsWith("tools/slide_build.ts")))
})

test("resource updates preserve the supported skill wildcard permission forms", () => {
  const cases = [
    { all: true, skillNames: [], allowedNames: [], expected: { "*": "allow" } },
    { all: true, skillNames: ["checked", "unchecked"], allowedNames: ["checked"], expected: { "*": "allow", unchecked: "deny" } },
    { all: false, allowedNames: ["checked"], expected: { "*": "deny", checked: "allow" } },
    { all: false, allowedNames: [], expected: "deny" }
  ]

  for (const [index, item] of cases.entries()) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `agent-skill-resource-${index}-`))
    const agent = fixtureAgent(path.join(workspace, "general/agents/example.md"), workspace, "test/model")
    for (const name of item.skillNames ?? (item.allowedNames.length ? item.allowedNames : [])) {
      const skillPath = path.join(workspace, "general/skills", name, "SKILL.md")
      fs.mkdirSync(path.dirname(skillPath), { recursive: true })
      fs.writeFileSync(skillPath, `# ${name}\n`)
    }
    const originalPermission = { read: "allow", skill: "ask", bash: "deny" }
    saveAgentFile(agent.currentPath, { ...agent.frontmatter, permission: originalPermission }, agent.body)
    const updatedAgent = parseAgentFile(agent.currentPath, workspace)!
    const catalog = discoverAgentResources(workspace, updatedAgent)

    updateAgentResourcesAndMcp(workspace, updatedAgent, catalog, {
      skills: { all: item.all, allowedNames: item.allowedNames }
    })

    const saved = parseAgentFile(agent.currentPath, workspace)!
    assert.deepEqual(saved.frontmatter.permission.skill, item.expected)
    assert.equal(saved.frontmatter.permission.read, "allow")
    assert.equal(saved.frontmatter.permission.bash, "deny")
  }
})

test("resource updates order tool family rules before overrides and update configured MCP state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-resource-update-"))
  const workspace = path.join(root, "workspace")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg")
  const agent = fixtureAgent(path.join(workspace, "general/agents/slides-orchestrator.md"), workspace, "test/model")
  const originalPermission = {
    read: "allow", bash: "deny", task: { helper: "allow" },
    skill: { "*": "deny" }, "slide_*": "deny", slide_build: "allow", "chrome-devtools_*": "deny"
  }
  saveAgentFile(agent.currentPath, { ...agent.frontmatter, permission: originalPermission }, agent.body)
  const updatedAgent = parseAgentFile(agent.currentPath, workspace)!
  const selectedSkillPath = path.join(workspace, "general/skills/selected-skill/SKILL.md")
  fs.mkdirSync(path.dirname(selectedSkillPath), { recursive: true })
  fs.writeFileSync(selectedSkillPath, "# selected-skill\n")
  fs.mkdirSync(path.join(workspace, "general/tools"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "general/tools/slide_build.ts"), "export default {}\n")
  const opencodePath = path.join(workspace, "general/opencode.json")
  fs.mkdirSync(path.dirname(opencodePath), { recursive: true })
  fs.writeFileSync(opencodePath, JSON.stringify({ mcp: { "chrome-devtools": { enabled: false } } }))
  const catalog = discoverAgentResources(workspace, updatedAgent)

  const result = updateAgentResourcesAndMcp(workspace, updatedAgent, catalog, {
    skills: { all: false, allowedNames: ["selected-skill"] },
    permissions: { "slide_*": true, slide_build: false, "chrome-devtools_*": true },
    mcpEnabled: { "chrome-devtools": true }
  })

  const saved = parseAgentFile(agent.currentPath, workspace)!
  assert.deepEqual(Object.keys(saved.frontmatter.permission).slice(0, 2), ["read", "bash"])
  const updatedKeys = Object.keys(saved.frontmatter.permission)
  assert.ok(updatedKeys.indexOf("slide_*") < updatedKeys.indexOf("slide_build"))
  assert.equal(saved.frontmatter.permission["slide_*"], "allow")
  assert.equal(saved.frontmatter.permission.slide_build, "deny")
  assert.equal(saved.frontmatter.permission["chrome-devtools_*"], "allow")
  assert.deepEqual(saved.frontmatter.permission.task, { helper: "allow" })
  assert.equal(saved.frontmatter.permission.read, "allow")
  assert.equal(saved.frontmatter.permission.bash, "deny")
  assert.deepEqual(JSON.parse(fs.readFileSync(opencodePath, "utf8")).mcp["chrome-devtools"], { enabled: true })
  assert.ok(result.changedPaths.includes(agent.currentPath))
  assert.ok(result.changedPaths.includes(opencodePath))
})

test("resource updates no-op on empty changes and reject unconfigured MCP edits", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-resource-noop-"))
  const agent = fixtureAgent(path.join(workspace, "general/agents/example.md"), workspace, "test/model")
  fs.mkdirSync(path.join(workspace, "general/tools"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "general/tools/example_tool.ts"), "export default {}\n")
  const catalog = discoverAgentResources(workspace, agent)
  const original = fs.readFileSync(agent.currentPath)

  const result = updateAgentResourcesAndMcp(workspace, agent, catalog, {})

  assert.deepEqual(result, { changedPaths: [] })
  assert.deepEqual(fs.readFileSync(agent.currentPath), original)
  assert.throws(() => updateAgentResourcesAndMcp(workspace, agent, catalog, {
    mcpEnabled: { "not-configured": true }
  }), /unconfigured|configured/i)
  assert.deepEqual(fs.readFileSync(agent.currentPath), original)
})

test("resource update restores agent.currentPath and bytes when opencode write fails", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-resource-rollback-"))
  const workspace = path.join(root, "workspace")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg")
  const agent = fixtureAgent(path.join(workspace, "general/agents/slides-orchestrator.md"), workspace, "test/model")
  fs.mkdirSync(path.join(workspace, "general/tools"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "general/tools/slide_build.ts"), "export default {}\n")
  const opencodePath = path.join(workspace, "general/opencode.json")
  fs.mkdirSync(path.dirname(opencodePath), { recursive: true })
  fs.writeFileSync(opencodePath, JSON.stringify({ mcp: { server: { enabled: false } } }))
  const catalog = discoverAgentResources(workspace, agent)
  const originalAgentPath = agent.currentPath
  const originalAgentBytes = fs.readFileSync(originalAgentPath)
  const originalConfigBytes = fs.readFileSync(opencodePath)
  const writeFileSync = fs.writeFileSync
  const renameSync = fs.renameSync
  t.mock.method(fs, "writeFileSync", function (filePath: fs.PathLike, ...args: any[]) {
    if (filePath === opencodePath) throw new Error("simulated opencode write failure")
    return (writeFileSync as any).call(fs, filePath, ...args)
  })
  t.mock.method(fs, "renameSync", function (oldPath: fs.PathLike, newPath: fs.PathLike) {
    if (newPath === opencodePath) throw new Error("simulated opencode write failure")
    return renameSync.call(fs, oldPath, newPath)
  })

  assert.throws(() => updateAgentResourcesAndMcp(workspace, agent, catalog, {
    permissions: { "slide_*": true },
    mcpEnabled: { server: true }
  }), /simulated opencode write failure/)

  assert.equal(agent.currentPath, originalAgentPath)
  assert.deepEqual(fs.readFileSync(originalAgentPath), originalAgentBytes)
  assert.deepEqual(fs.readFileSync(opencodePath), originalConfigBytes)
})

test("hybrid companion resources are discovered and exported except for tests", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hybrid-resources-"))
  const xdg = path.join(root, "xdg")
  const opencodeRoot = path.join(xdg, "opencode")
  const sourceRoot = path.join(root, "source")
  const workspace = path.join(root, "workspace")
  const previousXdg = process.env.XDG_CONFIG_HOME
  t.after(() => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
  })
  process.env.XDG_CONFIG_HOME = xdg
  const hybridAgent = fixtureAgent(path.join(workspace, "general/agents/hybrid-orchestrator.md"), workspace, "test/model")
  const resources = [
    "tools/pipeline_state.ts",
    "tools/_pipeline_core.js",
    "tools/_pipeline_run.js",
    "tools/_pipeline_serve.js",
    "skills/code-review-antipatterns/SKILL.md",
    "plugins/pipeline-guard.js"
  ]
  const contents: Record<string, string> = {
    "tools/pipeline_state.ts": 'import "./_pipeline_core.js"\n',
    "tools/_pipeline_core.js": 'import "./_pipeline_run.js"\n',
    "tools/_pipeline_run.js": 'import "./_pipeline_serve.js"\n',
    "tools/_pipeline_serve.js": "pipeline serve dependency\n",
    "skills/code-review-antipatterns/SKILL.md": "review skill\n",
    "plugins/pipeline-guard.js": "pipeline plugin\n"
  }
  for (const relative of [...resources, "tools/_pipeline_core.test.mjs"]) {
    for (const base of [sourceRoot, path.join(workspace, "general")]) {
      const source = path.join(base, relative)
      fs.mkdirSync(path.dirname(source), { recursive: true })
      fs.writeFileSync(source, contents[relative] ?? `${relative}\n`)
    }
  }

  const catalog = discoverAgentResources(workspace, hybridAgent)
  for (const relative of resources) {
    assert.ok(catalog.companionFiles.some(file => file.replace(/\\/g, "/").endsWith(relative)), `${relative} should be discovered`)
  }
  assert.equal(catalog.companionFiles.some(file => file.replace(/\\/g, "/").endsWith("tools/_pipeline_core.test.mjs")), false)

  const result = exportAgents([hybridAgent], new Set([hybridAgent.currentPath]), sourceRoot)
  for (const relative of resources) {
    assert.equal(fs.readFileSync(path.join(opencodeRoot, relative), "utf8"), contents[relative])
    assert.ok(result.domainResources.includes(path.join(opencodeRoot, relative)))
  }
  assert.equal(fs.existsSync(path.join(opencodeRoot, "tools/_pipeline_core.test.mjs")), false)
})

test("OpenCode V2 agent updates preserve frontmatter while changing params, model, and resources", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-v2-frontmatter-"))
  const filePath = path.join(workspace, "general/agents/v2-agent.md")
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const frontmatter = {
    name: "v2-agent",
    description: "V2 OpenCode agent",
    mode: "subagent",
    color: "#7c3aed",
    model: "old/model",
    steps: 8,
    request: { body: { temperature: 0.2, top_p: 0.8 } },
    system: "Keep this prompt",
    tools: { read: true, write: false },
    permissions: [
      { action: "read", resource: "*", effect: "allow" },
      { action: "skill", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" }
    ],
    metadata: { owner: "test", nested: { preserve: true } }
  }
  saveAgentFile(filePath, frontmatter, "V2 agent body.")
  let agent = parseAgentFile(filePath, workspace)!
  const preserved = { ...agent.frontmatter }
  fs.mkdirSync(path.join(workspace, "general/skills/selected-skill"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "general/skills/selected-skill/SKILL.md"), "# selected-skill\n")
  fs.mkdirSync(path.join(workspace, "general/tools"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "general/tools/example_tool.ts"), "export default {}\n")
  const catalog = discoverAgentResources(workspace, agent)

  updateAgentParams([agent], { temperature: 0.4 })
  agent = parseAgentFile(filePath, workspace)!
  updateAgentsModel([agent], "new/model", ["new/model"])
  agent = parseAgentFile(filePath, workspace)!
  updateAgentResourcesAndMcp(workspace, agent, catalog, {
    skills: { all: false, allowedNames: ["selected-skill"] }
  })

  const saved = parseAgentFile(filePath, workspace)!
  const savedContent = fs.readFileSync(filePath, "utf8")
  for (const key of ["name", "mode", "color", "top_p", "prompt", "tools", "metadata"]) {
    assert.deepEqual(saved.frontmatter[key], preserved[key], `${key} frontmatter should be preserved`)
  }
  assert.equal(saved.frontmatter.description, preserved.description)
  assert.equal(saved.frontmatter.temperature, 0.4)
  assert.equal(saved.frontmatter.model, "new/model")
  assert.match(savedContent, /action: skill\n\s+resource: selected-skill\n\s+effect: allow/)
  assert.match(savedContent, /action: read\n\s+resource: ["']\*["']\n\s+effect: allow/)
  assert.match(saved.body, /V2 agent body\./)
})
