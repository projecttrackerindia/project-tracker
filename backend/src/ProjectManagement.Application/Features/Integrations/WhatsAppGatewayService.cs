using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Common;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Integrations;

public class WhatsAppOptions
{
    public const string Section = "WhatsApp";
    public bool InstallationEnabled { get; set; }
    public bool HealthChecksEnabled { get; set; } // Read-only, administrator-initiated checks; default off.
    public bool TemplateChecksEnabled { get; set; } // Read-only, administrator-initiated checks; default off.
    public bool DeliveryEnabled { get; set; } // Default off; controlled registration/webhook/delivery checks precede activation.
    public int DeliveryUserDailyCap { get; set; } = 10;
    public int DeliveryOrganizationDailyCap { get; set; } = 1000;
    public int DeliveryIntervalSeconds { get; set; } = 10;
    public bool ContactLinkingEnabled { get; set; }
    public string? EmbeddedSignupConfigId { get; set; }
    public string? ApiVersion { get; set; }
    public string? SignupVersion { get; set; }
    public bool InstallationConfigured => Configured && WhatsAppGatewayService.ProviderId(EmbeddedSignupConfigId)
        && ApiVersion is { Length: <= 10 } && System.Text.RegularExpressions.Regex.IsMatch(ApiVersion, @"^v[0-9]{1,3}\.[0-9]{1,2}$")
        && SignupVersion is "v3" or "v4";
    public bool WebhookReceptionEnabled { get; set; } // Default off; sending has no implementation or activation switch.
    /// <summary>
    /// Default off. When on, a text from a member's verified number that starts with a project key ("PAY: refunds are blocked") is kept,
    /// encrypted, for that project's agent to read as information. It never changes anything by itself: the agent only proposes, and a person
    /// who may edit the project approves. Every other message's text is still discarded.
    /// </summary>
    public bool AgentMessagesEnabled { get; set; }
    public string? AppId { get; set; }
    public string? AppSecret { get; set; }
    public string? VerifyToken { get; set; }
    public bool Configured => WhatsAppGatewayService.ProviderId(AppId)
        && AppSecret is { Length: >= 16 and <= 256 } && VerifyToken is { Length: >= 16 and <= 256 };
}
public record WhatsAppStatusDto(bool Configured, bool ReceptionEnabled, bool Eligible, bool Connected,
    string? DisplayName, DateTimeOffset? ConnectedAt, bool InstallationEnabled = false, bool MessagingEnabled = false);
public record WhatsAppReceiptDto(Guid Id, string MessageType, DateTimeOffset ProviderCreatedAt, DateTimeOffset ReceivedAt,
    string Outcome = "identity_verification_required");

/// <summary>Signed inbound receipts and explicit self-service contact proof. Messages never invoke AI or change business data.</summary>
public class WhatsAppGatewayService(IAppDbContext db, CurrentContext ctx,
    AppClock clock, Recorder recorder, IOptions<WhatsAppOptions> options, WhatsAppContactService contacts, ProjectManagement.Application.Features.Agent.AgentSignalService agent)
{
    private readonly WhatsAppOptions _o = options.Value;
    private static readonly HashSet<string> Types = ["text", "image", "video", "audio", "document", "sticker",
        "location", "contacts", "interactive", "button", "reaction", "order", "system", "unknown", "unsupported"];
    internal static bool ProviderId(string? value) => value is { Length: > 0 and <= 40 } && value.All(c => c is >= '0' and <= '9');

    private static DateTimeOffset Utc(DateTime value) => new(DateTime.SpecifyKind(value, DateTimeKind.Utc));
    internal async Task RequireAdminAsync(CancellationToken ct)
    {
        var tenant = ctx.RequireTenantId(); var user = ctx.RequireUserId();
        if (!await db.TenantMembers.AnyAsync(x => x.TenantId == tenant && x.UserId == user
                && (x.Role == TenantRole.Owner || x.Role == TenantRole.Admin), ct)
            || !await db.Users.AnyAsync(x => x.Id == user && x.IsActive && !x.MustChangePassword, ct)
            || !await db.Tenants.AnyAsync(x => x.Id == tenant && x.Type == WorkspaceType.Organization, ct))
            throw new ForbiddenException("Only an organization owner or administrator can manage WhatsApp.");
    }
    internal Task<bool> EligibleAsync(Guid tenant, CancellationToken ct) => contacts.EligibleAsync(tenant, ct);
    public async Task<WhatsAppStatusDto> StatusAsync(CancellationToken ct)
    {
        await RequireAdminAsync(ct);
        var tenant = ctx.RequireTenantId();
        var connection = await db.WhatsAppConnections.AsNoTracking().SingleOrDefaultAsync(x => x.TenantId == tenant, ct);
        var eligible=await EligibleAsync(tenant,ct);
        return new(_o.Configured, _o.Configured && _o.WebhookReceptionEnabled, eligible,
            connection?.Active == true && (connection.TokenExpiresAt == null || connection.TokenExpiresAt > clock.Now), connection?.DisplayName, connection is null ? null : Utc(connection.ConnectedAt), _o.InstallationEnabled && _o.InstallationConfigured,
            WhatsAppDeliveryService.Enabled(_o)&&eligible&&connection?.Active==true&&connection.AppId==_o.AppId&&(connection.TokenExpiresAt==null||connection.TokenExpiresAt>clock.Now));
    }
    public async Task<IReadOnlyList<WhatsAppReceiptDto>> ReceiptsAsync(CancellationToken ct)
    {
        await RequireAdminAsync(ct); var tenant = ctx.RequireTenantId();
        if (!await EligibleAsync(tenant, ct))
            throw new ForbiddenException("WhatsApp requires an active subscription with integration access.", "WHATSAPP_PLAN_REQUIRED");
        var rows = await db.WhatsAppInboundReceipts.AsNoTracking().Where(x => x.TenantId == tenant && x.ReceivedAt >= clock.Now.AddDays(-30))
            .OrderByDescending(x => x.ReceivedAt).ThenByDescending(x => x.Id).Take(50)
            .ToListAsync(ct);
        return rows.Select(x => new WhatsAppReceiptDto(x.Id, x.MessageType, Utc(x.ProviderCreatedAt), Utc(x.ReceivedAt))).ToArray();
    }
    public async Task DisconnectAsync(CancellationToken ct)
    {
        await RequireAdminAsync(ct); var tenant = ctx.RequireTenantId();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await db.LockTenantLedgerAsync(tenant, ct);
        await db.WhatsAppDeliveries.Where(x=>x.State=="queued"||x.State=="preparing").ExecuteUpdateAsync(u=>u
            .SetProperty(x=>x.State,"suppressed").SetProperty(x=>x.Reason,"CONNECTION_DISCONNECTED")
            .SetProperty(x=>x.LeaseId,(Guid?)null).SetProperty(x=>x.LeaseUntil,(DateTime?)null),ct);
        await db.WhatsAppDeliveries.Where(x=>x.State=="sending").ExecuteUpdateAsync(u=>u
            .SetProperty(x=>x.State,"unknown").SetProperty(x=>x.Reason,"CONNECTION_DISCONNECTED"),ct);
        await db.ProviderOAuthAttempts.Where(x => x.Provider == "whatsapp" && x.TenantId == tenant).ExecuteDeleteAsync(ct);
        await db.WhatsAppContactLinks.Where(x => x.TenantId == tenant).ExecuteUpdateAsync(s => s
            .SetProperty(x => x.PhoneProtected, "").SetProperty(x => x.PhoneHash, (string?)null)
            .SetProperty(x => x.ChallengeHash, (string?)null).SetProperty(x => x.ChallengeIssuedAt, (DateTime?)null)
            .SetProperty(x => x.ChallengeExpiresAt, (DateTime?)null).SetProperty(x => x.VerifiedAt, (DateTime?)null)
            .SetProperty(x => x.ConsentVersion, (string?)null).SetProperty(x => x.ConsentAt, (DateTime?)null)
                .SetProperty(x => x.NotificationPreferencesVersion, x => x.NotificationPreferencesVersion + 1)
                .SetProperty(x => x.NotificationConsentVersion, (string?)null).SetProperty(x => x.NotificationConsentAt, (DateTime?)null)
                .SetProperty(x => x.NotificationConsentExpiresAt, (DateTime?)null)
                .SetProperty(x => x.NotifyTaskAssignments, false).SetProperty(x => x.NotifyOverdue, false).SetProperty(x => x.NotifySupportUpdates, false)
                .SetProperty(x => x.NotificationTimeZone, (string?)null).SetProperty(x => x.NotificationQuietStartMinutes, 1320)
                .SetProperty(x => x.NotificationQuietEndMinutes, 480), ct);
        var c = await db.WhatsAppConnections.SingleOrDefaultAsync(x => x.TenantId == tenant, ct);
        if (c is not null && (c.Active || c.AccessTokenProtected.Length > 0))
        {
            c.Active = false; c.AccessTokenProtected = ""; WhatsAppHealthService.Clear(c);
            WhatsAppTemplateService.Clear(c);
            recorder.Audit("whatsapp.disconnected", "WhatsAppConnection", c.Id);
            await db.SaveChangesAsync(ct);
        }
        await tx.CommitAsync(ct);
    }
    private void RequireReception()
    {
        if (!_o.Configured || !_o.WebhookReceptionEnabled)
            throw new AppException(503, "WHATSAPP_RECEPTION_DISABLED", "WhatsApp reception is not enabled.");
    }
    public string VerifyChallenge(string? mode, string? token, string? challenge)
    {
        RequireReception();
        if (mode != "subscribe" || token is not { Length: >= 16 and <= 256 }
            || !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(token), Encoding.UTF8.GetBytes(_o.VerifyToken!))
            || challenge is not { Length: > 0 and <= 200 } || !challenge.All(c => c is >= '0' and <= '9'))
            throw new UnauthorizedException("WhatsApp webhook verification failed.", "WHATSAPP_VERIFICATION_INVALID");
        return challenge;
    }
    public void VerifySignature(string? signature, ReadOnlySpan<byte> body)
    {
        RequireReception();
        if (signature is not { Length: 71 } || !signature.StartsWith("sha256=", StringComparison.Ordinal))
            throw new UnauthorizedException("WhatsApp signature is invalid.", "WHATSAPP_SIGNATURE_INVALID");
        byte[] digest;
        try { digest = Convert.FromHexString(signature[7..]); }
        catch (FormatException) { throw new UnauthorizedException("WhatsApp signature is invalid.", "WHATSAPP_SIGNATURE_INVALID"); }
        if (!CryptographicOperations.FixedTimeEquals(digest, HMACSHA256.HashData(Encoding.UTF8.GetBytes(_o.AppSecret!), body)))
            throw new UnauthorizedException("WhatsApp signature is invalid.", "WHATSAPP_SIGNATURE_INVALID");
    }
    private sealed record Incoming(string BusinessId, string PhoneId, string MessageId, string Type, DateTime Timestamp, string? Sender, string? Proof, string? AgentText = null);
    private static string? String(JsonElement obj, string key) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static JsonElement Array(JsonElement obj, string key, int maximum)
    {
        if (obj.ValueKind != JsonValueKind.Object || !obj.TryGetProperty(key, out var value)
            || value.ValueKind != JsonValueKind.Array || value.GetArrayLength() > maximum)
            throw new ValidationException("body", "Invalid or oversized WhatsApp webhook envelope.");
        return value;
    }
    private sealed record DeliveryStatus(string BusinessId,string PhoneId,string MessageId,string State,DateTime Timestamp,string? CallbackTag,string? Recipient);
    private static (List<Incoming> Messages,List<DeliveryStatus> Statuses) Parse(ReadOnlyMemory<byte> body, bool keepAgentText = false)
    {
        try
        {
            using var json = JsonDocument.Parse(body, new JsonDocumentOptions { MaxDepth = 20 });
            var root = json.RootElement;
            if (String(root, "object") != "whatsapp_business_account")
                throw new ValidationException("body", "Expected a WhatsApp business webhook.");
            var messages = new List<Incoming>();var statuses=new List<DeliveryStatus>();
            foreach (var entry in Array(root, "entry", 20).EnumerateArray())
            {
                var business = String(entry, "id");
                if (!ProviderId(business)) throw new ValidationException("body", "Invalid business account ID.");
                foreach (var change in Array(entry, "changes", 20).EnumerateArray())
                {
                    if (String(change, "field") != "messages") continue;
                    if (!change.TryGetProperty("value", out var value) || value.ValueKind != JsonValueKind.Object
                        || String(value, "messaging_product") != "whatsapp"
                        || !value.TryGetProperty("metadata", out var metadata) || !ProviderId(String(metadata, "phone_number_id")))
                        throw new ValidationException("body", "Invalid WhatsApp message metadata.");
                    // Status callbacks may only reconcile an already persisted, independently authorized send attempt.
                    if(value.TryGetProperty("statuses",out _))
                    {
                        foreach(var status in Array(value,"statuses",100).EnumerateArray())
                        {
                            var id=String(status,"id");var state=String(status,"status");
                            var timestamp=String(status,"timestamp");
                            if(timestamp==null&&status.TryGetProperty("timestamp",out var number)&&number.ValueKind==JsonValueKind.Number&&number.TryGetInt64(out var numeric))timestamp=numeric.ToString(CultureInfo.InvariantCulture);
                            if(id is not {Length:>0 and <=200}||id.Any(char.IsControl)||state is not ("sent" or "delivered" or "read" or "failed" or "deleted")
                                ||!long.TryParse(timestamp,NumberStyles.None,CultureInfo.InvariantCulture,out var unix)||unix<0||unix>253402300799)
                                throw new ValidationException("body","Invalid WhatsApp delivery status.");
                            var tag=String(status,"biz_opaque_callback_data");var recipient=String(status,"recipient_id");
                            if(tag is {Length:>100}||tag?.Any(char.IsControl)==true)throw new ValidationException("body","Invalid WhatsApp correlation metadata.");
                            statuses.Add(new(business!,String(metadata,"phone_number_id")!,id,state,DateTimeOffset.FromUnixTimeSeconds(unix).UtcDateTime,tag,recipient));
                            if(statuses.Count+messages.Count>100)throw new ValidationException("body","Too many WhatsApp events.");
                        }
                    }
                    if (!value.TryGetProperty("messages", out _)) continue;
                    foreach (var message in Array(value, "messages", 100).EnumerateArray())
                    {
                        var id = String(message, "id"); var type = String(message, "type");
                        if (id is not { Length: > 0 and <= 200 } || id.Any(char.IsControl)
                            || type is null || !Types.Contains(type)
                            || !long.TryParse(String(message, "timestamp"), NumberStyles.None, CultureInfo.InvariantCulture, out var unix)
                            || unix < 0 || unix > 253402300799)
                            throw new ValidationException("body", "Invalid WhatsApp message receipt.");
                        // Retain only a candidate link proof in memory - and, when the project agent may read messages, a text addressed to a project
                        // ("PAY: ..."); all other message text is discarded.
                        string? proof = null; string? sender = null; string? agentText = null;
                        if (type == "text" && message.TryGetProperty("text", out var text))
                        {
                            var candidate = String(text, "body");
                            if (candidate is { Length: 40 } && candidate.StartsWith("PT-LINK ", StringComparison.Ordinal))
                            { proof = candidate; sender = String(message, "from"); }
                            else if (keepAgentText && candidate is { Length: >= 6 and <= 4000 } && ProjectManagement.Application.Features.Agent.AgentSignalService.AddressedToProject(candidate))
                            { agentText = candidate; sender = String(message, "from"); }
                        }
                        messages.Add(new(business!, String(metadata, "phone_number_id")!, id, type,
                            DateTimeOffset.FromUnixTimeSeconds(unix).UtcDateTime, sender, proof, agentText));
                        if (messages.Count + statuses.Count > 100) throw new ValidationException("body", "Too many WhatsApp messages.");
                    }
                }
            }
            return (messages,statuses);
        }
        catch (JsonException) { throw new ValidationException("body", "Invalid WhatsApp JSON."); }
    }
    public async Task ReceiveAsync(ReadOnlyMemory<byte> body, string? signature, CancellationToken ct)
    {
        if (body.Length > 64 * 1024) throw new ValidationException("body", "WhatsApp payload is too large.");
        VerifySignature(signature, body.Span);
        var (messages,statuses) = Parse(body, _o.AgentMessagesEnabled); // Validate the entire batch before persisting any receipts.
        var originalTenant = ctx.TenantId; var originalUser = ctx.UserId;
        try
        {
            foreach (var group in messages.Select(x => new { x.BusinessId, x.PhoneId }).Concat(statuses.Select(x => new { x.BusinessId, x.PhoneId })).Distinct())
            {
                // Only installation metadata is read globally, after provider signature validation.
                // Identity can only be linked by a separate owner-initiated challenge; no business action is executed.
                var c = await db.WhatsAppConnections.IgnoreQueryFilters().AsNoTracking().SingleOrDefaultAsync(
                    x => x.AppId == _o.AppId && x.BusinessAccountId == group.BusinessId
                        && x.PhoneNumberId == group.PhoneId && x.Active, ct);
                if (c is null) continue;
                ctx.TenantId = c.TenantId; ctx.UserId = null;
                await using var tx = await db.Database.BeginTransactionAsync(ct);
                await db.LockTenantLedgerAsync(c.TenantId, ct);
                if (!await db.WhatsAppConnections.AnyAsync(x => x.Id == c.Id && x.ConnectedAt == c.ConnectedAt && x.Active
                        && x.AppId == _o.AppId && x.BusinessAccountId == group.BusinessId
                        && x.PhoneNumberId == group.PhoneId, ct)
                    || !await db.Tenants.AnyAsync(x => x.Id == c.TenantId && x.Type == WorkspaceType.Organization && x.Status == TenantStatus.Active, ct)) continue;
                // Delivery evidence is metadata-only and may reconcile an existing attempt after its plan/token expires.
                foreach(var status in statuses.Where(x=>x.BusinessId==group.BusinessId&&x.PhoneId==group.PhoneId))
                    await ReconcileAsync(c,status,ct);
                if(messages.Any(x=>x.BusinessId==group.BusinessId&&x.PhoneId==group.PhoneId)
                    &&(c.TokenExpiresAt==null||c.TokenExpiresAt>clock.Now)&&await EligibleAsync(c.TenantId,ct))
                {
                // Expired receipts cannot be reintroduced: old provider timestamps are discarded first.
                await db.WhatsAppInboundReceipts.Where(x => x.TenantId == c.TenantId && x.ReceivedAt < clock.Now.AddDays(-30))
                    .Take(100).ExecuteDeleteAsync(ct);
                var remaining = Math.Max(0, 10000 - await db.WhatsAppInboundReceipts.CountAsync(x => x.TenantId == c.TenantId, ct));
                foreach (var incoming in messages.Where(x=>x.BusinessId==group.BusinessId&&x.PhoneId==group.PhoneId).DistinctBy(x => x.MessageId))
                {
                    if (incoming.Timestamp < clock.Now.AddDays(-30) || incoming.Timestamp > clock.Now.AddMinutes(5)
                        || incoming.Timestamp < new DateTime(c.ConnectedAt.Ticks - c.ConnectedAt.Ticks % TimeSpan.TicksPerSecond, DateTimeKind.Utc)) continue;
                    if (await db.WhatsAppInboundReceipts.AnyAsync(x => x.AppId == _o.AppId
                            && x.PhoneNumberId == c.PhoneNumberId && x.ProviderMessageId == incoming.MessageId, ct)) continue;
                    await contacts.TryVerifyAsync(c, incoming.Sender, incoming.Proof, incoming.Timestamp, ct);
                    // Only from a member's own verified number; the agent reads it as information and proposes, nothing more.
                    if (incoming.AgentText is { } said && _o.AgentMessagesEnabled && await contacts.VerifiedUserAsync(c, incoming.Sender, ct) is { } member)
                        await agent.AddWhatsAppAsync(c.TenantId, member, incoming.MessageId, said, incoming.Timestamp, ct);
                    if (remaining == 0) continue;
                    remaining--;
                    db.WhatsAppInboundReceipts.Add(new WhatsAppInboundReceipt
                    {
                        TenantId = c.TenantId, AppId = c.AppId, PhoneNumberId = c.PhoneNumberId,
                        ProviderMessageId = incoming.MessageId, MessageType = incoming.Type,
                        ProviderCreatedAt = incoming.Timestamp, ReceivedAt = clock.Now
                    });
                }
                }
                await db.SaveChangesAsync(ct);
                await tx.CommitAsync(ct);
            }
        }
        finally { ctx.TenantId = originalTenant; ctx.UserId = originalUser; }
    }
    private async Task ReconcileAsync(WhatsAppConnection connection,DeliveryStatus status,CancellationToken ct)
    {
        if(status.State=="deleted"||status.CallbackTag is not {Length:74}||!status.CallbackTag.StartsWith("pt-wa-v1:",StringComparison.Ordinal)
            ||!WhatsAppContactService.PhoneDigits(status.Recipient)||status.Timestamp>clock.Now.AddMinutes(5)||status.Timestamp<clock.Now.AddDays(-30))return;
        var row=await db.WhatsAppDeliveries.SingleOrDefaultAsync(x=>x.ConnectionId==connection.Id&&x.ConnectionConnectedAt==connection.ConnectedAt
            &&x.CallbackTag==status.CallbackTag&&x.AttemptedAt!=null,ct);
        if(row==null||row.ConfigurationHash!=WhatsAppDeliveryService.Fingerprint(_o)
            ||row.RecipientHash!=WhatsAppDeliveryService.RecipientHash(_o,connection.TenantId,status.Recipient!)
            ||status.Timestamp<row.AttemptedAt!.Value.AddSeconds(-30)
            ||row.ProviderMessageId!=null&&row.ProviderMessageId!=status.MessageId||!status.MessageId.StartsWith("wamid.",StringComparison.Ordinal))return;
        if(await db.WhatsAppDeliveries.AnyAsync(x=>x.Id!=row.Id&&x.ConnectionId==connection.Id&&x.ProviderMessageId==status.MessageId,ct))return;
        static int Rank(string state)=>state switch {"read"=>4,"delivered"=>3,"sent"=>2,"accepted"=>1,_=>0};
        if(status.State=="failed")
        {
            if(Rank(row.State)>=3||row.ProviderStatusAt>status.Timestamp)return;
            row.State="failed";row.Reason="PROVIDER_DELIVERY_FAILED";
        }
        else
        {
            if(Rank(status.State)<Rank(row.State)||row.State=="failed"&&row.ProviderStatusAt>=status.Timestamp&&Rank(status.State)<3)return;
            row.State=status.State;row.Reason=null;
        }
        row.ProviderMessageId??=status.MessageId;row.AcceptedAt??=clock.Now;row.LeaseUntil=null;
        if(row.ProviderStatusAt==null||status.Timestamp>row.ProviderStatusAt)row.ProviderStatusAt=status.Timestamp;
    }

}
