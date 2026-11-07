# Interface for one implementation

Occurs when an abstraction layer is introduced despite having only a single implementation, no current variability, and no demonstrated need for polymorphism.

Treat interfaces, protocols, traits, abstract classes, and service contracts as design tools rather than default coding conventions. An abstraction should exist because multiple implementations, boundary protection, testing requirements, or architectural constraints justify it—not because abstractions are assumed to be inherently better.

Flag when:

- A new interface is introduced with exactly one implementation.
- There is no current or planned second implementation required by the user request.
- The interface simply mirrors the public methods of its only implementation.
- The abstraction does not protect a meaningful architectural boundary.
- The interface exists solely to satisfy dependency injection patterns.
- A repository, service, provider, client, manager, handler, or adapter interface is created without demonstrated variability.
- The implementation would be equally understandable if referenced directly.

Acceptable when:

- Multiple implementations already exist.
- Multiple implementations are required by current requirements.
- The interface represents a stable architectural boundary.
- The interface separates application code from infrastructure concerns.
- The repository follows a documented architecture that explicitly requires the abstraction.
- Testing strategy genuinely benefits from the boundary.
- The abstraction protects external integrations, APIs, databases, message buses, or other volatile dependencies.

Verdict guidance:

- pass: the abstraction protects a real boundary or enables real variability.
- pass-with-comments: the interface is premature but low-cost.
- reject: a single-implementation interface adds indirection without protecting a meaningful boundary.
