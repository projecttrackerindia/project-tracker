namespace ProjectManagement.Application.Features.Billing;

public record CurrencyDto(string Code, string Name);

/// <summary>
/// The currencies plans can be priced in. INR is the default; the platform administrator can switch to any other one in the list
/// (Admin → Platform settings), and adding another is one line here. Amounts are never converted between currencies.
/// </summary>
public static class Currencies
{
    public const string Default = "INR";

    public static readonly IReadOnlyList<CurrencyDto> All =
    [
        new("INR", "Indian rupee"), new("USD", "US dollar"), new("EUR", "Euro"), new("GBP", "Pound sterling"),
        new("AED", "UAE dirham"), new("SAR", "Saudi riyal"), new("SGD", "Singapore dollar"), new("AUD", "Australian dollar"),
        new("CAD", "Canadian dollar"), new("NZD", "New Zealand dollar"), new("JPY", "Japanese yen"), new("CNY", "Chinese yuan"),
        new("CHF", "Swiss franc"), new("ZAR", "South African rand"), new("MYR", "Malaysian ringgit"), new("LKR", "Sri Lankan rupee"),
        new("BDT", "Bangladeshi taka"), new("NPR", "Nepalese rupee"),
    ];

    public static bool IsSupported(string? code) => code is not null && All.Any(c => c.Code.Equals(code.Trim(), StringComparison.OrdinalIgnoreCase));

    /// <summary>The upper-case code from the list, or <paramref name="fallback"/> when <paramref name="code"/> is empty or unknown.</summary>
    public static string Normalize(string? code, string fallback = Default) =>
        IsSupported(code) ? All.First(c => c.Code.Equals(code!.Trim(), StringComparison.OrdinalIgnoreCase)).Code : fallback;
}
