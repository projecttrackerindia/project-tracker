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
        "ProjectManagement.Api/Middleware/Middleware.cs",
        "ProjectManagement.Api/Realtime/ChatHub.cs",
        "ProjectManagement.Application/Features/Admin/AdminService.cs",
        "ProjectManagement.Application/Features/Admin/GoLiveService.cs",
        "ProjectManagement.Application/Features/Admin/PlatformService.cs",
        "ProjectManagement.Application/Features/Ai/AiPortfolio.cs",
        "ProjectManagement.Application/Features/Ai/AiOperationsProcessor.cs", // scheduling metadata and atomic leases; retrieval uses fresh current requester scope
        "ProjectManagement.Application/Features/Ai/AiToolbox.cs",
        "ProjectManagement.Application/Features/Ai/AiUsageService.cs",
        "ProjectManagement.Application/Features/Auth/AuthService.cs",
        "ProjectManagement.Application/Features/Auth/DeviceLoginService.cs",
        "ProjectManagement.Application/Features/Automation/AutomationService.cs",
        "ProjectManagement.Application/Features/Billing/BillingWebhookService.cs",
        "ProjectManagement.Application/Features/Billing/SubscriptionActivator.cs",
        "ProjectManagement.Application/Features/Compliance/Compliance.cs",
        "ProjectManagement.Application/Features/Documents/DocumentAccessRequestService.cs",
        "ProjectManagement.Application/Features/Documents/DocumentNotifier.cs",
        "ProjectManagement.Application/Features/Documents/DocumentRetention.cs",
        "ProjectManagement.Application/Features/Documents/DocumentSearch.cs",
        "ProjectManagement.Application/Features/Documents/DocumentSecurity.cs",
        "ProjectManagement.Application/Features/Documents/DocumentService.cs",
        "ProjectManagement.Application/Features/Documents/DocumentWorkflowService.cs",
        "ProjectManagement.Application/Features/Documents/EnvelopeCrypto.cs",
        "ProjectManagement.Application/Features/Files/AttachmentService.cs",
        "ProjectManagement.Application/Features/Import/TaskImportService.cs",
        "ProjectManagement.Application/Features/Integrations/ApiKeyService.cs",
        "ProjectManagement.Application/Features/Integrations/CalendarFeedService.cs",
        "ProjectManagement.Application/Features/Integrations/GitLinkService.cs",
        "ProjectManagement.Application/Features/Integrations/InboundEmailService.cs",
        "ProjectManagement.Application/Features/Integrations/WebhookService.cs",
        "ProjectManagement.Application/Features/Issues/IssueService.cs",
        "ProjectManagement.Application/Features/Notifications/NotificationService.cs",
        "ProjectManagement.Application/Features/Notifications/PushService.cs",
        "ProjectManagement.Application/Features/Organization/AccessService.cs",
        "ProjectManagement.Application/Features/Organization/OrgSecurityService.cs",
        "ProjectManagement.Application/Features/Organization/OrgService.cs",
        "ProjectManagement.Application/Features/ProjectMeetings/MeetingSyncEngine.cs",
        "ProjectManagement.Application/Features/Projects/ProjectGroupService.cs",
        "ProjectManagement.Application/Features/Projects/ProjectService.Statuses.cs",
        "ProjectManagement.Application/Features/Projects/ProjectStatusService.cs",
        "ProjectManagement.Application/Features/Reminders/PortfolioDigestService.cs",
        "ProjectManagement.Application/Features/Reminders/ReminderEngine.cs",
        "ProjectManagement.Application/Features/Reports/ReportExportService.cs",
        "ProjectManagement.Application/Features/Sso/SsoGroupSync.cs",
        "ProjectManagement.Application/Features/Tasks/TaskService.cs",
        "ProjectManagement.Application/Features/Time/CapacityService.cs",
        "ProjectManagement.Application/Features/Work/SlaService.cs",
        "ProjectManagement.Application/Features/Work/WorkTaskService.cs",
        "ProjectManagement.Application/Features/Workspaces/WorkspaceService.cs",
        "ProjectManagement.Application/Services/EntitlementService.cs",
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
