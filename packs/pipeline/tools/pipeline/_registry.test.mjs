import assert from "node:assert/strict"
import { test } from "node:test"
import { registerHooks } from "node:module"

// @opencode/plugin is not installed in this repo: stub it before the dynamic imports below.
// Plugin.define is an identity function in V2; the stub marks the result so the tests can prove
// each default export really went through it.
const STUB_SOURCE = `
export const Plugin = {
  define(definition) {
    globalThis.__toolRegistryDefineCalls = (globalThis.__toolRegistryDefineCalls || 0) + 1
    return { ...definition, __defined: true }
  },
}
`
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode/plugin") return { url: "opencode-plugin-v2-stub://plugin", shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith("opencode-plugin-v2-stub:")) return { format: "module", source: STUB_SOURCE, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const REGISTRIES = [
  {
    id: "dev-tools",
    module: "./plugins/dev-tools/index.ts",
    namespace: "dev",
    names: ["dev_env", "dev_verify", "dev_smoke", "dev_serve"],
  },
  {
    id: "pipeline-tools",
    module: "./plugins/pipeline-tools/index.ts",
    namespace: "pipeline",
    names: ["pipeline_state", "pipeline_commit"],
  },
  {
    id: "doc-tools",
    module: "./plugins/doc-tools/index.ts",
    namespace: "doc",
    names: ["doc_compile_theme", "doc_convert", "doc_create", "doc_list", "doc_modify", "doc_restore", "doc_view"],
  },
  {
    id: "slide-tools",
    module: "./plugins/slide-tools/index.ts",
    namespace: "slide",
    names: [
      "slide_analyze_template", "slide_assemble_pptx", "slide_build_pptx", "slide_compile_composition",
      "slide_compile_theme", "slide_create_thumbnails", "slide_download_image", "slide_generate_image", "slide_screenshot",
    ],
  },
]

// Plugins live in <config>/plugins and this test in <config>/tools or <config>/tools/<pack>: resolve from the config root.
const CONFIG_ROOT = (() => {
  let url = new URL("./", import.meta.url)
  while (!url.pathname.endsWith("/tools/") && url.pathname !== "/") url = new URL("../", url)
  return new URL("../", url)
})()

const DIRECTORY = "/repo"

const effectiveName = (t) => (t.options?.namespace ? `${t.options.namespace}_${t.name}` : t.name)

async function setup(entry) {
  const plugin = (await import(new URL(entry.module, CONFIG_ROOT))).default
  const added = []
  const ctx = {
    location: { directory: DIRECTORY },
    tool: {
      transform: async (fn) => {
        await fn({ add: (tool) => added.push(tool) })
      },
    },
  }
  await plugin.setup(ctx)
  return { plugin, added }
}

for (const entry of REGISTRIES) {
  test(`${entry.id}: Plugin.define with id and every tool registered`, async () => {
    const { plugin, added } = await setup(entry)
    assert.equal(plugin.__defined, true)
    assert.equal(plugin.id, entry.id)
    assert.equal(typeof plugin.setup, "function")
    assert.equal(added.length, entry.names.length)
  })

  test(`${entry.id}: effective names are the ${entry.namespace}_* stems without duplicates`, async () => {
    const { added } = await setup(entry)
    const names = added.map(effectiveName).sort()
    assert.deepEqual(names, [...entry.names].sort())
    assert.equal(new Set(names).size, names.length)
    for (const tool of added) {
      assert.equal(tool.options?.namespace, entry.namespace)
      assert.equal(tool.options?.permission, effectiveName(tool))
      assert.equal(tool.options?.directory, DIRECTORY)
      assert.equal(tool.options?.worktree, DIRECTORY)
    }
  })

  test(`${entry.id}: every tool has a strict object input schema and an execute function`, async () => {
    const { added } = await setup(entry)
    for (const tool of added) {
      assert.equal(tool.input?.type, "object", `${effectiveName(tool)} input.type`)
      assert.equal(tool.input?.additionalProperties, false, `${effectiveName(tool)} additionalProperties`)
      assert.equal(typeof tool.input?.properties, "object", `${effectiveName(tool)} properties`)
      assert.equal(typeof tool.execute, "function", `${effectiveName(tool)} execute`)
      assert.equal(typeof tool.description, "string", `${effectiveName(tool)} description`)
    }
  })
}
