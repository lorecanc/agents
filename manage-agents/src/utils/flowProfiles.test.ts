import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { parseAgentFile, saveAgentFile } from "./agents.js"
import { loadCompanionLinks } from "./companionLinks.js"
import {
  applyFlowProfile,
  checkFlowBundles,
  deleteStampedFlow,
  forkStampedFlow,
  extractFlowRole,
  isStampedFlowCategory,
  normalizeFlowCategoryName,
  refreshStampedFlowsFromSource,
  resolveFlowRoleSpec,
  rewriteFlowText,
  saveFlowProfiles,
  syncFlowProfile,
} from "./flowProfiles.js"

function write(root: string, relative: string, content: string): void {
  const file = path.join(root, ...relative.split("/"))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-profiles-"))
  fs.mkdirSync(path.join(root, "export", "categories"), { recursive: true })
  saveAgentFile(path.join(root, "src", "agents", "flow-build.md"), {
    description: "build", mode: "primary",
    permission: { read: "allow", task: { "*": "deny", "flow-explore": "allow", "flow-eye": "allow", general: "allow" } },
  }, "Launch `flow-explore` in parallel, ask `flow-eye` for screenshots, load the `flow-frontend-design` skill, suggest `/flow-explain`.")
  saveAgentFile(path.join(root, "src", "agents", "flow-explore.md"), { description: "explore", mode: "subagent", permission: { read: "allow" } }, "Explore.")
  saveAgentFile(path.join(root, "src", "agents", "flow-eye.md"), { description: "eye", mode: "subagent", permission: { read: "allow" } }, "Look.")
  write(root, "src/commands/flow-feature.md", "---\ndescription: \"Flow: feature\"\nagent: flow-build\n---\n\nUse `flow-explore`; then run /flow-explain.\n")
  write(root, "src/commands/flow-explain.md", "---\ndescription: explain\nagent: flow-build\n---\n\nExplain.\n")
  write(root, "src/skills/flow-testing/SKILL.md", "---\nname: flow-testing\ndescription: t\n---\n\nTest.\n")
  write(root, "src/plugins/flow-guard/index.ts", "export default {}\n")
  write(root, "src/plugins/pipeline-tools/index.ts", "export default {}\n")
  const resources = [
    ...["build", "explore", "eye"].map(role => ({ kind: "file", source: `src/agents/flow-${role}.md`, target: `agents/flow-${role}.md`, policy: "text" })),
    { kind: "file", source: "src/commands/flow-feature.md", target: "commands/flow-feature.md", policy: "text" },
    { kind: "file", source: "src/commands/flow-explain.md", target: "commands/flow-explain.md", policy: "text" },
    { kind: "file", source: "src/skills/flow-testing/SKILL.md", target: "skills/flow-testing/SKILL.md", policy: "text" },
    { kind: "directory", source: "src/plugins/flow-guard", target: "plugins/flow-guard", policy: "text" },
    { kind: "directory", source: "src/plugins/pipeline-tools", target: "plugins/pipeline-tools", policy: "text" },
  ]
  write(root, ".agent-manager/categories/flow.json", JSON.stringify({ schemaVersion: 2, id: "flow", output: "export/categories/flow", resources }))
  write(root, ".agent-manager/companion-links.json", JSON.stringify({ version: 1, categories: { flow: { plugins: ["plugins/flow-guard", "plugins/pipeline-tools"], commands: [], skills: ["skills/flow-testing"], tools: [] } } }))
  saveFlowProfiles(root, {
    version: 1,
    profiles: {
      hybrid: { description: "h", defaults: { main: { model: "p/main", variant: "high" }, fast: { model: "p/fast" } } },
      solo: { description: "s", defaults: { all: { model: "p/all" } }, roles: { eye: { model: "p/vision" } } },
    },
  })
  return root
}

const stamped = (root: string, category: string, role: string) => parseAgentFile(path.join(root, "export", "categories", category, "agents", `${category}-${role}.md`), root)!

test("names: stamped flow categories and roles never overlap with the pipeline", () => {
  assert.equal(normalizeFlowCategoryName("hybrid"), "hybrid-flow")
  assert.equal(normalizeFlowCategoryName("hybrid-flow"), "hybrid-flow")
  assert.equal(normalizeFlowCategoryName("flow"), "flow")
  assert.ok(isStampedFlowCategory("go-flow"))
  assert.ok(!isStampedFlowCategory("flow"))
  assert.ok(!isStampedFlowCategory("go-pipeline"))
  assert.equal(extractFlowRole("flow-build.md"), "build")
  assert.equal(extractFlowRole("hybrid-flow-review.md", "hybrid-flow"), "review")
  assert.equal(extractFlowRole("hybrid-pipeline-executor.md", "hybrid-flow"), null)
  assert.equal(extractFlowRole("flow-frontend-design"), null)
})

test("rewriteFlowText renames agents and commands, never skills or plugins", () => {
  const text = "Use `flow-explore`, then /flow-explain. Load `flow-frontend-design` and `flow-commit`; flow-guard blocks it. agent: flow-build"
  assert.equal(
    rewriteFlowText(text, "go-flow", ["explain", "commit"]),
    "Use `go-flow-explore`, then /go-flow-explain. Load `flow-frontend-design` and `flow-commit`; flow-guard blocks it. agent: go-flow-build",
  )
})

test("resolveFlowRoleSpec: role override, then group, then all", () => {
  const profile = { description: "", defaults: { main: { model: "m" }, all: { model: "a" } }, roles: { plan: { model: "r" } } }
  assert.equal(resolveFlowRoleSpec(profile, "build")?.model, "m")
  assert.equal(resolveFlowRoleSpec(profile, "plan")?.model, "r")
  assert.equal(resolveFlowRoleSpec(profile, "review")?.model, "a")
  assert.equal(resolveFlowRoleSpec({ description: "", defaults: { main: { model: "m" } } }, "eye"), null)
})

test("sync stamps <profile>-flow with per-group models, renamed agents, commands and subagent permissions", () => {
  const root = workspace()
  const result = syncFlowProfile(root, "hybrid")
  assert.equal(result.targetCategory, "hybrid-flow")
  const build = stamped(root, "hybrid-flow", "build")
  assert.equal(build.frontmatter.model, "p/main")
  assert.equal(build.frontmatter.variant, "high")
  assert.equal(stamped(root, "hybrid-flow", "explore").frontmatter.model, "p/fast")
  assert.equal(stamped(root, "hybrid-flow", "eye").frontmatter.model, undefined, "no vision model in the profile: the agent keeps the default")
  assert.deepEqual(Object.keys(build.frontmatter.permission.task).sort(), ["*", "general", "hybrid-flow-explore", "hybrid-flow-eye"].sort())
  assert.match(build.body, /`hybrid-flow-explore`/)
  assert.match(build.body, /\/hybrid-flow-explain/)
  assert.match(build.body, /`flow-frontend-design`/)
  const bundle = path.join(root, "export", "categories", "hybrid-flow")
  const command = fs.readFileSync(path.join(bundle, "commands", "hybrid-flow-feature.md"), "utf8")
  assert.match(command, /agent: hybrid-flow-build/)
  assert.match(command, /\/hybrid-flow-explain/)
  assert.ok(!fs.existsSync(path.join(bundle, "commands", "flow-feature.md")))
  assert.ok(fs.existsSync(path.join(bundle, "skills", "flow-testing", "SKILL.md")))
  assert.ok(fs.existsSync(path.join(bundle, "plugins", "flow-guard", "index.ts")))
  assert.ok(loadCompanionLinks(root).categories["hybrid-flow"], "companion links registered for the export")
  // the canonical sources are untouched
  assert.equal(parseAgentFile(path.join(root, "src", "agents", "flow-build.md"), root)!.frontmatter.model, undefined)
})

test("sync to a custom target applies the named profile; roles override groups", () => {
  const root = workspace()
  syncFlowProfile(root, "solo", "lab")
  assert.equal(stamped(root, "lab-flow", "build").frontmatter.model, "p/all")
  assert.equal(stamped(root, "lab-flow", "eye").frontmatter.model, "p/vision")
})

test("refresh keeps per-bundle model edits, follows canonical changes, and dry-run writes nothing", () => {
  const root = workspace()
  syncFlowProfile(root, "hybrid")
  const buildPath = path.join(root, "export", "categories", "hybrid-flow", "agents", "hybrid-flow-build.md")
  const edited = parseAgentFile(buildPath, root)!
  saveAgentFile(buildPath, { ...edited.frontmatter, model: "p/tuned" }, edited.body)
  const source = parseAgentFile(path.join(root, "src", "agents", "flow-build.md"), root)!
  saveAgentFile(source.currentPath, source.frontmatter, `${source.body}\nNew rule.`)

  const before = fs.readFileSync(buildPath, "utf8")
  const preview = refreshStampedFlowsFromSource(root, "hybrid-flow", { dryRun: true })
  assert.deepEqual(preview.updatedAgents, [buildPath])
  assert.equal(fs.readFileSync(buildPath, "utf8"), before)
  assert.ok(checkFlowBundles(root)[0].problems.some(problem => /out of date/.test(problem)))

  refreshStampedFlowsFromSource(root)
  const after = parseAgentFile(buildPath, root)!
  assert.equal(after.frontmatter.model, "p/tuned")
  assert.match(after.body, /New rule\./)
  assert.deepEqual(checkFlowBundles(root), [{ category: "hybrid-flow", resourceRoot: path.join(root, "export", "categories", "hybrid-flow"), problems: [] }])
  assert.deepEqual(refreshStampedFlowsFromSource(root).updatedAgents, [], "idempotent")
})

test("apply sets models on the canonical flow agents; unknown profiles fail", () => {
  const root = workspace()
  const result = applyFlowProfile(root, "solo")
  assert.equal(result.updated.length, 3)
  assert.equal(parseAgentFile(path.join(root, "src", "agents", "flow-eye.md"), root)!.frontmatter.model, "p/vision")
  assert.throws(() => applyFlowProfile(root, "nope"), /Unknown flow profile/)
})

test("check reports a bundle that lost its guard plugin", () => {
  const root = workspace()
  syncFlowProfile(root, "hybrid")
  fs.rmSync(path.join(root, "export", "categories", "hybrid-flow", "plugins", "flow-guard"), { recursive: true })
  const [check] = checkFlowBundles(root)
  assert.ok(check.problems.some(problem => /plugin flow-guard is not shipped/.test(problem)))
})

test("delete removes a stamped bundle and its companion links, never the canonical flow", () => {
  const root = workspace()
  syncFlowProfile(root, "hybrid")
  assert.throws(() => deleteStampedFlow(root, "flow"), /canonical/)
  const result = deleteStampedFlow(root, "hybrid")
  assert.equal(result.deletedCategory, "hybrid-flow")
  assert.equal(result.removedAgentsCount, 3)
  assert.ok(!fs.existsSync(path.join(root, "export", "categories", "hybrid-flow")))
  assert.equal(loadCompanionLinks(root).categories["hybrid-flow"], undefined)
  assert.ok(fs.existsSync(path.join(root, "src", "agents", "flow-build.md")))
})

test("fork stamps several bundles at once, with or without a profile", () => {
  const root = workspace()
  const result = forkStampedFlow(root, "a, b-flow", { profileName: "hybrid" })
  assert.deepEqual(result.createdCategories, ["a-flow", "b-flow"])
  assert.equal(stamped(root, "b-flow", "build").frontmatter.model, "p/main")
  forkStampedFlow(root, "plain")
  assert.equal(stamped(root, "plain-flow", "build").frontmatter.model, undefined)
  assert.throws(() => forkStampedFlow(root, "flow"), /canonical/)
  assert.deepEqual(forkStampedFlow(root, "a").updatedCategories, ["a-flow"])
})
