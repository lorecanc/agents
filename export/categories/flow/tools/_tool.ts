/**
 * Boundary adapter between the legacy `@opencode-ai/plugin` tool definition
 * (`tool({ description, args, execute })`) and the OpenCode V2 tool registry
 * (`ctx.tool.transform(editor => editor.add({ name, description, input, execute }))`).
 *
 * The legacy tool modules keep their current shape; this module turns their
 * definition into the V2 registration object and builds the JSON Schema input
 * from the small schema DSL the tools use.
 */

export type JsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object"

export interface JsonSchema {
  type?: JsonSchemaType
  description?: string
  enum?: readonly unknown[]
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: JsonSchema | boolean
  minimum?: number
  maximum?: number
}

/** Chainable schema node produced by `tool.schema`. */
export interface ToolSchema {
  optional(): ToolSchema
  describe(text: string): ToolSchema
  int(): ToolSchema
  min(value: number): ToolSchema
  max(value: number): ToolSchema
}

export interface SchemaBuilder {
  string(): ToolSchema
  number(): ToolSchema
  boolean(): ToolSchema
  enum(values: readonly unknown[]): ToolSchema
  array(item: ToolSchema): ToolSchema
  record(value: ToolSchema): ToolSchema
  record(key: ToolSchema, value: ToolSchema): ToolSchema
}

export interface LegacyContext {
  directory?: string
  worktree?: string
  abort?: AbortSignal
  sessionID?: string
  [key: string]: unknown
}

export interface ToolDef {
  name?: string
  description: string
  args?: Record<string, ToolSchema | JsonSchema>
  execute: (args: any, context: LegacyContext) => unknown
}

export interface V2ToolContext {
  signal?: AbortSignal
  sessionID?: string
  [key: string]: unknown
}

export interface V2ToolResult {
  content: Array<{ type: "text"; text: string }>
  metadata?: Record<string, unknown>
  output?: unknown
}

export interface V2ToolOptions {
  name?: string
  directory?: string
  worktree?: string
  [key: string]: unknown
}

export interface V2ToolDefinition {
  name: string
  description: string
  input: JsonSchema
  execute: (input: Record<string, unknown>, context: V2ToolContext) => Promise<V2ToolResult>
  options: V2ToolOptions
}

interface SchemaState {
  json: JsonSchema
  optional: boolean
}

const schemaState = new WeakMap<object, SchemaState>()

const UNSUPPORTED_METHOD = Symbol("unsupported")

function unsupportedMethod(name: string): never {
  throw new Error(`Unsupported tool.schema method: ${name}()`)
}

/**
 * Wraps a method bag so unknown methods fail closed with a clear error instead
 * of silently behaving like `undefined is not a function`.
 */
function chainable<T extends object>(methods: T): T {
  return new Proxy(methods, {
    get(target, property, receiver) {
      if (typeof property === "string" && !(property in target)) {
        // Keep normal introspection and promise checks from throwing.
        if (property === "then" || property === "toJSON") return undefined
        return (..._args: unknown[]) => unsupportedMethod(property)
      }
      return Reflect.get(target, property, receiver)
    },
  }) as T
}

function createSchema(json: JsonSchema, optional = false): ToolSchema {
  const schema = chainable({
    optional(): ToolSchema {
      return createSchema(json, true)
    },
    describe(text: string): ToolSchema {
      return createSchema({ ...json, description: text }, optional)
    },
    int(): ToolSchema {
      assertNumeric(json, "int")
      return createSchema({ ...json, type: "integer" }, optional)
    },
    min(value: number): ToolSchema {
      assertNumeric(json, "min")
      assertFinite(value, "min")
      return createSchema({ ...json, minimum: value }, optional)
    },
    max(value: number): ToolSchema {
      assertNumeric(json, "max")
      assertFinite(value, "max")
      return createSchema({ ...json, maximum: value }, optional)
    },
  })
  schemaState.set(schema, { json, optional })
  return schema
}

function assertNumeric(json: JsonSchema, method: string): void {
  if (json.type !== "number" && json.type !== "integer") {
    throw new Error(`tool.schema.${method}() is only supported on number schemas, got ${json.type ?? "unknown"}`)
  }
}

function assertFinite(value: unknown, method: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`tool.schema.${method}() expects a finite number`)
  }
}

function toJsonSchema(schema: ToolSchema | JsonSchema, label: string): JsonSchema {
  const state = schemaState.get(schema as object)
  if (state) return state.json
  if (typeof schema === "object" && schema !== null) return schema as JsonSchema
  throw new Error(`Invalid schema for ${label}`)
}

function enumType(values: readonly unknown[]): JsonSchemaType | undefined {
  if (values.length === 0) return undefined
  const kind = typeof values[0]
  if (!values.every((value) => typeof value === kind)) return undefined
  if (kind === "string") return "string"
  if (kind === "number") return "number"
  if (kind === "boolean") return "boolean"
  return undefined
}

function createSchemaBuilder(): SchemaBuilder {
  return chainable({
    string(): ToolSchema {
      return createSchema({ type: "string" })
    },
    number(): ToolSchema {
      return createSchema({ type: "number" })
    },
    boolean(): ToolSchema {
      return createSchema({ type: "boolean" })
    },
    enum(values: readonly unknown[]): ToolSchema {
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error("tool.schema.enum() expects a non-empty array")
      }
      const type = enumType(values)
      return createSchema({ type, enum: [...values] })
    },
    array(item: ToolSchema): ToolSchema {
      return createSchema({ type: "array", items: toJsonSchema(item, "array item") })
    },
    record(key: ToolSchema | JsonSchema, value?: ToolSchema | JsonSchema): ToolSchema {
      // Existing tools pass `record(key, value)`; JSON Schema keys are always strings.
      const entry = value === undefined ? key : value
      return createSchema({
        type: "object",
        additionalProperties: toJsonSchema(entry, "record value"),
      })
    },
  })
}

/**
 * Identity adapter so legacy tools (and their direct unit tests) can keep
 * calling `def.execute(args, context)` on the exported object.
 */
export interface ToolFactory {
  <T extends ToolDef>(def: T): T
  schema: SchemaBuilder
}

export const tool: ToolFactory = Object.assign(
  <T extends ToolDef>(def: T): T => def,
  { schema: createSchemaBuilder() },
)

export function buildInputSchema(
  args: Record<string, ToolSchema | JsonSchema> = {},
): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []

  for (const [name, schema] of Object.entries(args)) {
    const state = schemaState.get(schema as object)
    properties[name] = state ? state.json : toJsonSchema(schema, `argument "${name}"`)
    if (!state?.optional) required.push(name)
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  }
}

function hasContent(value: object): boolean {
  // Only an array of content blocks is a valid V2 result envelope; any other
  // `content` value has to be serialized as text.
  return "content" in value && Array.isArray((value as { content?: unknown }).content)
}

function normalizeResult(result: unknown): V2ToolResult {
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] }
  }

  if (typeof result === "object" && result !== null && hasContent(result)) {
    return result as V2ToolResult
  }

  const serialized = JSON.stringify(result)
  const text = serialized === undefined ? String(result) : serialized
  return {
    content: [{ type: "text", text }],
    output: result,
  }
}

export function toV2Tool(def: ToolDef, options: V2ToolOptions = {}): V2ToolDefinition {
  return {
    name: options.name ?? def.name ?? "",
    description: def.description,
    input: buildInputSchema(def.args),
    async execute(input, v2ctx) {
      const legacyCtx: LegacyContext = {
        ...v2ctx,
        directory: options.directory,
        worktree: options.worktree,
        abort: v2ctx.signal,
      }
      return normalizeResult(await def.execute(input, legacyCtx))
    },
    options,
  }
}
