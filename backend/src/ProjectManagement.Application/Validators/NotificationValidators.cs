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

public class SetPreferencesValidator : AbstractValidator<SetPreferencesRequest>
{
    public SetPreferencesValidator()
    {
        RuleFor(x => x.Items).NotNull().Must(i => i is null || i.Count <= 20).WithMessage("Too many items.");
        RuleForEach(x => x.Items).ChildRules(i => i.RuleFor(p => p.Type).IsInEnum());
    }
}
