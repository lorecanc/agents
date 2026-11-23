# Magic values and hidden domain knowledge

Occurs when strings, numbers, identifiers, flags, codes, limits, thresholds, formats, or protocol values encode important domain knowledge without making their meaning explicit. The issue is not the use of literals themselves—the issue is when a reviewer cannot determine why a value exists, where it comes from, or what business rule it represents.

Flag when:

- A numeric threshold appears without explanation.
- A timeout, retry count, limit, percentage, or weight has no documented rationale.
- Business logic depends on opaque string values.
- Protocol codes, status values, or identifiers are duplicated across the codebase.
- The same literal appears in multiple locations.
- Changing the value would require understanding hidden business knowledge.
- A set of discrete, related values (status codes, modes, categories) is represented as raw strings or integers instead of an enum or union type.
- Boolean flags or numeric codes are used where a named enum would make the domain semantics explicit.

Acceptable when:

- The meaning is universally obvious.
- The value is used only once and is self-explanatory.
- Extracting a constant would not improve understandability.
- The literal represents standard language or framework usage.
- The value is immediately understandable from context.
- The language does not support enums or the overhead of introducing one is disproportionate.

Before flagging, answer:

1. Does the value represent domain knowledge?
2. Would a maintainer understand why this value exists?
3. Is the same value duplicated elsewhere?
4. Would naming the value improve clarity?
5. Would extracting it reduce future maintenance risk?

Do not require constant extraction for every literal. Named constants should improve understanding, not merely replace literals.

Verdict guidance:

- pass: all domain-significant values are clear from context or properly named.
- pass-with-comments: some values would benefit from naming but risk is low.
- reject: critical business rules are hidden behind unexplained literals.
