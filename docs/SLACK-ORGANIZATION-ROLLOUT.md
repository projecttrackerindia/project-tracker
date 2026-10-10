# Organization Slack integration - phased rollout

October 10, 2026. App supplied by the owner: A0C8DK68FNG. A read-only `auth.test` call verified the existing Railway bot token for workspace T0C87U2LDNJ. No Slack message was sent. That shared token and workspace are not imported as customer installations and are never used to authorize customers.

## Phase 1: installation foundation

Organization Settings > Integrations > Slack workspace starts Slack OAuth v2. New `SLACK_INTEGRATION` flag uses existing PlanFeature/tenant-override entitlement machinery. All plans default to disabled for this new flag; the platform administrator can explicitly enable selected plans through existing plan management. Suggested commercial starting point: Business and Enterprise, subject to owner review. No plan prices or existing API/webhook access are changed. Installation also requires an actual active, nonexpired subscription and an organization owner/admin whose membership is freshly checked. Plan expiry/downgrade does not prevent disconnecting.

The database stores one tenant-scoped SlackConnection per organization and globally unique Slack team ID. Different organizations can install different workspaces independently. A workspace cannot be silently rebound to another organization; disconnect first. Bot credentials use the existing ISecretProtector/AES implementation. Secure retention of its deployment encryption key is required across restarts and replicas. DTOs expose only status/installation metadata, never credentials. No arbitrary client-supplied tenant ID or shared bot-token fallback exists.

OAuth attempts store random-state and browser-proof hashes, expire after ten minutes and are consumed through an atomic compare-and-set. An HttpOnly Secure SameSite=Lax cookie binds the callback to the initiating browser. Callback membership and subscription checks run before and after token exchange. The returned app ID, bot token type and required scopes are checked. Replacement installs require an explicit disconnect. A bounded cleanup removes expired attempts. Disconnect removes local credentials, invalidates pending attempts and revokes the token at Slack; revocation failure is reported with manual removal instructions.

Signed HTTP Events API requests require the original raw body, a five-minute timestamp window and constant-time HMAC comparison. Uninstall and bot-token revocation events only deactivate their registered app/team and clear encrypted credentials. Revoked bot user IDs must match the installation. Durable event receipts make retries idempotent across reinstallation; events predating a new installation are ignored. Receipt admission, credential clearing and audit save share a transaction. Bounded cleanup removes receipts older than 30 days on installation starts. This phase does not process messages or grant Slack users any project access. Other events are acknowledged without running an AI model or executing work. Installation status explicitly reports `interactiveEnabled=false`.

Migrations: OrganizationSlackOAuth and SlackLifecycleReceipts (see generated timestamped files). Entities: SlackConnections, SlackOAuthAttempts and SlackEventReceipts. Existing audit history records connect, disconnect and revoke.

API endpoints: GET `/api/v1/integrations/slack/status`; POST `connect`; POST `disconnect`; public GET `callback`; signed public POST `events` under the same base path. Frontend settings: `/settings/slack` within the selected organization.

### Required Railway API variables

- `Slack__ClientId`: Basic Information > App Credentials > Client ID.
- `Slack__ClientSecret`: client secret, backend only.
- `Slack__SigningSecret`: signing secret, backend only.
- `Slack__AppId`: `A0C8DK68FNG` for this supplied platform app.
- `Slack__RedirectUri`: `https://projecttracker.in/api/v1/integrations/slack/callback`.

Existing `slack_app_token` and `slack_bot_token` do not replace OAuth client credentials and are not used by this adapter. This rollout uses HTTP events; a Socket Mode app token, Slack CLI and a separate OpenAI sample agent are not needed. Keep Gemini as the existing Project Tracker primary provider. Do not paste credentials into chat or commit them.

### Slack app configuration

1. In OAuth & Permissions add the exact redirect URL above. Minimum requested bot scopes: `chat:write`, `app_mentions:read`, `im:history`, `im:write`, `users:read`. No channel/private-channel history scopes are requested by this adapter. Requested scopes reserve the eventual DM/mention features; Phase 1 does not read messages.
2. Use HTTP Events API, with Socket Mode disabled for this deployment path. Set Request URL to `https://projecttracker.in/api/v1/integrations/slack/events` after signing-secret configuration and endpoint deployment. Subscribe to `app_uninstalled` and `tokens_revoked` for Phase 1. Do not advertise message workflows yet.
3. Keep token rotation off for this phase: rotating grants are rejected instead of storing a refresh token the adapter cannot maintain. Add refresh/rotation support and tests before turning it on. Enterprise organization-wide installations/Grid routing are not supported yet; install into a concrete workspace.
4. Enable distribution so other customer workspaces can install; follow Slack's current distribution/Marketplace requirements before broader release. Test with two real controlled workspaces after configuration. A successful unit test is not a verified customer install.
5. Ensure the public callback and connect endpoint share the same browser origin through the existing frontend/API proxy so the Secure cookie returns correctly. Review CSP for the OAuth navigation; no secrets belong in React variables.

References: https://docs.slack.dev/authentication/installing-with-oauth/ ; https://docs.slack.dev/authentication/verifying-requests-from-slack/ ; https://docs.slack.dev/apis/events-api/using-http-request-urls/ . Recheck provider requirements before enabling broader distribution.

## Phase 2: verified people and configuration (pending)

Add short-lived, one-time account linking initiated by the signed-in Project Tracker user and proved through Slack identity authorization. Store `(connection, Slack user ID, local user ID)` and recheck active organization membership, subscription, module permissions and current project/team/role scope on every operation. Do not infer membership from email matching or grant all workspace members access. Provide self-unlink/admin removal and revocation handling.

Add per-organization channel allowlists, project mappings, event subscriptions, timezone-aware quiet hours and preferences; administrators must be able to view/select only valid channels/projects. Shared channels require a channel-specific audience policy: a caller's private project access is insufficient authority to broadcast it. Keep private results in verified-user DMs or authenticated app links unless all intended recipients are authorized.

## Phase 3: delivery and agent workflows (pending)

Persist incoming event IDs and a bounded inbox; acknowledge within Slack's deadline, then process under a reconstructed current local context. Use durable outgoing delivery records with idempotent keys, per-workspace fairness, rate-limit Retry-After/backoff, bounded retries and delivery logs without sensitive content. Apply current eligibility before dispatch, and quiet hours before notifications.

Reuse existing task/project activity and reminder/SLA machinery for assignment, overdue, blocker and status notices. Queries route through existing application services; natural-language interpretation uses Gemini, with existing customer credits/person/team budgets and request admission. Never send a shared organization API key or run the model as an administrator for an unlinked Slack member. Bind consequential-action confirmation buttons to the exact tenant, linked user, proposal version, expiry and idempotency key. External-delivery retries must not rerun or recharge the AI request.

Required regressions include two organizations with independent installations and users, cross-tenant/project/team/role denial, lost membership/expired subscription, channel audience leakage, repeated/forged/stale events and confirmations, restart recovery, quiet hours, 429 delivery retry and disconnect cleanup. Verify real installs and controlled delivery before enabling interactive status. WhatsApp remains disabled.
