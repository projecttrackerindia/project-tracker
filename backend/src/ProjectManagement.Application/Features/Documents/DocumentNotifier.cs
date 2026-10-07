using Microsoft.EntityFrameworkCore;
using ProjectManagement.Application.Abstractions;
using ProjectManagement.Application.Features.Notifications;
using ProjectManagement.Domain.Entities;
using ProjectManagement.Domain.Enums;

namespace ProjectManagement.Application.Features.Documents;

/// <summary>
/// Sends the notices of the document workflow. One notice per person per event: the people are de-duplicated, the person who did it is left out, and a
/// dedupe key makes a retried request never notify twice. The notices go through the normal pipeline (bell, e-mail, push by each person's own choice).
/// </summary>
public class DocumentNotifier(IAppDbContext db, ICurrentContext ctx, NotificationService notifications)
{
    private readonly HashSet<string> _sent = [];

    /// <summary><paramref name="eventKey"/> names the event ("submitted:step0", "published:1.2") so the same person is told once about it.</summary>
    public async Task SendAsync(IEnumerable<Guid> people, Document doc, string eventKey, string title, string? body = null, bool withLink = true, CancellationToken ct = default)
    {
        var tid = ctx.RequireTenantId();
        foreach (var user in people.Distinct())
        {
            if (user == ctx.UserId) continue;
            // Short and fixed in length (the column holds 100 characters): the same event for the same person always gives the same key.
            var key = "doc:" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{eventKey}|{doc.Id:N}|{user:N}")))[..40];
            if (!_sent.Add(key)) continue;
            if (await db.Notifications.IgnoreQueryFilters().AnyAsync(n => n.TenantId == tid && n.DedupeKey == key, ct)) continue;
            await notifications.AddAsync(user, NotificationType.Document, title, body, withLink ? $"/documents/{doc.Id}" : null, key, ct: ct);
        }
    }
}
