# YAGNI violations

A YAGNI violation occurs when a change introduces functionality, extensibility, configurability, abstraction, or infrastructure that is not required by the current user request, current requirements, or documented architecture.

Focus on the requested behavior rather than hypothetical future needs.

Flag when:

- Code supports scenarios that do not currently exist.
- An abstraction is added before a second use case exists.
- Extension points are created without current consumers.
- Multiple implementations are prepared although only one exists.
- Generic frameworks are introduced for specific requirements.
- Configuration is added despite having only one valid value.
- Factories, registries, plugin systems, strategy patterns, adapters, or builders are introduced for future possibilities rather than present needs.
- Additional features are implemented beyond the user request.

Acceptable when:

- The abstraction immediately serves multiple existing use cases.
- The extensibility is required by documented architecture.
- The implementation cost is small and materially simplifies current code.
- The added capability is directly required by the task.

Before flagging, answer:

1. Which current requirement needs this capability?
2. What breaks if the abstraction does not exist today?
3. Is there more than one real use case?
4. Is the complexity serving current needs or future speculation?
5. Would a simpler implementation satisfy the request?

If the feature exists primarily for hypothetical future requirements, consider it a YAGNI violation.

Verdict guidance:

- pass: implementation is proportional to current requirements.
- pass-with-comments: minor speculative flexibility exists but cost is low.
- reject: significant complexity is introduced for hypothetical future needs.
