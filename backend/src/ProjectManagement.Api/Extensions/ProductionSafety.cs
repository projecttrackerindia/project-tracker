namespace ProjectManagement.Api.Extensions;

/// <summary>Development/test fallbacks must never silently become production behavior.</summary>
public static class ProductionSafety
{
    public static IReadOnlyList<string> Problems(IConfiguration config, string environment)
    {
        if (!string.Equals(environment, "Production", StringComparison.OrdinalIgnoreCase)) return [];
        var errors = new List<string>();
        if (!(new[] { "Smtp", "Resend" }).Contains(config["Email:Provider"], StringComparer.OrdinalIgnoreCase))
            errors.Add("Configure Email:Provider as Smtp or Resend before production startup.");
        if (!(config["Billing:Provider"] ?? "Mock").Equals("Razorpay", StringComparison.OrdinalIgnoreCase)
            && !config.GetValue<bool>("Billing:Upi:Enabled"))
            errors.Add("Configure Razorpay or the explicit manual UPI payment flow before production startup.");
        if (string.IsNullOrWhiteSpace(config["Mfa:EncryptionKey"])
            && (string.IsNullOrWhiteSpace(config["Mfa:EncryptionKeyWrapped"]) || string.IsNullOrWhiteSpace(config["Mfa:KmsKeyName"])))
            errors.Add("Configure independent Mfa encryption material (plain or KMS-wrapped); preserve the current effective key before rotating.");
        return errors;
    }

    public static void Validate(IConfiguration config, string environment)
    {
        var problems = Problems(config, environment);
        if (problems.Count > 0) throw new InvalidOperationException(string.Join(" ", problems));
    }
}
