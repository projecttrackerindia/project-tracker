using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ProjectManagement.Api.Filters;
using ProjectManagement.Application.Features.Admin;
using ProjectManagement.Application.Features.Billing;
using ProjectManagement.Domain.Enums;
using ProjectManagement.Infrastructure.Services;
using ProjectManagement.Domain;

namespace ProjectManagement.Api.Controllers.Billing;

[Route("api/v1/billing"), RequireWorkspace, RequireModule(Modules.Billing)]
public class BillingController(BillingService billing, InvoiceService invoices) : ApiControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Overview(CancellationToken ct) => Ok(await billing.GetOverviewAsync(ct));

    [HttpPost("checkout")]
    public async Task<IActionResult> Checkout([FromBody] CheckoutRequest req, CancellationToken ct) => Ok(await billing.CheckoutAsync(req, ct));

    /// <summary>The payment window's result, sent by the browser with the provider's signature.</summary>
    [HttpPost("confirm")]
    public async Task<IActionResult> Confirm([FromBody] ConfirmPaymentRequest req, CancellationToken ct) => Ok(await billing.ConfirmPaymentAsync(req, ct));

    // ---- invoices people can keep
    [HttpGet("details")]
    public async Task<IActionResult> Details(CancellationToken ct) => Ok(await invoices.GetBuyerAsync(ct));

    [HttpPut("details")]
    public async Task<IActionResult> SetDetails([FromBody] InvoiceBuyerDto req, CancellationToken ct) => Ok(await invoices.SetBuyerAsync(req, ct));

    [HttpGet("invoices/{id:guid}/pdf")]
    public async Task<IActionResult> InvoicePdf(Guid id, CancellationToken ct)
    {
        var file = await invoices.RenderAsync(id, ct);
        return File(file.Bytes, "application/pdf", file.FileName);
    }

    [HttpPost("cancel")]
    public async Task<IActionResult> Cancel(CancellationToken ct) => Ok(await billing.CancelAsync(ct));

    [HttpPost("resume")]
    public async Task<IActionResult> Resume(CancellationToken ct) => Ok(await billing.ResumeAsync(ct));
}

/// <summary>Where the payment provider reports what happened to a subscription. Anonymous by nature: the signature on the message is the proof.</summary>
[Route("api/v1/billing/webhooks")]
public class BillingWebhookController(BillingWebhookService webhooks, ILogger<BillingWebhookController> log) : ApiControllerBase
{
    [HttpPost("razorpay"), AllowAnonymous]
    public async Task<IActionResult> Razorpay(CancellationToken ct)
    {
        using var reader = new StreamReader(Request.Body);
        var body = await reader.ReadToEndAsync(ct);
        try { await webhooks.HandleAsync(body, Request.Headers["X-Razorpay-Signature"], Request.Headers["X-Razorpay-Event-Id"], ct); }
        catch (System.Text.Json.JsonException ex) { log.LogWarning(ex, "A billing event could not be read"); return BadRequest(); }
        return Ok();
    }
}
