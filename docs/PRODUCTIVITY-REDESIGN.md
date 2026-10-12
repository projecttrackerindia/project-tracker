# Responsive UI and connected accounts

The React frontend, .NET API and Electron shell now share a more readable interface. Laptop layouts retain normal font sizes and controls. Account navigation becomes horizontal in the resume studio and connected accounts, leaving the main canvas available for editing.

The resume studio supports Edit, Preview and Both. Both uses columns only when the studio itself has at least 1,050 px available, otherwise it stacks. Edit mode gives the writing form the full width. Fields use 15 px type (16 px in narrow layouts), larger text areas and clearly labelled sections. Preview remains a portrait document and reflects each template's alignment, margins, heading sizes and section rules. PDF and Word exports have stronger identity typography, readable body text and consistent header alignment. Existing saved resumes and purchases remain compatible; previously purchased artifacts are not regenerated.

## What Google and Microsoft actually enable

These are private connections for the current workspace. Colleagues do not receive access to the user's mailbox or tokens.

| Provider | Initial connection | Separate optional consent |
| --- | --- | --- |
| Google | Calendar events and Google Meet links from project meetings | Gmail sending in Email studio; read-only Gmail in Private inbox |
| Microsoft | Profile and reviewed Outlook email sending | Outlook inbox reading; basic reading of selected calendars owned by the connected user |

An administrator must configure the providers and enable optional capabilities before users can grant them. The connection cards display permission status. Email sends still require explicit confirmation, inbox content loads on request, and calendar availability checks do not create meetings. Drive and shared-file browsing are outside these integrations.

## Why GOOGLE_BROWSER_INVALID occurred

The callback requires an HttpOnly proof cookie from the browser that began the connection. The service keeps a hash of this proof and a hash of the one-time OAuth state; neither check has been removed.

The Electron wrapper previously fetched the consent URL inside Electron, then opened Google or Microsoft in the system browser. The proof stayed in Electron, so the external browser's callback could not supply it. All five productivity consent entry points now direct desktop users to the account page in their system browser before beginning OAuth. A restricted IPC command opens only the configured application's account page in the selected workspace and transfers no credentials or OAuth state. Users sign in there, connect there, and refresh the connection status after returning to the app.

Before a browser leaves for a provider, the frontend now checks that the configured callback origin matches the API origin, then calls an authenticated endpoint under the callback cookie's path to confirm that the proof was retained. Blocked cookies and callback-address mismatches produce an actionable message before consent. Missing, expired or invalid browser/state callbacks return a recovery page with HTTP 401 rather than raw JSON. They still reject the grant.

Secure, HttpOnly, SameSite=Lax proof cookies remain mandatory in production. Only loopback HTTP in the Development environment uses an unprefixed development cookie, so local HTTP previews can work without weakening production protection.

## Deployment

Deploy the frontend and API together: the frontend now calls the new `/api/v1/integrations/{google|microsoft}/callback/browser-check` endpoints. Rebuild the Electron release to include the new browser-opening IPC command and 100% default zoom. Saved user zoom settings are preserved; Ctrl+0 resets to the new default.

Check `GoogleCalendar:RedirectUri` and `MicrosoftProductivity:RedirectUri` against the public API origin, including scheme, hostname and port. Their paths must be `/api/v1/integrations/google/callback` and `/api/v1/integrations/microsoft/callback` respectively. Register those exact URLs with the providers. Keep the same hostname throughout the connection; switching between www and the bare domain loses host-scoped cookies. Use the application's normal same-origin reverse proxy for frontend/API hosting. Configure trusted forwarded headers where the deployment requires them.

Users who already reached a failed callback should return to Connected accounts and begin a fresh attempt; attempts expire after ten minutes. Browser cookie policies still apply. Live provider consent needs the deployment's provider credentials and a real account; automated tests use fake provider handlers and synthetic UI data.

## Verification

Run `npm run build`, `npm test`, `npm run lint` and `npm run test:ui` in `frontend`. The expanded browser suite checks 320, 390, 820, 1280, 1440 and 1920 px layouts, edit/preview state, input legibility, keyboard template selection, dark theme, reduced motion, provider permission descriptions, native browser handoff and existing email/inbox workflows.

Run backend tests matching `GoogleOAuthSafetyTests`, `MicrosoftProductivityTests`, `ProviderConnectionBrowserTests`, `ResumeTests`, `ResumePurchaseTests` and `ResumeEvidenceTests`. They cover callback proof/replay checks, cookie preflight, safe development exceptions, recovery content, owner isolation, version approval, imports, exports and purchases.
