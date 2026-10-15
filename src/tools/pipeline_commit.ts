import { tool } from "@opencode-ai/plugin"
import { executeCommit, planCommit, repoInfo, rootRecordFor } from "./_pipeline_core.js"

export default tool({
  description:
    "Create a local commit containing ONLY the files this session touched (files recorded by the session plus `expected_files`), never files that were already modified before the session, and never anything staged by someone else. Never pushes, amends, branches or stashes. Prefer this over raw git add/commit. Use dry_run to preview the commit scope.",
  args: {
    mode: tool.schema.enum(["final", "checkpoint"]).describe("final: conventional commit message; checkpoint: `chore(checkpoint): ...`"),
    message: tool.schema.string().describe("Commit subject, one line. For checkpoint the `chore(checkpoint): ` prefix is added if missing."),
    expected_files: tool.schema.array(tool.schema.string()).describe("Every file the session created, modified or deleted (from the executors' reports), repo-relative."),
    validation: tool.schema.enum(["passed", "failed", "unverified", "skipped", "unknown"]).describe("Validation status of the work."),
    validation_note: tool.schema.string().optional().describe("Required context when validation is `unverified` (the cause)."),
    baseline_dirty: tool.schema.array(tool.schema.string()).optional().describe("Files that were already modified before the session. Only needed if no session baseline is registered."),
    dry_run: tool.schema.boolean().optional().describe("Return the scope without committing."),
  },
  async execute(args, context) {
    const info = repoInfo(context.directory || context.worktree)
    if (!info) return JSON.stringify({ status: "error", error: "not a git repository" })
    if (!args.expected_files || !args.expected_files.length) {
      return JSON.stringify({ status: "refused", reason: "NEEDS_EXPECTED_FILES: pass every file the session created, modified or deleted." })
    }
    const subject = String(args.message || "").split("\n")[0].trim()
    if (!subject || subject.length > 120) return JSON.stringify({ status: "refused", reason: "message must be a single non-empty line of at most 120 characters" })
    if (args.mode === "final" && args.validation === "failed") {
      return JSON.stringify({ status: "refused", reason: "validation failed: a final commit is not allowed" })
    }
    if (args.validation === "unverified" && !args.validation_note) {
      return JSON.stringify({ status: "refused", reason: "validation_note is required when validation is `unverified`" })
    }
    let root: any = rootRecordFor(info, context.sessionID)
    const degraded = !root || !root.baseline
    if (degraded) root = { sessionId: context.sessionID, rootId: context.sessionID, files: {}, baseline: { dirty: args.baseline_dirty || [] } }
    const plan = planCommit(info, root, args.expected_files)
    const base: any = { degraded, plan }
    if (degraded && !args.baseline_dirty) {
      base.warning = "No session baseline registered and no baseline_dirty given: files that were already modified before the session cannot be detected."
    }
    if (!plan.commit.length) return JSON.stringify({ ...base, status: "refused", reason: "nothing to commit: no listed file is changed (or all are pre-existing/conflicting)" })
    if (args.dry_run) return JSON.stringify({ ...base, status: "dry_run" }, null, 2)
    const finalSubject = args.mode === "checkpoint" && !subject.startsWith("chore(checkpoint):") ? `chore(checkpoint): ${subject}` : subject
    const trailers = ["Pipeline-Checkpoint: true"]
    if (args.validation === "unverified") trailers.push(`Validation: unverified (${String(args.validation_note).replace(/\s+/g, " ").trim()})`)
    try {
      const result = executeCommit(info, plan, finalSubject, trailers)
      return JSON.stringify({ ...base, status: "committed", subject: finalSubject, ...result }, null, 2)
    } catch (e: any) {
      return JSON.stringify({ ...base, status: "error", error: String(e && e.message ? e.message : e) }, null, 2)
    }
  },
})
