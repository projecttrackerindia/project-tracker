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
