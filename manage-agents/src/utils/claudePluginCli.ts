import { spawnSync } from "node:child_process"

export type CliRunner = (file: string, args: string[], options?: { cwd?: string }) => { status: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException }

export interface PluginCliOutcome {
  kind: "pass" | "fail" | "error" | "skipped"
  message: string
  detail?: string
}

export const spawnRunner: CliRunner = (file, args, options) => {
  const result = spawnSync(file, args, { encoding: "utf8", cwd: options?.cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  }
}

const TAIL_LIMIT = 300

function tail(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > TAIL_LIMIT ? `...${trimmed.slice(-TAIL_LIMIT)}` : trimmed
}

// Keeps only the end of each stream: CLI errors put the cause last.
function describeOutput(result: { stdout: string; stderr: string; error?: NodeJS.ErrnoException }): string {
  const parts: string[] = []
  const stdout = tail(result.stdout)
  const stderr = tail(result.stderr)
  if (stdout) parts.push(`stdout: ${stdout}`)
  if (stderr) parts.push(`stderr: ${stderr}`)
  if (result.error?.message) parts.push(`error: ${result.error.message}`)
  return parts.join("; ")
}

function missingCli(step: string, detail?: string): PluginCliOutcome {
  return { kind: "skipped", message: `claude CLI not found; skipped ${step}`, detail }
}

export function validatePlugin(pluginDir: string, runner: CliRunner = spawnRunner): PluginCliOutcome {
  const result = runner("claude", ["plugin", "validate", pluginDir, "--strict"])
  const output = describeOutput(result)

  if (result.status === null) {
    if (result.error?.code === "ENOENT") return missingCli(`validation of ${pluginDir}`, output)
    return { kind: "error", message: `Validation of ${pluginDir} could not run${output ? `; ${output}` : ""}`, detail: output }
  }
  if (result.status === 0) {
    return { kind: "pass", message: `${pluginDir} passed plugin validation${output ? `; ${output}` : ""}`, detail: output }
  }
  if (result.status === 1) {
    return { kind: "fail", message: `${pluginDir} failed plugin validation (exit 1)${output ? `; ${output}` : ""}`, detail: output }
  }
  // Exit 2 is claude's unexpected-error path: the reason lives on stderr only.
  return { kind: "error", message: `${pluginDir} validation hit an unexpected CLI error (exit ${result.status})${output ? `; ${output}` : ""}`, detail: output }
}

export function registerPlugin(pluginDir: string, pluginName: string, marketplaceName: string, runner: CliRunner = spawnRunner): PluginCliOutcome {
  const steps = [
    { id: "marketplace", label: `marketplace add for ${pluginDir}`, args: ["plugin", "marketplace", "add", pluginDir] },
    { id: "install", label: `plugin install for ${pluginName}@${marketplaceName}`, args: ["plugin", "install", `${pluginName}@${marketplaceName}`] }
  ]
  // Track each step separately: an already-present marketplace does not mean
  // the plugin itself is already installed.
  let marketplaceAlreadyPresent = false
  let pluginAlreadyInstalled = false
  let lastOutput = ""

  for (const step of steps) {
    const result = runner("claude", step.args)
    const output = describeOutput(result)
    lastOutput = output

    if (result.status === null) {
      if (result.error?.code === "ENOENT") return missingCli(step.label, output)
      return { kind: "error", message: `Could not run ${step.label}${output ? `; ${output}` : ""}`, detail: output }
    }
    if (result.status === 1) {
      return { kind: "fail", message: `${step.label} failed (exit 1)${output ? `; ${output}` : ""}`, detail: output }
    }
    if (result.status !== 0) {
      return { kind: "error", message: `${step.label} hit an unexpected CLI error (exit ${result.status})${output ? `; ${output}` : ""}`, detail: output }
    }
    if (result.stdout.toLowerCase().includes("already")) {
      if (step.id === "marketplace") marketplaceAlreadyPresent = true
      else pluginAlreadyInstalled = true
    }
  }

  const action = pluginAlreadyInstalled
    ? `${pluginName}@${marketplaceName} was already registered`
    : `Registered ${pluginName}@${marketplaceName}${marketplaceAlreadyPresent ? " (marketplace was already on disk)" : ""}`
  return {
    kind: "pass",
    message: `${action} from ${pluginDir}${lastOutput ? `; ${lastOutput}` : ""}`,
    detail: lastOutput
  }
}
