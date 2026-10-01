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
