namespace ProjectManagement.Application.Features.Admin;

/// <summary>
/// The Privacy Policy and Terms of Service shown until a platform administrator publishes their own versions (Admin › Platform settings).
/// They describe what this installation actually does: keep them true when features change. The Google section carries the disclosure
/// Google requires of apps that use Google APIs (API Services User Data Policy, Limited Use).
/// </summary>
public static class ConsentTexts
{
    public const string LastUpdated = "21 October 2026";

    public const string PrivacyPolicy = """
Last updated: 21 October 2026

This policy explains what personal data Project Tracker (projecttracker.in, "we", "us") collects, why, who it is shared with, how long it is kept and the choices you have. Questions or requests: support@projecttracker.in.

1. Who this covers
It covers everyone who visits projecttracker.in, creates an account, or uses the web, desktop or mobile apps. When an organization uses Project Tracker for its work, that organization decides what goes into its workspace; we process that content on its behalf to provide the service.

2. What we collect
- Account details: name, e-mail address, password (stored only as a salted hash), profile picture, time zone, language and security settings such as two-step sign-in. If you sign in with Google, GitHub, Microsoft or single sign-on, we receive your name, e-mail address and an account identifier from that provider.
- Workspace content: projects, tasks, comments, documents, files, time entries, chat messages, meeting notes and anything else you or your colleagues add.
- Billing details: plan, number of seats, invoices, the billing name, address and tax ID you enter, and for UPI payments the transaction reference (UTR) you give us. We do not receive or store card or bank account numbers.
- Technical data: IP address, browser and device type, sign-in times, security events and error logs, used to keep the service running and secure.
- Data from services you connect (see sections 4 and 5), only when you choose to connect them.

3. How we use it
To provide and improve the features you use; to sign you in and keep accounts secure; to send the e-mails, push notifications and reminders you ask for or that are needed to run your account (for example password resets and invoices); to bill paid plans; to answer support requests; and to meet legal obligations. We do not sell personal data, do not show advertising and do not use your data to build advertising profiles.

4. Google user data
Connecting a Google account is optional. When you click Connect Google, Google asks you to allow some of these permissions, depending on the feature you turn on:
- See your primary Google Account e-mail address: to show which Google account is connected.
- View and edit events on your calendars (calendar.events): to create, update and cancel the calendar events for project meetings you schedule in Project Tracker, with a Google Meet link, and keep them in sync.
- Create, edit and see Google Meet conferences created by the app (meetings.space.created): to create the Meet call for those meetings.
- Read information about your Google Meet conferences (meetings.space.readonly): only if you turn on meeting transcripts, to read the transcript of a project meeting after it ends so the project agent can draft minutes and action items for your team to review.
- Edit and see Google Meet call settings (meetings.space.settings): only if you turn on automatic transcripts, to switch them on for your project meetings.
How we handle it: Google data is used only to provide these features to you. Project Tracker's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements (https://developers.google.com/terms/api-services-user-data-policy). We do not sell Google user data, do not use it for advertising, do not transfer it to others except as needed to provide or improve these user-facing features, to comply with the law, or as part of a merger or acquisition with notice to you, and we do not use it to develop, improve or train generalized artificial-intelligence or machine-learning models. People at Project Tracker do not read it unless you ask us to for support, it is needed for security or abuse investigation, or the law requires it. Meeting transcripts may be processed by the AI provider described in section 6, only to produce the minutes and proposals shown to your team, under terms that do not allow the provider to train on them.
Access tokens are encrypted at rest. You can disconnect at any time in Account › Integrations, which deletes our tokens and revokes the grant; you can also remove access at https://myaccount.google.com/permissions.

5. Other services you can connect
If you connect Microsoft 365 or Outlook, Slack, GitHub or WhatsApp, we receive only what is needed for the feature you turn on (for example the Slack channel you link to a project, or messages sent from your verified WhatsApp number that start with a project key). Tokens are encrypted and you can disconnect at any time.

6. AI features
The AI assistant and the project agent send the text needed to answer your request (for example a task list, a document section or a meeting transcript) to an AI model provider, currently Google Gemini on Google Cloud (Vertex AI), with Anthropic or a model we host ourselves as alternatives. Providers process it only to return the answer and are not permitted to train their models on it. AI output can be wrong: the project agent only proposes changes, and nothing changes in a project until someone who may edit it approves.

7. The meeting bot
If your team turns on the live meeting bot, a bot joins your project's Google Meet calls as a guest with the name your workspace chooses. The host must admit it, everyone in the call can see it, and it follows the call's captions to produce minutes. What it reads is stored encrypted and erased after 30 days by default; the minutes and approved items stay in the project.

8. Who we share data with
Only with the service providers that run Project Tracker for us, under contracts that limit their use of the data: hosting, databases and file storage (Google Cloud, Mumbai region), e-mail delivery (Resend), AI model providers (section 6), push notifications (Google Firebase Cloud Messaging and browser push services), and the sign-in and integration providers you choose to use. We may disclose data when the law requires it or to protect the rights and safety of our users. Within a workspace, other members see the content shared with them according to the workspace's roles and permissions.

9. Where data is stored
Your workspace data, files and backups are stored on Google Cloud in Mumbai, India. Some providers (for example e-mail delivery, push notifications or an AI provider your workspace chooses) may process data outside India, including in the United States. We take steps so it stays protected wherever it is processed.

10. How long we keep it
Workspace content is kept while the workspace exists. When a workspace is closed it is first kept in a recoverable state in case the closure was a mistake; ask support@projecttracker.in to erase it permanently. Content read by the project agent from mail, chat and meetings is erased after 30 days by default. Security and audit logs are kept for as long as they are needed for security and legal purposes. Invoices are kept as long as tax law requires. Backups are overwritten on a rolling basis.

11. Security
Connections are encrypted (HTTPS), passwords are hashed, secrets and third-party tokens are encrypted at rest, access inside a workspace follows its roles, and administrators can require two-step sign-in and single sign-on.

12. Your choices and rights
You can view and update your profile, export reports, and disconnect integrations yourself. To get a full copy of your data or to delete your account, write to support@projecttracker.in. You can also ask us to access, correct, erase or export your personal data, to withdraw consent, or to nominate someone to act for you, under the Digital Personal Data Protection Act, 2023 and other laws that apply to you. If your data is in an organization's workspace, we may refer your request to that organization. Write to support@projecttracker.in; we answer within 30 days.

13. Cookies
We use only the cookies and local storage needed to sign you in, keep you signed in securely and remember preferences such as the theme. We do not use advertising or third-party tracking cookies.

14. Children
Project Tracker is not intended for anyone under 18, and we do not knowingly collect their data.

15. Changes
When this policy changes we update the date above; for significant changes we ask you to review and accept the new version when you next use the app.

16. Contact and grievances
E-mail support@projecttracker.in for any question, request or complaint about your personal data. If you are not satisfied with our answer, you may complain to the Data Protection Board of India or the authority where you live.
""";

    public const string TermsOfService = """
Last updated: 19 October 2026

These terms apply to your use of Project Tracker (projecttracker.in and its web, desktop and mobile apps, "the service"). By creating an account or using the service you agree to them. Questions: support@projecttracker.in.

1. Accounts
You must give accurate details, keep your password and sign-in methods safe, and be at least 18 years old. You are responsible for what happens under your account. Tell us at once at support@projecttracker.in if you think someone else has used it.

2. Workspaces and your content
A workspace belongs to the person or organization that created it; its owners and administrators control who may join and what members can see and do. You and your organization keep all rights to the content you put into the service. You give us permission to host, copy, process and display it only as needed to run the service for you, including the AI features you choose to use. You are responsible for having the right to upload what you upload.

3. Acceptable use
Do not use the service to break the law; to infringe anyone's rights; to send spam or malware; to harass anyone; to try to reach data or workspaces you are not allowed to; to probe, overload or disrupt the service or get around its limits; or to resell it without our written agreement. We may remove content or suspend access that breaks these rules.

4. Plans, payment and renewal
Prices are shown in Settings › Billing and on the pricing page and exclude GST unless stated. Paid plans are paid in advance for the period you choose. While payments are made by UPI, a plan is switched on once we have confirmed your payment, which is usually within a few working hours; give the correct UPI transaction reference (UTR) when asked. Plans paid by UPI do not renew automatically: when the paid period ends you are asked to pay again, and if you do not, the workspace moves to the Free plan's limits without losing data. If we cannot confirm a payment or cannot switch on a plan you paid for, write to support@projecttracker.in with the reference and we will resolve it, including by refunding the amount. Other refunds are made where the law requires. Free plans and trials have the limits shown when you choose them, and we may change them for the future with notice.

5. Outside services
Features that connect to Google, Microsoft, Slack, GitHub, WhatsApp or other services are also subject to those services' terms. You can disconnect them at any time. Our use of data from Google APIs follows the Google API Services User Data Policy, as described in our Privacy Policy.

6. AI features and the meeting bot
AI answers, drafts, minutes and proposals are generated automatically and can be incomplete or wrong; check them before relying on them. The project agent only proposes changes; people decide. If you invite the meeting bot to a call, you are responsible for telling participants and for having any consent the law requires to record or transcribe the call.

7. Availability and changes
We work to keep the service available and secure but do not promise it will be uninterrupted or error-free. We may change or improve features; if we remove something important to a paid plan, we will tell you in advance.

8. Suspension and closing an account
You may stop using the service at any time; to close your account or a workspace you own, write to support@projecttracker.in and we will do it. We may suspend or close access for a serious or repeated breach of these terms, for non-payment, or when the law requires, and we will tell you why unless we are not allowed to. After closure you may ask us for an export of your content within 30 days.

9. Liability
The service is provided "as is" to the extent the law allows. We are not liable for indirect or consequential loss, lost profits or lost data that could have been avoided by reasonable care on your side. Our total liability for any claim is limited to the amount you paid us for the service in the 12 months before the claim. Nothing in these terms limits liability that cannot be limited by law.

10. Privacy
How we handle personal data is described in the Privacy Policy at https://projecttracker.in/privacy.

11. Changes to these terms
We may update these terms. We change the date above, and for significant changes we ask you to accept the new version when you next use the service. If you do not agree, you may stop using the service.

12. Law and disputes
These terms are governed by the laws of India, and the courts of India have jurisdiction. Please contact support@projecttracker.in first so we can try to resolve any problem.
""";
}
