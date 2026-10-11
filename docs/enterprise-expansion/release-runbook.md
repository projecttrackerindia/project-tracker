# Enterprise expansion release runbook — not yet release-ready

The requested release is coordinated across resume/certifications, support/workflows and safe external integration boundaries. Do not merge or deploy this branch as a completed enterprise expansion while modules or applicable acceptance gates remain unfinished.

1. Finish implementation and update the inventory, model, contracts and security review to match the actual code. Keep WhatsApp/Microsoft disabled as requested; configured-provider activation is separate from testable adapter implementation.
2. Verify isolated parser execution in the Linux deployment, current-source/privacy checks, document rendering verification, workflow recovery and external identity/delivery/confirmation boundaries. Verify tax/accounting/reconciliation before turning on cash checkout.
3. Review all additive migrations against disposable SQLite and PostgreSQL databases. Test upgrading a database at current main, not only creating a fresh database. Back up production before migration.
4. Run focused security/payment/workflow regression checks, the full existing backend suite, frontend tests/build and browser accessibility/layout checks. Run no bulk AI tests or real customer message/calendar operations.
5. Review explicit changed files only. Preserve historical untracked logs/TestResults and the other checkout; restore only generated frontend tsbuildinfo changes before staging.
6. Create a reviewable PR with the final scope, migration names, environment variables, real validation results and disabled features. Require all applicable CI checks before the authorized merge to main.
7. Verify Railway API and frontend deployments for the exact merged commit. Check migrations/startup/health, served frontend assets and controlled-account read-only navigation. Do not infer deployment success from a merge or local build.
8. Keep Resume__Checkout__Enabled false until production payment/tax/accounting gates pass. Keep external integrations disabled until their approved accounts and setup are verified. Inspect worker failures and durable queues after rollout.

Rollback: disable newly published workflows and cash checkout first if needed. Application rollback must remain compatible with additive schema. Do not remove production columns/tables or paid accounting records during an emergency rollback. Old workflow revisions stop before their next action when a new revision is published or the workflow is disabled; completed business actions remain audited.