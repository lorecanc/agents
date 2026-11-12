import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import test from "node:test"
import YAML from "yaml"
import { tempDir, writePack } from "../../test/helpers.js"
import { extractFrontmatter, findAgentFiles, getExportDestination, parseAgentFile, renameAgent, saveAgentFile, repairAgentModels, updateAgentsModel, discoverAgentResources, updateAgentResources, updateAgentParams, applySafetyPreset, AGENT_EFFORT_VARIANTS, inspectTuningTargets, buildTuningUpdateParams } from "./agents.js"
import { AUTO_COMMIT_MESSAGES, repositoryTransaction } from "./repositoryTransaction.js"

type PackFixture = { manifest?: Record<string, unknown>; files?: Record<string, string> }

function catalog(t: test.TestContext, prefix = "agent-catalog-", packs: Record<string, PackFixture> = { demo: {} }) {
  const root = tempDir(t, prefix)
  for (const [name, pack] of Object.entries(packs)) writePack(path.join(root, "packs", name), pack.files ?? {}, { name, ...pack.manifest })
  return root
}

const agentPath = (root: string, name: string, pack = "demo") => path.join(root, "packs", pack, "agents", `${name}.md`)

function fixtureAgent(filePath: string, workspace: string, model: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const frontmatter: any = { description: "x" }
  if (model !== undefined) frontmatter.model = model
  saveAgentFile(filePath, frontmatter, "body")
  return parseAgentFile(filePath, workspace)!
}

function globalDenyAgent(workspace: string, name = "pipeline-executor", body = "Agent body.") {
  const filePath = agentPath(workspace, name)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  saveAgentFile(filePath, {
    description: "Global deny",
    model: "test/model",
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" }
    ]
  }, body)
  return { filePath, agent: parseAgentFile(filePath, workspace)! }
}

function assertGlobalDenyFirst(filePath: string) {
  const permissions = YAML.parse(extractFrontmatter(fs.readFileSync(filePath, "utf8")).yamlText!).permissions
  assert.deepEqual(permissions[0], { action: "*", resource: "*", effect: "deny" })
  assert.equal(permissions.filter((rule: any) => rule.action === "*").length, 1)
}

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
}

function assertPosixMode(actual: number, expected: number) {
  if (process.platform !== "win32") assert.equal(actual, expected)
}

function setAutoCommit(t: test.TestContext, value: string | undefined) {
  const previous = process.env.AGENT_MANAGER_AUTO_COMMIT
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_MANAGER_AUTO_COMMIT
    else process.env.AGENT_MANAGER_AUTO_COMMIT = previous
  })
  if (value === undefined) delete process.env.AGENT_MANAGER_AUTO_COMMIT
  else process.env.AGENT_MANAGER_AUTO_COMMIT = value
}

function gitAgentRepository(t: test.TestContext) {
  const root = fs.realpathSync(catalog(t, "agent-model-git-"))
  git(root, "init", "-q")
  git(root, "config", "user.name", "Test")
  git(root, "config", "user.email", "test@example.com")
  const paths = ["one", "two"].map(name => agentPath(root, name))
  for (const [index, filePath] of paths.entries()) fixtureAgent(filePath, root, `old/model-${index}`)
  git(root, "add", ".")
  git(root, "commit", "-qm", "initial")
  return { root, paths }
}

function userConfig(t: test.TestContext, config?: unknown) {
  const xdg = tempDir(t, "agent-xdg-")
  const configPath = path.join(xdg, "opencode", "opencode.json")
  if (config !== undefined) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config, null, 2))
  }
  return { env: { XDG_CONFIG_HOME: xdg }, configPath }
}

function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else snapshot[path.relative(root, full)] = fs.readFileSync(full, "utf8")
    }
  }
  walk(root)
  return snapshot
}

test("grouped model repair validates all groups and applies one old value to N agents", (t) => {
  const workspace = catalog(t, "agent-repair-")
  const a = fixtureAgent(agentPath(workspace, "a"), workspace, "bad/model")
  const b = fixtureAgent(agentPath(workspace, "b"), workspace, "bad/model")
  const c = fixtureAgent(agentPath(workspace, "c"), workspace, "other/model")
  const result = repairAgentModels([a, b, c], [
    { oldModel: "bad/model", newModel: "real/one", agentPaths: [a.currentPath, b.currentPath] },
    { oldModel: "other/model", newModel: "real/two", agentPaths: [c.currentPath] }
  ], ["real/one", "real/two"])
  assert.deepEqual(result, { groups: 2, agentsChanged: 3 })
  assert.equal(parseAgentFile(a.currentPath, workspace)!.model, "real/one")
})

test("model update applies atomically to two agents and synchronizes memory", (t) => {
  const workspace = catalog(t, "agent-update-")
  const a = fixtureAgent(agentPath(workspace, "a"), workspace, "old/model")
  const b = fixtureAgent(agentPath(workspace, "b"), workspace, "old/model")

  updateAgentsModel([a, b], "new/model", ["new/model"])

  for (const agent of [a, b]) {
    assert.equal(agent.model, "new/model")
    assert.equal(agent.frontmatter.model, "new/model")
    assert.equal(agent.rawContent, fs.readFileSync(agent.currentPath, "utf8"))
    assert.equal(parseAgentFile(agent.currentPath, workspace)!.model, "new/model")
  }
})

test("model update uses one repository transaction for real agent files", (t) => {
  const { root, paths } = gitAgentRepository(t)
  const agents = paths.map(filePath => parseAgentFile(filePath, root)!)
  const head = git(root, "rev-parse", "HEAD")
  setAutoCommit(t, "1")

  const result = repositoryTransaction(root, paths, AUTO_COMMIT_MESSAGES.tune, () => {
    updateAgentsModel(agents, "verified/model", ["verified/model"])
  })

  assert.equal(result.commit, "committed")
  assert.ok(result.commitHash)
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "2")
  assert.notEqual(git(root, "rev-parse", "HEAD"), head)
  assert.equal(git(root, "show", "--format=", "--name-only", "HEAD"), "packs/demo/agents/one.md\npacks/demo/agents/two.md")
  assert.equal(git(root, "status", "--porcelain"), "")
  for (const filePath of paths) assert.equal(parseAgentFile(filePath, root)!.model, "verified/model")
})

test("dirty unrelated work is preserved and model transaction does not stage it", (t) => {
  const { root, paths } = gitAgentRepository(t)
  const agents = paths.map(filePath => parseAgentFile(filePath, root)!)
  const unrelated = path.join(root, "unrelated.txt")
  fs.writeFileSync(unrelated, "keep dirty\n")
  setAutoCommit(t, "1")

  const result = repositoryTransaction(root, paths, AUTO_COMMIT_MESSAGES.tune, () => updateAgentsModel(agents, "verified/model", ["verified/model"]))

  assert.equal(result.commit, "skipped")
  assert.equal(result.warning?.code, "dirty-repository")
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "1")
  assert.equal(git(root, "diff", "--cached", "--name-only"), "")
  assert.equal(fs.readFileSync(unrelated, "utf8"), "keep dirty\n")
  for (const filePath of paths) assert.equal(parseAgentFile(filePath, root)!.model, "verified/model")
})

test("dirty auto-commit updates both real model files, skips with a warning, and does not stage them", (t) => {
  const { root, paths } = gitAgentRepository(t)
  const agents = paths.map(filePath => parseAgentFile(filePath, root)!)
  fs.writeFileSync(path.join(root, "unrelated.txt"), "pre-existing work\n")
  setAutoCommit(t, "1")

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

test("CLI auto-commit warnings are written to stderr only", (t) => {
  const { root } = gitAgentRepository(t)
  fs.writeFileSync(path.join(root, "unrelated.txt"), "dirty\n")
  const cli = spawnSync(process.execPath, [path.resolve("manage-agents.mjs"), "tune", "--steps", "10"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, AGENT_MANAGER_AUTO_COMMIT: "1", MANAGE_AGENTS_WORKSPACE: root }
  })

  assert.equal(cli.status, 0, cli.stderr)
  assert.match(cli.stderr, /AUTO-COMMIT WARNING:/)
  assert.doesNotMatch(cli.stdout, /AUTO-COMMIT WARNING:/)
})

test("index.lock failure returns a warning without throwing and keeps both model files", (t) => {
  const { root, paths } = gitAgentRepository(t)
  const agents = paths.map(filePath => parseAgentFile(filePath, root)!)
  setAutoCommit(t, "1")
  const indexLock = path.join(root, ".git", "index.lock")

  const result = repositoryTransaction(root, paths, AUTO_COMMIT_MESSAGES.tune, () => {
    updateAgentsModel(agents, "verified/model", ["verified/model"])
    fs.writeFileSync(indexLock, "held\n")
  })

  assert.equal(result.commit, "failed")
  assert.equal(result.warning?.code, "git-failure")
  for (const filePath of paths) assert.equal(parseAgentFile(filePath, root)!.model, "verified/model")
  assert.match(git(root, "status", "--porcelain"), /packs\/demo\/agents\/(one|two)\.md/)
  fs.rmSync(indexLock)
})

test("model transaction stays dirty when auto-commit is disabled", (t) => {
  const { root, paths } = gitAgentRepository(t)
  const agents = paths.map(filePath => parseAgentFile(filePath, root)!)
  setAutoCommit(t, undefined)

  const result = repositoryTransaction(root, paths, AUTO_COMMIT_MESSAGES.tune, () => updateAgentsModel(agents, "verified/model", ["verified/model"]))

  assert.equal(result.commit, "off")
  assert.equal(git(root, "rev-list", "--count", "HEAD"), "1")
  assert.match(git(root, "status", "--porcelain"), /packs\/demo\/agents\/(one|two)\.md/)
  for (const filePath of paths) assert.equal(parseAgentFile(filePath, root)!.model, "verified/model")
})

test("model update restores both raw files and in-memory agents when the second writer fails", (t) => {
  const workspace = catalog(t, "agent-update-")
  const a = fixtureAgent(agentPath(workspace, "a"), workspace, "old/one")
  const b = fixtureAgent(agentPath(workspace, "b"), workspace, "old/two")
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

test("atomic agent writes preserve mode and clean temporary siblings", (t) => {
  const workspace = tempDir(t, "agent-atomic-")
  const filePath = path.join(workspace, "agent.md")
  fs.writeFileSync(filePath, "old\n")
  fs.chmodSync(filePath, 0o755)
  saveAgentFile(filePath, { description: "x" }, "new")
  assertPosixMode(fs.statSync(filePath).mode & 0o7777, 0o755)
  assert.deepEqual(fs.readdirSync(workspace).filter(name => name.endsWith(".tmp")), [])
})

test("rollback conflict preserves bytes changed after the manager write", (t) => {
  const workspace = catalog(t, "agent-rollback-conflict-")
  const agent = fixtureAgent(agentPath(workspace, "a"), workspace, "old/model")
  const original = fs.readFileSync(agent.currentPath)
  assert.throws(() => updateAgentsModel([agent], "new/model", ["new/model"], (filePath, frontmatter, body) => {
    saveAgentFile(filePath, frontmatter, body)
    fs.writeFileSync(filePath, "external change\n")
    throw new Error("writer failed")
  }), /rollback incomplete: .*rollback conflict: file changed after manager write/)
  assert.notDeepEqual(fs.readFileSync(agent.currentPath), original)
  assert.equal(fs.readFileSync(agent.currentPath, "utf8"), "external change\n")
})

test("grouped repair synchronizes raw content for an immediate second repair", (t) => {
  const workspace = catalog(t, "agent-repair-")
  const agent = fixtureAgent(agentPath(workspace, "a"), workspace, "bad/model")
  const mappings = [{ oldModel: "bad/model", newModel: "real/one", agentPaths: [agent.currentPath] }]

  repairAgentModels([agent], mappings, ["real/one", "real/two"])
  assert.equal(agent.rawContent, fs.readFileSync(agent.currentPath, "utf8"))

  repairAgentModels([agent], [{ oldModel: "real/one", newModel: "real/two", agentPaths: [agent.currentPath] }], ["real/one", "real/two"])
  assert.equal(agent.rawContent, fs.readFileSync(agent.currentPath, "utf8"))
})

test("grouped repair rejects invented or stale values before writing", (t) => {
  const workspace = catalog(t, "agent-repair-")
  const a = fixtureAgent(agentPath(workspace, "a"), workspace, "bad/model")
  const b = fixtureAgent(agentPath(workspace, "b"), workspace, "bad/model")
  const original = fs.readFileSync(a.currentPath, "utf8")
  assert.throws(() => repairAgentModels([a, b], [{ oldModel: "bad/model", newModel: "made/up", agentPaths: [a.currentPath, b.currentPath] }], ["real/one"]))
  fs.writeFileSync(b.currentPath, fs.readFileSync(b.currentPath, "utf8").replace("bad/model", "changed/model"))
  assert.throws(() => repairAgentModels([a, b], [{ oldModel: "bad/model", newModel: "real/one", agentPaths: [a.currentPath, b.currentPath] }], ["real/one"]))
  assert.equal(fs.readFileSync(a.currentPath, "utf8"), original)
})

test("grouped repair rejects body changes with an unchanged model before writing", (t) => {
  const workspace = catalog(t, "agent-repair-")
  const a = fixtureAgent(agentPath(workspace, "a"), workspace, "bad/model")
  const b = fixtureAgent(agentPath(workspace, "b"), workspace, "bad/model")
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

test("grouped repair rolls back a writer that changes a file before throwing", (t) => {
  const workspace = catalog(t, "agent-repair-")
  const agent = fixtureAgent(agentPath(workspace, "a"), workspace, "bad/model")
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

test("grouped repair rolls back all attempted files and memory after a later writer fails", (t) => {
  const workspace = catalog(t, "agent-repair-")
  const a = fixtureAgent(agentPath(workspace, "a"), workspace, "bad/model")
  const b = fixtureAgent(agentPath(workspace, "b"), workspace, "other/model")
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
  const workspace = catalog(t, "agent-repair-")
  const a = fixtureAgent(agentPath(workspace, "a"), workspace, "bad/model")
  const b = fixtureAgent(agentPath(workspace, "b"), workspace, "other/model")
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
  t.mock.restoreAll()
  assert.notDeepEqual(fs.readFileSync(a.currentPath), originalA)
  assert.deepEqual(fs.readFileSync(b.currentPath), originalB)
  assert.equal(a.model, "bad/model")
  assert.equal(b.model, "other/model")
})

test("agent save is idempotent and keeps one blank line after frontmatter", (t) => {
  const workspace = catalog(t, "agent-save-workspace-")
  const filePath = agentPath(workspace, "example")
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

test("V1 frontmatter renders as V2 at the write boundary", (t) => {
  const workspace = catalog(t, "agent-v1-to-v2-")
  const filePath = agentPath(workspace, "v1-source")
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, [
    "---",
    "description: V1 source",
    "model: test/model",
    "max_steps: 7",
    "temperature: 0.3",
    "top_p: 0.8",
    "permission:",
    "  read: allow",
    "variant: high",
    "---",
    "",
    "Agent body."
  ].join("\n"))

  const agent = parseAgentFile(filePath, workspace)!
  assert.equal(agent.frontmatterVersion, "v1")
  saveAgentFile(filePath, agent.frontmatter, agent.body, agent.frontmatterVersion)

  const content = fs.readFileSync(filePath, "utf8")
  assert.match(content, /\npermissions:\n  - action: read\n/)
  assert.doesNotMatch(content, /\npermission:/)
  assert.doesNotMatch(content, /\ntemperature:/)
  assert.doesNotMatch(content, /\ntop_p:/)
  assert.doesNotMatch(content, /\nvariant:/)
  assert.match(content, /\nsteps: 7\n/)
  assert.doesNotMatch(content, /\nrequest:/)
  assert.match(content, /\nmodel: test\/model#high\n/)
})

test("V2 frontmatter round-trips without losing V2 fields", (t) => {
  const workspace = catalog(t, "agent-v2-roundtrip-")
  const filePath = agentPath(workspace, "v2-source")
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const permissions = [
    { action: "read", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "deny" }
  ]
  saveAgentFile(filePath, {
    description: "V2 source",
    model: "test/model",
    steps: 8,
    temperature: 0.1,
    top_p: 0.7,
    request: { body: { temperature: 0.2, top_p: 0.8 } },
    system: "Keep this prompt",
    permissions
  }, "V2 agent body.")

  const agent = parseAgentFile(filePath, workspace)!
  assert.equal(agent.frontmatterVersion, "v2")
  saveAgentFile(filePath, agent.frontmatter, agent.body)

  const saved = parseAgentFile(filePath, workspace)!
  assert.equal(saved.frontmatterVersion, "v2")
  assert.equal(saved.frontmatter.max_steps, 8)
  assert.equal(saved.frontmatter.temperature, undefined)
  assert.equal(saved.frontmatter.top_p, undefined)
  assert.equal(saved.frontmatter.request, undefined)
  assert.equal(saved.frontmatter.prompt, "Keep this prompt")
  assert.deepEqual(saved.frontmatter.permission, {
    read: "allow",
    bash: "deny"
  })
})

test("variant composition appends model#variant exactly once", (t) => {
  const workspace = catalog(t, "agent-variant-once-")
  const filePath = agentPath(workspace, "a")
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  saveAgentFile(filePath, { description: "Example", model: "test/model", variant: "high" }, "Agent body.")

  let content = fs.readFileSync(filePath, "utf8")
  assert.equal(content.match(/test\/model#high/g)?.length, 1)
  assert.doesNotMatch(content, /#high#/)

  const agent = parseAgentFile(filePath, workspace)!
  updateAgentParams([agent], { variant: "high" })
  updateAgentParams([agent], { variant: "high" })
  content = fs.readFileSync(filePath, "utf8")
  assert.equal((content.match(/#/g) ?? []).length, 1)
  assert.match(content, /\nmodel: test\/model#high\n/)
})

test("rename keeps V2 frontmatter instead of downgrading it", (t) => {
  const workspace = catalog(t, "agent-rename-v2-")
  const oldPath = agentPath(workspace, "old")
  const refPath = agentPath(workspace, "ref")
  fs.mkdirSync(path.dirname(oldPath), { recursive: true })
  for (const filePath of [oldPath, refPath]) {
    saveAgentFile(filePath, {
      description: "V2 agent",
      model: "test/model",
      steps: 5,
      request: { body: { temperature: 0.1 } },
      permissions: [{ action: "read", resource: "*", effect: "allow" }]
    }, filePath === refPath ? "Call @old for help." : "Agent body.")
  }
  const agents = findAgentFiles(workspace)

  const result = renameAgent(workspace, oldPath, "new.md", agents)
  assert.equal(result.success, true)

  const refContent = fs.readFileSync(refPath, "utf8")
  assert.match(refContent, /\npermissions:\n/)
  assert.doesNotMatch(refContent, /\npermission:/)
  assert.match(refContent, /@new/)
  assert.equal(parseAgentFile(refPath, workspace)!.frontmatterVersion, "v2")
})

test("rename moves the agent inside its pack, updates task references and creates no backup", (t) => {
  const workspace = catalog(t, "agent-rename-pack-", { demo: {}, other: {} })
  const oldPath = agentPath(workspace, "demo-old")
  const callerPath = agentPath(workspace, "other-lead", "other")
  fs.mkdirSync(path.dirname(oldPath), { recursive: true })
  fs.mkdirSync(path.dirname(callerPath), { recursive: true })
  saveAgentFile(oldPath, { description: "Old", model: "test/model" }, "Agent body.")
  saveAgentFile(callerPath, { description: "Lead", permission: { task: { "*": "deny", "demo-old": "allow" } } }, "Delegate to @demo-old, not @demo-older.")
  const before = new Set(Object.keys(snapshotTree(workspace)))

  const result = renameAgent(workspace, oldPath, "demo-new", findAgentFiles(workspace))

  assert.deepEqual(result, { success: true, updatedReferences: ["other-lead.md"], skipped: [], newPath: agentPath(workspace, "demo-new") })
  assert.equal(fs.existsSync(oldPath), false)
  const caller = parseAgentFile(callerPath, workspace)!
  assert.deepEqual(caller.frontmatter.permission.task, { "*": "deny", "demo-new": "allow" })
  assert.match(caller.body, /@demo-new, not @demo-older\./)
  const after = Object.keys(snapshotTree(workspace))
  assert.deepEqual(after.filter(file => !before.has(file)), [path.join("packs", "demo", "agents", "demo-new.md")])
  assert.throws(() => renameAgent(workspace, callerPath, "../escape.md", findAgentFiles(workspace)), /Invalid filename/)
})

test("export destination always uses XDG_CONFIG_HOME, regardless of platform", (t) => {
  const root = tempDir(t, "agent-destination-")
  const xdg = path.join(root, "xdg")
  const expected = path.join(xdg, "opencode", "agents")
  assert.equal(getExportDestination({ XDG_CONFIG_HOME: xdg }), expected)
  assert.equal(getExportDestination({ XDG_CONFIG_HOME: xdg, APPDATA: path.join(root, "AppData") }), expected)
})

test("export destination treats an empty XDG_CONFIG_HOME as absent", (t) => {
  const root = tempDir(t, "agent-destination-")
  t.mock.method(os, "homedir", () => root)
  assert.equal(getExportDestination({ XDG_CONFIG_HOME: "" }), path.join(root, ".config", "opencode", "agents"))
})

test("export destination uses homedir when XDG_CONFIG_HOME is absent", (t) => {
  const root = tempDir(t, "agent-destination-")
  t.mock.method(os, "homedir", () => root)
  assert.equal(getExportDestination({}), path.join(root, ".config", "opencode", "agents"))
})

test("export destination does not depend on directory existence", (t) => {
  const root = tempDir(t, "agent-destination-")
  t.mock.method(os, "homedir", () => root)
  const expected = path.join(root, ".config", "opencode", "agents")
  assert.equal(getExportDestination({}), expected)
  fs.mkdirSync(expected, { recursive: true })
  assert.equal(getExportDestination({}), expected)
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

test("parseAgentFile parses frontmatter fields from a CRLF agent file", (t) => {
  const workspace = catalog(t, "agent-crlf-")
  const filePath = agentPath(workspace, "crlf-agent")
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

test("in a catalog every agent belongs to its pack, whatever its filename prefix", (t) => {
  const workspace = catalog(t, "agent-category-catalog-", {
    alpha: { files: { "agents/shared-one.md": "---\ndescription: a\n---\n", "agents/alpha-lead.md": "---\ndescription: b\n---\n" } },
    beta: { files: { "agents/shared-two.md": "---\ndescription: c\n---\n" } }
  })
  fs.mkdirSync(path.join(workspace, "agents"), { recursive: true })
  fs.writeFileSync(path.join(workspace, "agents", "stray-agent.md"), "---\ndescription: outside packs\n---\n")

  const agents = findAgentFiles(workspace)

  assert.deepEqual(agents.map(agent => [agent.filename, agent.category]).sort(), [
    ["alpha-lead.md", "alpha"],
    ["shared-one.md", "alpha"],
    ["shared-two.md", "beta"]
  ])
  for (const agent of agents) assert.equal(agent.targetPath, agent.currentPath)
  assert.equal(agents.warnings, undefined)
})

test("in a single pack every agent belongs to the pack named by its manifest", (t) => {
  const workspace = writePack(tempDir(t, "agent-category-single-"), {
    "agents/solo-lead.md": "---\ndescription: a\n---\n",
    "agents/other-helper.md": "---\ndescription: b\n---\n",
    "agents/other-scout.md": "---\ndescription: c\n---\n"
  }, { name: "solo" })

  const agents = findAgentFiles(workspace)

  assert.deepEqual(agents.map(agent => agent.category), ["solo", "solo", "solo"])
  for (const agent of agents) assert.equal(agent.targetPath, agent.currentPath)
})

test("nested agents are found, and a single pack with a packs/ directory is still a single pack", (t) => {
  const workspace = writePack(tempDir(t, "agent-nested-"), {
    "agents/team/solo-lead.md": "---\ndescription: a\n---\n",
    "modes/solo-main.md": "---\ndescription: b\n---\n",
    "packs/notes/readme.md": "not a pack\n"
  }, { name: "solo" })

  const agents = findAgentFiles(workspace)

  assert.deepEqual(agents.map(agent => [agent.filename, agent.category]).sort(), [["solo-lead.md", "solo"], ["solo-main.md", "solo"]])
  assert.equal(agents.find(agent => agent.filename === "solo-main.md")?.frontmatter.mode, "primary")
  assert.equal(parseAgentFile(path.join(workspace, "agents/team/solo-lead.md"), workspace)?.category, "solo")
})

test("a single pack with requires lists its own resources instead of failing on the packs it cannot see", (t) => {
  const workspace = writePack(tempDir(t, "agent-single-requires-"), {
    "agents/solo-lead.md": "---\ndescription: a\n---\n",
    "skills/solo-hello/SKILL.md": "---\ndescription: hi\n---\n"
  }, { name: "solo", requires: { "dev-tools": "^1.0.0" } })
  const [agent] = findAgentFiles(workspace)

  const catalogResources = discoverAgentResources(workspace, agent, [agent], { ...process.env, XDG_CONFIG_HOME: tempDir(t) })

  assert.deepEqual(catalogResources.skills.filter(item => item.kind === "skill").map(item => item.name), ["solo-hello"])
})

test("agent discovery warns on an empty catalog and refuses a source directory outside the workspace", (t) => {
  const workspace = catalog(t, "agent-discovery-")

  assert.deepEqual(findAgentFiles(workspace).warnings?.length, 1)
  assert.throws(() => findAgentFiles(workspace, "../elsewhere"), /sourceDir must stay inside workspace/)
  assert.throws(() => findAgentFiles(workspace, "missing"), /Agent source directory does not exist/)
})

test("agent params set effort variants and preserve other frontmatter and body", (t) => {
  const workspace = catalog(t, "agent-variant-")
  const filePath = agentPath(workspace, "a")
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

test("legacy V1 max_steps survives parsing and writes V2 on tuning updates", (t) => {
  const workspace = catalog(t, "agent-legacy-steps-")
  const filePath = agentPath(workspace, "legacy-agent")
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
  assert.match(content, /\nsteps: 12\n/)
  assert.doesNotMatch(content, /\nmax_steps:/)
  assert.doesNotMatch(content, /\n(?:temperature|top_p|top_k):/)
  assert.doesNotMatch(content, /\nrequest:/)
  assert.equal(parseAgentFile(filePath, workspace)!.frontmatterVersion, "v2")

  updateAgentParams([agent], { steps: 20 })
  content = fs.readFileSync(filePath, "utf8")
  assert.match(content, /\nsteps: 20\n/)
  assert.doesNotMatch(content, /\nmax_steps:/)
  const updated = parseAgentFile(filePath, workspace)!
  assert.equal(updated.frontmatterVersion, "v2")
  assert.equal(updated.frontmatter.max_steps, 20)
  assert.equal(Object.hasOwn(updated.frontmatter, "steps"), false)
})

test("multi-agent parameter tuning summarizes mixed values and only updates dirty fields", (t) => {
  const workspace = catalog(t, "agent-multi-tuning-", { pipeline: {} })
  const subagentPath = agentPath(workspace, "pipeline-executor", "pipeline")
  const orchestratorPath = agentPath(workspace, "pipeline-orchestrator", "pipeline")
  for (const [filePath, frontmatter] of [
    [orchestratorPath, { description: "Pipeline orchestrator", mode: "primary", steps: 120, temperature: 1, hidden: false }],
    [subagentPath, { description: "Pipeline executor", mode: "subagent", steps: 50, temperature: 0.2, hidden: true }]
  ] as const) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    saveAgentFile(filePath, frontmatter, "Agent body.")
  }
  const subagent = parseAgentFile(subagentPath, workspace)!
  const orchestrator = parseAgentFile(orchestratorPath, workspace)!

  const summary = inspectTuningTargets([subagent, orchestrator])
  assert.equal(summary.steps.mixed, true)
  assert.equal(summary.steps.displayMixed, "(mixed: 50, 120 — unchanged)")
  assert.equal(summary.temp.mixed, false)
  assert.equal(summary.temp.value, "0.2")
  assert.equal(summary.temp.displayMixed, "0.2")
  assert.equal(summary.mode.mixed, true)
  assert.equal(summary.mode.displayMixed, "(mixed: PRIMARY, SUBAGENT — unchanged)")
  assert.equal(summary.hidden.mixed, true)
  assert.equal(summary.hidden.displayMixed, "(mixed: FALSE, TRUE — unchanged)")

  const params = buildTuningUpdateParams(
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
  assert.equal(updatedSubagent.frontmatter.temperature, undefined)
  assert.equal(updatedOrchestrator.frontmatter.temperature, undefined)
  assert.doesNotMatch(fs.readFileSync(subagentPath, "utf8"), /\n(?:temperature|top_p|top_k):|\nrequest:/)
  assert.doesNotMatch(fs.readFileSync(orchestratorPath, "utf8"), /\n(?:temperature|top_p|top_k):|\nrequest:/)
  assert.equal(updatedOrchestrator.frontmatter.hidden, false)
})

test("agent params accept known model variants and model-specific allowed variants", (t) => {
  const workspace = catalog(t, "agent-variant-model-")
  const agent = fixtureAgent(agentPath(workspace, "a"), workspace, "test/model")

  for (const variant of ["minimal", "xhigh", "thinking"]) updateAgentParams([agent], { variant })
  updateAgentParams([agent], { variant: "custom-mode", allowedVariants: ["custom-mode"] })
  assert.equal(agent.frontmatter.variant, "custom-mode")
  assert.throws(() => updateAgentParams([agent], { variant: "another-mode", allowedVariants: ["custom-mode"] }), /Expected one of: custom-mode/)
})

test("agent params preserve or clear an existing effort variant", (t) => {
  const workspace = catalog(t, "agent-variant-")
  const agent = fixtureAgent(agentPath(workspace, "a"), workspace, "test/model")
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

test("agent params reject blank variants before modifying any agent", (t) => {
  const workspace = catalog(t, "agent-variant-")
  const a = fixtureAgent(agentPath(workspace, "a"), workspace, "test/model")
  const b = fixtureAgent(agentPath(workspace, "b"), workspace, "test/model")
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

test("resource discovery lists the pack's skills, tool families and tools, and MCP servers", (t) => {
  const workspace = catalog(t, "agent-resource-catalog-", { slides: { files: {
    "skills/slides-design/SKILL.md": "# slides-design\n",
    "skills/slides-composition/SKILL.md": "# slides-composition\n",
    "skills/not-a-skill/README.md": "no SKILL.md\n",
    "tools/slides/slide_build.ts": "export default {}\n",
    "tools/slides/slide_preview.ts": "export default {}\n",
    "tools/slides/doc_render.ts": "export default {}\n",
    "tools/slides/_tool.ts": "export default {}\n",
    "tools/slides/types.d.ts": "export {}\n",
    "tools/slides/slide_build.test.ts": "export {}\n",
    "tools/slides/helper.ts": "export {}\n",
    "tools/slides/notes.js": "export {}\n"
  } } })
  const filePath = agentPath(workspace, "slides-orchestrator", "slides")
  fixtureAgent(filePath, workspace, "test/model")
  const permission = {
    read: "allow",
    skill: { "*": "allow", "missing-skill": "allow" },
    "slide_*": "allow",
    slide_build: "deny",
    "doc_*": "deny",
    "chrome-devtools_*": "allow",
    "unknown-mcp_*": "deny"
  }
  saveAgentFile(filePath, { description: "x", model: "test/model", permission }, "body")
  const agent = findAgentFiles(workspace)[0]
  const opencodeRawContent = JSON.stringify({ mcp: { servers: {
    "chrome-devtools": { type: "local", command: ["devtools"], disabled: true },
    "another-server": { type: "remote", url: "https://mcp.example.test" }
  } } }, null, 2)
  const { env, configPath } = userConfig(t, opencodeRawContent)

  const resources = discoverAgentResources(workspace, agent, [agent], env)

  assert.equal(resources.skills[0].kind, "skill-wildcard")
  assert.equal(resources.skills[0].permissionKey, "*")
  assert.equal(resources.skills[0].allowed, true)
  assert.deepEqual(resources.skills.slice(1).map(skill => [skill.name, skill.exists, skill.allowed]), [
    ["missing-skill", false, true],
    ["slides-composition", true, true],
    ["slides-design", true, true]
  ])
  assert.equal(resources.skills.find(skill => skill.name === "slides-design")!.relativePath, path.join("skills", "slides-design", "SKILL.md"))

  assert.deepEqual(resources.tools.map(tool => [tool.kind, tool.name, tool.allowed]), [
    ["tool-family", "doc_*", false],
    ["tool", "doc_render", false],
    ["tool-family", "slide_*", true],
    ["tool", "slide_build", false],
    ["tool", "slide_preview", true],
    ["tool", "helper", false]
  ])
  assert.equal(resources.tools.find(tool => tool.name === "slide_preview")!.familyKey, "slide_*")
  assert.equal(resources.tools.find(tool => tool.name === "slide_build")!.relativePath, path.join("tools", "slides", "slide_build.ts"))

  const configuredMcp = resources.mcpServers.find(resource => resource.serverKey === "chrome-devtools")!
  assert.equal(configuredMcp.configuredInOpencode, true)
  assert.equal(configuredMcp.serverEnabled, false)
  assert.equal(configuredMcp.allowed, true)
  assert.equal(configuredMcp.relativePath, configPath)
  assert.equal(configuredMcp.serverTarget, "devtools")
  assert.equal(resources.mcpServers.find(resource => resource.serverKey === "another-server")!.serverTarget, "https://mcp.example.test")
  const unconfiguredMcp = resources.mcpServers.find(resource => resource.serverKey === "unknown-mcp")!
  assert.equal(unconfiguredMcp.configuredInOpencode, false)
  assert.equal(unconfiguredMcp.exists, false)
  assert.equal(unconfiguredMcp.allowed, false)
  assert.equal(resources.opencodeRawContent, opencodeRawContent)
  assert.equal(resources.opencodeConfigPath, configPath)
})

test("MCP discovery reads the user's JSONC config and reports the servers the pack recommends", (t) => {
  const workspace = catalog(t, "agent-recommended-mcp-", { demo: { files: {
    "opencode.json": JSON.stringify({ mcp: { servers: { "recommended-server": { type: "local", command: ["npx", "-y", "recommended-mcp"] } } } })
  } } })
  const agent = fixtureAgent(agentPath(workspace, "example"), workspace, "test/model")
  const { env } = userConfig(t, '{\n  "mcp": {\n    // enabled is omitted and should default to true\n    "XcodeBuildMCP": { "type": "local", "command": ["npx", "-y", "xcodebuildmcp"] },\n  }\n}\n')

  const resources = discoverAgentResources(workspace, findAgentFiles(workspace)[0], undefined, env)
  assert.equal(agent.filename, "example.md")

  const globalServer = resources.mcpServers.find(resource => resource.serverKey === "XcodeBuildMCP")!
  assert.equal(globalServer.configuredInOpencode, true)
  assert.equal(globalServer.serverEnabled, true)
  assert.equal(globalServer.recommendedInRepo, false)
  const recommendedServer = resources.mcpServers.find(resource => resource.serverKey === "recommended-server")!
  assert.equal(recommendedServer.configuredInOpencode, false)
  assert.equal(recommendedServer.recommendedInRepo, true)
  assert.equal(recommendedServer.serverEnabled, false)
  assert.equal(recommendedServer.exists, true)
  assert.equal(recommendedServer.relativePath, "opencode.json")
  assert.deepEqual(resources.recommendedMcpServers, { "recommended-server": { type: "local", command: ["npx", "-y", "recommended-mcp"] } })
  assert.equal(resources.opencodeRawContent?.includes("XcodeBuildMCP"), true)
})

test("resource discovery sees the skills, tools and MCP servers of required packs but not of unrelated packs", (t) => {
  const mcp = (name: string) => JSON.stringify({ mcp: { servers: { [name]: { type: "local", command: [name] } } } })
  const workspace = catalog(t, "agent-resource-closure-", {
    base: { files: { "skills/base-skill/SKILL.md": "# base\n", "tools/base/base_tool.ts": "export {}\n", "opencode.json": mcp("base-server") } },
    mid: { manifest: { requires: { base: "*" } }, files: { "skills/mid-skill/SKILL.md": "# mid\n", "tools/mid/mid_tool.ts": "export {}\n" } },
    app: { manifest: { requires: { mid: "*" } }, files: { "agents/app-lead.md": "---\ndescription: lead\n---\n", "skills/app-skill/SKILL.md": "# app\n" } },
    other: { files: { "skills/other-skill/SKILL.md": "# other\n", "tools/other/other_tool.ts": "export {}\n", "opencode.json": mcp("other-server") } }
  })
  const { env } = userConfig(t)
  const agent = findAgentFiles(workspace).find(item => item.filename === "app-lead.md")!

  const resources = discoverAgentResources(workspace, agent, undefined, env)

  assert.deepEqual(resources.skills.filter(skill => skill.kind === "skill").map(skill => skill.name), ["app-skill", "base-skill", "mid-skill"])
  assert.deepEqual(resources.tools.map(tool => tool.name), ["base_*", "base_tool", "mid_*", "mid_tool"])
  assert.equal(resources.tools.find(tool => tool.name === "base_tool")!.relativePath, path.join("tools", "base", "base_tool.ts"))
  assert.deepEqual(resources.mcpServers.map(server => [server.serverKey, server.recommendedInRepo]), [["base-server", true]])
  assert.equal(resources.opencodeRawContent, null)
})

test("resource updates preserve the supported skill wildcard permission forms", (t) => {
  const cases = [
    { all: true, skillNames: [], allowedNames: [], expected: "allow" },
    { all: true, skillNames: ["checked", "unchecked"], allowedNames: ["checked"], expected: { "*": "allow", unchecked: "deny" } },
    { all: false, allowedNames: ["checked"], expected: { "*": "deny", checked: "allow" } },
    { all: false, allowedNames: [], expected: "deny" }
  ]
  const { env } = userConfig(t)

  for (const [index, item] of cases.entries()) {
    const workspace = catalog(t, `agent-skill-resource-${index}-`)
    const agent = fixtureAgent(agentPath(workspace, "example"), workspace, "test/model")
    for (const name of item.skillNames ?? item.allowedNames) {
      const skillPath = path.join(workspace, "packs", "demo", "skills", name, "SKILL.md")
      fs.mkdirSync(path.dirname(skillPath), { recursive: true })
      fs.writeFileSync(skillPath, `# ${name}\n`)
    }
    saveAgentFile(agent.currentPath, { ...agent.frontmatter, permission: { read: "allow", skill: "ask", bash: "deny" } }, agent.body)
    const updatedAgent = findAgentFiles(workspace)[0]

    updateAgentResources(updatedAgent, discoverAgentResources(workspace, updatedAgent, undefined, env), {
      skills: { all: item.all, allowedNames: item.allowedNames }
    })

    const saved = parseAgentFile(agent.currentPath, workspace)!
    assert.deepEqual(saved.frontmatter.permission.skill, item.expected)
    assert.equal(saved.frontmatter.permission.read, "allow")
    assert.equal(saved.frontmatter.permission.bash, "deny")
  }
})

test("resource updates order tool family rules before overrides and keep unrelated permissions", (t) => {
  const workspace = catalog(t, "agent-resource-update-", { slides: { files: {
    "skills/selected-skill/SKILL.md": "# selected-skill\n",
    "tools/slides/slide_build.ts": "export default {}\n"
  } } })
  const filePath = agentPath(workspace, "slides-orchestrator", "slides")
  fixtureAgent(filePath, workspace, "test/model")
  saveAgentFile(filePath, { description: "x", model: "test/model", permission: {
    read: "allow", bash: "deny", task: { helper: "allow" },
    skill: { "*": "deny" }, slide_build: "allow", "chrome-devtools_*": "deny"
  } }, "body")
  const agent = findAgentFiles(workspace)[0]
  const { env } = userConfig(t, { mcp: { servers: { "chrome-devtools": { type: "local", disabled: true } } } })
  const resources = discoverAgentResources(workspace, agent, undefined, env)

  const result = updateAgentResources(agent, resources, {
    skills: { all: false, allowedNames: ["selected-skill"] },
    permissions: { "slide_*": true, slide_build: false, "chrome-devtools_*": true }
  })

  const saved = parseAgentFile(filePath, workspace)!
  const keys = Object.keys(saved.frontmatter.permission)
  assert.deepEqual(keys.slice(0, 2), ["read", "bash"])
  assert.ok(keys.indexOf("slide_*") < keys.indexOf("slide_build"))
  assert.equal(saved.frontmatter.permission["slide_*"], "allow")
  assert.equal(saved.frontmatter.permission.slide_build, "deny")
  assert.equal(saved.frontmatter.permission["chrome-devtools_*"], "allow")
  assert.deepEqual(saved.frontmatter.permission.skill, { "*": "deny", "selected-skill": "allow" })
  assert.deepEqual(saved.frontmatter.permission.task, { helper: "allow" })
  assert.deepEqual(result, { changedPaths: [filePath] })
  assert.equal(agent.rawContent, fs.readFileSync(filePath, "utf8"))
})

test("resource updates write only the agent file and never touch any opencode.json", (t) => {
  const packConfig = JSON.stringify({ mcp: { servers: { "pack-server": { type: "local", command: ["pack"] } } } })
  const workspace = catalog(t, "agent-resource-only-agent-", { demo: { files: { "opencode.json": packConfig, "tools/demo/example_tool.ts": "export {}\n" } } })
  const agent = fixtureAgent(agentPath(workspace, "example"), workspace, "test/model")
  const userBytes = JSON.stringify({ mcp: { servers: { "user-server": { type: "local", command: ["user"], disabled: true } } } })
  const { env, configPath } = userConfig(t, userBytes)
  const resources = discoverAgentResources(workspace, agent, undefined, env)
  const before = snapshotTree(workspace)

  const result = updateAgentResources(agent, resources, { permissions: { "user-server_*": true, "pack-server_*": true, example_tool: true } })

  assert.deepEqual(result.changedPaths, [agent.currentPath])
  assert.equal(fs.readFileSync(configPath, "utf8"), userBytes)
  const after = snapshotTree(workspace)
  const agentRel = path.relative(workspace, agent.currentPath)
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort())
  for (const rel of Object.keys(before)) if (rel !== agentRel) assert.equal(after[rel], before[rel], rel)
  assert.deepEqual(parseAgentFile(agent.currentPath, workspace)!.frontmatter.permission, { "user-server_*": "allow", "pack-server_*": "allow", example_tool: "allow" })
})

test("resource updates no-op on empty changes and reject unknown permissions, unknown skills and stale agents", (t) => {
  const workspace = catalog(t, "agent-resource-noop-", { demo: { files: { "tools/demo/example_tool.ts": "export default {}\n" } } })
  const agent = fixtureAgent(agentPath(workspace, "example"), workspace, "test/model")
  const { env } = userConfig(t)
  const resources = discoverAgentResources(workspace, agent, undefined, env)
  const original = fs.readFileSync(agent.currentPath)

  assert.deepEqual(updateAgentResources(agent, resources, {}), { changedPaths: [] })
  assert.deepEqual(updateAgentResources(agent, resources, { permissions: {} }), { changedPaths: [] })
  assert.throws(() => updateAgentResources(agent, resources, { permissions: { "not-configured_*": true } }), /Unknown resource permission key: not-configured_\*/)
  assert.throws(() => updateAgentResources(agent, resources, { skills: { all: false, allowedNames: ["ghost"] } }), /Unknown skill: ghost/)
  assert.deepEqual(fs.readFileSync(agent.currentPath), original)

  fs.writeFileSync(agent.currentPath, `${original.toString("utf8")}\nedited elsewhere\n`)
  assert.throws(() => updateAgentResources(agent, resources, { permissions: { example_tool: true } }), /Agent changed on disk before resource update/)
})

test("OpenCode V2 agent updates preserve frontmatter while changing params, model, and resources", (t) => {
  const workspace = catalog(t, "agent-v2-frontmatter-", { demo: { files: {
    "skills/selected-skill/SKILL.md": "# selected-skill\n",
    "tools/demo/example_tool.ts": "export default {}\n"
  } } })
  const filePath = agentPath(workspace, "v2-agent")
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const frontmatter = {
    name: "v2-agent",
    description: "V2 OpenCode agent",
    mode: "subagent",
    color: "#7c3aed",
    model: "old/model",
    steps: 8,
    temperature: 0.2,
    top_p: 0.8,
    request: { body: { temperature: 0.2, top_p: 0.8 } },
    system: "Keep this prompt",
    custom_metadata: { tier: "gold" },
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
  const { env } = userConfig(t)
  const resources = discoverAgentResources(workspace, findAgentFiles(workspace)[0], undefined, env)

  updateAgentParams([agent], { temperature: 0.4 })
  agent = parseAgentFile(filePath, workspace)!
  updateAgentsModel([agent], "new/model", ["new/model"])
  agent = parseAgentFile(filePath, workspace)!
  updateAgentResources(agent, resources, {
    skills: { all: false, allowedNames: ["selected-skill"] }
  })

  const saved = parseAgentFile(filePath, workspace)!
  const savedContent = fs.readFileSync(filePath, "utf8")
  for (const key of ["name", "mode", "color", "prompt", "custom_metadata", "metadata"]) {
    assert.deepEqual(saved.frontmatter[key], preserved[key], `${key} frontmatter should be preserved`)
  }
  assert.equal(saved.frontmatter.description, preserved.description)
  assert.equal(saved.frontmatter.temperature, undefined)
  assert.equal(saved.frontmatter.top_p, undefined)
  assert.equal(saved.frontmatter.request, undefined)
  assert.equal(saved.frontmatter.model, "new/model")
  assert.doesNotMatch(savedContent, /\n(?:temperature|top_p|top_k):|\nrequest:/)
  assert.match(savedContent, /action: skill\n\s+resource: selected-skill\n\s+effect: allow/)
  assert.match(savedContent, /action: read\n\s+resource: ["']\*["']\n\s+effect: allow/)
  assert.match(saved.body, /V2 agent body\./)
})

test("updateAgentParams keeps the V2 global deny first", (t) => {
  const workspace = catalog(t, "agent-global-params-")
  const { filePath, agent } = globalDenyAgent(workspace)

  updateAgentParams([agent], { temperature: 0.5 })

  assertGlobalDenyFirst(filePath)
})

test("renameAgent keeps the V2 global deny first", (t) => {
  const workspace = catalog(t, "agent-global-rename-")
  const { filePath } = globalDenyAgent(workspace, "old", "Call @old for help.")
  const agents = findAgentFiles(workspace)

  const result = renameAgent(workspace, filePath, "new.md", agents)

  assert.equal(result.success, true)
  assertGlobalDenyFirst(result.newPath)
})

test("updateAgentResources keeps the V2 global deny first", (t) => {
  const workspace = catalog(t, "agent-global-resources-", { demo: { files: { "tools/demo/example_tool.ts": "export default {}\n" } } })
  const { filePath, agent } = globalDenyAgent(workspace)
  const { env } = userConfig(t)
  const resources = discoverAgentResources(workspace, agent, undefined, env)

  updateAgentResources(agent, resources, { permissions: { example_tool: true } })

  assertGlobalDenyFirst(filePath)
})

test("applySafetyPreset keeps the V2 global deny first", (t) => {
  const workspace = catalog(t, "agent-global-preset-")
  const { filePath, agent } = globalDenyAgent(workspace)

  applySafetyPreset([agent], "safe_builder")

  assertGlobalDenyFirst(filePath)
})
