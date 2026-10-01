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
