# Gas Factory / Swiss Army Knife

Occurs when a class, service, manager, utility, helper, processor, engine, orchestrator, or factory accumulates too many unrelated responsibilities and becomes the default place to add new behavior.

New behavior should normally be placed in the most cohesive existing module rather than expanding an already oversized component.

Flag when:

- A single class or module owns many unrelated responsibilities.
- A service keeps growing whenever new functionality is added.
- New cases are implemented as additional branches inside an existing "god object".
- A utility or helper becomes the default destination for unrelated logic.
- Method count, configuration count, or dependency count grows continuously.
- A component depends on many external services or repositories.
- The name is generic and broad (`Manager`, `Processor`, `Engine`, `Coordinator`, `Helper`, `Service`, `Factory`, `Toolkit`) while its responsibilities span multiple domains.
- The change increases the size and scope of an already large component instead of extending a more appropriate module.
- Most future changes to the feature area are likely to touch the same file.

Acceptable when it:

- Represents a genuinely cohesive domain concept.
- Exists as a documented architectural boundary.
- Performs orchestration while domain logic remains elsewhere.
- Must aggregate multiple dependencies due to its explicit responsibility.
- Is large because of current functional requirements rather than accumulated convenience.

Before flagging, answer:

1. Does the component have a single clear responsibility?
2. Are the newly added behaviors strongly related to its existing responsibility?
3. Would a developer reasonably expect this logic to live here?
4. Is the growth caused by real orchestration needs?
5. Would moving the logic elsewhere improve cohesion?

Verdict guidance:

- pass: responsibilities remain cohesive and the component scope is stable.
- pass-with-comments: some signs of responsibility growth exist but remain manageable.
- reject: the change significantly expands a generic component into a central catch-all location for unrelated behaviors.
