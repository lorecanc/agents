# Configuration theater

Occurs when configuration options, feature flags, settings, runtime switches, strategy selections, providers, or deployment parameters are introduced without meaningful variability, operational value, or current requirements.

The implementation appears configurable but in practice only one meaningful configuration exists.

Flag when:

- A configuration value has only one valid option.
- A feature flag is added for functionality that is always enabled.
- Strategy selection exists despite having only one strategy.
- A provider setting exists despite having only one provider.
- Runtime flexibility is added where compile-time or hardcoded behavior would be sufficient.
- New configuration exists solely to support hypothetical future requirements.
- Changing the setting would result in unsupported or untested behavior.
- Most deployments use exactly the same value.

Acceptable when:

- Multiple configurations are currently required.
- Different environments genuinely need different behavior.
- Operational teams must be able to modify behavior without deployment.
- The configuration supports documented architecture or deployment requirements.
- Multiple supported implementations already exist.

Before flagging, answer:

1. How many valid values currently exist?
2. Does any deployed environment require different values?
3. Would changing the value be a supported operation?
4. Is the configuration solving a current operational need?
5. Would hardcoding the value simplify the system?

Verdict guidance:

- pass: configuration supports real operational variability.
- pass-with-comments: future variability may be plausible but current cost is low.
- reject: substantial configuration complexity is added without current operational justification.
