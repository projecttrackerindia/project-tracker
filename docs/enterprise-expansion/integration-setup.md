# Enterprise expansion integration setup — ongoing

User decisions: a clean resume export costs INR49 plus applicable taxes; one purchase binds one version/template/format and permits free identical-file re-downloads. WhatsApp and Microsoft integrations stay disabled until configured.

## Resume checkout

Existing Billing:Razorpay keys are reused on the backend. Resume:Checkout:Enabled defaults false. A reviewed Resume:Checkout:TaxPercent and TaxLabel are required before checkout becomes available. Railway uses Resume__Checkout__Enabled, Resume__Checkout__TaxPercent and Resume__Checkout__TaxLabel. Do not infer a production tax rate from automated test fixtures: their 18% value is explicitly labelled Test tax.

Configure and verify the provider's capture behavior, reconciliation/recovery, refund handling and required accounting documents before enabling purchases. Never expose the key secret to React. Only the public checkout key and saved order/amount are returned. Unknown order outcomes require reconciliation before another charge.

## Support workflow worker

Support__Workflows__WorkerEnabled defaults true and Support__Workflows__IntervalSeconds defaults 5 (bounded to 2–60). Execution additionally requires the organization's AUTOMATION entitlement and the executor's current workflow-management and Operations edit permissions. Publishing is an explicit administrator action; drafts do not run.

The worker currently performs database actions only. It does not send Slack/WhatsApp messages or make Google/Microsoft calendar writes. Configure schedules from a ticket's workflow controls and inspect its run history and approval previews.

## External integrations

Preserve existing organization-owned Slack OAuth and Google Workspace connections. No shared customer bot token is introduced. Existing Slack plan entitlement and interactive-execution gates remain in force.

WhatsApp and Microsoft are intentionally not activated. Provider accounts, OAuth/webhook configuration and verified tenant/user identity must be established before exposing live actions. Their new adapters and setup UI still need implementation; this document is not evidence that they exist. No real sends, customer messages or calendar writes are part of the verification plan.

Document imports use the bundled document-import/ProjectManagement.DocumentImport.dll worker by default. Resume__Imports__WorkerPath can override its absolute path for development. Resume__Imports__TimeoutSeconds defaults to 10 and is clamped to 2–30 seconds. Each API process admits at most two imports; each parser has a 128 MiB managed-GC heap budget. Retain API/container memory limits for native allocations and process overhead. No additional parser service or credentials are required.
Private-file cleanup uses the existing Maintenance worker. Keep Maintenance__Enabled true; pointer removal is immediate and durable deletion retries run at the configured maintenance interval (15 minutes by default). Receipts log only their identifier and error type. No private-file storage key is returned to the frontend.
## Google OAuth upgrade
Apply migration 20261011051417_DurableProviderOAuthAttempts before deploying the updated API. Existing Google connections are preserved, and existing GoogleCalendar client/secret/redirect variables remain valid. Complete new connections in the same browser that started them; HTTPS and cookie preservation are required. Cached connection attempts started before this upgrade must be restarted. No new Gmail, Microsoft or WhatsApp access is enabled. Google OAuth behavior is based on the official web-server authorization guidance: https://developers.google.com/identity/protocols/oauth2/web-server .
