# Knowledge duplication

Occurs when the same business rule, domain concept, invariant, workflow, policy, validation logic, state transition, threshold, calculation, or decision is represented in multiple locations.

The problem is not duplicated implementation—it is duplicated knowledge. When domain knowledge exists in multiple places, the locations can gradually diverge, causing inconsistencies, defects, maintenance overhead, and uncertainty about the system's true behavior.

Focus on ownership of business knowledge rather than textual similarity.

Flag when:

- The same business rule appears in multiple modules.
- Validation logic is repeated in several locations.
- State transition rules are reimplemented across features.
- Domain thresholds, limits, classifications, or calculations exist in multiple places.
- Multiple modules independently derive the same business decision.
- Similar logic evolves separately rather than sharing a common source of truth.
- A new implementation reproduces existing domain logic instead of reusing the owning module.
- The reviewer cannot identify a single authoritative location for the rule.

Acceptable when:

- Duplication is intentionally required by architecture or performance constraints.
- The duplicated logic is trivial and unlikely to evolve.
- The duplicated behavior is purely presentational.
- The shared abstraction would create more complexity than the duplication itself.
- The duplicated code does not represent important business knowledge.

Before flagging, answer:

1. Does the duplicated behavior represent domain knowledge?
2. Is there already an authoritative implementation?
3. Could future changes require updating multiple locations?
4. Would divergence create incorrect business behavior?
5. Is there a clear owner for this rule?

Do not aggressively extract helpers solely to eliminate duplication. A small amount of duplicated code is often preferable to introducing onion helpers, unnecessary abstractions, or artificial coupling. The goal is to centralize knowledge, not necessarily implementation.

Verdict guidance:

- pass: domain knowledge has a clear owner and source of truth.
- pass-with-comments: some duplication exists but risk of divergence is low.
- reject: significant business rules, validations, calculations, state transitions, or invariants are being duplicated across the codebase.
