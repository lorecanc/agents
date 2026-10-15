# Arrow anti-pattern / Deep nesting

Occurs when control flow accumulates excessive nesting depth, making the code hard to follow. Deeply nested `if/else`, `for`, `try/catch`, or `switch` blocks force the reader to maintain a mental stack of conditions to understand what each branch does.

The fix is almost always to flatten the code: use early returns, guard clauses, `continue`/`break`, or extract the inner logic into a named function.

Flag when:

- Nesting depth reaches 3 or more levels of indentation from the function body.
- A method contains nested conditionals where the "happy path" is buried inside multiple guards.
- `else` blocks contain the primary logic while the `if` block handles the edge case.
- Loop bodies contain deeply nested conditionals that could use `continue` to skip.
- The reader must track 3+ simultaneous conditions to understand which branch executes.

Acceptable when:

- The nesting reflects genuinely complex domain logic that cannot be simplified without losing clarity.
- The language or framework requires the nesting pattern (e.g., certain callback structures).
- Extracting the inner logic into a separate function would obscure the flow more than the nesting does.

Before flagging, answer:

1. Can an early return eliminate one or more nesting levels?
2. Can a guard clause at the top of the function handle the edge case?
3. Can `continue` or `break` flatten a loop body?
4. Would extracting the nested block into a named function improve readability?
5. Is the nesting caused by essential domain complexity or by code structure?

Verdict guidance:

- pass: nesting depth stays at 2 or fewer levels, or deeper nesting is justified by domain complexity.
- pass-with-comments: 3 levels of nesting exist but the code remains readable.
- reject: 4+ levels of nesting, or 3 levels where flattening is clearly possible and would materially improve readability.
