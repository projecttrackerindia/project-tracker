namespace ProjectManagement.Domain;

/// <summary>The legal documents someone must accept to use the platform. The documents' own text/version live in
/// PlatformSettings (like the password policy); this only names the two required ones.</summary>
public static class ConsentTypes
{
    public const string TermsOfService = "tos";
    public const string PrivacyPolicy = "privacy";
    public static readonly string[] All = [TermsOfService, PrivacyPolicy];
}
