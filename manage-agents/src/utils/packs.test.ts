import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { BASE_MANIFEST, makePack } from "../../test/helpers.js"
import { MANIFEST_FILE, hasErrors, parseJsonc, validatePack, type PackValidation } from "./packs.js"

const CONTRACT_DIR = fileURLToPath(new URL("../../contract/", import.meta.url))

const codes = (validation: PackValidation, level: "error" | "warning" = "error") =>
  validation.issues.filter(issue => issue.level === level).map(issue => issue.code)

test("the shipped example pack satisfies the contract with no warnings", () => {
  const validation = validatePack(path.join(CONTRACT_DIR, "examples", "minimal-pack"))

  assert.deepEqual(validation.issues, [])
  assert.equal(validation.manifest?.name, "minimal-pack")
  assert.deepEqual(validation.ids, { agents: ["minimal-lead", "minimal-scout"], commands: ["minimal-hello"], skills: ["minimal-hello"], plugins: ["minimal-greeter"], themes: [], mcpServers: [] })
  assert.deepEqual(validation.executable.toolModules, ["tools/minimal-pack/greet.js"])
  assert.deepEqual(validation.executable.skillScripts, ["skills/minimal-hello/scripts/hello.sh"])
  assert.ok(!validation.files.includes("node_modules"))
})

test("the JSON Schema and the validator accept the same manifest keys", (t) => {
  const schema = JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, "opencode-pack.schema.json"), "utf8"))

  assert.deepEqual(schema.required, ["contract", "name", "version", "description"])
  for (const key of Object.keys(schema.properties)) {
    const issues = validatePack(makePack(t, {}, { [key]: {} })).issues
    assert.ok(!issues.some(issue => issue.message === `unknown key "${key}"`), key)
  }
})

test("contract version: unknown major is rejected early, newer minor only warns, integers are invalid", (t) => {
  const major = validatePack(makePack(t, { "rootfile.txt": "x" }, { contract: "2.0" }))
  assert.deepEqual(codes(major), ["contract-unsupported"])

  const minor = validatePack(makePack(t, {}, { contract: "1.7" }))
  assert.equal(hasErrors(minor), false)
  assert.deepEqual(codes(minor, "warning"), ["contract-newer-minor"])

  assert.deepEqual(codes(validatePack(makePack(t, {}, { contract: 1 }))), ["manifest-invalid"])
  assert.deepEqual(codes(validatePack(makePack(t, {}, null))), ["manifest-missing"])
})

test("manifest fields: name, version, unknown keys and requires shape", (t) => {
  const messages = (manifest: Record<string, unknown>, sourceKind?: "git") =>
    validatePack(makePack(t, {}, manifest), { sourceKind }).issues.filter(issue => issue.level === "error").map(issue => issue.message)

  assert.match(messages({ name: "Bad_Name" })[0], /"name"/)
  assert.match(messages({ version: "v1.0" })[0], /"version"/)
  assert.match(messages({ extra: true })[0], /unknown key "extra"/)
  assert.match(messages({ requires: ["dev-tools"] })[0], /must be a map/)
  assert.match(messages({ requires: { demo: "^1.0.0" } })[0], /cannot require itself/)
  assert.match(messages({ requires: { "dev-tools": "not a range" } })[0], /semver range/)
  assert.deepEqual(messages({ requires: { "dev-tools": "*" } }), [])
  assert.match(messages({ requires: { "dev-tools": "*" } }, "git")[0], /only in local sources/)
})

test("layout: root files, legacy and reserved directories, mandatory namespaces", (t) => {
  const validation = validatePack(makePack(t, {
    "notes.txt": "x",
    "README.md": "ok",
    "LICENSE": "ok",
    "plugin/x.ts": "",
    "instructions/x.md": "",
    "resources/other/x.md": "",
    "resources/demo/ok.md": "",
    "tools/_demo_ok.js": "",
    "tools/demo/ok.js": "",
    "tools/_shared.js": "",
    "skills/stray.md": "",
    "plugins/single.ts": "",
    "plugins/empty/helper.ts": "",
    "themes/nested/x.json": "{}",
  }))

  assert.deepEqual(validation.issues.filter(issue => issue.level === "error").map(issue => `${issue.code} ${issue.path}`).sort(), [
    "legacy-directory plugin/x.ts",
    "namespace resources/other/x.md",
    "namespace tools/_shared.js",
    "plugin-entry plugins/empty",
    "plugin-single-file plugins/single.ts",
    "reserved-path instructions/x.md",
    "root-file notes.txt",
    "skill-orphan skills/stray.md",
    "theme-file themes/nested/x.json",
  ])
})

test("paths that differ only by case or Unicode normalization collide", (t) => {
  const root = makePack(t, { "agents/Foo.md": "", "commands/caf\u00e9.md": "" })
  fs.writeFileSync(path.join(root, "commands", "cafe\u0301.md"), "")
  let caseSensitive = true
  try {
    fs.writeFileSync(path.join(root, "agents", "foo.md"), "")
    caseSensitive = fs.readdirSync(path.join(root, "agents")).length === 2
  } catch {
    caseSensitive = false
  }
  const collisions = validatePack(root).issues.filter(issue => issue.code === "case-collision")
  const unicodeDistinct = fs.readdirSync(path.join(root, "commands")).length === 2

  assert.equal(collisions.length, (caseSensitive ? 1 : 0) + (unicodeDistinct ? 1 : 0))
})

test("symlinks: inside file accepted, escaping, directory and broken links rejected", { skip: process.platform === "win32" }, (t) => {
  const root = makePack(t, { "resources/demo/real.md": "x" })
  const outside = makePack(t, { "secret.txt": "s" }, null)
  fs.symlinkSync(path.join(root, "resources/demo/real.md"), path.join(root, "resources/demo/link.md"))
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "resources/demo/escape.md"))
  fs.symlinkSync(path.join(root, "resources/demo"), path.join(root, "resources/demo/dir"))
  fs.symlinkSync(path.join(root, "missing"), path.join(root, "resources/demo/broken.md"))

  const validation = validatePack(root)

  assert.deepEqual(codes(validation).sort(), ["symlink-broken", "symlink-directory", "symlink-escape"])
  assert.ok(validation.files.includes("resources/demo/link.md"))
})

test("a symlink to a FIFO inside the pack is rejected, so nothing ever blocks reading it", { skip: process.platform === "win32" }, (t) => {
  const root = makePack(t, {})
  fs.mkdirSync(path.join(root, "resources", "demo"), { recursive: true })
  const made = spawnSync("mkfifo", [path.join(root, "resources", "demo", "pipe")])
  if (made.status !== 0) return t.skip("mkfifo unavailable")
  fs.symlinkSync(path.join(root, "resources", "demo", "pipe"), path.join(root, "resources", "demo", "link"))

  const validation = validatePack(root)
  assert.deepEqual(codes(validation), ["symlink-special"])
  assert.ok(!validation.files.some(file => file.endsWith("pipe") || file.endsWith("link")))
})

test("opencode.json: user keys rejected, references resolved, escaped or recorded as unresolved", (t) => {
  const config = JSON.stringify({
    model: "x/y",
    plugins: ["./plugins/present", "./plugins/absent", "../outside", "npm-plugin@1"],
    skills: ["/abs/skills", "skills"],
    instructions: ["https://example.com/a.md", "resources/demo/*.md", "resources/demo/rules.md"],
    agents: { inline: { mode: "subagent" } },
    mcp: { servers: { db: { type: "local", command: ["db-mcp", "--ro"] }, web: { type: "remote", url: "https://mcp.example" } } },
    lsp: { go: { command: ["gopls"] } },
    commands: { greet: { template: "{file:resources/demo/greet.txt}" } },
  })
  const standalone = validatePack(makePack(t, { "opencode.json": config, "plugins/present/index.ts": "", "resources/demo/rules.md": "" }))
  assert.deepEqual(standalone.issues.filter(issue => issue.level === "error").map(issue => issue.code).sort(), [
    "absolute-path", "config-key", "reference-escape", "reference-missing", "reference-missing", "reference-missing",
  ])
  assert.deepEqual(standalone.ids.mcpServers, ["db", "web"])
  assert.ok(standalone.ids.agents.includes("inline"))
  assert.deepEqual(standalone.executable.pluginPackages, ["npm-plugin@1"])
  assert.deepEqual(standalone.executable.externalCommands, ["db-mcp", "gopls"])

  const withRequires = validatePack(makePack(t, { "opencode.json": config, "plugins/present/index.ts": "", "resources/demo/rules.md": "" }, { requires: { base: "^1.0.0" } }))
  assert.deepEqual(withRequires.unresolved.map(ref => `${ref.kind} ${ref.target}`).sort(), ["file resources/demo/greet.txt", "plugin plugins/absent", "skill skills"])
  assert.equal(codes(validatePack(makePack(t, { "opencode.json": JSON.stringify({ plugins: ["./tools/demo"] }), "tools/demo/x.js": "" }))).join(), "plugin-path")
})

test("code imports: relative imports checked, escapes rejected, foreign packages warned", (t) => {
  const files = {
    "plugins/p/index.ts": [
      `import { Plugin } from "@opencode/plugin"`,
      `import fs from "node:fs"`,
      `import path from "path"`,
      `import { a } from "../../tools/demo/a.js"`,
      `import { b } from "../../tools/base/b.js"`,
      `import "../../../escape.js"`,
      `const lazy = await import("./lazy.mjs")`,
      `import lodash from "lodash"`,
    ].join("\n"),
    "tools/demo/a.ts": "export const a = 1",
    "plugins/p/lazy.mjs": "",
  }
  const validation = validatePack(makePack(t, files, { requires: { base: "^1.0.0" } }))

  assert.deepEqual(codes(validation), ["reference-escape"])
  assert.deepEqual(codes(validation, "warning"), ["import-dependency"])
  assert.deepEqual(validation.unresolved, [{ from: "plugins/p/index.ts", kind: "import", target: "tools/base/b.js" }])
})

test("archetype: callers must be primary agents of the pack; pinned subagents are not routed", (t) => {
  const agents = {
    "agents/lead.md": "---\nmode: primary\n---\nx",
    "agents/scout.md": "---\nmode: subagent\n---\nx",
    "agents/eye.md": "---\nmode: subagent\nmodel: p/vision\n---\nx",
  }
  const ok = validatePack(makePack(t, agents, {
    archetype: { callers: ["lead"], reference: "lead" },
    routingDefaults: { p: { scout: "p/small#high", eye: "p/other" } },
  }))
  assert.equal(hasErrors(ok), false)
  assert.deepEqual(codes(ok, "warning"), ["archetype-pinned"])

  const bad = validatePack(makePack(t, agents, {
    archetype: { callers: ["scout", "ghost"], reference: "scout" },
    routingDefaults: { p: { lead: "p/x" } },
  }))
  assert.equal(codes(bad).filter(code => code === "archetype").length, 3)

  assert.match(validatePack(makePack(t, agents, { routingDefaults: { p: { scout: "p/x" } } })).issues[0].message, /requires "archetype"/)
})

test("agent frontmatter: invalid mode is an error, V1 keys warn, invalid YAML is reported", (t) => {
  const validation = validatePack(makePack(t, {
    "agents/a.md": "---\nmode: boss\ntools:\n  bash: true\n---\nx",
    "agents/b.md": "---\nfoo: [unclosed\n---\nx",
    "skills/s/SKILL.md": "---\nname: s\n---\nno description",
  }))

  assert.deepEqual(codes(validation).sort(), ["agent-mode", "frontmatter-invalid"])
  assert.deepEqual(codes(validation, "warning").sort(), ["agent-deprecated-key", "skill-description"])
})

test("absolute OpenCode config paths in opaque content are best-effort warnings with a line number", (t) => {
  const validation = validatePack(makePack(t, { "agents/a.md": "---\nmode: primary\n---\nline\nRead ~/.config/opencode/skills/x/SKILL.md" }))

  assert.equal(hasErrors(validation), false)
  assert.deepEqual(validation.issues.map(issue => `${issue.code} ${issue.path}`), ["absolute-config-path agents/a.md:5"])
})

test("parseJsonc strips comments and trailing commas but keeps them inside strings", () => {
  assert.deepEqual(parseJsonc(`{
    // line comment
    "url": "https://example.com//path", /* block */
    "list": [1, 2,],
    "quote": "a \\" // not a comment",
    "ref": "{file:x,}",
  }`), { url: "https://example.com//path", list: [1, 2], quote: 'a " // not a comment', ref: "{file:x,}" })
})

test("hostile packs: manifest symlink, Windows paths, backslashes, case-variant directories, large files", { skip: process.platform === "win32" }, (t) => {
  const outside = makePack(t, { "opencode-pack.json": JSON.stringify(BASE_MANIFEST) }, null)
  const linked = makePack(t, {}, null)
  fs.symlinkSync(path.join(outside, "opencode-pack.json"), path.join(linked, MANIFEST_FILE))
  const symlinked = validatePack(linked)
  assert.equal(symlinked.manifest, null)
  assert.ok(symlinked.issues.some(issue => issue.code === "manifest-invalid" && /regular file/.test(issue.message)))

  const config = JSON.stringify({ instructions: ["C:\\secret.md", "docs\\..\\..\\x.md"], commands: { c: { template: "{file:C:\\secret.txt}" } } })
  const validation = validatePack(makePack(t, {
    "opencode.json": config,
    "Agents/lead.md": "x",
    "Instructions/x.md": "x",
    "README.sh": "x",
    ".gitignore": "x",
    "resources/demo/big.md": "x".repeat(2 * 1024 * 1024 + 1),
  }, { requires: { base: "^1.0.0" } }))

  assert.deepEqual(codes(validation).sort(), ["absolute-path", "absolute-path", "directory-case", "directory-case", "reference-backslash", "root-file"])
  assert.deepEqual(validation.unresolved, [])
  assert.ok(!validation.files.includes(".gitignore"))
  assert.deepEqual(codes(validation, "warning"), ["file-too-large"])
})

test("FILE_REF scanning stays linear on many unterminated {file: prefixes", (t) => {
  const started = performance.now()
  validatePack(makePack(t, { "opencode.json": JSON.stringify({ commands: { c: { template: "{file:".repeat(50_000) } } }) }))
  assert.ok(performance.now() - started < 2000)
})

test("commented-out imports are not checked", (t) => {
  const validation = validatePack(makePack(t, { "plugins/p/index.ts": `// import "./missing.js"\n/* import x from "../../gone.js" */\nexport default 1` }))
  assert.equal(hasErrors(validation), false)
})
