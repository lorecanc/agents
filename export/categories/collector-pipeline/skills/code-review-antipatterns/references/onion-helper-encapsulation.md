# Onion helper encapsulation

Happens when a change introduces multiple thin helper functions, wrapper modules, service layers, adapter files, or utility classes that mostly delegate to each other without adding meaningful domain behavior, validation, dependency isolation, reuse, or simplification.

Prefer direct code over unnecessary indirection.

Flag when:

- A helper is mostly a one-line delegation.
- Parameters are passed unchanged through multiple layers.
- New files/modules exist only to host a trivial wrapper.
- Controller → service → manager → helper → util chains add little or no behavior.
- Existing platform/framework functionality is hidden behind local wrappers.
- Abstractions are justified by possible future needs rather than current requirements.

Acceptable when it:

- Removes real duplication.
- Names a meaningful domain concept.
- Isolates a dependency or side effect.
- Centralizes validation, authorization, parsing, normalization, or error translation.
- Improves testability.
- Implements a documented architectural boundary.

Before flagging, answer:

1. What responsibility does this new layer own?
2. Is there more than one current call site?
3. Does it isolate a dependency or side effect?
4. Does it add validation, policy, or error handling?
5. Would removing it make the code simpler?

If most answers are "no", consider the layer unnecessary indirection.

Verdict guidance:

- pass: every helper has a clear responsibility.
- pass-with-comments: slightly over-extracted but still maintainable.
- reject: multiple trivial layers, speculative wrappers, or unnecessary call-chain depth.
