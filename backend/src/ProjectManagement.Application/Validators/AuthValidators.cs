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
