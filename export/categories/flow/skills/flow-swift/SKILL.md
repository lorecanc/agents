---
name: flow-swift
description: Apple platform work (Swift, SwiftUI, UIKit, iOS/macOS/watchOS/visionOS) - find the deployment target, ground APIs in Cupertino/Axiom MCP docs instead of memory, modern SwiftUI and concurrency patterns, HIG checks, and building/testing with XcodeBuildMCP. Load when writing or reviewing Swift code.
---

# Swift and Apple platforms

## 1. Establish the facts first

- Find the **deployment target**: `IPHONEOS_DEPLOYMENT_TARGET`/`MACOSX_DEPLOYMENT_TARGET` in the build settings, `platforms:` in `Package.swift`, or the `.xcodeproj` (`grep -r DEPLOYMENT_TARGET`). Every API decision depends on it.
- Find the Swift version and the language mode (Swift 6 strict concurrency or not).
- Never claim a newer iOS or Xcode version "doesn't exist". Apple went from iOS 18 to iOS 26. Defer to the docs for the latest version.

## 2. Ground APIs in docs, not memory

Cupertino MCP (`cupertino_*`):
- `search_symbols(query, framework)` checks that a symbol exists. `read_document(uri, source)` gives availability and deprecation.
- `search(query, source: "hig" | "apple-docs" | "swift-evolution", framework, limit: 3)` gives design guidance and proposals.
- Keep queries specific (a type or API name) and **always set `limit` to 3 or less** and a framework. Large generic queries stall the server.
- If a Cupertino call times out, stop calling it this session and fall back to Axiom.

Axiom MCP (`axiom_*`):
- Run `axiom_search_skills(query)`, then `axiom_read_skill(name)`, filtered to the sections you need, for SwiftUI, concurrency, data, networking, accessibility and performance patterns.

For any API newer than the deployment target, add `if #available` / `@available` and a fallback path.

## 3. Modern defaults (verify availability against the target)

- Use `@Observable` (iOS 17+) over `ObservableObject`. Use `@State` for owned models and `@Bindable` for bindings.
- Use `NavigationStack`/`NavigationSplitView`, never `NavigationView`.
- Use `.task {}` for async work tied to view lifetime, not `onAppear { Task { } }`.
- Use the two-parameter `onChange(of:)` (iOS 17+) or the older one-parameter form, depending on the target.
- Use SwiftData or Core Data with explicit migrations. Never ship a destructive migration silently.
- Use `async`/`await` with `URLSession` and typed `Codable` models, and decode on a background executor.

## 4. Concurrency

- UI state and view models are `@MainActor`. Use actors for shared mutable state, and value types and `Sendable` across boundaries.
- Do not use `Task.detached` unless isolation must be dropped on purpose, and avoid `nonisolated(unsafe)`. Handle cancellation in long tasks.
- Under Swift 6, fix concurrency diagnostics at the source. Do not silence them with `@preconcurrency` or `@unchecked Sendable` without a reason written in a comment.

## 5. HIG and accessibility

- Follow the platform's navigation idioms: tabs for top-level sections on iPhone, sidebars on iPad and Mac.
- Use system colors and materials, SF Symbols, Dynamic Type (no fixed font sizes), and at least 44pt tap targets.
- Add VoiceOver labels on icon-only buttons, and support dark mode and increased contrast.

## 6. Build and test (XcodeBuildMCP)

1. Run `session_show_defaults` once and set the project, scheme and simulator if they are missing. Call `discover_projs` only when they are missing.
2. Run `build_sim` or `build_run_sim`, then `test_sim` for the relevant tests.
3. For UI, use `screenshot` or `snapshot_ui` and judge the result with the `flow-frontend-design` rubric (hierarchy, spacing, typography, contrast), adapted to the HIG.
4. If the toolchain is not available, report `UNVERIFIED` with the reason.
