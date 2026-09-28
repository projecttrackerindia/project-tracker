using FluentValidation;
using ProjectManagement.Application.Features.Admin;
using ProjectManagement.Application.Features.Auth;
using ProjectManagement.Application.Features.Billing;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Application.Features.Organization;
using ProjectManagement.Application.Features.Planning;
using ProjectManagement.Application.Features.Projects;
using ProjectManagement.Application.Features.Tasks;
using ProjectManagement.Application.Features.Teams;
using ProjectManagement.Application.Features.Workspaces;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Validators;

internal static class Rules
{
    public static IRuleBuilderOptions<T, string> Email<T>(this IRuleBuilder<T, string> rb) =>
        rb.NotEmpty().MaximumLength(254).EmailAddress().WithMessage("Enter a valid email address.");

    /// <summary>Only the limits every policy shares; the platform password policy (PasswordPolicyService) checks the rest.</summary>
    public static IRuleBuilderOptions<T, string> Password<T>(this IRuleBuilder<T, string> rb) =>
        rb.NotEmpty().WithMessage("Enter a password.").MaximumLength(128).WithMessage("Use at most 128 characters.");
}

public class RegisterValidator : AbstractValidator<RegisterRequest>
{
    public RegisterValidator()
    {
        RuleFor(x => x.Email).Email();
        RuleFor(x => x.Password).Password();
        RuleFor(x => x.DisplayName).NotEmpty().MaximumLength(100);
        RuleFor(x => x.AcceptedTerms).Equal(true).WithMessage("You must accept the Terms of Service and Privacy Policy to continue.");
    }
}

public class LoginValidator : AbstractValidator<LoginRequest>
{
    public LoginValidator() { RuleFor(x => x.Email).NotEmpty().MaximumLength(254); RuleFor(x => x.Password).NotEmpty().MaximumLength(128); }
}

public class MfaLoginValidator : AbstractValidator<MfaLoginRequest>
{
    public MfaLoginValidator() { RuleFor(x => x.Challenge).NotEmpty().MaximumLength(200); RuleFor(x => x.Code).NotEmpty().MaximumLength(20); }
}

public class MfaConfirmValidator : AbstractValidator<MfaConfirmRequest>
{
    public MfaConfirmValidator() { RuleFor(x => x.Password).NotEmpty().MaximumLength(128); RuleFor(x => x.Code).NotEmpty().MaximumLength(20); }
}

public class MfaSetupValidator : AbstractValidator<MfaSetupRequest>
{
    public MfaSetupValidator() { RuleFor(x => x.Password).NotEmpty().MaximumLength(128); }
}

public class MfaEnableValidator : AbstractValidator<MfaEnableRequest>
{
    public MfaEnableValidator() { RuleFor(x => x.Code).NotEmpty().MaximumLength(20); }
}

public class VerifyEmailValidator : AbstractValidator<VerifyEmailRequest>
{
    public VerifyEmailValidator() => RuleFor(x => x.Token).NotEmpty().MaximumLength(200);
}

public class ResendVerificationValidator : AbstractValidator<ResendVerificationRequest>
{
    public ResendVerificationValidator() => RuleFor(x => x.Email).Email();
}

public class ForgotPasswordValidator : AbstractValidator<ForgotPasswordRequest>
{
    public ForgotPasswordValidator() => RuleFor(x => x.Email).Email();
}

public class ResetPasswordValidator : AbstractValidator<ResetPasswordRequest>
{
    public ResetPasswordValidator() { RuleFor(x => x.Token).NotEmpty().MaximumLength(200); RuleFor(x => x.Password).Password(); }
}

public class ChangePasswordValidator : AbstractValidator<ChangePasswordRequest>
{
    public ChangePasswordValidator() { RuleFor(x => x.CurrentPassword).NotEmpty(); RuleFor(x => x.NewPassword).Password(); }
}

public class UpdateProfileValidator : AbstractValidator<UpdateProfileRequest>
{
    public UpdateProfileValidator() { RuleFor(x => x.DisplayName).NotEmpty().MaximumLength(100); RuleFor(x => x.TimeZone).MaximumLength(64); }
}

public class CreateWorkspaceValidator : AbstractValidator<CreateWorkspaceRequest>
{
    public CreateWorkspaceValidator() { RuleFor(x => x.Name).NotEmpty().MinimumLength(2).MaximumLength(80); RuleFor(x => x.Description).MaximumLength(500); }
}

public class UpdateWorkspaceValidator : AbstractValidator<UpdateWorkspaceRequest>
{
    public UpdateWorkspaceValidator() { RuleFor(x => x.Name).NotEmpty().MinimumLength(2).MaximumLength(80); RuleFor(x => x.Description).MaximumLength(500); }
}

public class InviteValidator : AbstractValidator<InviteRequest>
{
    public InviteValidator() { RuleFor(x => x.Email).Email(); RuleFor(x => x.Role).IsInEnum().NotEqual(TenantRole.Owner); }
}

public class CreateMemberValidator : AbstractValidator<CreateMemberRequest>
{
    public CreateMemberValidator()
    {
        RuleFor(x => x.Email).Email();
        RuleFor(x => x.DisplayName).NotEmpty().MaximumLength(100);
        RuleFor(x => x.Password).Password();
        RuleFor(x => x.Role).IsInEnum().NotEqual(TenantRole.Owner);
    }
}

public class AcceptInvitationValidator : AbstractValidator<AcceptInvitationRequest>
{
    public AcceptInvitationValidator() => RuleFor(x => x.Token).NotEmpty().MaximumLength(200);
}

public class CreateProjectValidator : AbstractValidator<CreateProjectRequest>
{
    public CreateProjectValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MaximumLength(120);
        RuleFor(x => x.Key).MaximumLength(10);
        RuleFor(x => x.Description).MaximumLength(4000);
        RuleFor(x => x.Priority).IsInEnum();
        RuleFor(x => x.MemberIds).Must(m => m is null || m.Count <= 200).WithMessage("Too many members.");
    }
}

public class UpdateProjectValidator : AbstractValidator<UpdateProjectRequest>
{
    public UpdateProjectValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MaximumLength(120);
        RuleFor(x => x.Description).MaximumLength(4000);
        RuleFor(x => x.Priority).IsInEnum();
        RuleFor(x => x.Status).IsInEnum();
    }
}

public class MoveProjectValidator : AbstractValidator<MoveProjectRequest>
{
    public MoveProjectValidator() => RuleFor(x => x.Status).IsInEnum();
}

public class UpsertStatusValidator : AbstractValidator<UpsertStatusRequest>
{
    public UpsertStatusValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MaximumLength(40);
        RuleFor(x => x.Category).IsInEnum();
        RuleFor(x => x.Color).Matches("^#[0-9a-fA-F]{6}$").When(x => x.Color is not null).WithMessage("Color must be a hex value like #8b5cf6.");
    }
}

public class UpsertStageValidator : AbstractValidator<UpsertStageRequest>
{
    public UpsertStageValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MaximumLength(80);
        RuleFor(x => x.Status).IsInEnum();
        RuleFor(x => x.Description).MaximumLength(2000);
    }
}

public class UpsertLabelValidator : AbstractValidator<UpsertLabelRequest>
{
    public UpsertLabelValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MaximumLength(40);
        RuleFor(x => x.Color).Matches("^#[0-9a-fA-F]{6}$").When(x => x.Color is not null).WithMessage("Color must be a hex value like #8b5cf6.");
    }
}

public class CreateTaskValidator : AbstractValidator<CreateTaskRequest>
{
    public CreateTaskValidator()
    {
        RuleFor(x => x.Title).NotEmpty().MaximumLength(200);
        RuleFor(x => x.Description).MaximumLength(10000);
        RuleFor(x => x.Priority).IsInEnum();
        RuleFor(x => x.EstimatedHours).InclusiveBetween(0, 10000).When(x => x.EstimatedHours is not null);
    }
}

public class UpdateTaskValidator : AbstractValidator<UpdateTaskRequest>
{
    public UpdateTaskValidator()
    {
        RuleFor(x => x.Title).NotEmpty().MaximumLength(200);
        RuleFor(x => x.Description).MaximumLength(10000);
        RuleFor(x => x.Priority).IsInEnum();
        RuleFor(x => x.EstimatedHours).InclusiveBetween(0, 10000).When(x => x.EstimatedHours is not null);
        RuleFor(x => x.ActualHours).InclusiveBetween(0, 10000).When(x => x.ActualHours is not null);
    }
}

public class CreateCommentValidator : AbstractValidator<CreateCommentRequest>
{
    public CreateCommentValidator() => RuleFor(x => x.Body).NotEmpty().MaximumLength(5000);
}

public class UpdateCommentValidator : AbstractValidator<UpdateCommentRequest>
{
    public UpdateCommentValidator() => RuleFor(x => x.Body).NotEmpty().MaximumLength(5000);
}

public class UpsertTeamValidator : AbstractValidator<UpsertTeamRequest>
{
    public UpsertTeamValidator() { RuleFor(x => x.Name).NotEmpty().MaximumLength(80); RuleFor(x => x.Description).MaximumLength(500); }
}

public class CheckoutValidator : AbstractValidator<CheckoutRequest>
{
    public CheckoutValidator() => RuleFor(x => x.PlanCode).NotEmpty().MaximumLength(20);
}

public class CreateTenantValidator : AbstractValidator<CreateTenantRequest>
{
    public CreateTenantValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MinimumLength(2).MaximumLength(80);
        RuleFor(x => x.Description).MaximumLength(500);
        RuleFor(x => x.OwnerEmail).Email();
        RuleFor(x => x.PlanCode).NotEmpty().MaximumLength(20);
    }
}

public class UpdateTenantValidator : AbstractValidator<UpdateTenantRequest>
{
    public UpdateTenantValidator() { RuleFor(x => x.Name).NotEmpty().MinimumLength(2).MaximumLength(80); RuleFor(x => x.Description).MaximumLength(500); }
}

public class UpdatePlanValidator : AbstractValidator<UpdatePlanRequest>
{
    public UpdatePlanValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MaximumLength(60);
        RuleFor(x => x.PriceMonthly).GreaterThanOrEqualTo(0).When(x => x.PriceMonthly is not null);
        RuleFor(x => x.Features).NotNull();
    }
}

public class CreateOrgRoleValidator : AbstractValidator<CreateOrgRoleRequest>
{
    public CreateOrgRoleValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MinimumLength(2).MaximumLength(60);
        RuleFor(x => x.Description).MaximumLength(300);
        RuleFor(x => x.Color).Matches("^#[0-9a-fA-F]{6}$").When(x => !string.IsNullOrWhiteSpace(x.Color)).WithMessage("Colour must look like #8b5cf6.");
    }
}

public class UpdateOrgRoleValidator : AbstractValidator<UpdateOrgRoleRequest>
{
    public UpdateOrgRoleValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MinimumLength(2).MaximumLength(60);
        RuleFor(x => x.Description).MaximumLength(300);
        RuleFor(x => x.Color).Matches("^#[0-9a-fA-F]{6}$").When(x => !string.IsNullOrWhiteSpace(x.Color)).WithMessage("Colour must look like #8b5cf6.");
    }
}

public class OrgLayoutValidator : AbstractValidator<OrgLayoutRequest>
{
    public OrgLayoutValidator() => RuleFor(x => x.Items).NotNull().Must(i => i is null || i.Count <= 500).WithMessage("Too many items.");
}

public class ApplyOrgTemplateValidator : AbstractValidator<ApplyOrgTemplateRequest>
{
    public ApplyOrgTemplateValidator() => RuleFor(x => x.Template).NotEmpty().MaximumLength(40);
}

public class SetAccessValidator : AbstractValidator<SetAccessRequest>
{
    public SetAccessValidator()
    {
        RuleFor(x => x.Modules).NotNull().Must(m => m is null || m.Count <= 50).WithMessage("Too many modules.");
        RuleFor(x => x.Actions).Must(a => a is null || a.Count <= 50).WithMessage("Too many actions.");
    }
}

public class SetPreferencesValidator : AbstractValidator<SetPreferencesRequest>
{
    public SetPreferencesValidator()
    {
        RuleFor(x => x.Items).NotNull().Must(i => i is null || i.Count <= 20).WithMessage("Too many items.");
        RuleForEach(x => x.Items).ChildRules(i => i.RuleFor(p => p.Type).IsInEnum());
    }
}

public class UpsertMilestoneValidator : AbstractValidator<UpsertMilestoneRequest>
{
    public UpsertMilestoneValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MaximumLength(120);
        RuleFor(x => x.Description).MaximumLength(2000);
        RuleFor(x => x.Status).IsInEnum();
    }
}

public class AddDependencyValidator : AbstractValidator<AddDependencyRequest>
{
    public AddDependencyValidator()
    {
        RuleFor(x => x.DependsOnTaskId).NotEmpty();
        RuleFor(x => x.Type).IsInEnum();
    }
}
