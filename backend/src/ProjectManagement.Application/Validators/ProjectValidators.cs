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
