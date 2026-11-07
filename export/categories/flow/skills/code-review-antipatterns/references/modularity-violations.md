# Modularity violations

Occurs when a change creates or reinforces dependencies that conflict with the intended module boundaries of the system.

Look for discrepancies between:

- how modules are expected to depend on each other according to repository structure, documented architecture, naming, layering, package boundaries, or wiki guidance;
- how modules actually become coupled through imports, calls, shared data, duplicated rules, hidden knowledge, side effects, or repeated co-changes.

Flag when:

- A module imports or calls into another module that should be independent.
- A higher-level module reaches into lower-level internals instead of using an established public API.
- A lower-level module starts depending on application, UI, routing, controller, orchestration, or infrastructure code.
- Business rules owned by one module are duplicated or partially reimplemented in another module.
- A change requires editing multiple modules that should evolve independently.
- A module needs knowledge of another module's internal data shape, naming, lifecycle, flags, or implementation details.
- A new dependency bypasses an existing boundary, adapter, repository, service, event, or interface.
- The diff makes future changes more likely to require coordinated edits across modules.
- The implementation follows an existing architectural shortcut instead of the intended architecture.

Acceptable when:

- It follows documented architecture or established repository conventions.
- It uses a public API or stable boundary intentionally provided by the depended-on module.
- It reduces coupling by consolidating previously duplicated logic.
- It moves behavior closer to the module that naturally owns it.
- It introduces an explicit boundary that makes future independent evolution easier.
- The user request explicitly requires integration between the affected modules.

Before flagging, answer:

1. Which module owns the behavior being added or changed?
2. Which module owns the data being accessed or mutated?
3. Is the new dependency allowed by the repository architecture?
4. Does the dependency go through a stable public boundary?
5. Would future changes to one module now require changes to another module?
6. Is business logic being duplicated across module boundaries?
7. Would moving the logic to the owning module reduce coupling?

Use repository evidence when available:

- Check nearby imports and existing call direction.
- Check `AGENTS.md`, wiki, package structure, and architectural docs.
- Use codebase-memory graph tools when the review requires impact analysis, call-chain reasoning, or dependency direction checks.
- Use `git log` only when co-change history is directly relevant and the local diff does not provide enough evidence.
- Do not infer a violation from naming alone.

Verdict guidance:

- pass: module ownership remains clear and dependencies respect intended boundaries.
- pass-with-comments: the dependency is suspicious but limited, or the architectural intent is unclear.
- reject: the change introduces or strengthens a dependency that violates module ownership, breaks layering, duplicates business rules across boundaries, or makes independent modules evolve together unnecessarily.
