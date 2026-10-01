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
