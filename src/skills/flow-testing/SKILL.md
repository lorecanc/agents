---
name: flow-testing
description: How to test changes efficiently - find and follow the project's test setup, reproduce bugs with a failing test first, write focused tests for new behavior, run only the relevant tests during work and the broader suite once at the end, and report verification honestly (VERIFIED / PARTIALLY VERIFIED / UNVERIFIED). Load for bug fixes, new logic, or when unsure what to run.
---

# Testing

## Find the setup (once per session)

- Find the test runner and the commands: `package.json` scripts, `pyproject.toml` or `pytest.ini`, `go test`, `cargo test`, the Gradle or Xcode schemes, or `.opencode/pipeline.json` `verify`.
- Look at 1 or 2 existing tests near the code you are changing, and copy their style: file location, naming, fixtures, assertion library and mocking approach.
- `dev_verify` runs lint, typecheck, targeted tests or the full suite with timeouts. Prefer it over hand-written commands when the project is detected.

## Bugs: reproduce first

1. Write the smallest test that fails **for the reported reason**. Run it and confirm it fails with the expected message.
2. Fix the code.
3. Run the test again and confirm it passes. Then run the neighbors: the same file and the same module.
4. If a test cannot reproduce the bug (UI-only, timing, environment), write down the manual reproduction steps and how you verified the fix.

## New behavior

- Test the public behavior, not the implementation details. Cover the main path, one or two important edge cases (empty input, a boundary, an invalid value) and the error path.
- Do not add tests for trivial getters, for framework behavior, or that re-assert mocks.
- Use real objects where cheap. Mock only at boundaries (network, clock, randomness, external services).
- Make tests deterministic: no sleeps, no real network, no dependence on test order.

## While working

- Run **only** the relevant tests after each meaningful change (the file, a pattern or the package). Fast feedback beats coverage at this stage.
- Run typecheck and lint for the touched files when the project has them.

## Before finishing

- Run the broader suite (or `dev_verify` with `test_fast`/`full`) **once**. If it fails, decide whether your change caused it: compare with the same failure on the starting commit when in doubt.
- Never weaken, skip or delete a test to make it pass unless the test is wrong. If you change one, say why.

## Report verification honestly

- **VERIFIED:** the tests covering the change ran and passed, and you say which ones.
- **PARTIALLY VERIFIED:** some checks ran, some could not. Say which were skipped and why.
- **UNVERIFIED:** nothing could run (a missing service, credentials or environment). Give the exact blocker and the command the user can run.
