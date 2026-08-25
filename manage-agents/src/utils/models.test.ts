import assert from "node:assert/strict"
import test from "node:test"
import { loadModelCatalog, parseModelCatalog, isVerifiedModel, suggestModels, collectInvalidModelGroups, modelDisplayValue } from "./models.js"

test("model catalog parser is strict, trimmed, deduplicated, and preserves slashes", () => {
  assert.deepEqual(parseModelCatalog(" provider/model/a \nprovider/model/a\nmalformed\nprovider/ two\nprovider/model-b "), ["provider/model/a", "provider/model-b"])
  assert.deepEqual(parseModelCatalog("garbage\nnot-a-model"), [])
})

test("catalog loading selects refresh command and fails closed", () => {
  let command = ""
  assert.deepEqual(loadModelCatalog(c => { command = c; return "p/model" }, true), { status: "verified", models: ["p/model"] })
  assert.equal(command, "opencode models --refresh")
  assert.equal(loadModelCatalog(() => "").status, "unavailable")
  assert.equal(loadModelCatalog(() => { throw new Error("offline") }).status, "unavailable")
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
