using ProjectManagement.Domain.Common;

namespace ProjectManagement.Domain.Entities;

/// <summary>
/// One payment for a plan by UPI QR, used until a payment gateway is connected. The workspace owner pays the installation's UPI ID shown as a
/// QR (the amount and a reference are in it), then enters the UPI transaction id (UTR); a platform administrator checks it against the bank
/// statement and confirms it, which activates the plan. If paying to one QR fails, the next attempt of the same checkout uses another UPI ID
/// (<see cref="ChainId"/> ties the attempts together).
/// </summary>
public class UpiPayment : TenantEntity, ITenantScoped
{
    public Guid PlanId { get; set; }
    public string PlanCode { get; set; } = "";
    public int Seats { get; set; } = 1;
    /// <summary>monthly or yearly.</summary>
    public string Period { get; set; } = "monthly";
    public decimal Amount { get; set; }
    public string Currency { get; set; } = "INR";
    public string Description { get; set; } = "";
    /// <summary>Short reference put in the UPI note ("PT-7K3F9Q"), so the payment can be found in the bank statement.</summary>
    public string Reference { get; set; } = "";
    /// <summary>The first attempt of this checkout; later attempts (after a failed payment) keep it.</summary>
    public Guid ChainId { get; set; }
    public int Attempt { get; set; } = 1;
    /// <summary>The UPI ID (VPA) the QR pays.</summary>
    public string AccountId { get; set; } = "";
    /// <summary>Which bank account it is, as shown to people ("Kotak Mahindra Bank").</summary>
    public string? AccountLabel { get; set; }
    /// <summary>awaiting, submitted, confirmed, rejected, failed, cancelled.</summary>
    public string Status { get; set; } = "awaiting";
    /// <summary>The UPI transaction id (UTR / UPI Ref No.) the payer entered.</summary>
    public string? Utr { get; set; }
    public DateTime? SubmittedAt { get; set; }
    public Guid? SubmittedBy { get; set; }
    public DateTime? DecidedAt { get; set; }
    public Guid? DecidedBy { get; set; }
    public string? DecisionNote { get; set; }
    /// <summary>Why the payer said paying this QR failed.</summary>
    public string? FailureReason { get; set; }
    public DateTime ExpiresAt { get; set; }
}
