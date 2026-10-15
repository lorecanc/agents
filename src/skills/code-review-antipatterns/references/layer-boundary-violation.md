# Layer boundary violation (strict)

A stricter specialization of the modularity violations anti-pattern. Applies specifically to layered architectures where each layer should communicate only with the layer directly adjacent to it.

The principle: **never punch holes through layers**. A UI controller must not call a database driver directly. A presentation layer must not reach into the hardware abstraction. Each layer talks to the next layer, which talks to the next, and so on.

Flag when:

- A UI/controller/view layer directly calls a database, filesystem, network driver, or hardware API.
- A presentation layer bypasses a service/business layer to reach a data access layer.
- An application layer calls an infrastructure primitive (raw SQL, direct HTTP, file I/O) instead of using a repository, client, or service abstraction.
- A high-level orchestration component reaches into low-level implementation details.
- A layer skips an intermediate layer to "save time" or "avoid boilerplate".
- The dependency direction violates the expected stack (e.g., a domain model importing a UI framework).

Acceptable when:

- The architecture is intentionally flat (no layered design).
- The layer being "skipped" is documented as transparent or pass-through by design.
- Performance requirements justify bypassing a layer (must be explicitly documented).
- The project is small enough that strict layering would be over-engineering.

Before flagging, answer:

1. What layer does the calling code belong to?
2. What layer does the called code belong to?
3. Are these adjacent layers or is a layer being skipped?
4. Does an intermediate abstraction already exist that should be used?
5. Is the architecture documented as layered?

Verdict guidance:

- pass: all cross-layer calls go through adjacent layers.
- pass-with-comments: a minor shortcut exists but the architecture is otherwise clean.
- reject: a layer directly calls a non-adjacent layer, bypassing an existing intermediate abstraction.
