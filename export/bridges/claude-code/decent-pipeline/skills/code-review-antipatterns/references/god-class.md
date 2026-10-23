# God Class / God Object / God Method

Exists when so much behavior accumulates in a single location that understanding, modifying, testing, or reviewing the code requires understanding a large portion of the system. The problem is not merely size—it is concentration of responsibility, decision making, and change impact.

Treat excessive centralization as a maintainability risk, especially when a single file, class, object, or method becomes the primary destination for unrelated future changes.

Flag a potential God Object when:

- The component is significantly larger than surrounding components.
- The change adds more behavior to an already large component.
- A method contains multiple logical phases or responsibilities.
- The component has many dependencies, collaborators, or imports.
- A large number of branches, conditionals, or execution paths exist.
- Understanding a change requires reading a substantial portion of the file.
- The same file is repeatedly modified for unrelated feature requests.
- The component acts as a central decision point for many workflows.

Flag a potential God Method when:

- A method performs orchestration, validation, transformation, persistence, and error handling together.
- Logical sections are separated only by comments.
- Multiple loops, conditionals, or nested branches appear in sequence.
- The method would become substantially clearer if divided into named operations.
- The reviewer struggles to summarize the purpose of the method in one sentence.

Acceptable when:

- They represent a genuinely cohesive domain concept.
- The complexity comes from unavoidable business requirements.
- The code remains understandable without extensive cross-referencing.
- The component is acting as a documented architectural boundary.
- Breaking it apart would increase complexity more than reduce it.

Before flagging, answer:

1. Can the component's responsibility be explained in one sentence?
2. Can a reviewer reasonably understand the change without reading the entire file?
3. Is the component large because of domain complexity or because responsibilities kept accumulating?
4. Will future changes likely continue growing this component?
5. Would extracting a cohesive responsibility improve clarity?

Verdict guidance:

- pass: size and complexity remain proportionate to responsibility.
- pass-with-comments: some growth is visible but still manageable.
- reject: the change expands an already oversized component or introduces a new central point of complexity.
