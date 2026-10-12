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

WhatsApp and Microsoft are intentionally not activated. Provider accounts, OAuth/webhook configuration and verified tenant/user identity must be established before exposing live actions. Microsoft now has a gated personal OAuth/send adapter and setup UI. WhatsApp and additional inbox/calendar operations still need implementation. No real sends, customer messages or calendar writes are part of the verification plan.

Document imports use the bundled document-import/ProjectManagement.DocumentImport.dll worker by default. Resume__Imports__WorkerPath can override its absolute path for development. Resume__Imports__TimeoutSeconds defaults to 10 and is clamped to 2–30 seconds. Each API process admits at most two imports; each parser has a 128 MiB managed-GC heap budget. Retain API/container memory limits for native allocations and process overhead. No additional parser service or credentials are required.
Private-file cleanup uses the existing Maintenance worker. Keep Maintenance__Enabled true; pointer removal is immediate and durable deletion retries run at the configured maintenance interval (15 minutes by default). Receipts log only their identifier and error type. No private-file storage key is returned to the frontend.
## Google OAuth upgrade
Apply migration 20261011051417_DurableProviderOAuthAttempts before deploying the updated API. Existing Google connections are preserved, and existing GoogleCalendar client/secret/redirect variables remain valid. Complete new connections in the same browser that started them; HTTPS and cookie preservation are required. Cached connection attempts started before this upgrade must be restarted. No new Gmail, Microsoft or WhatsApp access is enabled. Google OAuth behavior is based on the official web-server authorization guidance: https://developers.google.com/identity/protocols/oauth2/web-server .

## Optional Gmail sending
Apply migration 20261011053210_PersonalEmailDrafts. GoogleCalendar__MailEnabled defaults false: private manual drafts and entitled AI rewriting remain usable while sending is off. Microsoft and WhatsApp remain disabled.

Before enabling the gate, enable the Gmail API in the Google OAuth client project, configure the consent screen and permitted accounts, add gmail.send to the application's declared scopes, and complete Google's required OAuth verification for the intended audience. Reuse the existing backend GoogleCalendar client/secret/HTTPS redirect variables and protected-token store. Never put OAuth secrets or refresh tokens in React. Verify installation, permission denial, sender display and disconnect against a controlled account.

Users: My account -> Google Workspace -> Private email drafts. Save a draft; optional AI rewriting explains provider sharing and credit cost before generation. Choose Enable Gmail sending to grant send-only access. Review the sender, recipient, complete saved message and version, then Confirm and send. Calendar access remains a separate capability. No inbox permission, attachment sending or thread summaries are introduced here.

A Gmail timeout, malformed receipt or failed response is shown as an unknown outcome and is never retried automatically. The user must check Gmail Sent; automated reconciliation and administrator recovery remain future work. Keep the gate off until that operating procedure is established. The server bounds each dispatch to 20 seconds, receipt reads to 8 KiB, and confirmed sends to ten per person per workspace per rolling hour; erased accepted messages still count.

Primary provider references: https://developers.google.com/workspace/gmail/api/auth/scopes and https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send .
## Optional Microsoft Outlook sending

Apply additive migration 20261011062100_MicrosoftProductivityAndEmailProviders before the API upgrade. Keep MicrosoftProductivity__Enabled=false until setup and controlled-account verification are complete. Private manual drafts and shared-credit rewriting work without enabling Microsoft.

Administrator setup:
1. Register a confidential Web application in Microsoft Entra. Choose supported account types deliberately: the default authority accepts work/school accounts across organizations; enabling personal accounts requires a compatible registration and common authority.
2. Configure the exact HTTPS Web redirect URI, for example https://projecttracker.in/api/v1/integrations/microsoft/callback.
3. Configure backend-only MicrosoftProductivity__ClientId, MicrosoftProductivity__ClientSecret, MicrosoftProductivity__RedirectUri and MicrosoftProductivity__AuthorityTenant. AuthorityTenant defaults to organizations; common, consumers or an actual directory GUID are accepted. Never put the secret in React.
4. Use delegated Microsoft Graph User.Read and Mail.Send permissions, with offline_access for refresh. No application-wide mail, Mail.Read, Mail.ReadWrite or Calendar permission is requested by this adapter. Customer directory policies may require administrator consent.
5. Preserve the backend token-protection key across deployments and replicas. Verify sign-in, consent denial, sender selection, refresh and local disconnect using a controlled account before enabling the gate.

User steps: My account -> Google Workspace -> Microsoft Outlook -> Connect Microsoft. Complete consent in the same browser within ten minutes. In Private email drafts select Microsoft Outlook as the sending account, save the message, review sender/recipient/full saved version and explicitly Confirm and send. Optional AI rewrite consumes the existing shared credit allocation and preserves the selected provider; rewriting never sends.

Graph 202 means accepted for processing, not confirmed delivery. It returns no message ID; the optional Graph request ID is a tracing receipt, not a retry/idempotency guarantee. Lost responses remain unknown and block resend. Check Outlook Sent before recovery; automated reconciliation remains future work. Gmail and Outlook share the ten confirmed sends per user/workspace per rolling hour cap.

Disconnect removes the local protected credentials. It does not revoke the remote Microsoft consent grant. Users can separately remove application consent in Microsoft's account/application access portal; reconnecting is required before further local sends.

Provider references: https://learn.microsoft.com/en-us/graph/auth-v2-user and https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0 .

## Optional private Google Calendar time blocks
Apply migration 20261011065223_PersonalCalendarProposals before the API upgrade. GoogleCalendar__PersonalCalendarEnabled defaults false and is separate from existing project meetings and Gmail sending. Reuse the existing protected personal Google connection with calendar.events; no additional Microsoft scopes or attendee invitations are enabled.

User steps: My account -> Google Workspace -> Private calendar proposals. Enter a title, private notes and future start/end in the displayed browser time zone. Save the proposal, optionally check availability, then Review calendar block. The confirmation displays the account, full notes, saved version, named zone and exact instants. Confirm calendar block performs a fresh availability check before writing. A saved manual proposal uses no AI credits.

The first implementation creates a personal block with no attendees in the connected account's primary Google calendar. Conflict checks cover only that calendar. It does not check other calendars, colleagues or external participants, and external changes can still race the final check. A verified receipt requires a matching provider read-back, not just a successful write response.

For an unknown outcome, use Check provider status. This only reads the stable saved provider event ID and verifies its ownership markers/content/times; it never resends. Reconnect the original account if the account changed. Missing or altered events remain unverified. Removing a verified local receipt does not delete the Google event; manage that event in Google Calendar.

Keep the deployment gate off until controlled-account read-back/recovery behavior is verified. No real provider writes were used in development verification. Existing project-meeting mutation durability, attendee scheduling and Microsoft calendar operations remain separate release work.

Provider contracts: https://developers.google.com/workspace/calendar/api/v3/reference/events/insert , https://developers.google.com/workspace/calendar/api/v3/reference/events/list and https://developers.google.com/workspace/calendar/api/v3/reference/events/get .

## WhatsApp foundation: leave live activation off
Current backend variable names are WhatsApp__AppId, WhatsApp__AppSecret, WhatsApp__VerifyToken and WhatsApp__WebhookReceptionEnabled (default false). App secret and a random verification token remain backend-only. These configure the receiver, not customer installation. No shared organization token is accepted or exposed to React.

The future Meta webhook address is https://projecttracker.in/api/v1/integrations/whatsapp/webhook. GET verification uses hub.mode, hub.verify_token and hub.challenge; POST verification uses the raw-body SHA-256 app-secret signature. Keep the reception gate false until official signup, verified identities and provider readiness are implemented and checked.

Customer UI: Workspace settings -> Integrations -> WhatsApp Business. It shows plan access and pending setup, explains business-account preparation, and exposes Connect only after the separately gated installation configuration described below is enabled. Eligible fixture connections show bounded metadata diagnostics and explicitly confirmed local disconnect. Disconnect does not revoke Meta consent; remove the app separately in Meta Business Settings.

Reference checked for the raw webhook contract: https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/ (Meta-owned, archived SDK documentation; not a recommendation to use that SDK). At the receiver-only checkpoint, Embedded Signup documentation could not be read and no OAuth contract was shipped. The next checkpoint uses Meta's maintained reference app, as recorded below. Official signup/app review and current messaging policy verification remain separate implementation gates.

## Embedded Signup configuration and customer steps
Keep WhatsApp__InstallationEnabled=false and WhatsApp__WebhookReceptionEnabled=false until controlled-account verification. Alongside WhatsApp__AppId, WhatsApp__AppSecret and WhatsApp__VerifyToken, configure WhatsApp__EmbeddedSignupConfigId, WhatsApp__ApiVersion (explicit version such as vN.N) and WhatsApp__SignupVersion (v3 or v4). Values are backend configuration, not frontend token inputs. WHATSAPP_INTEGRATION must be granted through the existing plan/tenant entitlement system; an active subscription alone does not grant it.

Configure the Meta business app, required app review/business verification, Facebook Login for Business Embedded Signup configuration, and the production HTTPS domain in Meta's allowed JavaScript domains. Verify exact scopes and supported API/signup versions for that app. Our nginx CSP permits the explicit SDK, login and frame origins; test the actual SDK against this policy before activation. Provider code exchange currently uses an empty redirect_uri as in Meta's reference app; validate that contract with the configured controlled account rather than assuming a generic OAuth callback.

Customer flow after activation:
1. An eligible organization owner/admin opens Workspace settings -> Integrations -> WhatsApp Business and chooses Connect.
2. Once setup is prepared, choose Continue with Meta to open signup. Review the business account and phone selection in Meta.
3. The backend verifies the returned account and verified phone, then saves the organization connection securely. Cancel setup before opening Meta, or close the Meta window during signup.
4. Connected status and bounded receiver diagnostics become available. Disconnect erases usable local credentials and cancels in-flight attempts; revoke the remote app separately in Meta Business Settings.

Connecting does not enable replies, notifications, task queries or access for a phone-number owner. Verified contact linking, consent, messaging-scope health, app webhook subscription/phone readiness, templates, current 24-hour policy and durable outbox delivery are separate activation prerequisites. No provider asset subscription, phone registration, remote revocation or outbound message is performed by this installation phase.

Contract reference: Meta's maintained [business messaging sample](https://github.com/fbsamples/business-messaging-sample-tech-provider-app/tree/14703a3e1fdba9bcf75b2360b00817b6fcc9f79b), specifically app/api/beUtils.ts, app/components/Fbl4bLauncher.tsx, ClientDashboard.tsx and app/publicConfig.ts. Meta's documentation site returned rate-limit errors during this implementation; this primary reference supplied the code-exchange and signup-event contracts. Live provider contract verification is still pending.

## Personal WhatsApp linking: default off
New backend variable: WhatsApp__ContactLinkingEnabled=false. Linking additionally requires configured signature verification, WhatsApp__WebhookReceptionEnabled, an active organization installation and central WHATSAPP_INTEGRATION access. Keep both gates off until approved controlled-account setup and webhook readiness are verified.

After activation, members open My account -> Notifications in the intended organization, enter their own country-code phone number and accept the account-link notice. Prepare the code, then send the exact message from that number to the organization's WhatsApp business number. Ask the administrator for that business number; the installation currently stores a provider phone ID, not a publicly usable phone number. Select Check verification to refresh the masked result. Codes expire in ten minutes; after a full page reload prepare a new code. Remove my link erases the stored number and consent for this organization. A business disconnect invalidates all linked and pending contacts.

This notice is not marketing or notification consent. Sending, notifications, templates and authorized business actions stay disabled pending their separate implementation and policy checks. A link never expands project/team/role permissions. Signature contract reference remains Meta's [archived webhook documentation](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/); no archived SDK is installed. Live provider sender-field and supported phone-format verification are still required.

## Member notification preferences: user steps
1. Open the intended organization, then My account -> Notifications -> Your WhatsApp link.
2. When the organization connection and platform phone-link gate are ready, verify your own number using the private one-time message instructions.
3. In WhatsApp notification preferences, select task assignments, overdue reminders and/or support ticket updates. Enter an IANA time zone and quiet-hour start/end.
4. Review the separate notification notice, check it explicitly, then Save WhatsApp preferences. Saving records consent; delivery remains unavailable in this checkpoint.
5. Use Revoke WhatsApp notifications to withdraw just messaging consent, or Remove my link to erase the phone and withdraw its notification consent for that organization.

These preferences are private to the member and organization. Administrators cannot opt in users. New phone proof cannot inherit previous consent. Plan/gate disablement blocks new grants but does not prevent an active member withdrawing consent. There are no new environment variables, outbound calls, voice consent or live provider setup actions in this checkpoint.

## Administrator provider health: user steps
1. Open Organization settings -> Integrations -> WhatsApp after connecting your organization's own business account.
2. When the platform enables read checks for a controlled rollout, select Check provider health. A successful installation alone does not establish current provider readiness.
3. Review token validity, scoped permissions, selected assets, app subscription and phone ownership checks. Correct setup or reconnect through Meta when indicated; never paste provider tokens into the frontend.
4. Recheck after setup changes. Results expire after five minutes; requests have a one-minute organization cooldown. Settings poll every five seconds only while a check is running so abandoned claims can recover.
5. Even if every read check passes, delivery stays disabled. Phone registration, signed webhook delivery, recipient permissions/consent, messaging rules and durable delivery/recovery remain separate rollout gates.

New variable: WhatsApp__HealthChecksEnabled=false (default). Existing app/secret/verification and explicit version/signup configuration are still required. Read checks perform no automatic app subscription or phone registration. Verify the strict provider response/granular-grant contract with a controlled account before enabling this gate.

The implementation uses Meta's published read endpoint shapes, with conservative response validation. [Meta token inspection collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api?entity=folder-066d0881-3f31-4f0c-accc-d0fa2e4b2ed9), [Meta app subscription reads](https://www.postman.com/meta/whatsapp-business-platform/request/tl2wk2j/get-all-subscriptions-for-a-waba). App-secret proof follows the official SDK HMAC pattern. [Meta SDK session source](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/session.py)

## Notification template preparation: administrator steps
New variable: WhatsApp__TemplateChecksEnabled=false. Keep this and all outbound/reception rollout gates disabled until controlled-account validation. Template checks also require WhatsApp__HealthChecksEnabled, current successful health and active WHATSAPP_INTEGRATION entitlement. They do not require or perform outbound activation.

In Workspace settings -> Integrations -> WhatsApp Business, expand Set up approved templates. In Meta WhatsApp Manager for this organization's connected WABA, create the following exact English (US)/en_US Utility templates with a single plain text BODY; omit headers, buttons, media and variables:

| Name | Exact body |
| --- | --- |
| project_tracker_task_assignment_v1 | You have a new task assignment in Project Tracker. Open your Project Tracker workspace to review it. |
| project_tracker_overdue_v1 | A task assigned to you is overdue in Project Tracker. Open your Project Tracker workspace to review it. |
| project_tracker_support_update_v1 | A support ticket you follow has an update in Project Tracker. Open your Project Tracker workspace to review it. |

Submit each to Meta. Meta decides approval/category; this code does not promise these submissions will be approved. After controlled setup, check provider health, then Check templates. A missing, pending, paused/rejected, wrong-locale, recategorized or changed-content result cannot establish template readiness. Read checks expire after five minutes and cannot enable messaging. No project/task/ticket content, customer identity or recipient phone is part of these bodies. Linking is separate from notification opt-in.

Current official policy permits free-form replies within the user-message-triggered 24-hour customer-service window and requires approved templates outside it. Our initial notification design conservatively uses approved templates in either case; it does not infer support intent from contact-proof messages or implement free-form chat replies. [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/), checked 11 October 2026. The GET-by-name shape follows [Meta's maintained template collection](https://www.postman.com/meta/whatsapp-business-platform/request/7whkjje/get-template-by-name-default-fields). Verify that the configured Graph version supplies the strict fields/components with an approved controlled account before activation.

## Delivery activation and history
Workspace Settings > Integrations > WhatsApp Business now includes delivery history; members can see their own history in the private phone/notification settings. Accepted means the provider acknowledged a send, while delivered/read require signed receipts. Unknown outcomes are explained and do not offer a duplicate-send button. Quiet hours defer delivery; withdrawal stops newly admitted attempts and cannot recall a send already committed to the provider.

Additional API configuration:
- WhatsApp__DeliveryEnabled=false (keep off until controlled rollout verification).
- WhatsApp__DeliveryUserDailyCap=10 (rolling 24-hour send attempts per member).
- WhatsApp__DeliveryOrganizationDailyCap=1000 (rolling 24-hour send attempts per organization).
- WhatsApp__DeliveryIntervalSeconds=10 (worker interval; bounded internally).

These notification safeguards are separate from subscription-based AI credits/rate limits. Rejected/unknown attempts count toward budgets; one attempt per recipient per minute avoids bursts. Delivery also requires configured installation, contact, reception, health and template gates plus the existing active-plan entitlement. Use each organization's installation, never shared customer credentials. No gate has been enabled in production.

Before activation, verify actual Graph-version send/opaque-callback contracts, exact approved templates, phone registration, signed webhook receipt, current permissions, controlled delivery outcomes and organization notification budgets. No app subscription/registration or real message is performed automatically by this checkpoint. Existing templates and consent setup steps above remain prerequisites.

## Background metadata retention

No new provider variables are required. The existing Maintenance__Enabled switch and Maintenance__IntervalMinutes control housekeeping (defaults true and fifteen minutes). Apply 20261011161936_WhatsAppMetadataRetention first. Maintenance selects ten installations per pass and at most 100 rows per operation, including inactive registrations, without accessing provider credentials or making calls. Keep WhatsApp deployment gates off until controlled provider verification passes. Installation ownership/phone reservation survives cleanup; recent acknowledgement/status evidence and live attempts are retained. Review housekeeping backlog/cadence using measured traffic before claiming capacity for large fleets.


The consolidated studios and private upload recovery require no additional credentials or flags. Existing maintenance scheduling handles interrupted uploads after their one-day deadline. Provider and cash-purchase gates remain unchanged, and full expanded functionality remains the prerequisite for merge.


## Optional private Gmail and Outlook inbox
Keep GoogleCalendar__InboxEnabled=false and MicrosoftProductivity__InboxEnabled=false until controlled OAuth/provider verification is completed. These flags are separate from Gmail sending, Google personal calendars and MicrosoftProductivity__Enabled. Existing OAuth client/secret/redirect configuration is reused. Gmail requires the optional https://www.googleapis.com/auth/gmail.readonly grant and userinfo.email, initiated with the dedicated Allow inbox access action. Microsoft optional inbox consent adds delegated Mail.Read alongside User.Read/Mail.Send/offline_access; existing send-only installations receive no inbox access automatically. Configure provider consent/approval for those scopes before enabling. Users connect their own accounts from My account > Google Workspace > Private inbox, select the mailbox, allow reading, then explicitly load messages and open a thread. Disconnecting removes stored local credentials and hides content; Microsoft provider-side consent revocation still uses the provider account/organization portal. No application-wide or shared mailbox credentials are used.

Provider contracts: [Gmail message listing](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), [Gmail thread retrieval](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get), [Microsoft Graph message listing](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0). The implementation applies smaller bounds than the provider maxima and validates continuation hosts and mailbox paths.


## Optional AI summaries of private conversations
Keep `PersonalInboxSummaries__Enabled=false` until controlled mailbox consent and summary quality verification pass. Google/Microsoft inbox gates and existing configured AI provider/plan credit budgets still apply. Apply `20261011184438_GroundedInboxSummaryReceipts` first. Gemini remains the primary provider through the existing AI router, with its configured local fallback; this feature does not select a new provider or grant sending rights.

Users open an authorized complete thread, choose Summarize conversation and explicitly confirm the displayed AI credit cost and sharing. The result shows cited quotes with View cited message controls. Saved summaries recovers the receipt without generation. Deleted private results do not refund completed charges. Keep `Ai__Operations__WorkerEnabled` and shared credit-expiry recovery configured according to the existing worker setup; pending reservations expire after twenty minutes. Existing maintenance defaults remove expired results in batches of at most 1,000 every maintenance pass.


## Attachment access setup
Keep `PersonalInboxAttachments__Enabled=false` until controlled provider-read verification passes. Existing private inbox flags and the user's separately consented Gmail read-only or Microsoft Mail.Read permission are required; no additional OAuth scope is requested. There is no migration for this batch. Users open a message, choose Show attachment list, then Download on one available file. The protected link expires in ten minutes; Reload attachments obtains current metadata. Files over 2 MiB and unsupported provider attachment kinds are opened directly in the user's mail provider, not followed through Project Tracker. Attachments are not automatically opened or shared with AI.

Contracts: [Gmail attachment retrieval](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments/get), [Graph message attachment listing](https://learn.microsoft.com/en-us/graph/api/message-list-attachments?view=graph-rest-1.0), [Graph attachment/raw-file retrieval](https://learn.microsoft.com/en-us/graph/api/attachment-get?view=graph-rest-1.0).
