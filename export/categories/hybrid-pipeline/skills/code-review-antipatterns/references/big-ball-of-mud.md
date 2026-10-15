# Big Ball of Mud

Emerges when system structure gradually deteriorates and boundaries between modules become increasingly blurred. New code is added wherever it is convenient, causing dependencies, responsibilities, and business rules to spread across unrelated parts of the codebase.

Unlike a God Object (which concentrates complexity in one place), a Big Ball of Mud distributes complexity across the system in ways that make ownership, dependencies, and architectural boundaries difficult to understand.

Flag when:

- A change introduces new cross-module dependencies without clear justification.
- Business logic is split across unrelated modules.
- Features require modifications in many distant parts of the system.
- Similar responsibilities appear in multiple locations.
- Modules begin accessing each other's internals rather than using established interfaces.
- The diff bypasses existing architectural boundaries for convenience.
- Ownership of data or behavior becomes ambiguous.
- New code follows existing examples of architectural decay rather than existing architectural intent.
- A feature cannot be clearly assigned to a single owning module or bounded area.

Acceptable when:

- The dependency is required by the domain model.
- The dependency follows documented architecture.
- The boundary change simplifies the overall system.
- The change consolidates duplicated responsibilities.
- The modification reduces coupling rather than increasing it.

Before flagging, answer:

1. Which module owns this behavior?
2. Which module owns this data?
3. Does the new dependency respect existing boundaries?
4. Would a developer know where to add similar functionality in the future?
5. Does the change strengthen or weaken architectural cohesion?

This anti-pattern should be evaluated at system level, not at file level, through a deep architectural chain of references. A small local change may still be rejected if it contributes to long-term architectural erosion.

Verdict guidance:

- pass: module ownership remains clear and architectural boundaries are preserved.
- pass-with-comments: some coupling increase exists but remains understandable.
- reject: the change materially weakens module boundaries, spreads responsibilities across unrelated areas, or increases architectural entropy.
