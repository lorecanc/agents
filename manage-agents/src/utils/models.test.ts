import assert from "node:assert/strict"
import test from "node:test"
import { loadModelCatalog, parseModelCatalog, parseVerboseModelCatalogOutput, getModelVariants, isVerifiedModel, suggestModels, collectInvalidModelGroups, modelDisplayValue } from "./models.js"

test("model catalog parser is strict, trimmed, deduplicated, and preserves slashes", () => {
  assert.deepEqual(parseModelCatalog(" provider/model/a \nprovider/model/a\nmalformed\nprovider/ two\nprovider/model-b "), ["provider/model/a", "provider/model-b"])
  assert.deepEqual(parseModelCatalog("garbage\nnot-a-model"), [])
})

test("verbose catalog parser reads model variants from balanced JSON blocks", () => {
  const output = `provider/first
{
  "nested": { "text": "braces { } and an escaped quote \\"" },
  "variants": { "low": {}, "medium": {}, "high": {}, "xhigh": {}, "none": {}, "thinking": {} }
}
provider/second
{"variants": {}}
`
  assert.deepEqual(parseVerboseModelCatalogOutput(output), {
    models: ["provider/first", "provider/second"],
    variants: {
      "provider/first": ["low", "medium", "high", "xhigh", "none", "thinking"],
      "provider/second": [],
    },
    hasVerboseBlocks: true,
  })
  assert.deepEqual(parseModelCatalog("not a model line"), [])
})

test("model variants are only returned for verified catalogs with a matching base model", () => {
  const catalog = { status: "verified" as const, models: ["p/model"], variants: { "p/model": ["low", "high"], "p/empty": [] } }
  assert.deepEqual(getModelVariants(catalog, "p/model#high"), ["low", "high"])
  assert.deepEqual(getModelVariants(catalog, "p/empty"), [])
  assert.equal(getModelVariants({ status: "unavailable", models: [] }, "p/model"), null)
  assert.equal(getModelVariants({ status: "verified", models: ["p/model"] }, "p/model"), null)
})

test("catalog loading tries verbose listing first and fails closed", () => {
  let command = ""
  assert.deepEqual(loadModelCatalog(c => { command = c; return "p/model" }, true), { status: "verified", models: ["p/model"] })
  assert.equal(command, "opencode models --verbose")
  assert.equal(loadModelCatalog(() => "").status, "unavailable")
  assert.equal(loadModelCatalog(() => { throw new Error("offline") }).status, "unavailable")
})

test("refresh flag is silently ignored for V2 compatibility", () => {
  const commands: string[] = []
  const catalog = loadModelCatalog(c => {
    commands.push(c)
    return "p/model"
  }, true)
  assert.deepEqual(catalog, { status: "verified", models: ["p/model"] })
  assert.deepEqual(commands, ["opencode models --verbose"])

  const failedFallback = loadModelCatalog(() => { throw new Error("offline") }, true)
  assert.equal(failedFallback.status, "unavailable")
  assert.equal(failedFallback.status === "unavailable" && failedFallback.error, "offline")
})

test("catalog loading falls back to the plain listing when verbose command throws", () => {
  const commands: string[] = []
  const catalog = loadModelCatalog(command => {
    commands.push(command)
    if (command === "opencode models --verbose") throw new Error("unsupported flag")
    return "p/model"
  })
  assert.deepEqual(commands, ["opencode models --verbose", "opencode models"])
  assert.deepEqual(catalog, { status: "verified", models: ["p/model"] })
})

test("membership is exact and suggestions are catalog members with provider priority", () => {
  const catalog = { status: "verified" as const, models: ["p/model-new", "p/model-old", "q/model-new"] }
  assert.equal(isVerifiedModel("p/model-new", catalog), true)
  assert.equal(isVerifiedModel("P/model-new", catalog), false)
  const suggestions = suggestModels("p/model-old", catalog)
  assert.ok(suggestions.every(model => catalog.models.includes(model)))
  assert.equal(suggestions[0], "p/model-new")
  assert.deepEqual(suggestModels("unknown/unrelated", { status: "verified", models: ["p/other"] }), [])
})

test("invalid groups include only explicit invalid values and preserve first-seen order", () => {
  const catalog = { status: "verified" as const, models: ["p/valid"] }
  const agents = [
    { frontmatter: {} },
    { frontmatter: { model: "p/valid" } },
    { frontmatter: { model: "bad/model" } },
    { frontmatter: { model: null } },
    { frontmatter: { model: false } },
    { frontmatter: { model: "" } },
    { frontmatter: { model: "bad/model" } },
  ]
  const groups = collectInvalidModelGroups(agents, catalog)
  assert.deepEqual(groups.map(group => group.value), ["bad/model", null, false, ""])
  assert.equal(groups[0].agents.length, 2)
  assert.deepEqual(collectInvalidModelGroups(agents, { status: "unavailable", models: [] }), [])
})

test("model display distinguishes inherited and explicit invalid values", () => {
  const catalog = { status: "verified" as const, models: ["provider/model"] }
  assert.equal(modelDisplayValue({ frontmatter: {} }), "Inherited")
  assert.equal(modelDisplayValue({ frontmatter: { model: null } }), "Invalid: null")
  assert.equal(modelDisplayValue({ frontmatter: { model: false } }), "Invalid: false")
  assert.equal(modelDisplayValue({ frontmatter: { model: "" } }), "Invalid: empty")
  assert.equal(modelDisplayValue({ frontmatter: { model: "provider-model" } }, true), "Invalid: provider-model")
  assert.equal(modelDisplayValue({ frontmatter: { model: "provider/model" } }, true, catalog), "model")
  assert.equal(modelDisplayValue({ frontmatter: { model: "provider/model" } }, false, catalog), "provider/model")
  assert.equal(modelDisplayValue({ frontmatter: { model: "bad/model" } }, true, catalog), "Invalid: bad/model")
  assert.equal(modelDisplayValue({ frontmatter: { model: "bad/model/with/slashes" } }, true, catalog), "Invalid: bad/model/with/slashes")
})
