---
title: "Architecture"
description: "Repository layers and generation flows for the agent catalog and manager."
category: "root"
source_files:
  - "README.md"
  - ".agent-manager/categories/wiki.json"
  - ".agent-manager/categories/docs.json"
  - ".agent-manager/categories/slides.json"
  - ".agent-manager/pipeline-profiles.json"
  - ".agent-manager/companion-links.json"
  - ".agent-manager/translation-config.json"
  - "manage-agents/README.md"
  - "manage-agents/src/index.tsx"
  - "manage-agents/src/utils/categoryDistribution.ts"
  - "manage-agents/src/utils/pipelineProfiles.ts"
created: "2026-10-16"
last_updated: "2026-10-16"
---

# Architecture

## Overview

The repository separates authored material from configuration and generated output. `src/` holds the canonical catalog and OpenCode blueprint; `.agent-manager/` declares category allowlists, pipeline model profiles, companion-resource links, and translation settings, as detailed in [Workspace and Distribution Configuration](./config/workspace-and-distribution.md). The [Agent Manager](./modules/agent-manager.md) reads these inputs and maintains generated distributions and bridges in `export/`.

## Component Diagram

```mermaid
graph TD
    subgraph "Canonical inputs"
        Sources["src/: agents and resources"]
        Blueprint["src/opencode.json"]
    end
    subgraph "Declarations"
        Manifests[".agent-manager/categories/*.json"]
        Profiles["pipeline-profiles.json"]
        BridgeConfig["translation-config.json"]
    end
    Manager["manage-agents CLI and TUI"]
    CategoryBuilder["Category distribution generator"]
    PipelineTools["Pipeline profile and stamping utilities"]
    BridgeTools["Claude Code and Codex bridge renderers"]
    Outputs["export/categories/ and export/bridges/"]
    Sources --> Manager
    Blueprint --> Manager
    Manifests --> CategoryBuilder
    Profiles --> PipelineTools
    BridgeConfig --> BridgeTools
    Manager --> CategoryBuilder
    Manager --> PipelineTools
    Manager --> BridgeTools
    CategoryBuilder --> Outputs
    PipelineTools --> Outputs
    BridgeTools --> Outputs
```

The manager is the entry point for interactive and command-line operations; focused utilities interpret the relevant declarations and write the corresponding generated output. The [custom tools and plugins](./modules/tools-and-plugins.md) provide additional document, slide, and pipeline operations alongside these generation flows.

## Data Flow

```mermaid
sequenceDiagram
    participant Maintainer
    participant Manager as manage-agents
    participant Manifest as .agent-manager manifest
    participant Source as src/ canonical resources
    participant Generator as Category generator
    participant Output as export/categories
    Maintainer->>Manager: Run category build <id>
    Manager->>Manifest: Load and validate category declaration
    Manager->>Source: Read allowlisted resources
    Manager->>Generator: Build expected package contents
    Generator->>Output: Publish generated distribution
    Manager-->>Maintainer: Report current or stale status
```

Category manifests define explicit sources, destination paths, content policies, and any generated configuration. The generator validates manifest structure and resource paths, produces package metadata, and can compare the output with expected contents through the read-only check operation.

## Key Design Decisions

### Canonical inputs are separate from generated distributions

- **Context**: Category distributions are projections of selected canonical resources, and provider pipelines are stamped from the base pipeline.
- **Decision**: Author and configure in `src/` and `.agent-manager/`; generate distributions and bridges into `export/`.
- **Consequences**: Generated folders are reproducible outputs; changes should be made in their declared sources and regenerated.

### Category membership is manifest-driven

- **Context**: Category packages may include selected agents and their supporting commands, skills, or tools.
- **Decision**: Each category JSON manifest lists its resources and targets explicitly rather than selecting files by filename alone.
- **Consequences**: The build can validate its source/target declarations and provide a deterministic inventory, while membership changes require updating the manifest.
