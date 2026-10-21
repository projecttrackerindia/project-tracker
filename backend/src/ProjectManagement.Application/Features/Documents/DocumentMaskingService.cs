using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Exceptions;
using ProjectManagement.Application.Services;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Documents;

public record MaskingBuiltInDto(string Label, string Strategy, string Example, string Masked, bool Enabled);
public record MaskingRuleDto(Guid Id, string Field, string Match, string Strategy, string Label, bool Enabled);
public record MaskingSettingsDto(bool Enabled, IReadOnlyList<MaskingBuiltInDto> BuiltIns, IReadOnlyList<MaskingRuleDto> Rules, bool CanManage);
public record SaveMaskingSettingsRequest(bool Enabled, IReadOnlyList<string>? DisabledBuiltIns);
public record SaveMaskingRuleRequest(string Field, string? Match, string? Strategy, string? Label, bool Enabled);
public record MaskPreviewRequest(string Text);
public record MaskPreviewDto(string Masked, int Count);

/// <summary>
/// The workspace's masking of personal and secret data in documents: on or off, which built-in kinds apply, and its own rules. Owners and
/// admins manage it; everyone's document views go through <see cref="MaskerAsync"/>.
/// </summary>
public class DocumentMaskingService(IAppDbContext db, ICurrentContext ctx, AppClock clock, Recorder recorder)
{
    // Loaded once per request; each caller gets its own masker so its count of masked values is its own.
    private (bool On, List<MaskRule> Rules, List<string> Off)? _config;

    private void RequireAdmin()
    {
        if (ctx.Role is not (TenantRole.Owner or TenantRole.Admin)) throw new ForbiddenException("Only owners and admins can change masking.", "PERMISSION_DENIED");
    }

    /// <summary>A fresh masker with the workspace's rules, or null when masking is switched off.</summary>
    public async Task<PiiMasker?> MaskerAsync(CancellationToken ct)
    {
        if (_config is null)
        {
            var s = await db.DocumentMaskingSettings.AsNoTracking().FirstOrDefaultAsync(ct);
            var rules = s is { Enabled: false } ? [] : await db.MaskingRules.AsNoTracking().Where(r => r.Enabled).Select(r => new MaskRule(r.Field, r.Match, r.Strategy, r.Label)).ToListAsync(ct);
            _config = (s?.Enabled ?? true, rules, Split(s?.DisabledBuiltIns));
        }
        return _config.Value.On ? new PiiMasker(_config.Value.Rules, _config.Value.Off) : null;
    }

    private static List<string> Split(string? s) => (s ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

    public async Task<MaskingSettingsDto> GetAsync(CancellationToken ct)
    {
        ctx.RequireTenantId();
        var s = await db.DocumentMaskingSettings.AsNoTracking().FirstOrDefaultAsync(ct);
        var off = Split(s?.DisabledBuiltIns);
        var rules = await db.MaskingRules.AsNoTracking().OrderBy(r => r.CreatedAt).ToListAsync(ct);
        return new(s?.Enabled ?? true,
            PiiMasker.BuiltIns.Select(b => new MaskingBuiltInDto(b.Label, b.Strategy, b.Example, PiiMasker.Apply(b.Example, b.Strategy), !off.Contains(b.Label, StringComparer.OrdinalIgnoreCase))).ToList(),
            rules.Select(Dto).ToList(), ctx.Role is TenantRole.Owner or TenantRole.Admin);
    }

    private static MaskingRuleDto Dto(MaskingRule r) => new(r.Id, r.Field, r.Match, r.Strategy, r.Label, r.Enabled);

    public async Task<MaskingSettingsDto> SaveSettingsAsync(SaveMaskingSettingsRequest req, CancellationToken ct)
    {
        RequireAdmin();
        var known = PiiMasker.BuiltIns.Select(b => b.Label).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var off = (req.DisabledBuiltIns ?? []).Where(known.Contains).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var s = await db.DocumentMaskingSettings.FirstOrDefaultAsync(ct);
        if (s is null) { s = new DocumentMaskingSettings { TenantId = ctx.RequireTenantId(), CreatedAt = clock.Now, CreatedBy = ctx.UserId }; db.DocumentMaskingSettings.Add(s); }
        else { s.UpdatedAt = clock.Now; s.UpdatedBy = ctx.UserId; }
        var was = s.Enabled;
        s.Enabled = req.Enabled; s.DisabledBuiltIns = string.Join(',', off);
        recorder.Audit("document.masking_changed", "DocumentMaskingSettings", s.Id, new { enabled = was }, new { enabled = s.Enabled, off });
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    public async Task<MaskingSettingsDto> SaveRuleAsync(Guid? id, SaveMaskingRuleRequest req, CancellationToken ct)
    {
        RequireAdmin();
        var field = (req.Field ?? "").Trim();
        var match = req.Match is "contains" or "regex" ? req.Match : "exact";
        var strategy = PiiMasker.Strategies.Contains(req.Strategy) ? req.Strategy! : "full";
        if (field.Length is 0 or > 200) throw new ValidationException("field", "Enter the field name, like loan_account_no or Customer mobile.");
        if (match == "regex")
        {
            try { _ = new Regex(field, RegexOptions.None, TimeSpan.FromMilliseconds(50)).IsMatch(new string('a', 2000)); }
            catch (ArgumentException) { throw new ValidationException("field", "That is not a valid pattern."); }
            catch (RegexMatchTimeoutException) { throw new ValidationException("field", "That pattern is too slow; make it simpler."); }
        }
        var label = string.IsNullOrWhiteSpace(req.Label) ? field : req.Label.Trim();
        if (label.Length > 80) label = label[..80];
        var row = id is { } existing ? await db.MaskingRules.FirstOrDefaultAsync(r => r.Id == existing, ct) ?? throw new NotFoundException("Rule not found.") : null;
        if (row is null)
        {
            if (await db.MaskingRules.CountAsync(ct) >= 100) throw new ConflictException("Up to 100 masking rules.");
            row = new MaskingRule { TenantId = ctx.RequireTenantId(), CreatedAt = clock.Now, CreatedBy = ctx.UserId };
            db.MaskingRules.Add(row);
        }
        else { row.UpdatedAt = clock.Now; row.UpdatedBy = ctx.UserId; }
        row.Field = field; row.Match = match; row.Strategy = strategy; row.Label = label; row.Enabled = req.Enabled;
        recorder.Audit(id is null ? "document.masking_rule_added" : "document.masking_rule_changed", "MaskingRule", row.Id, null, new { field, match, strategy });
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    public async Task<MaskingSettingsDto> DeleteRuleAsync(Guid id, CancellationToken ct)
    {
        RequireAdmin();
        var row = await db.MaskingRules.FirstOrDefaultAsync(r => r.Id == id, ct) ?? throw new NotFoundException("Rule not found.");
        db.MaskingRules.Remove(row);
        recorder.Audit("document.masking_rule_removed", "MaskingRule", row.Id, new { row.Field }, null);
        await db.SaveChangesAsync(ct);
        return await GetAsync(ct);
    }

    /// <summary>Shows what the current rules do to a sample, without storing it.</summary>
    public async Task<MaskPreviewDto> PreviewAsync(MaskPreviewRequest req, CancellationToken ct)
    {
        var text = req.Text ?? "";
        if (text.Length > 4000) throw new ValidationException("text", "Up to 4000 characters.");
        var m = await MaskerAsync(ct) ?? new PiiMasker();
        var masked = text.TrimStart().StartsWith('{') ? m.MaskRichText(System.Text.Json.JsonSerializer.Serialize(new { type = "doc", content = new[] { new { type = "codeBlock", content = new[] { new { type = "text", text } } } } })) : m.MaskText(text);
        if (text.TrimStart().StartsWith('{'))
            masked = System.Text.Json.Nodes.JsonNode.Parse(masked)?["content"]?[0]?["content"]?[0]?["text"]?.ToString() ?? masked;
        return new(masked, m.Count);
    }
}
