using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Ai;

/// <summary>The workspace's own AI key, decrypted, as the AI clients need it (never sent to a browser).</summary>
public sealed record WorkspaceAiKey(Guid TenantId, int Version, string Provider, string ApiKey, string QuickModel, string StandardModel, string DeepModel, bool FallbackToPlatform)
{
    public string ProviderName => WorkspaceAiService.NameOf(Provider);

    /// <summary>The organization's model for the level Project Tracker asked for (named after the platform's own quick, standard and deep models).</summary>
    public string ModelFor(string requested, AiChatOptions tiers)
    {
        if (string.Equals(requested, QuickModel, StringComparison.OrdinalIgnoreCase) || string.Equals(requested, StandardModel, StringComparison.OrdinalIgnoreCase)
            || string.Equals(requested, DeepModel, StringComparison.OrdinalIgnoreCase)) return requested;
        if (string.Equals(requested, tiers.Quick.Model, StringComparison.OrdinalIgnoreCase) || string.Equals(requested, tiers.ClassifierModel, StringComparison.OrdinalIgnoreCase)) return QuickModel;
        if (string.Equals(requested, tiers.Deep.Model, StringComparison.OrdinalIgnoreCase)) return DeepModel;
        return StandardModel;
    }
}

/// <summary>Builds AI clients that answer on a workspace's own key, and asks a provider which models a key may use.</summary>
public interface IWorkspaceAiClients
{
    IAiChat Chat(WorkspaceAiKey key);
    IAiClient OneShot(WorkspaceAiKey key);
    /// <summary>The models the key may use (chat models only). Throws an <see cref="AppException"/> people can act on when the key is refused.</summary>
    Task<IReadOnlyList<string>> ListModelsAsync(string provider, string apiKey, CancellationToken ct);
}

public sealed record AiProviderSettingsDto(bool Configured, string Provider, string ProviderName, string? KeyHint, string QuickModel, string StandardModel, string DeepModel,
    bool Enabled, bool FallbackToPlatform, DateTime? LastCheckedAt, string? LastError, int PeopleAgreed, int Version);
public sealed record SaveAiProviderRequest(string Provider, string? ApiKey, string? QuickModel, string? StandardModel, string? DeepModel, bool Enabled, bool FallbackToPlatform);
public sealed record CheckAiKeyRequest(string Provider, string? ApiKey);
public sealed record AiKeyCheckDto(bool Ok, IReadOnlyList<string> Models, string? Error);
/// <summary>What one person sees: whether the workspace answers on its own AI account, and whether they agreed to it.</summary>
public sealed record AiProviderStatusDto(bool Active, string? Provider, string? ProviderName, bool Agreed, DateTime? AgreedAt, bool FallbackToPlatform, string? Notice);

/// <summary>
/// A workspace's own Claude or ChatGPT key. An owner or admin adds it (checked against the provider before it is saved, stored encrypted,
/// shown only by its last four characters); each person agrees once before their questions go to that provider, and can withdraw.
/// While it is on, people who agreed are answered on the organization's own account - no AI credits are used for them. Background work
/// (scheduled digests, the project agent) keeps using Project Tracker's own AI: nobody is there to have agreed.
/// </summary>
public class WorkspaceAiService(IAppDbContext db, ICurrentContext ctx, AppClock clock, ISecretProtector protector, IWorkspaceAiClients clients, Recorder recorder)
{
    public static readonly string[] Providers = ["anthropic", "openai"];
    public static string NameOf(string provider) => provider == "openai" ? "ChatGPT (OpenAI)" : "Claude (Anthropic)";
    /// <summary>Starting choices for Claude (the current generation); a key's own model list is what the admin finally picks from.</summary>
    public static (string Quick, string Standard, string Deep) Defaults(string provider) =>
        provider == "anthropic" ? ("claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5") : ("", "", "");

    private bool loaded;
    private WorkspaceAiKey? active;

    /// <summary>A signed-in person using the app (not a script with an API key, not background work).</summary>
    private bool Interactive => ctx.UserId is not null && ctx.TenantId is not null && ctx.SessionId is not null && !ctx.ViaApiKey;

    private async Task RequireAdminAsync(CancellationToken ct)
    {
        var tenant = ctx.RequireTenantId(); var user = ctx.RequireUserId();
        var role = await db.TenantMembers.AsNoTracking().Where(x => x.TenantId == tenant && x.UserId == user).Select(x => (TenantRole?)x.Role).SingleOrDefaultAsync(ct);
        if (role is not (TenantRole.Owner or TenantRole.Admin) || !await db.Tenants.AnyAsync(x => x.Id == tenant && x.Type == WorkspaceType.Organization, ct))
            throw new ForbiddenException("Only an organization owner or administrator can set up the workspace's own AI key.", "PERMISSION_DENIED");
    }

    private static string Hint(string key) => key.Length <= 4 ? "••••" : key[^4..];

    public async Task<AiProviderSettingsDto> GetAsync(CancellationToken ct = default)
    {
        await RequireAdminAsync(ct);
        var row = await db.AiWorkspaceProviders.AsNoTracking().FirstOrDefaultAsync(ct);
        if (row is null)
        {
            var d = Defaults("anthropic");
            return new AiProviderSettingsDto(false, "anthropic", NameOf("anthropic"), null, d.Quick, d.Standard, d.Deep, false, true, null, null, 0, 0);
        }
        var agreed = await db.AiProviderConsents.AsNoTracking().CountAsync(c => c.Provider == row.Provider && c.Version == row.Version && c.WithdrawnAt == null, ct);
        return new AiProviderSettingsDto(true, row.Provider, NameOf(row.Provider), row.KeyHint, row.QuickModel, row.StandardModel, row.DeepModel, row.Enabled, row.FallbackToPlatform,
            row.LastCheckedAt, row.LastError, agreed, row.Version);
    }

    /// <summary>Asks the provider which models the key may use - the proof that the key works. With no key given, the saved one is checked.</summary>
    public async Task<AiKeyCheckDto> CheckAsync(CheckAiKeyRequest req, CancellationToken ct = default)
    {
        await RequireAdminAsync(ct);
        var provider = ProviderOf(req.Provider);
        var key = req.ApiKey?.Trim();
        var row = await db.AiWorkspaceProviders.FirstOrDefaultAsync(ct);
        if (string.IsNullOrEmpty(key))
        {
            if (row is null || row.Provider != provider) throw new ValidationException("apiKey", "Paste the API key to check.");
            key = protector.Unprotect(row.KeyProtected);
        }
        else ValidateKey(provider, key);
        try
        {
            var models = await clients.ListModelsAsync(provider, key, ct);
            if (row is not null && row.Provider == provider && string.IsNullOrEmpty(req.ApiKey)) { row.LastCheckedAt = clock.Now; row.LastError = null; await db.SaveChangesAsync(ct); }
            return new AiKeyCheckDto(true, models, null);
        }
        catch (AppException ex)
        {
            if (row is not null && row.Provider == provider && string.IsNullOrEmpty(req.ApiKey)) { row.LastCheckedAt = clock.Now; row.LastError = Clip(ex.Message, 300); await db.SaveChangesAsync(ct); }
            return new AiKeyCheckDto(false, [], ex.Message);
        }
    }

    public async Task<AiProviderSettingsDto> SaveAsync(SaveAiProviderRequest req, CancellationToken ct = default)
    {
        await RequireAdminAsync(ct);
        var provider = ProviderOf(req.Provider);
        var row = await db.AiWorkspaceProviders.FirstOrDefaultAsync(ct);
        var newKey = req.ApiKey?.Trim();
        if (string.IsNullOrEmpty(newKey) && (row is null || row.Provider != provider))
            throw new ValidationException("apiKey", $"Paste your {NameOf(provider)} API key.");
        if (!string.IsNullOrEmpty(newKey)) ValidateKey(provider, newKey);
        var quick = Model(req.QuickModel, "quickModel"); var standard = Model(req.StandardModel, "standardModel"); var deep = Model(req.DeepModel, "deepModel");

        // The key must work, and the chosen models must be ones it may use, before anything is saved.
        var key = string.IsNullOrEmpty(newKey) ? protector.Unprotect(row!.KeyProtected) : newKey;
        var models = await clients.ListModelsAsync(provider, key, ct);
        foreach (var (m, field) in new[] { (quick, "quickModel"), (standard, "standardModel"), (deep, "deepModel") })
            if (!models.Contains(m, StringComparer.OrdinalIgnoreCase)) throw new ValidationException(field, $"This key cannot use {m}. Pick one of the models listed for it.");

        var changed = row is null || row.Provider != provider || !string.IsNullOrEmpty(newKey);
        if (row is null)
        {
            row = new AiWorkspaceProvider { TenantId = ctx.RequireTenantId(), Version = 1 };
            db.AiWorkspaceProviders.Add(row);
        }
        else if (changed) row.Version++;   // a new provider or key: people agree again
        row.Provider = provider;
        if (!string.IsNullOrEmpty(newKey)) { row.KeyProtected = protector.Protect(newKey); row.KeyHint = Hint(newKey); }
        row.QuickModel = quick; row.StandardModel = standard; row.DeepModel = deep;
        row.Enabled = req.Enabled; row.FallbackToPlatform = req.FallbackToPlatform;
        row.LastCheckedAt = clock.Now; row.LastError = null;
        recorder.Audit(changed ? "ai_provider.key_set" : "ai_provider.updated", nameof(AiWorkspaceProvider), row.Id,
            newValue: new { provider, keyHint = row.KeyHint, quick, standard, deep, req.Enabled, req.FallbackToPlatform, row.Version });
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    public async Task RemoveAsync(CancellationToken ct = default)
    {
        await RequireAdminAsync(ct);
        var row = await db.AiWorkspaceProviders.FirstOrDefaultAsync(ct);
        if (row is null) return;
        db.AiWorkspaceProviders.Remove(row);
        recorder.Audit("ai_provider.removed", nameof(AiWorkspaceProvider), row.Id, oldValue: new { row.Provider, row.KeyHint });
        await db.SaveChangesAsync(ct);
    }

    // ------------------------------------------------------------------ each person

    public async Task<AiProviderStatusDto> StatusAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var row = await db.AiWorkspaceProviders.AsNoTracking().FirstOrDefaultAsync(ct);
        if (row is not { Enabled: true }) return new AiProviderStatusDto(false, null, null, false, null, true, null);
        var consent = await db.AiProviderConsents.AsNoTracking().FirstOrDefaultAsync(c => c.UserId == me, ct);
        var agreed = consent is { WithdrawnAt: null } && consent.Provider == row.Provider && consent.Version == row.Version;
        return new AiProviderStatusDto(true, row.Provider, NameOf(row.Provider), agreed, agreed ? consent!.AgreedAt : null, row.FallbackToPlatform, Notice(row.Provider));
    }

    /// <summary>What a person agrees to, in plain words.</summary>
    public static string Notice(string provider) =>
        $"Your organization answers the assistant with its own {NameOf(provider)} account. When you ask something, your question and the work details the assistant " +
        $"looks up for it (only what you can already see) are sent to {(provider == "openai" ? "OpenAI" : "Anthropic")} under your organization's agreement with them, " +
        "and are not used to charge AI credits. You can withdraw at any time in your account.";

    public async Task<AiProviderStatusDto> AgreeAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var row = await db.AiWorkspaceProviders.AsNoTracking().FirstOrDefaultAsync(ct) ?? throw new ConflictException("Your workspace does not use its own AI key.", "AI_PROVIDER_OFF");
        var consent = await db.AiProviderConsents.FirstOrDefaultAsync(c => c.UserId == me, ct);
        if (consent is null) { consent = new AiProviderConsent { TenantId = ctx.RequireTenantId(), UserId = me }; db.AiProviderConsents.Add(consent); }
        consent.Provider = row.Provider; consent.Version = row.Version; consent.AgreedAt = clock.Now; consent.WithdrawnAt = null;
        recorder.Audit("ai_provider.agreed", nameof(AiProviderConsent), consent.Id, newValue: new { row.Provider, row.Version });
        await db.SaveChangesAsync(ct);
        loaded = false;
        return await StatusAsync(ct);
    }

    public async Task<AiProviderStatusDto> WithdrawAsync(CancellationToken ct = default)
    {
        var me = ctx.RequireUserId();
        var consent = await db.AiProviderConsents.FirstOrDefaultAsync(c => c.UserId == me, ct);
        if (consent is { WithdrawnAt: null })
        {
            consent.WithdrawnAt = clock.Now;
            recorder.Audit("ai_provider.withdrawn", nameof(AiProviderConsent), consent.Id, newValue: new { consent.Provider, consent.Version });
            await db.SaveChangesAsync(ct);
        }
        loaded = false;
        return await StatusAsync(ct);
    }

    /// <summary>
    /// The key to answer this request on: the workspace's own, when it is on and this signed-in person agreed to its current version.
    /// Null otherwise (Project Tracker's own AI answers). Worked out once per request.
    /// </summary>
    public async Task<WorkspaceAiKey?> ActiveAsync(CancellationToken ct = default)
    {
        if (loaded) return active;
        loaded = true; active = null;
        if (!Interactive) return null;
        var me = ctx.UserId!.Value;
        var row = await db.AiWorkspaceProviders.AsNoTracking().FirstOrDefaultAsync(ct);
        if (row is not { Enabled: true }) return null;
        var agreed = await db.AiProviderConsents.AsNoTracking().AnyAsync(c => c.UserId == me && c.WithdrawnAt == null && c.Provider == row.Provider && c.Version == row.Version, ct);
        if (!agreed) return null;
        string key;
        try { key = protector.Unprotect(row.KeyProtected); } catch { return null; }   // a key that cannot be read (rotated protection keys): as if none
        return active = new WorkspaceAiKey(row.TenantId, row.Version, row.Provider, key, row.QuickModel, row.StandardModel, row.DeepModel, row.FallbackToPlatform);
    }

    /// <summary>The provider's name when the workspace uses its own key and this person has not agreed yet (the assistant asks them first).</summary>
    public async Task<string?> NeedsAgreementAsync(CancellationToken ct = default)
    {
        if (!Interactive) return null;
        var row = await db.AiWorkspaceProviders.AsNoTracking().FirstOrDefaultAsync(ct);
        if (row is not { Enabled: true }) return null;
        var me = ctx.UserId!.Value;
        var agreed = await db.AiProviderConsents.AsNoTracking().AnyAsync(c => c.UserId == me && c.WithdrawnAt == null && c.Provider == row.Provider && c.Version == row.Version, ct);
        return agreed ? null : NameOf(row.Provider);
    }

    /// <summary>Keeps the last problem the key had (shown to admins), without failing the request that met it.</summary>
    public async Task ReportFailureAsync(string message, CancellationToken ct = default)
    {
        try
        {
            var row = await db.AiWorkspaceProviders.FirstOrDefaultAsync(ct);
            if (row is null) return;
            row.LastError = Clip(message, 300); row.LastCheckedAt = clock.Now;
            await db.SaveChangesAsync(ct);
        }
        catch (Exception) { /* best effort */ }
    }

    // ------------------------------------------------------------------ checks

    private static string ProviderOf(string? provider)
    {
        var p = (provider ?? "").Trim().ToLowerInvariant();
        return Providers.Contains(p) ? p : throw new ValidationException("provider", "Choose Claude (Anthropic) or ChatGPT (OpenAI).");
    }

    private static void ValidateKey(string provider, string key)
    {
        if (key.Length is < 20 or > 400 || key.Any(char.IsWhiteSpace)) throw new ValidationException("apiKey", "That does not look like an API key. Copy it again from the provider's console.");
        if (provider == "anthropic" && !key.StartsWith("sk-ant-", StringComparison.Ordinal)) throw new ValidationException("apiKey", "An Anthropic API key starts with sk-ant-. Create one at console.anthropic.com › API keys.");
        if (provider == "openai" && !key.StartsWith("sk-", StringComparison.Ordinal)) throw new ValidationException("apiKey", "An OpenAI API key starts with sk-. Create one at platform.openai.com › API keys.");
    }

    private static string Model(string? model, string field)
    {
        var m = (model ?? "").Trim();
        if (m.Length is 0 or > 100 || !m.All(c => char.IsLetterOrDigit(c) || c is '-' or '.' or '_' or ':' or '/'))
            throw new ValidationException(field, "Pick a model for each level.");
        return m;
    }

    private static string Clip(string s, int max) => s.Length <= max ? s : s[..max];
}
