# Band-Aid fix / Palliative patch

Occurs when a change addresses a specific symptom rather than the underlying cause. The fix works for the reported case but does not correct the software's general behavior. When a similar but non-identical scenario arises, the problem reappears — often requiring yet another special case.

The core question is: "Does this fix correct *why* the software misbehaves, or does it only handle *this particular case* of misbehavior?"

A corrective fix changes the underlying logic so the specific case is resolved *as a consequence* of the general correction. A palliative fix adds special-case handling that works only for the exact scenario reported.

Flag when:

- The fix adds a conditional that checks for a specific value, ID, name, or case rather than correcting the general logic.
- The fix works only for the exact input described in the bug report and would fail for similar but different inputs.
- The fix duplicates logic to handle "the special case" alongside the general case.
- The fix adds a flag, parameter, or configuration to disable a behavior only in a specific context.
- The explanation of the fix starts with "when the value is..." or "in the case where..." rather than "the logic now correctly handles...".
- The fix adds a workaround explicitly documented as such (e.g., `// HACK`, `// WORKAROUND`, `// TODO: fix properly`).
- The diff adds code but does not modify or remove the code that caused the original misbehavior.
- Multiple previous fixes in the same area follow the same pattern of adding special cases.

Acceptable when:

- Backward compatibility constraints prevent changing the underlying behavior.
- The root cause is in a third-party dependency or external system outside the project's control.
- A corrective fix would require a large-scale refactor and the team has explicitly decided to defer it (must be documented).
- The special case genuinely represents an exception in the domain model, not a bug in the logic.
- Time-critical hotfix with an explicit follow-up plan to address the root cause.

Before flagging, answer:

1. What is the root cause of the reported behavior?
2. Does this fix correct the root cause or add handling for the specific case?
3. If a similar but different input arrives, will the software behave correctly?
4. Is the fix adding a new conditional/branch or correcting existing logic?
5. Could the same class of bug reappear in a different form after this fix?
6. If this fix were removed in 6 months, would the underlying problem resurface?

Verdict guidance:

- pass: the fix addresses the root cause; the specific case is resolved as a consequence.
- pass-with-comments: minor palliative element exists but the core logic is corrected and the risk of recurrence is low.
- reject: the fix adds special-case handling without correcting the underlying behavior, and a corrective fix is feasible.
