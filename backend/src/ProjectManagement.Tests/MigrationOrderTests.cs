using System.Text.RegularExpressions;

namespace ProjectManagement.Tests;

/// <summary>
/// The migration chain must apply in the same order on a fresh database as on an upgraded one. Several migrations were given hand-written
/// identifiers dated ahead of the calendar (up to 20261104000100), so a migration generated today from the clock would sort into the middle of
/// the chain and run in a different position on new installations. Every migration added from now on must therefore carry an identifier
/// greater than the frontier below; the recorded list is the chain as it stood when this guard was written and is not to be extended.
/// </summary>
public class MigrationOrderTests
{
    private const string Frontier = "20261104000100";

    private static readonly string[] Recorded =
    [
        "20260920142936_InitialCreate",
        "20260920162335_TenantSoftDeleteAndProjectPosition",
        "20260920165837_OrganizationChart",
        "20260921042609_JobRoleAccess",
        "20260921065243_NotificationDelivery",
        "20260921071624_Attachments",
        "20260921082143_DependenciesAndMilestones",
        "20260921083605_InvitationRoles",
        "20260921084712_MfaSupport",
        "20260921091833_TimeAndAutomation",
        "20260921095451_Sprints",
        "20260921100830_ReportExports",
        "20260921103222_ChecklistsAndPriorities",
        "20260921105723_CustomFields",
        "20260921110741_ApiKeys",
        "20260921111657_Webhooks",
        "20260921131710_PlatformAdmin",
        "20260921151752_Chat",
        "20260922071036_PasswordPolicy",
        "20260922074009_OrgSecurity",
        "20260922123115_UserConsent",
        "20260923133240_ReportExportTargetUser",
        "20260923141920_FixReportExportKindNames",
        "20260923154739_TaskStageLink",
        "20260923164728_RemoveBlockedStatus",
        "20260924073017_UserMustChangePassword",
        "20260924094053_CustomTimelineTemplates",
        "20260924130816_TestIssues",
        "20260924135652_ProjectChat",
        "20260924155502_ProjectGroupsAndDueDateHistory",
        "20260924163937_ActionItems",
        "20260925052701_ProjectTypeAndWorkTasks",
        "20261001033749_ModuleConsolidation",
        "20261001091439_SearchIndexes",
        "20261001103610_SingleSignOn",
        "20261001125945_ResourcesAndServiceLevels",
        "20261001134822_IntegrationsAndCompliance",
        "20261001175206_AssistantAutomationPush",
        "20261002152526_Reminders",
        "20261004143752_AiWorkspace",
        "20261004161428_AiEfficiencyAndLearning",
        "20261005061445_OrganizationAddresses",
        "20261005084551_ChatFilesReactionsAndNotices",
        "20261005102145_ProjectVisibilityByTeam",
        "20261005185726_PhoneSignIn",
        "20261005202346_ApiHardeningAndPasskeys",
        "20261006002424_EmailDeliveryAndSuppression",
        "20261006005021_RazorpaySubscriptions",
        "20261006012111_InvoiceDetails",
        "20261006065740_PerSeatPricing",
        "20261007031759_Documents",
        "20261007035629_DocumentVersionsSharingFiles",
        "20261007043116_DocumentWorkflowAccessRequestsRequirements",
        "20261007052014_ApiDocumentation",
        "20261007060925_DocumentSecrets",
        "20261007082202_DocumentExportSearch",
        "20261007084317_SsoGroupMappings",
        "20261007092906_DocumentBrandingAndLifecycle",
        "20261007153055_AddUserAvatar",
        "20261008035158_ProjectMeetingsAndGoogleConnection",
        "20261009164837_AiAgentTracker",
        "20261010143636_EnterpriseAgentWorkflows",
        "20261010145303_TransactionalAiCredits",
        "20261010152701_AiUserAndTeamBudgets",
        "20261010154349_AiProviderPriceSnapshots",
        "20261010170118_EnterpriseKnowledgeEvidence",
        "20261010171145_VerifiedSupportResolutions",
        "20261010182752_OrganizationSlackOAuth",
        "20261010184340_SlackLifecycleReceipts",
        "20261011021558_PersonalResumesAndCertifications",
        "20261011023413_ResumeExportsAndSupportTickets",
        "20261011024744_CertificationExpiryReminders",
        "20261011025027_PrivateCertificationAttachments",
        "20261011030531_DurableSupportWorkflows",
        "20261011035406_DurablePersonalFileCleanup",
        "20261011051417_DurableProviderOAuthAttempts",
        "20261011053210_PersonalEmailDrafts",
        "20261011062100_MicrosoftProductivityAndEmailProviders",
        "20261011065223_PersonalCalendarProposals",
        "20261011073057_WhatsAppInboundFoundation",
        "20261011091248_WhatsAppInstallationExpiry",
        "20261011093926_WhatsAppPrivateContactLinks",
        "20261011102347_WhatsAppNotificationConsent",
        "20261011104645_WhatsAppProviderHealth",
        "20261011111118_WhatsAppNotificationTemplates",
        "20261011114854_DurableWhatsAppNotificationDelivery",
        "20261011161936_WhatsAppMetadataRetention",
        "20261011173857_ExplicitInboxConsent",
        "20261011184438_GroundedInboxSummaryReceipts",
        "20261012060025_DurablePersonalEmailRecovery",
        "20261012171600_PlannedTimesheetLeave",
        "20261013101012_AutomaticStageScheduling",
        "20261013175049_RecurringProjectMeetings",
        "20261014125420_DocumentClassificationAndFileEncryption",
        "20261014133355_RecentlyViewedDocumentsAndComments",
        "20261015074857_AddBuildArtifactVersioning",
        "20261018000050_WorkspaceTimeZone",
        "20261018000100_UniqueInvoiceReferences",
        "20261018000200_CoreIntegrityIndexes",
        "20261018000300_MeetingsQuietHoursInvoicesRequiredDocs",
        "20261019000100_ProjectAgent",
        "20261020000100_ProjectAgentAccuracy",
        "20261021000100_UpiPayments",
        "20261022000100_MeetingBotQueue",
        "20261023000100_AgentCommandCenter",
        "20261024000100_AgentAlertsAndCosts",
        "20261025000100_UserUiPreferences",
        "20261026000100_OperationsRouting",
        "20261027000100_DataProtectionKeys",
        "20261028000100_MailAccounts",
        "20261029000100_Notetaker",
        "20261030000100_CompanyMail",
        "20261031000100_NotetakerAutomation",
        "20261101000100_VoiceAgent",
        "20261102000100_SupportChannels",
        "20261102000200_DocumentMasking",
        "20261102000300_ProjectArchitecture",
        "20261103000100_OAuthConnectedApps",
        "20261104000100_VoiceToolFlows"
    ];

    private static string MigrationsDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "ProjectManagement.Infrastructure"))) dir = dir.Parent;
        if (dir is null) throw new InvalidOperationException("Could not find the backend's src folder from the test output directory.");
        return Path.Combine(dir.FullName, "ProjectManagement.Infrastructure", "Persistence", "Migrations");
    }

    private static IReadOnlyList<(string File, string Id)> Migrations()
    {
        // A generated migration carries its [Migration] attribute in the .Designer.cs partial; a hand-written one carries it inline.
        static string IdOf(string file)
        {
            var designer = Path.ChangeExtension(file, null) + ".Designer.cs";
            foreach (var candidate in new[] { file, designer })
                if (File.Exists(candidate) && new Regex(@"\[Migration\(""([0-9]{14}_[A-Za-z0-9]+)""\)\]").Match(File.ReadAllText(candidate)) is { Success: true } m) return m.Groups[1].Value;
            return "";
        }
        return Directory.EnumerateFiles(MigrationsDir(), "*.cs")
            .Where(f => !f.EndsWith(".Designer.cs", StringComparison.Ordinal) && !f.EndsWith("ModelSnapshot.cs", StringComparison.Ordinal))
            .Select(f => (File: Path.GetFileNameWithoutExtension(f), Id: IdOf(f)))
            .OrderBy(m => m.File, StringComparer.Ordinal).ToList();
    }

    [Fact]
    public void Every_migration_declares_the_identifier_its_file_is_named_after()
    {
        foreach (var (file, id) in Migrations())
            Assert.True(file == id, $"{file}.cs declares the migration identifier '{id}'; the file name and the attribute must agree.");
    }

    [Fact]
    public void A_new_migration_sorts_after_the_frontier_so_fresh_and_upgraded_databases_apply_the_same_order()
    {
        var recorded = Recorded.ToHashSet(StringComparer.Ordinal);
        var offenders = Migrations().Select(m => m.Id)
            .Where(id => !recorded.Contains(id) && string.CompareOrdinal(id.Split('_')[0], Frontier) <= 0)
            .ToList();
        Assert.True(offenders.Count == 0,
            $"These migrations sort before the frontier {Frontier} and would apply in a different position on a fresh database: {string.Join(", ", offenders)}. " +
            "Rename the migration so its identifier is greater than the frontier (for example the frontier plus one minute) and keep the attribute and the file name in step.");
    }

    [Fact]
    public void The_recorded_chain_is_still_present()
    {
        var present = Migrations().Select(m => m.Id).ToHashSet(StringComparer.Ordinal);
        var missing = Recorded.Where(id => !present.Contains(id)).ToList();
        Assert.True(missing.Count == 0, $"Recorded migrations are missing from the chain: {string.Join(", ", missing)}. A migration that has shipped is never removed.");
    }
}
