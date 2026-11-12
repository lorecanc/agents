// Pure logic for the flow-context plugin: the session-start git snapshot and the todo reminder that
// flow agents receive as extra system text.

import { gitT } from "../dev-tools/_repo.js"

export const STATUS_MAX_CHARS = 2000
/** Tool calls without a `todowrite` before an open todo list earns a reminder. */
export const TODO_REMINDER_EVERY = 10

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

/** Open items of a `todowrite` input: everything not completed or cancelled. */
export function openTodos(todos) {
  if (!Array.isArray(todos)) return []
  return todos.filter((t) => t && typeof t.content === "string" && !["completed", "cancelled"].includes(t.status))
}

export function todoReminderText(open) {
  return [
    `You have not updated the todo list for ${TODO_REMINDER_EVERY} or more tool calls. If the work has moved on, update it with \`todowrite\`: mark finished items completed and drop the ones that no longer apply. Ignore this if the list is current.`,
    "Open items:",
    ...open.map((t) => `- [${t.status || "pending"}] ${t.content}`),
  ].join("\n")
}
