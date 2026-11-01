/**
 * Single accessor for the MCP section of an OpenCode config.
 *
 * V1 stored servers flat under `mcp` with an `enabled` flag. V2 nests them
 * under `mcp.servers` and uses `disabled`. Readers and writers go through
 * these helpers so both shapes keep working during the migration.
 */

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function readMcpServers(config: Record<string, any>): Record<string, any> {
  if (!isPlainObject(config)) return {}
  const mcp = config.mcp
  if (!isPlainObject(mcp)) return {}
  if (isPlainObject(mcp.servers)) return mcp.servers
  const servers: Record<string, any> = {}
  for (const [name, server] of Object.entries(mcp)) {
    if (name === "servers") continue
    servers[name] = server
  }
  return servers
}

export function isServerDisabled(server: Record<string, any>): boolean {
  return server.disabled === true || server.enabled === false
}

export function setServerDisabled(server: Record<string, any>, disabled: boolean): Record<string, any> {
  const next = { ...server }
  delete next.enabled
  if (disabled) next.disabled = true
  else delete next.disabled
  return next
}

export function normalizeMcpConfig(config: Record<string, any>): Record<string, any> {
  return { ...config, mcp: { servers: { ...readMcpServers(config) } } }
}

export function isLocalServer(server: Record<string, any>): boolean {
  return server.type === "local"
}

export function readMcpServerNames(config: Record<string, any>): string[] {
  return Object.keys(readMcpServers(config)).sort()
}
