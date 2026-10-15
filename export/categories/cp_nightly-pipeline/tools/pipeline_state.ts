import { tool } from "@opencode-ai/plugin"
import { changedFiles, gitAnomalies, isLive, listSessions, repoInfo, rootRecordFor, scratchDir, snapshot } from "./_pipeline_core.js"

const statusOf = (i: any) => (i.untracked ? "new" : i.deleted ? "deleted" : i.orig ? "renamed" : "modified")

export default tool({
  description:
    "Read-only report of the current pipeline session: the session baseline (base commit, files that were already modified before the session), the files changed now split into session / pre-existing / unattributed, new branches/worktrees/stashes since the baseline, and other live sessions touching the same files. Use it instead of guessing what changed with `git diff HEAD~1`. Never modifies anything.",
  args: {},
  async execute(_args, context) {
    const info = repoInfo(context.directory || context.worktree)
    if (!info) return JSON.stringify({ error: "not a git repository" })
    const root = rootRecordFor(info, context.sessionID)
    const items = changedFiles(info)
    const baselineDirty = new Set<string>((root && root.baseline && root.baseline.dirty) || [])
    const claimed = new Set<string>(Object.keys((root && root.files) || {}))
    const entry = (i: any) => ({ path: i.path, status: statusOf(i), ...(i.orig ? { from: i.orig } : {}) })
    const session = items.filter((i) => claimed.has(i.path) && !baselineDirty.has(i.path)).map(entry)
    const preExisting = items.filter((i) => baselineDirty.has(i.path)).map(entry)
    const unattributed = items.filter((i) => !claimed.has(i.path) && !baselineDirty.has(i.path)).map(entry)
    const now = snapshot(info)
    const mine = new Set(claimed)
    const others = listSessions(info)
      .filter((r: any) => r.sessionId === r.rootId && (!root || r.sessionId !== root.sessionId) && isLive(r))
      .map((r: any) => ({ session: r.sessionId, agent: r.agent, overlapping_files: Object.keys(r.files || {}).filter((f) => mine.has(f)) }))
    const out: any = {
      degraded: !root || !root.baseline,
      base_commit: (root && root.baseline && root.baseline.head) || now.head,
      branch: now.branch,
      baseline_dirty: [...baselineDirty].sort(),
      changed: { session, pre_existing: preExisting, unattributed },
      untracked_files_need_full_read: items.filter((i) => i.untracked).map((i) => i.path),
      anomalies: gitAnomalies(root && root.baseline, now),
      other_active_sessions: others,
      scratch_dir: scratchDir(info),
      how_to_diff: "tracked: `git diff <base_commit> -- <path>`; new (untracked) files are in no diff, read them in full.",
    }
    if (out.degraded) {
      out.warning =
        "No session baseline is registered (pipeline-guard plugin inactive or session unknown). Treat the 'session' bucket as unreliable and use the explorer's `Session baseline` block for base_commit and pre-existing files."
    }
    if (out.anomalies.length) {
      out.warning = `${out.warning ? out.warning + " " : ""}Branches, worktrees, stashes or the checked-out branch changed during this session: report this to the user.`
    }
    return JSON.stringify(out, null, 2)
  },
})
