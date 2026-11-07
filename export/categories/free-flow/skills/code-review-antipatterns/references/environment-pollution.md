# Environment pollution

Occurs when environment variables, configuration entries, secrets, flags, settings, or deployment parameters accumulate faster than actual deployment needs.

Each environment parameter increases cognitive load, deployment complexity, documentation burden, testing effort, and operational risk.

Treat every newly introduced environment variable as part of the public operational API of the system.

Flag when:

- New environment variables are introduced unnecessarily.
- Configuration values merely duplicate hardcoded constants.
- Multiple environment variables control behavior that never varies.
- Environment variables are added for speculative future features.
- Related settings are fragmented across many variables.
- The deployment surface grows disproportionately to the feature being implemented.
- New variables are introduced without clear operational ownership.
- The system becomes harder to deploy, test, or document due to configuration growth.

Acceptable when:

- Values genuinely differ across environments.
- Secrets must not be committed to source control.
- Infrastructure or deployment topology requires runtime configuration.
- Operational teams need runtime control.
- The variable supports a documented deployment requirement.

Before flagging, answer:

1. Does this value actually vary between environments?
2. Is runtime configurability required?
3. Could the value safely exist in source code?
4. Does the deployment process become more complex because of this variable?
5. Is the operational benefit larger than the maintenance cost?

Environment variables should be treated as long-term operational commitments. Adding a variable is easy; maintaining, documenting, testing, securing, and supporting it is not.

Verdict guidance:

- pass: the environment variable serves a real deployment or operational need.
- pass-with-comments: justification exists but should be documented more clearly.
- reject: environment surface area grows without corresponding operational value.
