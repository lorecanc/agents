const MODEL_RE = /^[^\s/#]+\/[^\s#]+(?:#[^\s#]+)?$/
const TRIGGER_RE = /^[^\s/#]+(?:\/[^\s#]+)?$/

/** "provider/model#variant" in OpenCode's V2 notation. */
export const isModelRef = (value: unknown): value is string => typeof value === "string" && MODEL_RE.test(value)
/** A routing trigger: a provider ("mistral") or an exact model ("mistral/zai-glm-5-3"). */
export const isTrigger = (value: unknown): value is string => typeof value === "string" && TRIGGER_RE.test(value)

/** Plain assignment of a key such as "__proto__" would change the prototype instead of adding the entry. */
export const setOwn = (object: Record<string, unknown>, key: string, value: unknown) =>
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true })

/** The own object at `key`, created when missing; never walks into the prototype ("__proto__", "constructor"). */
export function ownChild<T extends object>(object: Record<string, T>, key: string): T {
  if (!Object.hasOwn(object, key)) setOwn(object, key, {})
  return object[key]
}

/** Own property only, so a key such as "__proto__" never reaches Object.prototype. */
export const own = <T>(object: Record<string, T> | undefined, key: string): T | undefined => object && Object.hasOwn(object, key) ? object[key] : undefined
