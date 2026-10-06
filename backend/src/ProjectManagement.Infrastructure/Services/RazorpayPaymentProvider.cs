using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;

namespace ProjectManagement.Infrastructure.Services;

public class RazorpayOptions
{
    public const string Section = "Billing:Razorpay";
    /// <summary>The key id (rzp_test_... or rzp_live_...): it is public, the browser needs it.</summary>
    public string KeyId { get; set; } = "";
    public string KeySecret { get; set; } = "";
    /// <summary>The secret set on the webhook in the Razorpay dashboard.</summary>
    public string WebhookSecret { get; set; } = "";
    public string BaseUrl { get; set; } = "https://api.razorpay.com/v1";
}

/// <summary>The two signatures Razorpay uses: on the browser's payment confirmation, and on every webhook. Both are HMAC-SHA256, compared in constant time.</summary>
public static class RazorpaySignature
{
    public static string Hex(string secret, string text) => Convert.ToHexString(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(text))).ToLowerInvariant();

    public static bool Matches(string expectedHex, string? given) =>
        !string.IsNullOrEmpty(given) && CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expectedHex), Encoding.ASCII.GetBytes(given.Trim().ToLowerInvariant()));

    /// <summary>The smallest unit of a currency (paise for rupees); a few currencies have none.</summary>
    public static long Minor(decimal amount, string currency) => (long)Math.Round(amount * (currency.Equals("JPY", StringComparison.OrdinalIgnoreCase) ? 1 : 100), MidpointRounding.AwayFromZero);
}

/// <summary>
/// Razorpay Subscriptions: monthly auto-debit with the customer's own approval. The server creates the plan and the subscription (keys never leave it), the
/// browser opens Razorpay's payment window with the subscription id, and Razorpay reports each charge to the webhook.
/// </summary>
public class RazorpayPaymentProvider(HttpClient http, IOptions<RazorpayOptions> options, ILogger<RazorpayPaymentProvider> log) : IPaymentProvider
{
    private RazorpayOptions O => options.Value;
    public string Name => "razorpay";
    public bool RequiresCheckout => true;

    public Task<PaymentResult> ChargeAsync(Guid tenantId, string planCode, decimal amount, string currency, CancellationToken ct = default) =>
        throw new NotSupportedException("Razorpay payments are made in the payment window, not charged by the server.");

    public async Task<string> EnsurePlanAsync(string planCode, string name, decimal price, string currency, string? existingId, decimal? existingAmount, CancellationToken ct = default)
    {
        if (!string.IsNullOrEmpty(existingId) && existingAmount == price) return existingId;
        var res = await PostAsync("/plans", new
        {
            period = "monthly", interval = 1,
            item = new { name = $"{name} plan", amount = RazorpaySignature.Minor(price, currency), currency = currency.ToUpperInvariant(), description = $"Project Tracker {name}, per organization per month" },
            notes = new { planCode },
        }, ct);
        return res.GetProperty("id").GetString()!;
    }

    public async Task<HostedCheckout> StartSubscriptionAsync(Guid tenantId, string planCode, string planName, string providerPlanId, decimal price, string currency, CancellationToken ct = default)
    {
        var res = await PostAsync("/subscriptions", new { plan_id = providerPlanId, total_count = 120, customer_notify = 1, notes = new { tenantId = tenantId.ToString(), planCode } }, ct);
        return new HostedCheckout("razorpay", O.KeyId, res.GetProperty("id").GetString()!, "Project Tracker", $"{planName} plan, monthly", RazorpaySignature.Minor(price, currency), currency.ToUpperInvariant());
    }

    public async Task CancelSubscriptionAsync(string providerSubscriptionId, bool atCycleEnd, CancellationToken ct = default) =>
        await PostAsync($"/subscriptions/{Uri.EscapeDataString(providerSubscriptionId)}/cancel", new { cancel_at_cycle_end = atCycleEnd ? 1 : 0 }, ct);

    /// <summary>Razorpay signs "payment_id|subscription_id" with the key secret.</summary>
    public bool VerifyCheckout(string paymentId, string subscriptionId, string signature) =>
        !string.IsNullOrEmpty(O.KeySecret) && RazorpaySignature.Matches(RazorpaySignature.Hex(O.KeySecret, $"{paymentId}|{subscriptionId}"), signature);

    public bool VerifyWebhook(string body, string? signature) =>
        !string.IsNullOrEmpty(O.WebhookSecret) && RazorpaySignature.Matches(RazorpaySignature.Hex(O.WebhookSecret, body), signature);

    private async Task<JsonElement> PostAsync(string path, object body, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(O.KeyId) || string.IsNullOrWhiteSpace(O.KeySecret))
            throw new InvalidOperationException("Billing:Razorpay:KeyId and KeySecret must be set to take payments through Razorpay.");
        using var req = new HttpRequestMessage(HttpMethod.Post, O.BaseUrl.TrimEnd('/') + path) { Content = JsonContent.Create(body) };
        req.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{O.KeyId}:{O.KeySecret}")));
        using var res = await http.SendAsync(req, ct);
        var text = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode)
        {
            log.LogWarning("Razorpay {Path} answered {Status}: {Body}", path, (int)res.StatusCode, text.Length > 300 ? text[..300] : text);
            // The provider's own description is useful to the administrator and holds no secret.
            var reason = "the payment provider refused the request";
            try { reason = JsonDocument.Parse(text).RootElement.GetProperty("error").GetProperty("description").GetString() ?? reason; } catch { /* keep the generic text */ }
            throw new InvalidOperationException($"Razorpay: {reason}");
        }
        return JsonDocument.Parse(text).RootElement.Clone();
    }
}
