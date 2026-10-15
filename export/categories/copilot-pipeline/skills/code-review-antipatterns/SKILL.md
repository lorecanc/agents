---
name: code-review-antipatterns
description: Detailed catalog of code review anti-patterns (YAGNI, reinventing the wheel, god objects, modularity and layer violations, accidental complexity, configuration theater, band-aid fixes, and more). Each entry has a definition, when to flag, when it is acceptable, the questions to answer before flagging, and verdict guidance.
---

# Code review anti-pattern catalog

Reference for `*-pipeline-code_reviewer`. The reviewer prompt carries a compact checklist; open the detailed entry here **only** before flagging or rejecting on that anti-pattern, or when a case is borderline.

## How to use

1. Spot a candidate with the checklist in the reviewer prompt.
2. Read the matching file in `references/` (just that one).
3. Answer its "Before flagging" questions about the actual diff, check "Acceptable when", and apply its verdict guidance.
4. Report the anti-pattern by name in the review output, with file and line.

## Entries

| Anti-pattern | File |
|---|---|
| YAGNI violations | `references/yagni-violations.md` |
| Reinventing the wheel | `references/reinventing-the-wheel.md` |
| Reinventing the square wheel | `references/reinventing-the-square-wheel.md` |
| God Class / God Object / God Method | `references/god-class.md` |
| Onion helper encapsulation | `references/onion-helper-encapsulation.md` |
| Gas Factory / Swiss Army Knife | `references/gas-factory.md` |
| Big Ball of Mud | `references/big-ball-of-mud.md` |
| Knowledge duplication | `references/knowledge-duplication.md` |
| Modularity violations | `references/modularity-violations.md` |
| Accidental complexity | `references/accidental-complexity.md` |
| Interface for one implementation | `references/interface-for-one-implementation.md` |
| Configuration theater | `references/configuration-theater.md` |
| Environment pollution | `references/environment-pollution.md` |
| Magic values and hidden domain knowledge | `references/magic-values-and-hidden-domain-knowledge.md` |
| Band-Aid fix / Palliative patch | `references/band-aid-fix.md` |
| Arrow anti-pattern / Deep nesting | `references/arrow-anti-pattern.md` |
| Boolean parameter trap | `references/boolean-parameter-trap.md` |
| Layer boundary violation (strict) | `references/layer-boundary-violation.md` |
