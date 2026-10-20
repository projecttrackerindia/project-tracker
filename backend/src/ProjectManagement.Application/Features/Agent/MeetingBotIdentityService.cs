using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;

namespace ProjectManagement.Application.Features.Agent;

public record MeetingBotIdentityDto(Guid Id, string Email, string DisplayName, bool Active, int Cookies, DateTime CreatedAt, DateTime? LastUsedAt, string? LastError, DateTime? LastErrorAt);
public record SaveMeetingBotIdentityRequest(string Email, string DisplayName, string Cookies);
/// <summary>What a worker receives to join as the account: its id (reported back on failure) and its cookies in Playwright's shape.</summary>
public record BotIdentityDto(string Id, JsonElement Cookies);

/// <summary>
/// The Google accounts the meeting bot joins calls as. A platform administrator signs the account in in an ordinary browser, exports its
/// cookies (Cookie-Editor's JSON or Playwright's storage state) and pastes them here; they are stored only encrypted, never shown again,
/// and handed to a worker for each call. The account in least recent use is chosen, so several accounts share the load.
/// </summary>
public class MeetingBotIdentityService(IAppDbContext db, ICurrentContext ctx, ISecretProtector secrets, AppClock clock, Recorder recorder)
{
    public const string SignedOut = "NOTETAKER_SIGNED_OUT";
    private static readonly HashSet<string> Domains = [".google.com", "google.com", "meet.google.com", ".meet.google.com", "accounts.google.com", ".accounts.google.com", ".youtube.com", "www.google.com"];

    private void RequireAdmin() { if (!ctx.IsPlatformAdmin) throw new ForbiddenException("Platform administrators only.", "PERMISSION_DENIED"); }

    private static MeetingBotIdentityDto Dto(MeetingBotIdentity i, int cookies) =>
        new(i.Id, i.Email, i.DisplayName, i.Active, cookies, i.CreatedAt, i.LastUsedAt, i.LastError, i.LastErrorAt);

    public async Task<IReadOnlyList<MeetingBotIdentityDto>> ListAsync(CancellationToken ct)
    {
        RequireAdmin();
        var rows = await db.MeetingBotIdentities.AsNoTracking().OrderBy(i => i.CreatedAt).ToListAsync(ct);
        return rows.Select(r => Dto(r, Count(r))).ToList();
    }

    private int Count(MeetingBotIdentity i)
    {
        try { return JsonNode.Parse(secrets.Unprotect(i.CookiesProtected)) is JsonArray a ? a.Count : 0; } catch { return 0; }
    }

    /// <summary>Turns an export into Playwright cookies, keeping only Google's: name, value, domain, path, expires, httpOnly, secure, sameSite.</summary>
    public static JsonArray Normalize(string text)
    {
        JsonNode? root;
        try { root = JsonNode.Parse(text); } catch (JsonException) { throw new ValidationException("cookies", "Paste the cookies as JSON (Cookie-Editor's Export › JSON, or a Playwright storage state)."); }
        var list = root is JsonObject o && o["cookies"] is JsonArray inner ? inner : root as JsonArray
            ?? throw new ValidationException("cookies", "Paste the cookies as a JSON list.");
        var result = new JsonArray();
        foreach (var c in list.OfType<JsonObject>())
        try
        {
            var name = c["name"]?.GetValue<string>(); var value = c["value"]?.GetValue<string>(); var domain = c["domain"]?.GetValue<string>();
            if (string.IsNullOrEmpty(name) || value is null || string.IsNullOrEmpty(domain)) continue;
            if (!Domains.Contains(domain) && !domain.EndsWith(".google.com", StringComparison.OrdinalIgnoreCase)) continue;
            double expires = -1;
            if (c["expires"] is JsonValue e1 && e1.TryGetValue<double>(out var x1)) expires = x1;
            else if (c["expirationDate"] is JsonValue e2 && e2.TryGetValue<double>(out var x2)) expires = x2;
            var same = (c["sameSite"]?.ToString() ?? "").ToLowerInvariant() switch { "strict" => "Strict", "none" or "no_restriction" => "None", _ => "Lax" };
            var secure = c["secure"] is JsonValue s && s.TryGetValue<bool>(out var sv) && sv;
            if (same == "None") secure = true;
            result.Add(new JsonObject
            {
                ["name"] = name, ["value"] = value, ["domain"] = domain, ["path"] = c["path"]?.GetValue<string>() ?? "/",
                ["expires"] = Math.Round(expires), ["httpOnly"] = c["httpOnly"] is JsonValue h && h.TryGetValue<bool>(out var hv) && hv,
                ["secure"] = secure, ["sameSite"] = same,
            });
            if (result.Count >= 400) break;
        }
        catch (Exception e) when (e is InvalidOperationException or FormatException) { /* a malformed entry is skipped */ }
        if (!result.OfType<JsonObject>().Any(c => c["name"]!.GetValue<string>() is "SID" or "__Secure-1PSID" or "__Secure-3PSID"))
            throw new ValidationException("cookies", "These cookies are not from a signed-in Google account. Sign in to the notetaker account first, then export again.");
        return result;
    }

    public async Task<MeetingBotIdentityDto> SaveAsync(Guid? id, SaveMeetingBotIdentityRequest req, CancellationToken ct)
    {
        RequireAdmin();
        var email = (req.Email ?? "").Trim().ToLowerInvariant();
        if (email.Length is < 3 or > 254 || !System.Net.Mail.MailAddress.TryCreate(email, out _)) throw new ValidationException("email", "Enter the notetaker account's email address.");
        var name = (req.DisplayName ?? "").Trim();
        if (name.Length is < 2 or > 100) throw new ValidationException("displayName", "Enter the name the account shows in meetings.");
        if (string.IsNullOrWhiteSpace(req.Cookies) || req.Cookies.Length > 300_000) throw new ValidationException("cookies", "Paste the exported cookies.");
        var cookies = Normalize(req.Cookies);
        var row = id is { } existing ? await db.MeetingBotIdentities.FirstOrDefaultAsync(i => i.Id == existing, ct) ?? throw new NotFoundException("Notetaker account not found.")
            : await db.MeetingBotIdentities.FirstOrDefaultAsync(i => i.Email == email, ct);
        if (row is null) { row = new MeetingBotIdentity { CreatedAt = clock.Now, CreatedBy = ctx.UserId }; db.MeetingBotIdentities.Add(row); }
        row.Email = email; row.DisplayName = name; row.CookiesProtected = secrets.Protect(cookies.ToJsonString());
        row.Active = true; row.LastError = null; row.LastErrorAt = null; row.UpdatedAt = clock.Now; row.UpdatedBy = ctx.UserId;
        recorder.Audit("meetingbot.identity_saved", "MeetingBotIdentity", row.Id, null, new { email });
        await db.SaveChangesAsync(ct);
        return Dto(row, cookies.Count);
    }

    public async Task<MeetingBotIdentityDto> SetActiveAsync(Guid id, bool active, CancellationToken ct)
    {
        RequireAdmin();
        var row = await db.MeetingBotIdentities.FirstOrDefaultAsync(i => i.Id == id, ct) ?? throw new NotFoundException("Notetaker account not found.");
        row.Active = active; row.UpdatedAt = clock.Now;
        await db.SaveChangesAsync(ct);
        return Dto(row, Count(row));
    }

    public async Task DeleteAsync(Guid id, CancellationToken ct)
    {
        RequireAdmin();
        var row = await db.MeetingBotIdentities.FirstOrDefaultAsync(i => i.Id == id, ct) ?? throw new NotFoundException("Notetaker account not found.");
        db.MeetingBotIdentities.Remove(row);
        recorder.Audit("meetingbot.identity_removed", "MeetingBotIdentity", id, null, new { row.Email });
        await db.SaveChangesAsync(ct);
    }

    /// <summary>For a worker taking a Google Meet session: the active account used least recently (null = join as a guest).</summary>
    public async Task<BotIdentityDto?> PickAsync(string meetingUrl, CancellationToken ct)
    {
        if (!meetingUrl.Contains("meet.google.com", StringComparison.OrdinalIgnoreCase)) return null;
        var row = await db.MeetingBotIdentities.AsNoTracking().Where(i => i.Active && i.LastError == null)
            .OrderBy(i => i.LastUsedAt ?? DateTime.MinValue).FirstOrDefaultAsync(ct);
        if (row is null) return null;
        string json;
        try { json = secrets.Unprotect(row.CookiesProtected); } catch { return null; }
        await db.MeetingBotIdentities.Where(i => i.Id == row.Id).ExecuteUpdateAsync(u => u.SetProperty(i => i.LastUsedAt, clock.Now), ct);
        using var doc = JsonDocument.Parse(json);
        return new BotIdentityDto(row.Id.ToString(), doc.RootElement.Clone());
    }

    /// <summary>A worker found the account signed out: stop using it until an administrator signs it in again.</summary>
    public async Task MarkSignedOutAsync(string? identityId, CancellationToken ct)
    {
        if (!Guid.TryParse(identityId, out var id)) return;
        await db.MeetingBotIdentities.Where(i => i.Id == id && i.LastError == null).ExecuteUpdateAsync(u => u
            .SetProperty(i => i.LastError, "Google signed this account out. Sign in again and paste fresh cookies.")
            .SetProperty(i => i.LastErrorAt, clock.Now), ct);
    }
}
