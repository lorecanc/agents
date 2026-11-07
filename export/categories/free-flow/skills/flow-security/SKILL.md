---
name: flow-security
description: Security checklist for writing and reviewing code that touches authentication, authorization, user input, files, shell, network, crypto, secrets, serialization or dependencies. Area-by-area checks with the safe pattern for each, severity rules based on reachability, and how to report findings with CWE ids. Load when implementing or reviewing such code.
---

# Security checklist

Use it twice: **while writing** (choose the safe pattern up front) and **while reviewing** (look for the unsafe one).
A finding needs a concrete path. Name the input the attacker controls, the line it reaches, and the effect.
Pattern matches with no reachable input are informational, not findings.

## By area: unsafe → safe

**Injection (CWE-74 family)**
- SQL built with concatenation, f-strings or template literals → parameters or placeholders, or the query builder's binding API (CWE-89).
- Shell with interpolated input (`exec(\`… ${x}\`)`, `shell=True`, `os.system`) → `execFile`/`spawn` or `subprocess.run([...])` with an argument array and an allowlist for the command (CWE-78).
- `eval`, `new Function`, dynamic `import()` of user strings → parse the data and dispatch through a map (CWE-95).
- HTML: `innerHTML`, `dangerouslySetInnerHTML`, `v-html`, `|safe` with user data → text nodes or framework escaping; if HTML is required, use DOMPurify or an equivalent with a strict config (CWE-79).
- NoSQL queries built from request objects (`{ $where }`, operator injection) → validate the shape with a schema first.
- Header or log injection: strip CR/LF from values written to headers or logs.

**Input validation (CWE-20)**
- Validate at the boundary (request handler, CLI, message consumer) with a schema (zod, pydantic, valibot, JSON Schema). Check type, length, range, format and allowlist.
- Never trust client-side validation, hidden fields, `Content-Type` or file extensions.

**Authentication and sessions (CWE-287, 384, 613)**
- Hash passwords with argon2id, scrypt or bcrypt only. Never use md5, sha1 or a plain sha256.
- Session cookies use `HttpOnly`, `Secure` and `SameSite=Lax` or `Strict`. Rotate the session id on login and expire it.
- Tokens: verify the signature **and** `exp`/`aud`/`iss`, and reject `alg: none`. Never put secrets in JWT payloads.
- Compare secrets in constant time (`crypto.timingSafeEqual`, `hmac.compare_digest`).
- Rate-limit login, reset and OTP endpoints.

**Authorization (CWE-284, 639, 862)**
- Every handler that reads or changes a resource checks that the **current user owns or may access that id** (IDOR).
- Deny by default. Admin and role checks happen on the server, not only by hiding UI.
- Mass assignment: never spread the request body into a model. Pick the allowed fields.

**Files and paths (CWE-22, 434)**
- Resolve the path and check it stays inside the base directory (`path.resolve` + `startsWith(base + sep)`, or `realpath`).
- For uploads, enforce size limits, check the type by content, store under a random name outside the web root, and never execute uploads.

**Network and SSRF (CWE-918)**
- For URLs from users, use an allowlist of hosts and schemes and block private, link-local and metadata IPs after DNS resolution. Disable redirects or re-check them.
- TLS verification is never disabled in non-test code (`rejectUnauthorized: false`, `verify=False`).
- CORS: no `*` with credentials; use an explicit origin allowlist.

**Secrets and data exposure (CWE-798, 532, 200)**
- No secrets in code, tests, fixtures, logs or client bundles. Use environment variables or a secret manager, and add a `.env.example` entry with a placeholder.
- Do not log tokens, passwords, full card numbers or PII. Redact them.
- Error responses carry no stack traces or SQL errors in production.
- Frontend: anything prefixed `NEXT_PUBLIC_` or `VITE_` is public.

**Deserialization (CWE-502)**
- Untrusted data never goes to `pickle`, `yaml.load` (use `safe_load`), Java native serialization or `unserialize`.

**Crypto (CWE-327, 330)**
- Use the platform's high-level APIs (libsodium, WebCrypto, `cryptography`). Use AES-GCM or ChaCha20-Poly1305, never ECB or custom schemes.
- Random values for security come from a CSPRNG (`crypto.randomUUID`, `secrets`), never `Math.random`.

**Dependencies (CWE-1104)**
- A new dependency needs a reason. Prefer maintained, popular packages and pin versions.
- Run the ecosystem audit when it is available (`npm audit --omit=dev`, `pip-audit`) if dependencies changed.

**Web app hardening**
- Use CSRF protection for cookie-authenticated state changes.
- Add security headers (CSP, `X-Content-Type-Options`, `frame-ancestors`) where the project configures headers.
- Open redirects: redirect only to relative paths or allowlisted hosts.

## Severity (judge in context)

- **critical**: remotely reachable without authentication, attacker-controlled input, sensitive data or code execution, and no mitigation.
- **high**: exploitable with some precondition (an authenticated user, a specific config), with significant impact.
- **medium**: needs unusual conditions, or a partial mitigation exists.
- **low / info**: theoretical, test-only code, or a best-practice deviation.

## Reporting format (one line per finding plus a fix)

`[severity] path:line: CWE-<id> <title>. <input> → <sink> → <effect>. Fix: <specific change>.`

If the `cwe-search` MCP is available, use it to confirm the CWE id. If it is not, use the ids above. Never invent one.
