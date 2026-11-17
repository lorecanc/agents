---
description: Run an isolated, evidence-based Chrome DevTools audit and return a diagnostic report.
agent: chrome-devtools
subagent: true
---

Audit the following URL, component, or issue with Chrome DevTools:

$ARGUMENTS

---

Before inspecting, identify:

1. URL or component under analysis: which page or element is involved?
2. Observed symptom: what is the user seeing that is wrong?
3. Problem domain: is this a performance issue (LCP/CWV), accessibility, memory leak, or interactive behavior?
4. Initial hypothesis: what is the likely cause?
5. Expected output: what must the final response contain?

Then follow the DevTools workflow:

- Load the skill that matches the problem domain from the agent's skill table.
- Gather relevant evidence with the available DevTools tools: snapshots, screenshots, traces, console messages, and network logs.
- Explain the findings, likely root cause, and concrete recommended fix.
- Be explicit about uncertainty or evidence you could not collect.

Do not modify files. Return only the diagnosis and recommended fixes.
