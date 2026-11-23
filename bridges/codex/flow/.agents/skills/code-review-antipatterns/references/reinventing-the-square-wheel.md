# Reinventing the square wheel

Occurs when a change replaces an existing solution with a custom implementation that is less capable, less maintainable, less tested, less secure, less battle-tested, or less aligned with platform conventions.

Unlike reinventing the wheel, the problem is not merely duplication—the problem is replacing an established solution with an objectively inferior alternative.

Flag when:

- Mature framework functionality is replaced by custom code.
- Standard library features are bypassed without justification.
- Existing repository abstractions are ignored.
- A custom solution introduces more code than the capability it replaces.
- The replacement reduces reliability, observability, security, or maintainability.
- The implementation recreates only a subset of a capability already provided elsewhere.
- Existing battle-tested functionality is replaced with unproven code.
- The change discards repository conventions in favor of custom mechanisms.

Acceptable when:

- The existing solution is demonstrably inadequate.
- The replacement provides measurable and necessary benefits.
- Security, compliance, performance, or reliability requirements justify the change.
- The existing capability cannot satisfy current requirements.

Before flagging, answer:

1. What existing solution already exists?
2. Why was the existing solution not used?
3. Is the new implementation objectively simpler?
4. Is it objectively more capable?
5. Does it reduce long-term maintenance burden?
6. Does it align with repository conventions?

Prefer mature, battle-tested, repository-approved solutions over custom code. Custom implementations require stronger justification than reuse.

Verdict guidance:

- pass: the replacement provides clear and justified benefits.
- pass-with-comments: tradeoffs are debatable but reasonable.
- reject: a weaker custom implementation replaces a stronger existing solution without sufficient justification.
