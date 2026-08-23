---
title: "Translation Configuration"
description: "Reference for the v2 agent translation configuration and model-resolution rules"
category: "config"
source_files:
  - ".agent-manager/translation-config.json"
  - "manage-agents/src/utils/translationConfig.ts"
  - "README.md"
created: "2026-08-22"
last_updated: "2026-08-22"
---

# Translation Configuration

The translation configuration is stored at `.agent-manager/translation-config.json`. It controls whether agents are translated for Claude or Codex, where [source agents](../modules/pipeline-catalogs.md) are read from, how [agent names](../modules/agent-manager.md) map to tiers, and which model target is selected.

## v2 Schema

The top-level v2 shape is:

| Field | Type | Description |
|---|---|---|
| `version` | `2` | Configuration version. |
| `target` | `"claude" \| "codex"` | Translation target. |
| `pluginName` | `string` | Target plugin name. |
| `prefix` | `string` | Prefix removed when normalizing agent filenames. |
| `sourceDir` | `string` | Workspace-relative directory containing [source agents](../modules/pipeline-catalogs.md). |
| `inference` | `boolean` (optional) | Enables model-based tier inference when no explicit role mapping exists. |
| `defaultTier` | `string` | Tier used when no role or unambiguous inference resolves a tier. |
| `tiers` | `Record<string, TranslationTier>` | Open-ended named tier profiles. |
| `roles` | `Record<string, string>` | Maps normalized [agent names](../modules/agent-manager.md) to tier names. |
| `claude` | `{ overrides: Record<string, ModelTarget> }` | Claude-specific per-agent model overrides. |
| `codex` | `{ overrides: Record<string, ModelTarget>, emitSkills?, emitReadme?, emitMcp? }` | Codex-specific overrides and optional emission settings. |

Each `TranslationTier` has an optional `description` and required Claude and Codex targets. Each `ModelTarget` has a required `model` and an optional `reasoningEffort`:

```json
{
  "description": "Agents that reason, plan and review",
  "claude": { "model": "opus" },
  "codex": { "model": "gpt-5.6-sol", "reasoningEffort": "high" }
}
```

Tier names are not a fixed enum. The implementation stores them as `Record<string, TranslationTier>`; `planning` and `execution` are the configured defaults, not the only permitted names.

## Current Configuration

The checked-in configuration currently uses:

| Setting | Value |
|---|---|
| `target` | `claude` |
| `pluginName` | `decent-pipeline` |
| `prefix` | `copilot-pipeline-` |
| `sourceDir` | `general` |
| `inference` | `true` |
| `defaultTier` | `execution` |

### Tiers

| [Tier](../modules/agent-manager.md) | Description | Claude | Codex | Codex `reasoningEffort` |
|---|---|---|---|---|
| `planning` | Agents that reason, plan and review | `opus` | `gpt-5.6-sol` | `high` |
| `execution` | Agents that execute tasks, cheaper and faster | `sonnet` | `gpt-5.6-luna` | `max` |

The current target-specific settings are:

```json
"claude": {
  "overrides": {}
},
"codex": {
  "overrides": {},
  "emitSkills": true,
  "emitReadme": true
}
```

`emitMcp` is an optional Codex field in the TypeScript schema, but it is not present in the current JSON file.

### Role assignments

[`roles`](../modules/agent-manager.md) assigns a normalized agent name to a tier. The current assignments are:

```json
"roles": {
  "orchestrator": "planning",
  "planner": "planning",
  "reasoner": "planning",
  "critic": "planning",
  "code_reviewer": "planning",
  "executor": "execution",
  "explorer": "execution",
  "refactorer": "execution",
  "tester": "execution",
  "fast_lane": "execution"
}
```

The name is derived from the [filename](../modules/pipeline-catalogs.md): the basename is used, a trailing `.md` is removed, the configured `prefix` is removed when present at the start, and the result is lowercased. Role assignment is therefore a mapping to a tier; it is not a direct model override.

## Overrides and Model Inference

[Resolution](../modules/agent-manager.md) is target-specific and follows this order:

1. Look up the normalized agent name in `config[target].overrides`. A matching `ModelTarget` wins immediately and is reported with `source: "override"`.
2. Use `roles[normalizedAgentName]` when it points to a configured tier. This is reported with `source: "role"`.
3. When `inference` is not `false`, compare the agent's `frontmatter?.model` or `agent.model` with the inference index. A unique tier match is reported with `source: "inferred"` and includes `inferredFrom`.
4. Use `defaultTier`, or the first configured tier if `defaultTier` is unavailable in the in-memory configuration. This is reported with `source: "default"`.

Inference indexes both the lowercased full model string and its bare name after the final `/`. The index only includes candidates with a valid role-to-tier mapping and a model. If a model matches more than one tier, inference abstains and resolution falls back instead of choosing arbitrarily.

These mechanisms are distinct:

- **Role assignment**: `roles[agentName] = tierName`; it selects a tier profile.
- **Per-agent override**: `claude.overrides[agentName]` or `codex.overrides[agentName]`; it supplies a target-specific `ModelTarget` directly and takes precedence over the tier's target model.
- **Model inference**: derives a tier from an existing agent model only when there is no explicit role assignment and inference is enabled.

## Validation, Defaults, and Migration

[`normalizeTranslationConfig`](../modules/agent-manager.md) merges partial input with defaults, including default tiers, roles, and target-specific objects. Loading a missing file returns the normalized default configuration. A v2 file is normalized and then validated; unsupported versions throw `unsupported config version: <version>`.

Validation requires:

- at least one tier;
- every role to reference an existing tier;
- `defaultTier` to reference an existing tier;
- every tier to contain both `claude.model` and `codex.model`; and
- `sourceDir` to pass the workspace-relative path check.

Files with no `version` or with `version: 1` are migrated to v2. Migration maps v1 Claude `primaryModel` and Codex `modelMapping.primary` (or `opus`) into the `planning` tier, and Claude `defaultSubagentModel` plus Codex `modelMapping.default` into `execution`. It defaults `sourceDir` to `general`, keeps the Codex emission settings, and initializes both override maps empty. If both Codex `primary` and `opus` differ, `primary` wins with a migration warning. Legacy `claude.modelMap` and `codex.modelMapping.exact` entries are discarded with warnings; wildcard entries are explicitly unsupported in v2.

By default, a migrated configuration is persisted through `saveTranslationConfig`. Saving also normalizes and validates the configuration, creates the parent directory, writes pretty-printed JSON, and rejects a configuration path outside the workspace.
