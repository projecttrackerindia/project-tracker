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
