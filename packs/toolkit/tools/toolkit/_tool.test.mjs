import assert from "node:assert/strict"
import { test } from "node:test"
import { buildInputSchema, toV2Tool, tool } from "./_tool.js"

test("buildInputSchema tracks required and optional fields with descriptions", () => {
  const schema = buildInputSchema({
    projectName: tool.schema.string().describe("Project folder"),
    mode: tool.schema.enum(["fast", "slow"]).optional(),
  })

  assert.deepEqual(schema, {
    type: "object",
    properties: {
      projectName: { type: "string", description: "Project folder" },
      mode: { type: "string", enum: ["fast", "slow"] },
    },
    required: ["projectName"],
    additionalProperties: false,
  })
})

test("buildInputSchema supports enum, array, record, int, min and max", () => {
  const schema = buildInputSchema({
    checks: tool.schema.array(tool.schema.enum(["a", "b"])),
    tags: tool.schema.record(tool.schema.string().describe("Tag name"), tool.schema.number()),
    limit: tool.schema.number().int().min(1).max(10),
    nested: tool.schema
      .array(tool.schema.record(tool.schema.string()))
      .describe("Nested list")
      .optional(),
  })

  assert.deepEqual(schema.properties, {
    checks: { type: "array", items: { type: "string", enum: ["a", "b"] } },
    tags: { type: "object", additionalProperties: { type: "number" } },
    limit: { type: "integer", minimum: 1, maximum: 10 },
    nested: {
      type: "array",
      items: { type: "object", additionalProperties: { type: "string" } },
      description: "Nested list",
    },
  })
  assert.deepEqual(schema.required, ["checks", "tags", "limit"])
})

test("unsupported schema methods fail closed", () => {
  assert.throws(
    () => tool.schema.string().nullable(),
    /Unsupported tool\.schema method: nullable\(\)/,
  )
  assert.throws(
    () => tool.schema.string().int(),
    /tool\.schema\.int\(\) is only supported on number schemas/,
  )
  assert.throws(
    () => tool.schema.number().min(Number.NaN),
    /tool\.schema\.min\(\) expects a finite number/,
  )
})

test("tool(def) returns the definition unchanged", () => {
  const def = {
    description: "identity",
    args: { value: tool.schema.string() },
    execute(args, _context) {
      return `hello ${args.value}`
    },
  }

  assert.equal(tool(def), def)
  assert.equal(def.execute({ value: "world" }, {}), "hello world")
})

test("toV2Tool exposes name, description and input schema", () => {
  const def = {
    description: "Demo tool",
    args: {
      projectName: tool.schema.string().describe("Project folder"),
      verbose: tool.schema.boolean().optional(),
    },
    execute() {
      return "ok"
    },
  }

  const v2 = toV2Tool(def, { name: "demo_tool", directory: "/repo", worktree: "/tree" })

  assert.equal(v2.name, "demo_tool")
  assert.equal(v2.description, "Demo tool")
  assert.deepEqual(v2.input, {
    type: "object",
    properties: {
      projectName: { type: "string", description: "Project folder" },
      verbose: { type: "boolean" },
    },
    required: ["projectName"],
    additionalProperties: false,
  })
  assert.equal(v2.input.additionalProperties, false)
})

test("toV2Tool passes directory, worktree, abort and sessionID to the legacy context", async () => {
  let seen
  const def = {
    description: "Context tool",
    args: { input: tool.schema.string() },
    async execute(args, context) {
      seen = context
      return `got ${args.input}`
    },
  }

  const v2 = toV2Tool(def, { directory: "/repo", worktree: "/tree" })
  const signal = new AbortController().signal
  const result = await v2.execute({ input: "value" }, { sessionID: "session-1", signal })

  assert.equal(seen.directory, "/repo")
  assert.equal(seen.worktree, "/tree")
  assert.equal(seen.abort, signal)
  assert.equal(seen.sessionID, "session-1")
  assert.deepEqual(result, { content: [{ type: "text", text: "got value" }] })
})

test("toV2Tool normalizes a string result to a single text content", async () => {
  const v2 = toV2Tool({
    description: "String result",
    args: {},
    execute() {
      return "plain text"
    },
  })

  assert.deepEqual(await v2.execute({}, {}), {
    content: [{ type: "text", text: "plain text" }],
  })
})

test("toV2Tool passes through results that already have content", async () => {
  const envelope = {
    content: [{ type: "text", text: "raw" }],
    metadata: { ok: true },
  }
  const v2 = toV2Tool({
    description: "Envelope result",
    args: {},
    execute() {
      return envelope
    },
  })

  const result = await v2.execute({}, {})
  assert.equal(result, envelope)
  assert.deepEqual(result, envelope)
})

test("toV2Tool stringifies plain objects and keeps them as output", async () => {
  const value = { ok: true, count: 2 }
  const v2 = toV2Tool({
    description: "Object result",
    args: {},
    execute() {
      return value
    },
  })

  const result = await v2.execute({}, {})
  assert.deepEqual(result, {
    content: [{ type: "text", text: JSON.stringify(value) }],
    output: value,
  })
  assert.equal(result.output, value)
})

test("toV2Tool serializes an object whose content is not an array", async () => {
  const value = { content: "raw", ok: true }
  const v2 = toV2Tool({
    description: "Non-envelope result",
    args: {},
    execute() {
      return value
    },
  })

  const result = await v2.execute({}, {})
  assert.deepEqual(result, {
    content: [{ type: "text", text: JSON.stringify(value) }],
    output: value,
  })
})
