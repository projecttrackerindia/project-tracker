# Assessment remediation — 2 November 2026

PR: https://github.com/projecttrackerindia/project-tracker/pull/108

These changes address the findings in ProjectTracker_Assessment.md against source b546657c6d38cf81381c0e02573058db5bfd4949. Code changes are proposed and require CI, review, deployment and live negative retesting. They are not a certification that no vulnerabilities remain.

| Finding | Change | Closure requirement |
| --- | --- | --- |
| SEC-01 | Check old Vault protection before edits; require fresh verification for class/field/use-only downgrades, protected moves and collection/policy relaxation | Regression tests and live dummy-value retest |
| SEC-02 | Upgrade MailKit 4.12.1 to 4.16.0 | Dependency audit and rebuild/deploy |
| SEC-03, SEC-05 | Public-only DNS resolution inside socket connection callback; no redirects or proxy re-resolution for voice connectors and API drift | Private/mixed DNS rejection tests and deployed egress verification |
| SEC-04 | Require all verified account bindings to exist and match the target connector schema and supplied inputs | Binding regressions and representative configured-flow retest |
| SEC-06 | Read external responses with a byte limit and response-headers-only completion | Known-size and chunked-response tests |
| SEC-07 | Require active incoming-webhook actor membership | Suspended-actor regression |
| SEC-08 | Apply security headers at response start, after error clearing | Error-path header regression |
| SEC-09 | Reject production development email/billing/encryption fallbacks at startup | Configure real providers and preserve/migrate encryption material before deployment |
| SEC-10 | Operational: change reused credentials at their issuing systems and update Vault | Owner action; source changes cannot rotate external credentials |
| SEC-11 | Return unknown/status for unavailable checks; scheduled failures cannot overwrite prior breach results | Outage regressions and UI verification |
| FUN-01 | Compare forecast and due dates before describing their relation | Portfolio regression |
| FUN-02 | Never substitute baseline movement for forecast slip; label forecast lateness explicitly | Portfolio regression |
| FUN-03 | Count and display work-complete projects separately, with sign-off guidance | Completed-work API regression |
| FUN-04 | Rename current on-track share; show no-activity/zero-denominator trend wording | Insights UI regression |
| FUN-05 | Show missing-rate costs as unknown, suppress invalid forecasts and expose default-estimate assumptions | Missing-rate API regression and money UI verification |
| FUN-06 | Use canonical https://projecttracker.in/fsbl | Correct copied links; arbitrary nested URLs retain normal not-found behavior |

## Production preflight

1. Back up the database and verify restoration. Record current deployment identifiers and preserve rollback configuration.
2. Set Email:Provider to Smtp or Resend with working provider settings. Set Billing:Provider=Razorpay with working credentials, or explicitly enable/configure the manual Billing:Upi flow.
3. Supply Mfa:EncryptionKey, or Mfa:EncryptionKeyWrapped plus Mfa:KmsKeyName. Existing data encrypted using the JWT fallback needs the same effective material preserved or an independently tested decrypt/re-encrypt migration before a new key is installed. Blindly replacing the key makes existing encrypted values unreadable. Never paste keys into issues, CI logs or this document.
4. Rotate reused credentials at the original systems, save replacements in Vault, and revoke obsolete credentials/sessions where applicable. This PR has not accessed or changed their plaintext values.
5. Deploy reviewed images to staging, run independent Owner/Admin/Member/Guest and cross-tenant flows, then deploy with rollback available. Validate normal configured connector calls as well as rejection cases.
6. Repeat the original dummy Vault downgrade test on the deployed build; verify ordinary edits, approved fresh verification, errors, disabled membership and outage displays. Retain build SHA and test evidence.

## Remaining assessment coverage

Independent role accounts, infrastructure/cloud configuration, production egress rules, provider integrations and full live retesting remain outside the evidence supplied by this code change. The original assessment's blocked tests remain open until executed. No production deployment or merge is authorized by creating this PR.
