---
description: Launch a Chrome DevTools audit in an isolated session with a structured diagnostic brief. Uses gpt-5-mini. Does not pollute the main context.
agent: chrome-devtools
subtask: true
---

Run a Chrome DevTools audit for the following problem:

$ARGUMENTS

---

Before starting, build an internal diagnostic brief by answering the following questions mentally:

1. URL or component under analysis: which page or element is involved?
2. Observed symptom: what is the user seeing that is wrong?
3. Problem domain: is this a performance issue (LCP/CWV), accessibility, memory leak, or interactive behavior?
4. Initial hypothesis: what is the likely cause?
5. Expected output: what must the final response contain?

Then proceed with the DevTools workflow:

- Cross-reference the skill table in your system prompt and load the skill that matches the identified problem domain.
- Collect evidence using available DevTools MCP tools: snapshots, screenshots, traces, console messages, network logs.
- Analyze findings and identify the root cause.
- Respond strictly in the structured report format defined in your system prompt.

Do not modify any files. Respond only with diagnosis and recommended fixes.
