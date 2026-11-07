# Reinventing the wheel

Occurs when a change implements functionality that already exists within the language, standard library, framework, platform, repository, dependency set, or documented architecture.

Every new implementation carries maintenance, testing, documentation, defect, and security costs. Existing solutions should be preferred unless there is a clear reason not to use them.

Flag when:

- A standard library capability is reimplemented.
- Existing framework functionality is duplicated.
- Repository utilities are recreated instead of reused.
- Existing dependencies already provide the required behavior.
- Infrastructure capabilities are recreated in application code.
- Similar code already exists elsewhere in the repository.
- New code duplicates established architectural services.

Acceptable when:

- Existing solutions cannot satisfy the requirement.
- The existing solution has unacceptable limitations.
- Security, performance, reliability, or compliance requirements justify replacement.
- The repository has a documented convention requiring custom implementation.

Before flagging, answer:

1. Does the capability already exist?
2. Is an established implementation already available?
3. Why is the existing solution insufficient?
4. Would reuse reduce maintenance burden?
5. Is the new implementation providing meaningful additional value?

Verdict guidance:

- pass: reuse is preferred where appropriate.
- pass-with-comments: some duplication exists but justification is reasonable.
- reject: significant functionality is reimplemented without clear justification.
