// Pure logic for the flow-context plugin: the session-start git snapshot flow agents receive as
// extra system text.

import { gitT } from "../dev-tools/_repo.js"

export const STATUS_MAX_CHARS = 2000

function mainBranch(cwd) {
  const remoteHead = gitT(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { allowFail: true })
  if (remoteHead) return remoteHead.replace(/^origin\//, "")
  for (const name of ["main", "master"]) {
    if (gitT(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { allowFail: true })) return name
  }
  return null
}

/** Git facts for the system prompt, or null outside a repository. Taken once per session. */
export function gitSnapshotText(cwd) {
  if (!gitT(cwd, ["rev-parse", "--is-inside-work-tree"], { allowFail: true })) return null
  const branch = gitT(cwd, ["branch", "--show-current"], { allowFail: true }) || "(detached HEAD)"
  const main = mainBranch(cwd)
  let status = gitT(cwd, ["status", "--short"], { allowFail: true }) ?? ""
  if (status.length > STATUS_MAX_CHARS) status = `${status.slice(0, STATUS_MAX_CHARS)}\n… (truncated; run git status for the full list)`
  const commits = gitT(cwd, ["log", "--oneline", "-5"], { allowFail: true }) || "(no commits)"
  return [
    "Git status at the start of this session. It is a snapshot and does not update: run `git status` for the current state.",
    `Current branch: ${branch}`,
    ...(main ? [`Main branch (the usual base for pull requests): ${main}`] : []),
    "Status:",
    status || "(clean)",
    "Recent commits:",
    commits,
  ].join("\n")
}
