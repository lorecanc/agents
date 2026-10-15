import fs from "node:fs"
import path from "node:path"
import { findAgentFiles, forkCategory, saveAgentFile } from "./agents.js"
import { copyCategoryCompanionLinks } from "./companionLinks.js"

export const PIPELINE_ROLES = [
  "orchestrator", "planner", "reasoner", "executor", "tester", "refactorer", "code_reviewer", "critic", "ops",
  "explorer", "researcher", "docs_grounding", "fast_lane", "hitl", "post_session", "chrome_devtools",
  "frontend_specialist", "swift_specialist", "kotlin_specialist", "security_auditor", "multimodal"
] as const

export const PIPELINE_ROLE_GROUPS = {
  orchestration: ["orchestrator"],
  planning: ["planner", "reasoner"],
  execution: ["executor", "tester", "refactorer", "code_reviewer", "critic", "ops"],
  fast: ["explorer", "researcher", "docs_grounding", "fast_lane", "hitl", "post_session"],
  specialist: ["chrome_devtools", "frontend_specialist", "swift_specialist", "kotlin_specialist", "security_auditor", "multimodal"]
} as const

export interface PipelineRoleModelSpec {
  model: string
  variant?: string
}

export interface PipelineProfile {
  description: string
  defaults?: Record<string, PipelineRoleModelSpec>
  roles?: Record<string, PipelineRoleModelSpec>
}

export interface PipelineProfilesConfig {
  version: 1
  baseCategory: string
  profiles: Record<string, PipelineProfile>
}

export const DEFAULT_PIPELINE_PROFILES: PipelineProfilesConfig = {
  version: 1,
  baseCategory: "hybrid-pipeline",
  profiles: {
    hybrid: {
      description: "Mistral GLM-5.3 for orchestration/planning/reasoning + DeepSeek V4.1 Flash for execution and specialists.",
      defaults: {
        orchestration: { model: "mistral/zai-glm-5-3" },
        planning: { model: "mistral/zai-glm-5-3" },
        execution: { model: "opencode-go/deepseek-v4.1-flash" },
        fast: { model: "opencode-go/deepseek-v4.1-flash" },
        specialist: { model: "opencode-go/deepseek-v4.1-flash" }
      }
    },
    go: { description: "OpenCode Go DeepSeek V4.1 Flash across all pipeline roles.", defaults: { all: { model: "opencode-go/deepseek-v4.1-flash" } } },
    mistral: { description: "Mistral ZAI GLM-5.3 across all pipeline roles.", defaults: { all: { model: "mistral/zai-glm-5-3" } } },
    collector: { description: "OpenCode Go Muse Spark 1.3 Contributor across all pipeline roles.", defaults: { all: { model: "opencode-go/muse-spark-1.3-contributor" } } },
    free: { description: "OpenCode Free Muse Spark 1.3 Contributor across all pipeline roles.", defaults: { all: { model: "opencode/muse-spark-1.3-contributor-free" } } },
    copilot: {
      description: "GitHub Copilot Claude Opus 4.6 (high) for planning/reasoning, Sonnet 4.6 (medium) for execution, Haiku 4.5 (low) for fast/discovery.",
      defaults: {
        orchestration: { model: "github-copilot/claude-opus-4.6", variant: "high" },
        planning: { model: "github-copilot/claude-opus-4.6", variant: "high" },
        execution: { model: "github-copilot/claude-sonnet-4.6", variant: "medium" },
        specialist: { model: "github-copilot/claude-sonnet-4.6", variant: "medium" },
        fast: { model: "github-copilot/claude-haiku-4.5", variant: "low" }
      }
    },
    cp_nightly: {
      description: "GitHub Copilot Gemini 4 Argon with tiered thinking effort (high/medium/low).",
      defaults: {
        orchestration: { model: "github-copilot/gemini-4-argon", variant: "high" },
        planning: { model: "github-copilot/gemini-4-argon", variant: "high" },
        execution: { model: "github-copilot/gemini-4-argon", variant: "medium" },
        specialist: { model: "github-copilot/gemini-4-argon", variant: "medium" },
        fast: { model: "github-copilot/gemini-4-argon", variant: "low" }
      }
    }
  }
}

export function pipelineProfilesPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agent-manager", "pipeline-profiles.json")
}

export function loadPipelineProfiles(workspaceRoot: string): PipelineProfilesConfig {
  const configPath = pipelineProfilesPath(workspaceRoot)
  if (!fs.existsSync(configPath)) return structuredClone(DEFAULT_PIPELINE_PROFILES)
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as PipelineProfilesConfig
}

export function savePipelineProfiles(workspaceRoot: string, config: PipelineProfilesConfig): string {
  const configPath = pipelineProfilesPath(workspaceRoot)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  return configPath
}

export function extractPipelineRole(filenameOrName: string, categoryPrefix = "hybrid-pipeline"): string | null {
  const filename = path.basename(filenameOrName).replace(/\.md$/i, "")
  const prefix = `${categoryPrefix}-`
  if (!filename.startsWith(prefix)) return null
  const role = filename.slice(prefix.length)
  return role || null
}

export function resolveProfileRoleSpec(profile: PipelineProfile, role: string): PipelineRoleModelSpec | null {
  if (profile.roles?.[role]) return profile.roles[role]
  for (const [group, roles] of Object.entries(PIPELINE_ROLE_GROUPS)) {
    if (roles.includes(role as never) && profile.defaults?.[group]) return profile.defaults[group]
  }
  return profile.defaults?.all ?? null
}

function getProfile(workspaceRoot: string, profileName: string): { config: PipelineProfilesConfig; profile: PipelineProfile } {
  const config = loadPipelineProfiles(workspaceRoot)
  const profile = config.profiles[profileName]
  if (!profile) throw new Error(`Unknown pipeline profile '${profileName}'`)
  return { config, profile }
}

export function applyPipelineProfile(
  workspaceRoot: string,
  profileName: string,
  targetCategory?: string
): { updated: string[]; profileName: string; targetCategory: string } {
  const { config, profile } = getProfile(workspaceRoot, profileName)
  const category = targetCategory || config.baseCategory
  const updated: string[] = []
  for (const agent of findAgentFiles(workspaceRoot, "general").filter(agent => agent.category === category)) {
    const role = extractPipelineRole(agent.filename, category)
    if (!role) continue
    const spec = resolveProfileRoleSpec(profile, role)
    if (!spec) continue
    const frontmatter: Record<string, any> = { ...agent.frontmatter, model: spec.model }
    if (typeof spec.variant === "string" && spec.variant.length > 0) frontmatter.variant = spec.variant
    else delete frontmatter.variant
    saveAgentFile(agent.currentPath, frontmatter, agent.body, agent.frontmatterVersion)
    updated.push(agent.currentPath)
  }
  return { updated, profileName, targetCategory: category }
}

export function syncPipelineProfile(
  workspaceRoot: string,
  profileName: string,
  targetCategory?: string
): { synced: string[]; targetCategory: string; baseCategory: string; profileName: string; backupsPath: string | null } {
  const { config } = getProfile(workspaceRoot, profileName)
  const baseCategory = config.baseCategory
  const resolvedTarget = targetCategory
    ? (targetCategory.endsWith("-pipeline") ? targetCategory : `${targetCategory}-pipeline`)
    : `${profileName}-pipeline`

  if (resolvedTarget === baseCategory) {
    const applied = applyPipelineProfile(workspaceRoot, profileName, baseCategory)
    return { synced: applied.updated, targetCategory: baseCategory, baseCategory, profileName, backupsPath: null }
  }

  const forked = forkCategory(workspaceRoot, baseCategory, baseCategory, resolvedTarget)
  const applied = applyPipelineProfile(workspaceRoot, profileName, resolvedTarget)
  copyCategoryCompanionLinks(workspaceRoot, baseCategory, resolvedTarget)
  return { synced: applied.updated, targetCategory: resolvedTarget, baseCategory, profileName, backupsPath: forked.backupsPath }
}
