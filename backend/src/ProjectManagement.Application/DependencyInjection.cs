using FluentValidation;
using Microsoft.Extensions.DependencyInjection;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Features.Admin;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Automation;
using ProjectManagement.Application.Features.Reports;
using ProjectManagement.Application.Features.Time;
using ProjectManagement.Application.Features.Billing;
using ProjectManagement.Application.Features.Files;
using ProjectManagement.Application.Features.Insights;
using ProjectManagement.Application.Features.Issues;
using ProjectManagement.Application.Features.Import;
using ProjectManagement.Application.Features.Integrations;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Features.Planning;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Features.Teams;
using ProjectManagement.Application.Features.Workspaces;
using ProjectManagement.Application.Services;

namespace ProjectManagement.Application;

public static class DependencyInjection
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        // One mutable context per request/scope; ICurrentContext is the read-only view services depend on.
        services.AddScoped<CurrentContext>();
        services.AddScoped<ICurrentContext>(sp => sp.GetRequiredService<CurrentContext>());

        services.AddScoped<AppClock>();
        services.AddScoped<Recorder>();
        services.AddScoped<PermissionService>();
        services.AddScoped<EntitlementService>();
        services.AddScoped<ProjectAccess>();
        services.AddScoped<WorkspaceProvisioner>();

        services.AddScoped<SecurityAlerts>();
        services.AddScoped<MfaService>();
        services.AddScoped<PasswordPolicyService>();
        services.AddScoped<ProjectManagement.Application.Features.Organization.OrgSecurityService>();
        services.AddScoped<ProjectManagement.Application.Features.Consent.ConsentService>();
        services.AddScoped<AuthService>();
        services.AddScoped<WorkspaceService>();
        services.AddScoped<TeamService>();
        services.AddScoped<OrgService>();
        services.AddScoped<AccessService>();
        services.AddScoped<ProjectService>();
        services.AddScoped<DueDateHistory>();
        services.AddScoped<ProjectGroupService>();
        services.AddScoped<ProjectStatusService>();
        services.AddScoped<ActionItemService>();
        services.AddScoped<ProjectManagement.Application.Features.Work.WorkTypeService>();
        services.AddScoped<ProjectManagement.Application.Features.Work.WorkTaskService>();
        services.AddScoped<TaskService>();
        services.AddScoped<TaskCompletionService>();
        services.AddScoped<IssueService>();
        services.AddScoped<TimelineTemplateService>();
        services.AddScoped<PlanningService>();
        services.AddScoped<TimeService>();
        services.AddScoped<ProjectManagement.Application.Features.Chat.ChatService>();
        services.AddScoped<PlatformService>();
        services.AddScoped<GoLiveService>();
        services.AddSingleton<PlatformSettingsCache>();
        services.AddSingleton<SystemMetrics>();
        services.AddSingleton<WorkerHeartbeats>();
        services.AddScoped<ReportingService>();
        services.AddScoped<WebhookService>();
        services.AddSingleton<WebhookProcessor>();
        services.AddScoped<ApiKeyService>();
        services.AddScoped<ApiKeyAuthenticator>();
        services.AddScoped<CustomFieldService>();
        services.AddScoped<TaskImportService>();
        services.AddScoped<ChecklistService>();
        services.AddScoped<PriorityService>();
        services.AddScoped<ReportExportService>();
        services.AddScoped<ReportBuilder>();
        services.AddSingleton<ReportExportProcessor>();
        services.AddScoped<SprintService>();
        services.AddScoped<AutomationService>();
        services.AddScoped<AutomationEngine>();
        services.AddScoped<AttachmentService>();
        services.AddScoped<AttachmentJanitor>();
        services.AddScoped<NotificationRouter>();
        services.AddScoped<NotificationService>();
        services.AddScoped<NotificationPreferenceService>();
        services.AddScoped<NotificationEmailService>();
        services.AddScoped<ActivityService>();
        services.AddScoped<DashboardService>();
        services.AddScoped<CalendarService>();
        services.AddScoped<SearchService>();
        services.AddScoped<ReportService>();
        services.AddScoped<BillingService>();
        services.AddScoped<MaintenanceService>();
        services.AddScoped<AdminService>();

        services.AddValidatorsFromAssemblyContaining<RegisterRequest>(includeInternalTypes: true);
        return services;
    }
}
