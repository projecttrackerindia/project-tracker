# Security policy

This file states the security rules Project Tracker enforces, where each one lives in the code, and how to report a problem.
It is checked against OWASP ASVS 4.0 Level 2 and the OWASP Top 10 / API Security Top 10.

## Reporting a vulnerability

Email support@projecttracker.in (subject "Security") with the steps to reproduce. Do not open a public issue. We acknowledge reports within two working
days and fix confirmed high or critical issues within 14 days. Test only against your own workspace. Never test against another
customer's data, never run denial-of-service tests, and never use social engineering.

## Sign-up (strict by default)

Every rule runs on the server (`SignupGuard.cs`, `RegisterValidator`). The sign-up form shows the same rules inline (`signupRules.ts`).

| Field | Rule |
|---|---|
| Name | 2 to 60 characters. Letters in any script, joined by single spaces, apostrophes or hyphens. No digits, links, email addresses, emoji or symbols, and no character repeated four or more times. |
| Email | RFC 5322 dot-atom local part (64 characters or fewer) and an RFC 1035 domain with an alphabetic or IDNA top-level domain. No IP literals or quoted local parts. Disposable-inbox domains are refused, including their subdomains (a bundled list, which `Signup:BlockedEmailDomains` extends). The domain must be able to receive mail: it needs an MX record, or an A/AAAA record (the implicit MX). A domain that does not exist or publishes a null MX is refused. A DNS outage never blocks a sign-up. |
| Organisation | 2 to 100 characters with at least two letters. Letters, digits, spaces and `& . , ' ( ) / + -` only. No links. |
| Phone (where collected) | E.164 format. The national number length is checked exactly for +91, +1, +44, +971, +65 and +61 (`SignupRules.PhoneProblem`). |
| Password | 12 characters minimum (platform floor; admins can raise it but not lower it), a letter and a digit. Common passwords and passwords built from the person's name or email are refused. Passwords found in public breaches are refused, checked through the Pwned Passwords k-anonymity range API (only 5 hex characters of the SHA-1 leave the server). |

Bot checks:

- **Honeypot.** A hidden `website` field. A request that fills it in is refused.
- **Time to submit.** `GET /auth/signup-form` returns an HMAC-signed "loaded at" token. A submission less than `Signup:MinSubmitSeconds` (3) after that time is refused, and so is one older than `Signup:MaxFormAgeMinutes` (120). A forged token is refused. `Signup:RequireFormToken` (true) makes the token mandatory.
- **Cloudflare Turnstile (optional).** Turns on when the `Signup__TurnstileSecretKey` environment variable is set. Never commit the secret. When it is on, a failed or unreachable verification refuses the sign-up (fails closed).

Every account must verify its email address before it can sign in or reach a workspace (`App:RequireEmailVerification`, on by default; Go-live
warns when it is off).

Organisations are invite-only: nobody can join one without an invitation. An owner or admin can also limit invitations to the organisation's
own email domains (Settings, Security, "Allowed email domains", stored in `TenantSecuritySettings.AllowedEmailDomains`). An administrator can
close self-service sign-up for the whole platform (`SignupsEnabled`). After that, only invited people can create accounts.

## Authentication and sessions

- Account lockout uses exponential backoff. Five failed attempts lock the account for 15 minutes, and each further lockout in a row doubles that time, up to 24 hours (`LockoutPolicy`). A successful sign-in or a password reset resets the count. The password is checked before the lockout, so a stranger cannot learn that an account exists and cannot keep someone else's account locked.
- Sign-in, forgot-password and resend-verification give the same answer whether or not the account exists. Sign-up reports a duplicate address only after the bot checks and the per-IP rate limit (see the audit's needs-decision list).
- Access tokens are short-lived JWTs. Refresh tokens rotate on every use and are kept in an HttpOnly, Secure, `SameSite=Strict` cookie whose path is `/api/v1/auth`. Reusing a rotated token after a short grace period revokes the session (`session.reuse_detected` is audited). Signing out everywhere revokes every session. The strict SameSite cookie together with bearer-token APIs is the CSRF defence.
- MFA is available as TOTP, recovery codes or passkeys (WebAuthn). An organisation can require MFA, an IP allowlist, a session length and the allowed sign-in methods.
- Revealing a vault secret needs the account password and either a current TOTP code or a passkey, checked within the last few minutes (`RevealStepUpService`). Every reveal is audited.

## Rate limits (ASP.NET Core RateLimiter, Redis-backed when `Redis:ConnectionString` is set)

| Policy | Partition | Default per minute |
|---|---|---|
| Global, anonymous | client IP | 60 |
| Global, signed in | user (API keys get their own allowance) | 300 |
| `auth`: register, login, MFA, verify, forgot/reset password, signup-form, vault step-up | client IP | 10 |
| `sensitive`: vault, document and secret reveals, exports, invitations | user and workspace | 20 |
| `search`: global search and chat search | user and workspace | 60 |
| AI requests | per workspace and plan (`AiRequestLimits`) | plan-based |
| SCIM, OAuth, meeting bot | token or bot | 600 |

Every 429 response carries a `Retry-After` header and the standard error envelope.

## Browser protections

- **CSP (nginx).** App pages allow no inline script, only hash-listed scripts: `script-src 'self' <sha256 hashes>`. The policy also sets `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'` and `form-action 'self'`, and requires Trusted Types (`require-trusted-types-for 'script'`). API responses get `default-src 'none'; frame-ancestors 'none'`.
- **HSTS.** Two years, `includeSubDomains`, `preload` (Caddy, nginx, and the API over HTTPS).
- **Other headers.** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a minimal `Permissions-Policy`, and `Cross-Origin-Opener-Policy`. JSON responses carry `Cross-Origin-Resource-Policy: same-origin`.
- **Markup.** All markup passes the Trusted Types cleaning policy (`trustedTypes.ts`). SVG drawn from user text is also cleaned by an allowlist (`sanitize.ts`). User-supplied links pass `safeHref`, which allows http(s), mailto and tel links and same-site paths. Every `target="_blank"` link has `rel="noopener noreferrer"`. Email templates HTML-encode every user value.
- **Uploads.** An extension allowlist, a magic-byte check against the claimed type, and a per-plan size limit. SVG and HTML files are not accepted as attachments.

## Server-side

- Tenant isolation is enforced by EF Core global query filters on every `ITenantScoped` entity. Every use of `IgnoreQueryFilters` is listed in and reviewed by `QueryFilterBypassGuardTests`.
- Request DTOs are allowlists (records), so there is no mass assignment of entities. FluentValidation runs on every bound model.
- No raw SQL is built from strings. Outbound HTTP to user-supplied URLs (webhooks, API drift checks, voice connectors) uses `PublicNetworkHandler`, which refuses private, loopback, link-local and metadata (169.254.169.254) addresses at connect time and does not follow redirects.
- Errors return a trace id, never a stack trace. Secrets and tokens are kept out of log lines (tested through the test log sink); structured PII masking for every log field is tracked in the audit as needing a decision.
- CI fails on vulnerable NuGet packages (`dotnet list package --vulnerable`) and on high or critical `npm audit` findings.

## Infrastructure

- Caddy terminates TLS 1.2 and 1.3 only. Only ports 80 and 443 are exposed. The database, Redis and the API are reachable only inside the container network.
- The API image runs as a non-root user, with every Linux capability dropped and `no-new-privileges` set.
- The Electron desktop app runs with `contextIsolation`, `sandbox` and `nodeIntegration: false`. It allows navigation only within the app, and `openExternal` opens only http(s) and mailto links.
