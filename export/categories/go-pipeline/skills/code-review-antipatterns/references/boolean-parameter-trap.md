# Boolean parameter trap

Occurs when a function accepts a `bool` (or equivalent binary flag) parameter that controls behavior, making call sites unreadable. The reader sees `doThing(true)` or `doThing(false)` and cannot understand the meaning without navigating to the function signature.

The fix is to replace the boolean with an enum, named constant, or separate functions — anything that makes the call site self-documenting.

Flag when:

- A function parameter is a boolean that switches between two behaviors.
- The call site reads as `doThing(true)` or `process(false)` with no indication of what the flag means.
- Multiple boolean parameters exist on the same function, creating combinatorial confusion (e.g., `render(true, false, true)`).
- The boolean parameter was added to avoid creating a second function or an enum.
- A comment is needed at the call site to explain the boolean value.

Acceptable when:

- The boolean has a descriptive parameter name that is visible at the call site (e.g., named parameters in Python/Kotlin/Swift: `doThing(recursive=true)`).
- The function is private/internal with few call sites and the meaning is obvious from context.
- The parameter represents a genuine binary state in the domain (e.g., `enabled`, `visible`, `ascending`).
- The language convention strongly favors booleans for this pattern.

Before flagging, answer:

1. Can a reader understand the call site without looking at the function signature?
2. Would an enum or named constant improve readability?
3. Are there multiple boolean parameters on the same function?
4. Is the boolean controlling behavior or representing state?
5. Does the language support named parameters that make the boolean self-documenting?

Verdict guidance:

- pass: boolean parameters are self-documenting at call sites.
- pass-with-comments: a single boolean is slightly ambiguous but the function is internal and rarely called.
- reject: call sites are unreadable due to boolean parameters, and an enum or separate functions would materially improve clarity.
