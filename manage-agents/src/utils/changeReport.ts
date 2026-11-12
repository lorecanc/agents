import type { ChangeResult } from "./installer.js"
import type { LockChange } from "./lock.js"
import { terminalSafeText } from "./terminalText.js"

export const formatLockChange = (change: LockChange) => `  ${change.kind} ${terminalSafeText(change.name)}${change.from ? ` ${terminalSafeText(change.from)}` : ""}${change.to ? ` -> ${terminalSafeText(change.to)}` : ""}`

/** Human-readable outcome of install, uninstall, update or reconcile, shared by the CLI and the TUI. */
export function describeChangeResult(target: string, result: ChangeResult): string[] {
  const plan = result.plan
  const problems = [...(result.change?.problems ?? []), ...(plan?.conflicts ?? [])]
  const warnings = [...(result.change?.warnings ?? []), ...(plan?.warnings ?? [])]
  const safe = terminalSafeText
  const lines: string[] = []
  if (result.recovered) lines.push("Rolled back an interrupted transaction first.")
  if (result.changes.length) lines.push("Packs:", ...result.changes.map(formatLockChange))
  if (plan && !problems.length) {
    const count = (kind: string) => plan.writes.filter(write => write.kind === kind).length
    lines.push(`Files: ${count("create")} new, ${count("update")} updated, ${count("adopt")} adopted, ${plan.deletes.length} removed${plan.configText !== null ? `; ${plan.configFile} updated` : ""}.`)
    if (result.status === "dry-run") {
      for (const write of plan.writes) lines.push(`  ${write.kind} ${safe(write.rel)}`)
      for (const rel of plan.deletes) lines.push(`  remove ${safe(rel)}`)
    }
  }
  for (const warning of warnings) lines.push(`warning: ${safe(warning)}`)
  for (const problem of problems) lines.push(`ERROR: ${safe(problem)}`)
  const outcome: Record<ChangeResult["status"], string> = {
    applied: `Done: ${safe(target)} is up to date.${result.backupId ? ` Replaced content was saved; undo with \`manage-agents restore ${result.backupId}\`.` : ""}`,
    unchanged: `Nothing to do: ${safe(target)} is already up to date.`,
    "dry-run": "Dry run: nothing was written.",
    failed: "Nothing was written.",
    declined: "Not confirmed: nothing was written.",
  }
  lines.push(outcome[result.status])
  return lines
}
