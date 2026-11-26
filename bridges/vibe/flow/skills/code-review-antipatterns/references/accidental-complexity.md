# Accidental complexity

Occurs when the implementation becomes harder than the underlying problem requires.

Distinguish between:

- essential complexity: complexity inherent to the domain;
- accidental complexity: complexity introduced by implementation choices.

The goal is not to make code small. The goal is to ensure that the implementation remains proportional to the actual problem being solved.

Flag when:

- The solution contains significantly more moving parts than the requirement.
- Multiple abstractions are required to understand a simple behavior.
- The implementation introduces unnecessary files, modules, layers, or workflows.
- A straightforward operation requires excessive control flow.
- The implementation depends on concepts unrelated to the user request.
- Configuration, dependency injection, factories, adapters, or orchestration layers dominate the actual business logic.
- Understanding the code requires navigating large portions of the repository.
- The implementation pattern is more complex than existing repository conventions.

Acceptable when:

- The domain itself is complex.
- Security, reliability, performance, or compliance requirements require additional structure.
- The architecture explicitly requires the implementation pattern.
- The additional complexity reduces larger complexity elsewhere.

Before flagging, answer:

1. What is the actual problem being solved?
2. How many concepts must a maintainer understand to modify it?
3. Is the complexity required by the domain?
4. Does each layer contribute meaningful value?
5. Could the same behavior be implemented more directly?

Verdict guidance:

- pass: complexity is proportional to the problem.
- pass-with-comments: some unnecessary complexity exists but remains manageable.
- reject: the implementation introduces substantial accidental complexity without compensating benefits.
