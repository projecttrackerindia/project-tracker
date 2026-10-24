namespace ProjectManagement.Tests;

/// <summary>
/// <c>IgnoreQueryFilters</c> turns off the automatic tenant (and soft-delete) filtering that every other query gets for free - each call is a
/// deliberate, reviewed decision (a background worker with no signed-in tenant, an admin cross-tenant view, a lookup by token/e-mail before a
/// tenant is known, ...), not something that should ever slip in by habit or copy-paste. This is the source-level sibling of
/// <see cref="TenantIsolationGuardTests"/>: that one watches which entities opt out of scoping, this one watches which files reach for the
/// escape hatch. A new file added to this list means someone decided that on purpose; a new, un-reviewed use fails this test until they do.
/// </summary>
public class QueryFilterBypassGuardTests
{
    private static readonly string[] Reviewed =
    [
        "ProjectManagement.Application/Features/Time/PlannedLeaveService.cs", // exact tenant/request tombstone check after person authorization; no cross-tenant read
        "ProjectManagement.Api/Middleware/Middleware.cs",
        "ProjectManagement.Application/Features/Vault/VaultService.Sealed.cs", // who has access to a sealed collection now: memberships of the whole workspace (named explicitly), so people outside the caller's project view never look like they lost access
        "ProjectManagement.Application/Features/Vault/SecretLinkPublic.cs", // a self-destructing link is opened without signing in: found by the hash of its token (unique across workspaces); its workspace's name and the sender's name only
        "ProjectManagement.Application/Features/Vault/VaultService.Links.cs", // a new link's token hash must be unique across workspaces: existence check only
        "ProjectManagement.Application/Features/Vault/MachineAccess.cs", // a pipeline reads with GitHub's signed token, no workspace session: the binding is found by id and every claim checked against it; then only that binding's workspace and collection
        "ProjectManagement.Application/Features/Vault/VaultService.Machines.cs", // values for a verified pipeline: the binding's own workspace and collection, named explicitly
        "ProjectManagement.Application/Features/Vault/VaultJobs.cs", // nightly vault work and offboarding: each query names its workspace (or reads only ids to visit each workspace in turn, as that workspace); key re-wrapping per workspace
        "ProjectManagement.Application/Features/Integrations/OAuthService.cs", // token endpoint: grants found by their secret hash, before any workspace exists
        "ProjectManagement.Api/Realtime/ChatHub.cs",
        "ProjectManagement.Application/Features/Admin/AdminService.cs",
        "ProjectManagement.Application/Features/People/MemberProfile.cs",
        "ProjectManagement.Application/Features/Resumes/PersonalFileCleanup.cs", // trusted storage-key existence checks only, across owners and deleted records; no content is retrieved
        "ProjectManagement.Application/Features/Admin/GoLiveService.cs",
        "ProjectManagement.Application/Features/Billing/UpiBillingService.cs", // platform administrators confirm UPI payments of every workspace (writes switch to that workspace); a UTR is unique across all workspaces; account health counts every workspace's payments
        "ProjectManagement.Application/Features/Agent/MeetingBotClient.cs", // the meeting-bot queue: workers serve every workspace, so sessions are claimed, renewed and finished across workspaces (by id and lease only)
        "ProjectManagement.Application/Features/Admin/DeployAlertService.cs", // anonymous hosting webhook (token in the address): only the platform administrators' e-mail addresses are read
        "ProjectManagement.Application/Features/Admin/PlatformService.cs",
        "ProjectManagement.Application/Features/Ai/AiPortfolio.cs",
        "ProjectManagement.Application/Features/Ai/AiOperationsProcessor.cs", // scheduling metadata and atomic leases; retrieval uses fresh current requester scope
        "ProjectManagement.Application/Features/Ai/AiSemanticIndex.cs", // background embedding across workspaces; every search hit is re-opened with the reader's own access
        "ProjectManagement.Application/Features/Ai/AiToolbox.cs",
        "ProjectManagement.Application/Features/Ai/AiWatchService.cs", // the background watch check reads each watch's target by id, for its own tenant only, and notifies only the watch's owner
        "ProjectManagement.Application/Features/Ai/AiUsageService.cs",
        "ProjectManagement.Application/Features/Auth/AccountDeletionService.cs", // the signed-in person's own account, the workspaces they own (count only) and the platform administrators' e-mail addresses
        "ProjectManagement.Application/Features/Billing/BillingMailer.cs", // billing e-mails are sent from webhooks and background jobs with no signed-in workspace: it reads only that workspace's name and its owner's address
        "ProjectManagement.Application/Features/Auth/AuthService.cs",
        "ProjectManagement.Application/Features/Auth/DeviceLoginService.cs",
        "ProjectManagement.Application/Features/Automation/AutomationService.cs",
        "ProjectManagement.Application/Features/Billing/BillingService.cs", // personal certification destinations and bounded expired-summary ID deletion only; no employer reads or decrypted email retrieval
        "ProjectManagement.Application/Features/Billing/BillingWebhookService.cs",
        "ProjectManagement.Application/Features/Billing/SubscriptionActivator.cs",
        "ProjectManagement.Application/Features/Compliance/Compliance.cs",
        "ProjectManagement.Application/Features/Documents/DocumentAccessRequestService.cs",
        "ProjectManagement.Application/Features/Documents/DocumentNotifier.cs",
        "ProjectManagement.Application/Features/Documents/DocumentRetention.cs",
        "ProjectManagement.Application/Features/Documents/DocumentSearch.cs",
        "ProjectManagement.Application/Features/Documents/DocumentFreshness.cs", // nightly: which pages have links or mentions (ids only), then each workspace is checked with its own context
        "ProjectManagement.Application/Features/Documents/DocumentSecurity.cs",
        "ProjectManagement.Application/Features/Documents/DocumentService.cs",
        "ProjectManagement.Application/Features/Documents/DocumentWorkflowService.cs",
        "ProjectManagement.Application/Features/Documents/EnvelopeCrypto.cs",
        "ProjectManagement.Application/Features/Files/AttachmentService.cs",
        "ProjectManagement.Application/Features/Import/TaskImportService.cs",
        "ProjectManagement.Application/Features/Integrations/ApiKeyService.cs",
        "ProjectManagement.Application/Features/Integrations/CalendarFeedService.cs",
        "ProjectManagement.Application/Features/Integrations/ConnectedAccountsService.cs", // Slack messages: the dispatcher claims waiting notifications across workspaces, then reads only that notification's workspace bot and that person's link
        "ProjectManagement.Application/Features/Integrations/GitLinkService.cs",
        "ProjectManagement.Application/Features/Integrations/GitHubAppService.cs", // an installation id may belong to one workspace only: uniqueness check across workspaces, nothing else read
        "ProjectManagement.Application/Features/Integrations/GitHubAppWebhook.cs", // signed GitHub App webhook: the installation id picks the workspace (routing row and tenant status only); everything after runs in that workspace
        "ProjectManagement.Application/Features/Integrations/InboundEmailService.cs",
        "ProjectManagement.Application/Features/Integrations/SlackConnectionService.cs", // global workspace uniqueness and signed lifecycle routing only; no business-data reads; exact team/app mapping establishes tenant before writes
        "ProjectManagement.Application/Features/Integrations/WhatsAppInstallationService.cs", // exact app/phone uniqueness metadata only; current authenticated tenant/user checked before persistence
        "ProjectManagement.Application/Features/Integrations/WhatsAppMetadataMaintenance.cs", // metadata-only global scheduling; bounded cleanup uses explicit tenant scope and its ledger lock, including inactive installations
        "ProjectManagement.Application/Features/Support/SupportReplyProcessor.cs", // scheduling reads chat ids, workspace ids and the waiting flag only; each chat is answered in its own workspace
        "ProjectManagement.Application/Features/Support/SupportChannelService.cs", // anonymous WhatsApp webhook: a channel is found by the id in its address and used only after its app-secret signature checks; uniqueness of a phone number id across workspaces
        "ProjectManagement.Application/Features/Integrations/WhatsAppDeliveryProcessor.cs", // scheduling returns tenant IDs only using routing/consent/status predicates; all notification/contact contents and delivery execution are tenant-scoped after selection
        "ProjectManagement.Application/Features/Integrations/WhatsAppGatewayService.cs", // signed provider callbacks resolve exact app/WABA/phone installation metadata only; tenant scope restored and no business reads/actions
        "ProjectManagement.Application/Features/Integrations/WebhookService.cs",
        "ProjectManagement.Application/Features/Integrations/IncomingWebhookService.cs", // anonymous incoming webhook: the address is found by the token in its URL (and its secret, when set); everything after runs in that workspace as the member who set it up
        "ProjectManagement.Application/Features/Chat/ChatService.Upgrades.cs", // scheduled send: finds due rows (ids, workspace and sender only), then sends each as its sender inside that workspace
        "ProjectManagement.Application/Features/Issues/IssueService.cs",
        "ProjectManagement.Application/Features/Notifications/NotificationService.cs",
        "ProjectManagement.Application/Features/Notifications/PushService.cs",
        "ProjectManagement.Application/Features/Organization/AccessService.cs",
        "ProjectManagement.Application/Features/Organization/OrgSecurityService.cs",
        "ProjectManagement.Application/Features/Organization/OrgService.cs",
        "ProjectManagement.Application/Features/ProjectMeetings/MeetingSyncEngine.cs",
        "ProjectManagement.Application/Features/ProjectMeetings/StandupSummaryService.cs", // background: finds stand-up meetings across active tenants (ids and times only); each summary is built in that tenant's own scope
        "ProjectManagement.Application/Features/Agent/AgentEngine.cs", // background: finds projects with the agent on and inbox opt-ins across active tenants (ids only); each is handled in that tenant's own scope as its acting person
        "ProjectManagement.Application/Features/Agent/AgentSignalService.cs", // anonymous project-mailbox webhook: the token picks the project before a tenant is known; de-duplication by exact project/source reference; WhatsApp texts inside the gateway's signed tenant transaction with an explicit tenant id; retention clean-up of what was read, in every tenant
        "ProjectManagement.Application/Features/Agent/AgentMeetingService.cs", // anonymous meeting-bot webhook: the token picks the bot before a tenant is known; only that row's transcript is appended
        "ProjectManagement.Application/Features/Projects/ProjectGroupService.cs",
        "ProjectManagement.Application/Features/Projects/ProjectService.cs", // project-key uniqueness only, scoped to the current tenant; no data is read
        "ProjectManagement.Application/Features/Projects/ProjectService.Statuses.cs",
        "ProjectManagement.Application/Features/Projects/ProjectStatusService.cs",
        "ProjectManagement.Application/Features/Calls/CallService.cs", // signed media-server webhooks name a room before a tenant is known; only that room's rows change
        "ProjectManagement.Application/Features/Projects/ActionItemService.cs", // restoring an action item from the bin (deleted rows are filtered out otherwise), checked against its project and tenant
        "ProjectManagement.Application/Features/Reminders/PortfolioDigestService.cs",
        "ProjectManagement.Application/Features/Reminders/ReminderEngine.cs",
        "ProjectManagement.Application/Features/Reports/ReportExportService.cs",
        "ProjectManagement.Application/Features/Sso/SsoGroupSync.cs",
        "ProjectManagement.Application/Features/Tasks/TaskService.cs",
        "ProjectManagement.Application/Features/Time/CapacityService.cs",
        "ProjectManagement.Application/Features/Work/SlaService.cs",
        "ProjectManagement.Application/Features/Time/TimesheetNudgeMonitor.cs", // background: timesheet reminders across active organizations, written per (tenant, person) with dedupe keys
        "ProjectManagement.Application/Features/Work/WorkTaskService.cs",
        "ProjectManagement.Application/Features/Workspaces/WorkspaceService.cs",
        "ProjectManagement.Application/Services/EntitlementService.cs",
        "ProjectManagement.Application/Services/WorkspaceExecutionPrincipal.cs", // reconstructs current membership and project scope for a saved principal; active tenant and exact user checks
        "ProjectManagement.Infrastructure/Workers/AiTraceRetentionWorker.cs", // background cleanup: only expired operational traces; no content or business writes
        "ProjectManagement.Infrastructure/Persistence/AppDbContext.Audit.cs",
        "ProjectManagement.Infrastructure/Persistence/AppDbContext.QueryFilters.cs",
        "ProjectManagement.Infrastructure/Persistence/DatabaseInitializer.cs",
    ];

    /// <summary>Walks up from the test assembly's output folder (.../src/ProjectManagement.Tests/bin/Debug/net9.0) to the "src" folder that
    /// holds every project - the root every path in <see cref="Reviewed"/> is relative to.</summary>
    private static string SrcRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && dir.Name != "src") dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("Could not find the backend's src folder from the test output directory.");
    }

    [Fact]
    public void Every_file_that_bypasses_tenant_and_soft_delete_filtering_was_reviewed_on_purpose()
    {
        var root = SrcRoot();
        var projects = new[] { "ProjectManagement.Api", "ProjectManagement.Application", "ProjectManagement.Infrastructure" };
        var found = projects
            .SelectMany(p => Directory.EnumerateFiles(Path.Combine(root, p), "*.cs", SearchOption.AllDirectories))
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}Migrations{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                        && !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                        && !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                        && File.ReadAllText(f).Contains("IgnoreQueryFilters", StringComparison.Ordinal))
            .Select(f => Path.GetRelativePath(root, f).Replace(Path.DirectorySeparatorChar, '/'))
            .OrderBy(f => f, StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(Reviewed.OrderBy(f => f, StringComparer.Ordinal), found);
    }
}
