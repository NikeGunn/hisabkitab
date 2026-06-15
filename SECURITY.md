# Security Policy

HisabKitab handles small businesses' financial data, so we take security seriously.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Instead, report privately via a
[GitHub Security Advisory](https://github.com/NikeGunn/hisabkitab/security/advisories/new).

Please include: what you found, how to reproduce it, and the potential impact. We aim to
acknowledge within 72 hours and to ship a fix or mitigation as quickly as the severity warrants.

## Scope & design guarantees

These are enforced in code (not just policy) and are good places to look for issues:

- **Tenant isolation** — every row is `tenant_id`-scoped with Postgres Row-Level Security;
  the tenant is derived from a signed session token, never from a tool argument or the model.
- **Server-side RBAC** — roles (owner/accountant/staff/viewer) are enforced in the MCP tools
  and RLS; the role travels inside the HMAC-signed token and cannot be set by the model.
- **No money action without explicit owner consent**; nothing is saved until confirmed.
- **No credentials over chat** — a guard refuses passwords/OTPs/portal logins before they reach
  the agent or any log.
- **Never auto-files with the government**; the app only prepares numbers.

## Please do not

- Test against real tenants or production data.
- Attempt denial-of-service, spam, or social-engineering attacks.
- Access data that isn't yours.

Secrets must never be committed; the repo has push protection and secret scanning enabled.
