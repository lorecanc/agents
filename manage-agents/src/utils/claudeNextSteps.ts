/**
 * Local validation and run hints printed after a Claude layer export.
 *
 * Lines keep the leading indentation of the current printout so callers can
 * print them verbatim. The agent is plugin-scoped, the form claude resolves
 * when running with --plugin-dir.
 */
export function claudeNextSteps(pluginName: string, orchestratorName: string | null, pluginDir: string): string[] {
  const lines = [`     claude plugin validate ${pluginDir} --strict`]
  if (orchestratorName === null) return lines
  lines.push(`     claude --plugin-dir ${pluginDir} --agent ${pluginName}:${orchestratorName}`)
  return lines
}
